// routes/leaderboard.js — Weekly leaderboard API
const express = require('express');
const router = express.Router();
const { pool, redis } = require('../db/index');
const { auth } = require('../middleware/Auth');

// ─── Helper: Get current week boundaries (Monday 00:00 → Sunday 23:59) ────────
function getWeekBounds() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  
  const sunday = new Date(now);
  sunday.setUTCDate(now.getUTCDate() - day);
  sunday.setUTCHours(0, 0, 0, 0);
  
  const saturday = new Date(sunday);
  saturday.setUTCDate(sunday.getUTCDate() + 6);
  saturday.setUTCHours(23, 59, 59, 999);
  
  return { weekStart: sunday, weekEnd: saturday };
}

// Short-TTL in-process caches to avoid sequential DB storms on Redis fallback
const _weeklyLeaderboardCache = new Map();
let _leaderboardSettingsCache = { data: null, expiresAt: 0 };
let _payoutPendingCache = { value: false, expiresAt: 0 };

async function getPayoutPendingFlag() {
  const now = Date.now();
  if (now < _payoutPendingCache.expiresAt) {
    return _payoutPendingCache.value;
  }
  try {
    const pendingRes = await pool.query(`
      SELECT 1 FROM leaderboard_snapshots 
      WHERE prize_status = 'pending' 
      LIMIT 1
    `);
    const val = pendingRes.rows.length > 0;
    _payoutPendingCache = { value: val, expiresAt: now + 15_000 };
    return val;
  } catch (e) {
    console.warn('[LEADERBOARD] Error fetching pending snapshot:', e.message);
    return false;
  }
}

// ─── Helper: Get global settings ────────
async function getSettings(keys) {
  try {
    if (keys.length === 1 && keys[0] === 'leaderboard_enabled' && _leaderboardSettingsCache.data && Date.now() < _leaderboardSettingsCache.expiresAt) {
      return _leaderboardSettingsCache.data;
    }
    const { rows } = await pool.query(
      'SELECT key, value FROM global_settings WHERE key = ANY($1)',
      [keys]
    );
    const config = {};
    for (const r of rows) {
      config[r.key] = r.value;
    }
    if (keys.length === 1 && keys[0] === 'leaderboard_enabled') {
      _leaderboardSettingsCache = { data: config, expiresAt: Date.now() + 15000 };
    }
    return config;
  } catch (err) {
    console.error('[LEADERBOARD] Error fetching global settings:', err);
    return {};
  }
}

