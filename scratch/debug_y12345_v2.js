require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function debugY12345() {
  try {
    const { rows: users } = await pool.query("SELECT id, username FROM users WHERE username = 'y12345'");
    if (users.length === 0) return;
    const uid = users[0].id;

    const { rows: wallets } = await pool.query("SELECT * FROM wallets WHERE user_id = $1", [uid]);

    const { rows: wRows } = await pool.query("SELECT tx_type as type, amount, status, created_at FROM wallet_transactions WHERE user_id = $1", [uid]);
    const { rows: bRows } = await pool.query("SELECT 'BONUS_LOG' as type, amount, created_at FROM bonus_logs WHERE user_id = $1", [uid]);
    const { rows: gBetRows } = await pool.query("SELECT 'GAME_BET' as type, bet_amount as amount, created_at FROM games WHERE (player_x = $1 OR player_o = $1)", [uid]);
    const { rows: gWinRows } = await pool.query("SELECT 'GAME_WIN' as type, (bet_amount * 1.6) as amount, finished_at as created_at FROM games WHERE winner = $1 AND status = 'completed'", [uid]);

    const allEvents = [
            ...wRows.filter(r => ['COMPLETED', 'PENDING', 'PENDING_MANUAL', 'success'].includes(r.status)).map(r => ({ ...r, amount: Number(r.amount) })),
            ...bRows.map(r => ({ ...r, amount: Number(r.amount) })),
            ...gBetRows.map(r => ({ ...r, amount: Number(r.amount) })),
            ...gWinRows.map(r => ({ ...r, amount: Number(r.amount) }))
          ];

    allEvents.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    console.log("Total Events Details:", allEvents.length);
    if(allEvents.length > 0) {
      console.log("First 5 events:", allEvents.slice(0, 5));
    }
    
    let avail = 0;
    let withdraw = 0;
    let bonus = 0;

    for (const ev of allEvents) {
      const t = String(ev.type).toUpperCase();
      const amt = Math.round(Number(ev.amount));
      
      if (t === 'DEPOSIT') {
        avail += amt;
        withdraw += amt;
      } else if (t === 'BONUS_LOG' || t === 'PRIZE' || t === 'GIFT' || t === 'BONUS') {
        avail += amt;
        bonus += amt;
      } else if (t === 'WITHDRAW_REQUEST' || t === 'WITHDRAW_SETTLED' || t === 'WITHDRAWAL') {
        avail -= amt;
        withdraw -= amt;
      } else if (t === 'GAME_BET') {
        const bonusToUse = Math.min(bonus, amt);
        const realToUse = amt - bonusToUse;
        
        avail -= amt;
        bonus -= bonusToUse;
        withdraw -= realToUse;
      } else if (t === 'GAME_WIN') {
        avail += amt;
        withdraw += amt;
      }
    }

    console.log("Calculated balances:", {avail, withdraw, bonus});
    
    let totalBonus = 0;
    for (const b of bRows) totalBonus += Number(b.amount);

    console.log("Wallet:", wallets[0]);
    console.log("Total Deposits from Tx:", totalDeposits);
    console.log("Total Withdrawals from Tx:", totalWithdraws);
    console.log("Total Bonus from Logs:", totalBonus);
    console.log("Bonus Logs Count:", bRows.length);
    console.log("First 5 Bonus Logs:", bRows.slice(0, 5));

    const { rows: games } = await pool.query(`
      SELECT 
        COUNT(*) as count, 
        SUM(bet_amount) as total_bet 
      FROM games 
      WHERE (player_x = $1 OR player_o = $1)
    `, [uid]);

    console.log("Games played:", games[0]);

  } catch (err) {
    console.error(err);
  } finally {
    await pool.end();
  }
}
debugY12345();
