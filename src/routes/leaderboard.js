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

// ─── Helper: Get global settings ────────
async function getSettings(keys) {
  try {
    const { rows } = await pool.query(
      'SELECT key, value FROM global_settings WHERE key = ANY($1)',
      [keys]
    );
    const config = {};
    for (const r of rows) {
      config[r.key] = r.value;
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
    const userId = req.user.id || req.user.userId || req.user.sub;
    const { weekStart, weekEnd } = getWeekBounds();

    const search = req.query.search ? String(req.query.search).trim() : '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 50));
    const offset = (page - 1) * limit;

    const CACHE_KEY = `leaderboard:weekly:${search}:${page}:${limit}`;
    let cachedGlobal = null;
    try {
      const cached = await redis.get(CACHE_KEY);
      if (cached) cachedGlobal = JSON.parse(cached);
    } catch (e) { console.error('Redis err', e) }

    let total = 0, realListBase = [], top3Base = [];

    if (cachedGlobal) {
      ({ total, realListBase, top3Base } = cachedGlobal);
    } else {
      // 1. Get total count for pagination
      let countQuery = `
        SELECT COUNT(DISTINCT g.winner) AS total
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND g.created_at >= $1 AND g.created_at <= $2
      `;
      const countParams = [weekStart.toISOString(), weekEnd.toISOString()];
      if (search) {
        countQuery += ` AND (u.username ILIKE $3 OR u.phone_number ILIKE $3)`;
        countParams.push(`%${search}%`);
      }
      const countRes = await pool.query(countQuery, countParams);
      total = parseInt(countRes.rows[0]?.total || 0);

      // 2. Get paginated list
      let itemsQuery = `
        SELECT 
          u.id::text as id,
          u.username,
          u.avatar,
          COUNT(*) AS wins,
          COALESCE((
            SELECT SUM(amount) FROM payment_transactions 
            WHERE user_id = u.id AND bank IN ('GAME_WIN', 'SPIN_PRIZE', 'WIN') AND status = 'success'
          ), COUNT(*) * 50) AS win_amount
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND g.created_at >= $1 AND g.created_at <= $2
      `;
      const itemsParams = [weekStart.toISOString(), weekEnd.toISOString()];
      if (search) {
        itemsQuery += ` AND (u.username ILIKE $3 OR u.phone_number ILIKE $3)`;
        itemsParams.push(`%${search}%`);
      }
      itemsQuery += `
        GROUP BY u.id, u.username, u.avatar
        ORDER BY wins DESC, MAX(g.created_at) ASC
        LIMIT $${itemsParams.length + 1} OFFSET $${itemsParams.length + 2}
      `;
      itemsParams.push(limit, offset);

      const { rows } = await pool.query(itemsQuery, itemsParams);
      realListBase = rows.map((r, idx) => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        wins: Number(r.wins),
        winAmount: Number(r.win_amount || 0),
        rank: offset + idx + 1
      }));

      // 3. Always fetch top 3 global winners for podium
      const { rows: top3Rows } = await pool.query(`
        SELECT 
          u.id::text as id,
          u.username,
          u.avatar,
          COUNT(*) AS wins,
          COALESCE((
            SELECT SUM(amount) FROM payment_transactions 
            WHERE user_id = u.id AND bank IN ('GAME_WIN', 'SPIN_PRIZE', 'WIN') AND status = 'success'
          ), COUNT(*) * 50) AS win_amount
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND g.created_at >= $1 AND g.created_at <= $2
        GROUP BY u.id, u.username, u.avatar
        ORDER BY wins DESC, MAX(g.created_at) ASC
        LIMIT 3
      `, [weekStart.toISOString(), weekEnd.toISOString()]);

      top3Base = top3Rows.map((r, idx) => ({
        id: r.id,
        username: r.username,
        avatar: r.avatar,
        wins: Number(r.wins),
        winAmount: Number(r.win_amount || 0),
        rank: idx + 1
      }));

      try {
        await redis.setex(CACHE_KEY, 30, JSON.stringify({ total, realListBase, top3Base }));
      } catch (e) { console.error('Redis set err', e); }
    }

    const realList = realListBase.map(u => ({ ...u, isMe: u.id === userId }));
    const top3 = top3Base.map(u => ({ ...u, isMe: u.id === userId }));

    // Find current user's rank
    const meInList = realList.find(u => u.isMe);
    let myRank = null;

    if (meInList) {
      myRank = meInList;
    } else {
      // Calculate user's wins
      const { rows: myData } = await pool.query(`
        SELECT COUNT(*) AS wins
        FROM games g
        WHERE g.winner = $1
          AND g.status IN ('completed', 'finished')
          AND g.created_at >= $2 AND g.created_at <= $3
      `, [userId, weekStart.toISOString(), weekEnd.toISOString()]);

      const myWins = Number(myData[0]?.wins || 0);

      if (myWins > 0) {
        // Count real users above
        const { rows: realAbove } = await pool.query(`
          SELECT COUNT(DISTINCT g.winner) AS cnt
          FROM games g
          WHERE g.winner != $1
            AND g.status IN ('completed', 'finished')
            AND g.created_at >= $2 AND g.created_at <= $3
          GROUP BY g.winner
          HAVING COUNT(*) > $4
        `, [userId, weekStart.toISOString(), weekEnd.toISOString(), myWins]);

        const rankCount = realAbove.length || 0;
        const actualRank = rankCount + 1;
        const { rows: meInfo } = await pool.query(`SELECT username, avatar FROM users WHERE id = $1`, [userId]);

        myRank = {
          id: userId,
          username: meInfo[0]?.username || 'You',
          avatar: meInfo[0]?.avatar || null,
          wins: myWins,
          rank: actualRank,
          isMe: true,
        };
      } else {
        myRank = {
          id: userId,
          username: 'You',
          avatar: null,
          wins: 0,
          rank: null,
          isMe: true,
        };
      }
    }

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

    // Check if the current user has an unacknowledged win (top 3) from last week's snapshot
    let previousWeekWin = null;
    let payoutPending = false;
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
        previousWeekWin = {
          snapshotId: snap.id,
          rank: Number(snap.rank),
          prize: Number(snap.prize_amount),
          weekStart: snap.week_start,
          weekEnd: snap.week_end
        };
      }

      // Check if there are any pending snapshots (i.e. manual review is in progress)
      const pendingRes = await pool.query(`
        SELECT 1 FROM leaderboard_snapshots 
        WHERE prize_status = 'pending' 
        LIMIT 1
      `);
      payoutPending = pendingRes.rows.length > 0;
    } catch (e) {
      console.warn('[LEADERBOARD] Error fetching last week win snapshot:', e.message);
    }

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
    res.status(500).json({ error: 'Failed to fetch leaderboard' });
  }
});