// ─── GET /leaderboard/weekly — Top 50 + current user rank ─────────────────────
router.get('/weekly', auth, async (req, res) => {
  try {
    const config = await getSettings(['leaderboard_enabled']);
    const isEnabled = config.leaderboard_enabled !== false && config.leaderboard_enabled !== 'false';
    if (!isEnabled) {
      return res.json({
        enabled: false,
        message: 'Leaderboard is currently offline for maintenance.',
        leaderboard: [],
        top3: [],
        myRank: null,
        prizes: [],
        total: 0,
        secondsRemaining: 0,
      });
    }

    const userId = req.user.id || req.user.userId || req.user.sub;
    const { weekStart, weekEnd } = getWeekBounds();

    const search = req.query.search ? String(req.query.search).trim() : '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const CACHE_KEY = `leaderboard:weekly:${search}:${page}:${limit}`;
    let cachedGlobal = null;
    const memEntry = _weeklyLeaderboardCache.get(CACHE_KEY);
    if (memEntry && Date.now() < memEntry.expiresAt) {
      cachedGlobal = memEntry.payload;
    } else {
      try {
        const cached = await redis.get(CACHE_KEY);
        if (cached) cachedGlobal = JSON.parse(cached);
      } catch (e) { console.error('Redis err', e); }
    }

    let total = 0, realListBase = [], top3Base = [];

    if (cachedGlobal) {
      ({ total, realListBase, top3Base } = cachedGlobal);
    } else {
      // 1. Build queries (count, paginated list, top 3 podium) and run them in parallel
      let countQuery = `
        SELECT COUNT(DISTINCT g.winner) AS total
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND COALESCE(u.is_bot, false) = false
          AND g.created_at >= $1 AND g.created_at <= $2
      `;
      const countParams = [weekStart.toISOString(), weekEnd.toISOString()];
      if (search) {
        countQuery += ` AND (u.username ILIKE $3 OR u.number ILIKE $3)`;
        countParams.push(`%${search}%`);
      }

      // 2. Paginated list (CTE + grouped LEFT JOIN eliminates correlated subquery N+1)
      const itemsParams = [weekStart.toISOString(), weekEnd.toISOString()];
      let searchClause = '';
      if (search) {
        searchClause = ` AND (u.username ILIKE $3 OR u.number ILIKE $3)`;
        itemsParams.push(`%${search}%`);
      }
      const limitParamIdx = itemsParams.length + 1;
      const offsetParamIdx = itemsParams.length + 2;
      itemsParams.push(limit, offset);

      const itemsCte = `
        WITH ranked AS (
          SELECT
            u.id,
            u.username,
            u.avatar,
            COUNT(*) AS wins,
            MAX(g.created_at) AS last_win_at
          FROM games g
          JOIN users u ON u.id = g.winner
          WHERE g.status IN ('completed', 'finished')
            AND g.winner IS NOT NULL
            AND COALESCE(u.is_bot, false) = false
            AND g.created_at >= $1 AND g.created_at <= $2
            ${searchClause}
          GROUP BY u.id, u.username, u.avatar
          ORDER BY wins DESC, MAX(g.created_at) ASC
          LIMIT $${limitParamIdx} OFFSET $${offsetParamIdx}
        )
      `;

      const itemsQuery = `
        ${itemsCte}
        SELECT
          ranked.id::text AS id,
          ranked.username,
          ranked.avatar,
          ranked.wins,
          COALESCE(pt.win_sum, ranked.wins * 50) AS win_amount
        FROM ranked
        LEFT JOIN (
          SELECT user_id, SUM(amount) AS win_sum
          FROM payment_transactions
          WHERE user_id IN (SELECT id FROM ranked)
            AND bank IN ('GAME_WIN', 'SPIN_PRIZE', 'WIN')
            AND status = 'success'
          GROUP BY user_id
        ) pt ON pt.user_id = ranked.id
        ORDER BY ranked.wins DESC, ranked.last_win_at ASC
      `;

      const fallbackItemsQuery = `
        ${itemsCte}
        SELECT
          ranked.id::text AS id,
          ranked.username,
          ranked.avatar,
          ranked.wins,
          ranked.wins * 50 AS win_amount
        FROM ranked
        ORDER BY ranked.wins DESC, ranked.last_win_at ASC
      `;

      // 3. Top 3 global winners for podium (skipped when page === 1 && !search && limit >= 3)
      const canDeriveTop3FromItems = (page === 1 && !search && limit >= 3);
      const top3Cte = `
        WITH ranked AS (
          SELECT
            u.id,
            u.username,
            u.avatar,
            COUNT(*) AS wins,
            MAX(g.created_at) AS last_win_at
          FROM games g
          JOIN users u ON u.id = g.winner
          WHERE g.status IN ('completed', 'finished')
            AND g.winner IS NOT NULL
            AND COALESCE(u.is_bot, false) = false
            AND g.created_at >= $1 AND g.created_at <= $2
          GROUP BY u.id, u.username, u.avatar
          ORDER BY wins DESC, MAX(g.created_at) ASC
          LIMIT 3
        )
      `;
      const top3Query = `
        ${top3Cte}
        SELECT
          ranked.id::text AS id,
          ranked.username,
          ranked.avatar,
          ranked.wins,
          COALESCE(pt.win_sum, ranked.wins * 50) AS win_amount
        FROM ranked
        LEFT JOIN (
          SELECT user_id, SUM(amount) AS win_sum
          FROM payment_transactions
          WHERE user_id IN (SELECT id FROM ranked)
            AND bank IN ('GAME_WIN', 'SPIN_PRIZE', 'WIN')
            AND status = 'success'
          GROUP BY user_id
        ) pt ON pt.user_id = ranked.id
        ORDER BY ranked.wins DESC, ranked.last_win_at ASC
      `;
      const fallbackTop3Query = `
        ${top3Cte}
        SELECT
          ranked.id::text AS id,
          ranked.username,
          ranked.avatar,
          ranked.wins,
          ranked.wins * 50 AS win_amount
        FROM ranked
        ORDER BY ranked.wins DESC, ranked.last_win_at ASC
      `;

      const fetchItems = async () => {
        try {
          const queryRes = await pool.query(itemsQuery, itemsParams);
          return queryRes.rows;
        } catch (err) {
          if (err.code === '42P01' || (err.message && err.message.includes('payment_transactions'))) {
            console.warn('[LEADERBOARD] payment_transactions missing, falling back to count * 50');
            const queryRes = await pool.query(fallbackItemsQuery, itemsParams);
            return queryRes.rows;
          }
          throw err;
        }
      };

      const fetchTop3 = async () => {
        try {
          const top3Res = await pool.query(top3Query, [weekStart.toISOString(), weekEnd.toISOString()]);
          return top3Res.rows;
        } catch (err) {
          if (err.code === '42P01' || (err.message && err.message.includes('payment_transactions'))) {
            const top3Res = await pool.query(fallbackTop3Query, [weekStart.toISOString(), weekEnd.toISOString()]);
            return top3Res.rows;
          }
          throw err;
        }
      };

      const [countRes, rows, top3Rows] = await Promise.all([
        pool.query(countQuery, countParams),
        fetchItems(),
        canDeriveTop3FromItems ? Promise.resolve(null) : fetchTop3(),
      ]);

      total = parseInt(countRes.rows[0]?.total || 0);

      realListBase = rows.map((r, idx) => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        wins: Number(r.wins),
        winAmount: Number(r.win_amount || 0),
        rank: offset + idx + 1
      }));

      top3Base = canDeriveTop3FromItems
        ? realListBase.slice(0, 3).map((u, idx) => ({ ...u, rank: idx + 1 }))
        : top3Rows.map((r, idx) => ({
            id: r.id,
            username: r.username,
            avatar: r.avatar,
            wins: Number(r.wins),
            winAmount: Number(r.win_amount || 0),
            rank: idx + 1
          }));

      const cachePayload = { total, realListBase, top3Base };
      if (_weeklyLeaderboardCache.size > 50) _weeklyLeaderboardCache.clear();
      _weeklyLeaderboardCache.set(CACHE_KEY, { payload: cachePayload, expiresAt: Date.now() + 15000 });
      try {
        await redis.setex(CACHE_KEY, 30, JSON.stringify(cachePayload));
      } catch (e) { console.error('Redis set err', e); }
    }

    const realList = realListBase.map(u => ({ ...u, isMe: u.id === userId }));
    const top3 = top3Base.map(u => ({ ...u, isMe: u.id === userId }));

    // Find current user's rank + snapshot state in parallel
    const meInList = realList.find(u => u.isMe);

    const resolveMyRank = async () => {
      if (meInList) return meInList;

      const { rows: myData } = await pool.query(`
        SELECT COUNT(*) AS wins
        FROM games g
        WHERE g.winner = $1
          AND g.status IN ('completed', 'finished')
          AND g.created_at >= $2 AND g.created_at <= $3
      `, [userId, weekStart.toISOString(), weekEnd.toISOString()]);

      const myWins = Number(myData[0]?.wins || 0);
      if (myWins <= 0) {
        return {
          id: userId,
          username: 'You',
          avatar: null,
          wins: 0,
          rank: null,
          isMe: true,
        };
      }

      const [{ rows: realAbove }, { rows: meInfo }] = await Promise.all([
        pool.query(`
          SELECT COUNT(*)::int AS cnt FROM (
            SELECT g.winner
            FROM games g
            WHERE g.winner != $1
              AND g.status IN ('completed', 'finished')
              AND g.created_at >= $2 AND g.created_at <= $3
            GROUP BY g.winner
            HAVING COUNT(*) > $4
          ) sub
        `, [userId, weekStart.toISOString(), weekEnd.toISOString(), myWins]),
        pool.query(`SELECT username, avatar FROM users WHERE id = $1`, [userId]),
      ]);

      const rankCount = Number(realAbove[0]?.cnt || 0);
      return {
        id: userId,
        username: meInfo[0]?.username || 'You',
        avatar: meInfo[0]?.avatar || null,
        wins: myWins,
        rank: rankCount + 1,
        isMe: true,
      };
    };

    const fetchLastSnapshot = async () => {
      try {
        const lastSnapshotRes = await pool.query(`
          SELECT id, rank, prize_amount, week_start, week_end 
          FROM leaderboard_snapshots 
          WHERE user_id = $1 AND prize_status = 'approved' AND rank <= 3
          ORDER BY week_start DESC 
          LIMIT 1
        `, [userId]);

        if (lastSnapshotRes.rows.length > 0) {
          const snap = lastSnapshotRes.rows[0];
          return {
            snapshotId: snap.id,
            rank: Number(snap.rank),
            prize: Number(snap.prize_amount),
            weekStart: snap.week_start,
            weekEnd: snap.week_end
          };
        }
      } catch (e) {
        console.warn('[LEADERBOARD] Error fetching last week win snapshot:', e.message);
      }
      return null;
    };

    const [myRank, previousWeekWin, payoutPending] = await Promise.all([
      resolveMyRank(),
      fetchLastSnapshot(),
      getPayoutPendingFlag(),
    ]);

    // Prizes list
    const prizes = [
      { rank: 1, amount: 500, label: '1st Place' },
      { rank: 2, amount: 300, label: '2nd Place' },
      { rank: 3, amount: 200, label: '3rd Place' },
    ];

    // Calculate remaining seconds to Sunday 00:00:00 UTC (reset point)
    const nextSunday = new Date(weekEnd);
    nextSunday.setUTCMilliseconds(nextSunday.getUTCMilliseconds() + 1);
    const secondsRemaining = Math.max(0, Math.floor((nextSunday.getTime() - Date.now()) / 1000));

    res.json({
      leaderboard: realList,
      myRank: myRank,
      prizes,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      secondsRemaining,
      previousWeekWin,
      payoutPending,
      top3,
      total,
      page,
      limit
    });
  } catch (err) {
    console.error('[LEADERBOARD] weekly error:', err);
    const { weekStart, weekEnd } = getWeekBounds();
    res.json({
      leaderboard: [],
      myRank: null,
      prizes: [
        { rank: 1, amount: 500, label: '1st Place' },
        { rank: 2, amount: 300, label: '2nd Place' },
        { rank: 3, amount: 200, label: '3rd Place' },
      ],
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      secondsRemaining: 0,
      previousWeekWin: null,
      payoutPending: false,
      top3: [],
      total: 0,
      page: 1,
      limit: 50
    });
  }
});

