// routes/leaderboard.js — Weekly leaderboard API
const express = require('express');
const router = express.Router();
const { pool } = require('../db/index');
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
      HAVING COUNT(*) >= 1
      ORDER BY wins DESC, MAX(g.created_at) ASC
      LIMIT 50
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

    // Limit to top 50
    const top50 = realList.slice(0, 50);

    // Assign ranks
    const ranked = top50.map((u, i) => ({
      id: u.id,
      username: u.username,
      avatar: u.avatar,
      wins: u.wins,
      rank: i + 1,
      isMe: u.id === userId,
    }));

    // Find current user's rank
    const meInList = ranked.find(u => u.isMe);
    let myRank = null;

    if (!meInList) {
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
    try {
      const lastSnapshotRes = await pool.query(`
        SELECT id, rank, prize_amount, week_start, week_end 
        FROM leaderboard_snapshots 
        WHERE user_id = $1 AND prize_status IN ('pending', 'approved') AND rank <= 3
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
    } catch (e) {
      console.warn('[LEADERBOARD] Error fetching last week win snapshot:', e.message);
    }

    res.json({
      leaderboard: ranked,
      myRank: meInList || myRank,
      prizes,
      weekStart: weekStart.toISOString(),
      weekEnd: weekEnd.toISOString(),
      secondsRemaining,
      previousWeekWin,
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
  try {
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

    // Limit to 30 entries
    res.json({ ticker: tickerData.slice(0, 30) });
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
      WHERE id::text = $1::text AND user_id = $2 AND prize_status IN ('pending', 'approved')
    `, [snapshotId, userId]);

    return res.json({ ok: true, claimed: rowCount > 0 });
  } catch (err) {
    console.error('[LEADERBOARD] claim error:', err);
    res.status(500).json({ error: 'Failed to claim prize' });
  }
});

module.exports = router;