// ─── GET /leaderboard/podium — Top 3 for home widget (lightweight) ────────────
router.get('/podium', auth, async (req, res) => {
  try {
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

// ─── GET /leaderboard/ticker — Live winner feed ──────────────────────────────
router.get('/ticker', async (req, res) => {
  const CACHE_KEY = 'cache:leaderboard_ticker';
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

    // 1. Get real winners if enabled
    if (showReal) {
      const { rows: realWinners } = await pool.query(`
        SELECT 
          u.username,
          g.prize_amount AS amount,
          g.finished_at
        FROM games g
        JOIN users u ON u.id = g.winner
        WHERE g.status IN ('completed', 'finished')
          AND g.winner IS NOT NULL
          AND g.prize_amount > 0
        ORDER BY g.finished_at DESC
        LIMIT 20
      `);

      realWinnersList = realWinners.map(w => ({
        username: w.username,
        amount: Number(w.amount),
        type: 'real',
      }));
    }

    // 2. Get fake entries if enabled
    if (showFake) {
      const { rows: fakeEntries } = await pool.query(
        `SELECT username, amount FROM fake_ticker_entries WHERE active = true`
      );
      if (fakeEntries.length > 0) {
        fakeEntriesList = fakeEntries.map(f => ({
          username: f.username,
          amount: Number(f.amount),
          type: 'fake',
        }));
        // Shuffle fake entries
        fakeEntriesList.sort(() => Math.random() - 0.5);
      }
    }

    let tickerData = [];
    if (showReal && showFake) {
      // Prioritize real winners first, then fake entries
      tickerData = [...realWinnersList, ...fakeEntriesList];
    } else if (showReal) {
      tickerData = realWinnersList;
    } else if (showFake) {
      tickerData = fakeEntriesList;
    }

    const responsePayload = { ticker: tickerData.slice(0, 30) };
    // Try to cache, but don't fail if Redis is down
    try {
      await redis.setex(CACHE_KEY, 30, JSON.stringify(responsePayload));
    } catch (cacheErr) {
      console.warn('[TICKER] Redis cache write failed (non-fatal):', cacheErr.message);
    }
    // Limit to 30 entries
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

module.exports = router;