// ─── GET /leaderboard/podium — Top 3 for home widget (lightweight) ────────────
router.get('/podium', auth, async (req, res) => {
  try {
    const config = await getSettings(['leaderboard_enabled']);
    const isEnabled = config.leaderboard_enabled !== false && config.leaderboard_enabled !== 'false';
    if (!isEnabled) {
      return res.json({
        enabled: false,
        message: 'Leaderboard is currently offline for maintenance.',
        podium: [],
        myRank: null,
        myWins: 0,
      });
    }

    const userId = req.user.id || req.user.userId || req.user.sub;
    const { weekStart, weekEnd } = getWeekBounds();

    // 1. Get real users
    const { rows } = await pool.query(`
      SELECT 
        u.id::text as id,
        u.username,
        u.avatar,
        COUNT(*) AS wins
      FROM games g
      JOIN users u ON u.id = g.winner
      WHERE g.status IN ('completed', 'finished')
        AND g.winner IS NOT NULL
        AND COALESCE(u.is_bot, false) = false
        AND g.created_at >= $1 AND g.created_at <= $2
      GROUP BY u.id, u.username, u.avatar
      ORDER BY wins DESC, MAX(g.created_at) ASC
      LIMIT 3
    `, [weekStart.toISOString(), weekEnd.toISOString()]);
    
    const realList = rows.map(r => ({
      id: r.id,
      username: r.username,
      avatar: r.avatar,
      wins: Number(r.wins),
      isFake: false
    }));

    // Sort: wins DESC, then alphabetically
    realList.sort((a, b) => {
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.username.localeCompare(b.username);
    });

    // Top 3
    const top3 = realList.slice(0, 3);
    const prizes = [500, 300, 200];
    const podium = top3.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      avatar: u.avatar,
      wins: u.wins,
      prize: prizes[i] || 0,
      isMe: u.id === userId
    }));

    // Calculate current user wins and rank
    let myWins = 0;
    let myRank = null;

    const { rows: myData } = await pool.query(`
      SELECT COUNT(*) AS wins
      FROM games g
      WHERE g.winner = $1
        AND g.status IN ('completed', 'finished')
        AND g.created_at >= $2 AND g.created_at <= $3
    `, [userId, weekStart.toISOString(), weekEnd.toISOString()]);
    
    myWins = Number(myData[0]?.wins || 0);

    if (myWins > 0) {
      // Count real above
      const { rows: aboveMe } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT g.winner
          FROM games g
          WHERE g.status IN ('completed', 'finished')
            AND g.winner IS NOT NULL
            AND g.winner != $1
            AND g.created_at >= $2 AND g.created_at <= $3
          GROUP BY g.winner
          HAVING COUNT(*) > $4
        ) sub
      `, [userId, weekStart.toISOString(), weekEnd.toISOString(), myWins]);
      
      myRank = Number(aboveMe[0]?.cnt || 0) + 1;
    }

    res.json({
      podium,
      myRank,
      myWins,
    });
  } catch (err) {
    console.error('[LEADERBOARD] podium error:', err);
    res.status(500).json({ error: 'Failed to fetch podium' });
  }
});

// ─── GET /leaderboard/ticker — Live winner feed across all games (XO, RPS, Spin) ──
router.get('/ticker', async (req, res) => {
  const filter = (req.query.filter || 'all').toString().toLowerCase();
  const CACHE_KEY = `cache:leaderboard_ticker:${filter}`;
  try {
    // Try Redis cache first, but don't fail if Redis is down
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) return res.json(JSON.parse(cached));
    } catch (cacheErr) {
      console.warn('[TICKER] Redis cache read failed (falling through to DB):', cacheErr.message);
    }

    // Fetch config switches
    const config = await getSettings(['fake_ticker_enabled', 'real_ticker_enabled']);
    const showReal = config.real_ticker_enabled !== false && config.real_ticker_enabled !== 'false';
    const showFake = config.fake_ticker_enabled === 'true' || config.fake_ticker_enabled === true;

    let realWinnersList = [];
    let fakeEntriesList = [];

    // 1. Get real winners from all 3 games (Tic-Tac-Toe, RPS, Spin & Win)
    if (showReal) {
      // 1a. Tic-Tac-Toe
      try {
        const { rows: xoWins } = await pool.query(`
          SELECT 
            u.id AS user_id,
            u.username,
            u.avatar,
            u.created_at,
            COALESCE(g.prize_amount, 0) AS amount,
            COALESCE(g.bet_amount, 10) AS bet_amount,
            'xo' AS game_type,
            'Tic-Tac-Toe 1v1' AS game_title,
            COALESCE(g.finished_at, g.created_at) AS finished_at
          FROM games g
          JOIN users u ON u.id = g.winner
          WHERE g.status IN ('completed', 'finished')
            AND g.winner IS NOT NULL
            AND g.prize_amount > 0
          ORDER BY COALESCE(g.finished_at, g.created_at) DESC
          LIMIT 25
        `);
        for (const w of xoWins) {
          realWinnersList.push({
            userId: w.user_id,
            username: w.username,
            avatar: w.avatar,
            createdAt: w.created_at,
            amount: Number(w.amount),
            betAmount: Number(w.bet_amount || 10),
            gameType: 'xo',
            gameTitle: 'Tic-Tac-Toe 1v1',
            finishedAt: w.finished_at,
            type: 'real',
          });
        }
      } catch (xoErr) {
        console.warn('[TICKER] XO games query failed:', xoErr.message);
      }

      // 1b. Rock Paper Scissors
      try {
        const { rows: rpsWins } = await pool.query(`
          SELECT 
            u.id AS user_id,
            u.username,
            u.avatar,
            u.created_at,
            COALESCE(r.prize_amount, 0) AS amount,
            COALESCE(r.stake_amount, 10) AS bet_amount,
            'rps' AS game_type,
            'Rock Paper Scissors' AS game_title,
            COALESCE(r.finished_at, r.created_at, NOW()) AS finished_at
          FROM rps_games r
          JOIN users u ON u.id = r.winner_id
          WHERE r.status IN ('completed', 'finished', 'paid')
            AND r.winner_id IS NOT NULL
            AND r.prize_amount > 0
          ORDER BY COALESCE(r.finished_at, r.created_at) DESC
          LIMIT 25
        `);
        for (const w of rpsWins) {
          realWinnersList.push({
            userId: w.user_id,
            username: w.username,
            avatar: w.avatar,
            createdAt: w.created_at,
            amount: Number(w.amount),
            betAmount: Number(w.bet_amount || 10),
            gameType: 'rps',
            gameTitle: 'Rock Paper Scissors',
            finishedAt: w.finished_at,
            type: 'real',
          });
        }
      } catch (rpsErr) {
        console.warn('[TICKER] RPS games query failed (non-fatal):', rpsErr.message);
      }

      // 1c. Spin & Win
      try {
        const { rows: spinWins } = await pool.query(`
          SELECT 
            u.id AS user_id,
            u.username,
            u.avatar,
            u.created_at,
            COALESCE(s.prize_amount, 0) AS amount,
            COALESCE(c.bet_amount, 10) AS bet_amount,
            'spin' AS game_type,
            'Wheel of Fortune' AS game_title,
            COALESCE(s.resolved_at, s.created_at) AS finished_at
          FROM spin_rounds s
          JOIN users u ON u.id = s.winner_user_id
          LEFT JOIN spin_room_configs c ON c.id = s.config_id
          WHERE s.status IN ('paid', 'completed', 'finished')
            AND s.winner_user_id IS NOT NULL
            AND s.prize_amount > 0
          ORDER BY COALESCE(s.resolved_at, s.created_at) DESC
          LIMIT 25
        `);
        for (const w of spinWins) {
          realWinnersList.push({
            userId: w.user_id,
            username: w.username,
            avatar: w.avatar,
            createdAt: w.created_at,
            amount: Number(w.amount),
            betAmount: Number(w.bet_amount || 10),
            gameType: 'spin',
            gameTitle: 'Wheel of Fortune',
            finishedAt: w.finished_at,
            type: 'real',
          });
        }
      } catch (spinErr) {
        console.warn('[TICKER] Spin rounds query failed (non-fatal):', spinErr.message);
      }
    }

    // 2. Get fake entries if enabled
    if (showFake) {
      try {
        const { rows: fakeEntries } = await pool.query(
          `SELECT username, amount FROM fake_ticker_entries WHERE active = true`
        );
        if (fakeEntries.length > 0) {
          fakeEntriesList = fakeEntries.map(f => ({
            username: f.username,
            amount: Number(f.amount),
            betAmount: Math.round(Number(f.amount) * 0.6),
            gameType: 'xo',
            gameTitle: 'Tic-Tac-Toe 1v1',
            finishedAt: new Date(),
            type: 'fake',
          }));
        }
      } catch (fakeErr) {
        console.warn('[TICKER] Fake entries query failed (non-fatal):', fakeErr.message);
      }
    }

    let combined = [...realWinnersList];
    if (combined.length === 0 && showFake) {
      combined = [...fakeEntriesList];
    }

    // Apply sorting filters: "all", "top_bets", "top_wins", "payout"
    if (filter === 'top_bets') {
      combined.sort((a, b) => (b.betAmount || 0) - (a.betAmount || 0));
    } else if (filter === 'top_wins') {
      combined.sort((a, b) => (b.amount || 0) - (a.amount || 0));
    } else if (filter === 'payout') {
      // Payout multiplier: amount / betAmount
      combined.sort((a, b) => {
        const multA = a.betAmount ? (a.amount / a.betAmount) : 0;
        const multB = b.betAmount ? (b.amount / b.betAmount) : 0;
        return multB - multA;
      });
    } else {
      // Default: chronologically newest first
      combined.sort((a, b) => new Date(b.finishedAt || 0).getTime() - new Date(a.finishedAt || 0).getTime());
    }

    const responsePayload = { ticker: combined.slice(0, 30) };
    try {
      await redis.setex(CACHE_KEY, 5, JSON.stringify(responsePayload));
    } catch (cacheErr) {
      console.warn('[TICKER] Redis cache write failed (non-fatal):', cacheErr.message);
    }
    res.json(responsePayload);
  } catch (err) {
    console.error('[LEADERBOARD] ticker error:', err);
    res.status(500).json({ error: 'Failed to fetch ticker' });
  }
});

// ─── POST /leaderboard/claim — Mark a prize snapshot as claimed ───────────────
router.post('/claim', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId || req.user.sub;
    const { snapshotId } = req.body;
    
    if (!snapshotId) return res.status(400).json({ error: 'snapshotId is required' });

    const { rowCount } = await pool.query(`
      UPDATE leaderboard_snapshots 
      SET prize_status = 'claimed' 
      WHERE id::text = $1::text AND user_id = $2 AND prize_status = 'approved'
    `, [snapshotId, userId]);

    return res.json({ ok: true, claimed: rowCount > 0 });
  } catch (err) {
    console.error('[LEADERBOARD] claim error:', err);
    res.status(500).json({ error: 'Failed to claim prize' });
  }
});

// ─── GET /leaderboard/user/:id — User details for modal ────────────────────────
router.get('/user/:id', auth, async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(targetUserId)) {
      return res.status(400).json({ error: 'Invalid user ID format' });
    }
    
    // 1. Fetch user base info
    const userRes = await pool.query('SELECT created_at, username FROM users WHERE id = $1', [targetUserId]);
    if (!userRes.rows.length) {
      return res.status(404).json({ error: 'User not found' });
    }
    const { created_at, username } = userRes.rows[0];

    // 2. Fetch game stats
    const gamesPlayedRes = await pool.query(
      'SELECT COUNT(*) AS total FROM games WHERE player_x = $1 OR player_o = $1',
      [targetUserId]
    );
    const totalGames = Number(gamesPlayedRes.rows[0]?.total || 0);

    const winsRes = await pool.query(
      'SELECT COUNT(*) AS total FROM games WHERE winner = $1',
      [targetUserId]
    );
    const totalWins = Number(winsRes.rows[0]?.total || 0);

    // 3. Fetch snapshots of prizes won
    const snapshotsRes = await pool.query(
      `SELECT id, rank, prize_amount, week_start, week_end, prize_status 
       FROM leaderboard_snapshots 
       WHERE user_id = $1 
       ORDER BY week_start DESC`,
      [targetUserId]
    );

    res.json({
      ok: true,
      username,
      createdAt: created_at,
      totalGames,
      totalWins,
      prizes: snapshotsRes.rows.map(row => ({
        id: row.id,
        rank: Number(row.rank),
        prizeAmount: Number(row.prize_amount),
        weekStart: row.week_start,
        weekEnd: row.week_end,
        prizeStatus: row.prize_status,
      }))
    });
  } catch (err) {
    console.error('[LEADERBOARD] user details error:', err);
    res.status(500).json({ error: 'Failed to fetch user leaderboard details' });
  }
});

// ─── GET /leaderboard/monthly — Top 50 monthly + current user rank ──────────────
router.get('/monthly', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId || req.user.sub;
    const startOfMonth = new Date();
    startOfMonth.setUTCDate(1);
    startOfMonth.setUTCHours(0, 0, 0, 0);

    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));

    // Get top users based on wins in current month
    const { rows } = await pool.query(`
      SELECT 
        u.id::text as id,
        u.username,
        u.avatar,
        COUNT(CASE WHEN g.winner = u.id THEN 1 END) AS wins,
        COUNT(g.id) AS total
      FROM users u
      JOIN games g ON g.player_x = u.id OR g.player_o = u.id
      WHERE g.status IN ('completed', 'finished')
        AND g.created_at >= $1
      GROUP BY u.id, u.username, u.avatar
      ORDER BY wins DESC, total ASC, MAX(g.created_at) ASC
      LIMIT $2
    `, [startOfMonth.toISOString(), limit]);

    const leaderboard = rows.map((r, idx) => ({
      id: r.id,
      username: r.username,
      avatar: r.avatar,
      wins: Number(r.wins),
      total: Number(r.total),
      rank: idx + 1,
      isMe: r.id === userId
    }));

    const top3 = leaderboard.slice(0, 3);

    // Find current user rank
    let myRank = leaderboard.find(u => u.isMe) || null;
    if (!myRank) {
      // Calculate my wins/total if not in top list
      const { rows: myRows } = await pool.query(`
        SELECT 
          COUNT(CASE WHEN g.winner = $1 THEN 1 END) AS wins,
          COUNT(g.id) AS total
        FROM games g
        WHERE (g.player_x = $1 OR g.player_o = $1)
          AND g.status IN ('completed', 'finished')
          AND g.created_at >= $2
      `, [userId, startOfMonth.toISOString()]);

      const myWins = Number(myRows[0]?.wins || 0);
      const myTotal = Number(myRows[0]?.total || 0);

      // Count players with more wins
      const { rows: aboveRows } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT u.id
          FROM users u
          JOIN games g ON g.player_x = u.id OR g.player_o = u.id
          WHERE g.status IN ('completed', 'finished')
            AND g.created_at >= $2
            AND u.id != $1
          GROUP BY u.id
          HAVING COUNT(CASE WHEN g.winner = u.id THEN 1 END) > $3
        ) sub
      `, [userId, startOfMonth.toISOString(), myWins]);

      const rank = Number(aboveRows[0]?.cnt || 0) + 1;
      const { rows: userRows } = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [userId]);

      myRank = {
        id: userId,
        username: userRows[0]?.username || 'You',
        avatar: userRows[0]?.avatar || null,
        wins: myWins,
        total: myTotal,
        rank,
        isMe: true
      };
    }

    res.json({ ok: true, leaderboard, top3, myRank });
  } catch (err) {
    console.error('[LEADERBOARD] monthly error:', err);
    res.status(500).json({ error: 'Failed to fetch monthly leaderboard' });
  }
});

// ─── GET /leaderboard/alltime — Overall rankings ──────────────────────────────────
router.get('/alltime', auth, async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId || req.user.sub;
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));

    // Get top users based on total wins
    const { rows } = await pool.query(`
      SELECT 
        u.id::text as id,
        u.username,
        u.avatar,
        COUNT(CASE WHEN g.winner = u.id THEN 1 END) AS wins,
        COUNT(g.id) AS total
      FROM users u
      JOIN games g ON g.player_x = u.id OR g.player_o = u.id
      WHERE g.status IN ('completed', 'finished')
      GROUP BY u.id, u.username, u.avatar
      ORDER BY wins DESC, total ASC, MAX(g.created_at) ASC
      LIMIT $1
    `, [limit]);

    const leaderboard = rows.map((r, idx) => ({
      id: r.id,
      username: r.username,
      avatar: r.avatar,
      wins: Number(r.wins),
      total: Number(r.total),
      rank: idx + 1,
      isMe: r.id === userId
    }));

    const top3 = leaderboard.slice(0, 3);

    // Find current user rank
    let myRank = leaderboard.find(u => u.isMe) || null;
    if (!myRank) {
      // Calculate my wins/total if not in top list
      const { rows: myRows } = await pool.query(`
        SELECT 
          COUNT(CASE WHEN g.winner = $1 THEN 1 END) AS wins,
          COUNT(g.id) AS total
        FROM games g
        WHERE (g.player_x = $1 OR g.player_o = $1)
          AND g.status IN ('completed', 'finished')
      `, [userId]);

      const myWins = Number(myRows[0]?.wins || 0);
      const myTotal = Number(myRows[0]?.total || 0);

      // Count players with more wins
      const { rows: aboveRows } = await pool.query(`
        SELECT COUNT(*) AS cnt FROM (
          SELECT u.id
          FROM users u
          JOIN games g ON g.player_x = u.id OR g.player_o = u.id
          WHERE g.status IN ('completed', 'finished')
            AND u.id != $1
          GROUP BY u.id
          HAVING COUNT(CASE WHEN g.winner = u.id THEN 1 END) > $2
        ) sub
      `, [userId, myWins]);

      const rank = Number(aboveRows[0]?.cnt || 0) + 1;
      const { rows: userRows } = await pool.query('SELECT username, avatar FROM users WHERE id = $1', [userId]);

      myRank = {
        id: userId,
        username: userRows[0]?.username || 'You',
        avatar: userRows[0]?.avatar || null,
        wins: myWins,
        total: myTotal,
        rank,
        isMe: true
      };
    }

    res.json({ ok: true, leaderboard, top3, myRank });
  } catch (err) {
    console.error('[LEADERBOARD] alltime error:', err);
    res.status(500).json({ error: 'Failed to fetch alltime leaderboard' });
  }
});

router._clearLeaderboardCaches = () => {
  _weeklyLeaderboardCache.clear();
  _leaderboardSettingsCache = { data: null, expiresAt: 0 };
  _payoutPendingCache = { value: false, expiresAt: 0 };
};

module.exports = router;
