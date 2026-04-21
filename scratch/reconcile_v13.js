require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 120000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('[POOL ERROR]', err.message);
});

async function reconcileV13() {
  console.log("=== V13 CHRONOLOGICAL RECONCILIATION START ===");

  const BATCH = 50;
  let offset = 0;
  let totalProcessed = 0;

  try {
    // 1. Fetch ALL users
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) AS c FROM users`);
    const totalUsers = Number(countRows[0].c);
    console.log(`Total active users to reconcile chronologically: ${totalUsers}`);

    while (offset < totalUsers) {
      const { rows: batch } = await pool.query(
        `SELECT id, username FROM users ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
        [BATCH, offset]
      );
      if (batch.length === 0) break;

      for (const u of batch) {
        const uid = u.id;
        
        try {
          // 1. Fetch wallet transactions (Deposits, Payouts, Bonuses)
          // Filter carefully: Deposits only if COMPLETED. Withdrawals if COMPLETED or PENDING (escrowed)
          const { rows: wRows } = await pool.query(`
            SELECT 
              tx_type as type, 
              amount, 
              status,
              created_at
            FROM wallet_transactions
            WHERE user_id = $1 
            ORDER BY created_at ASC
          `, [uid]);

          const validWRows = wRows.filter(r => {
            const status = String(r.status || '').toUpperCase();
            const type = String(r.type || '').toUpperCase();
            
            if (type === 'DEPOSIT') {
               return status === 'COMPLETED' || status === 'SUCCESS';
            }
            if (type === 'WITHDRAWAL' || type === 'WITHDRAW_REQUEST' || type === 'WITHDRAW_SETTLED') {
               return status === 'COMPLETED' || status === 'SUCCESS' || status === 'PENDING' || status === 'PENDING_MANUAL';
            }
            // For PRIZE or BONUS allow COMPLETED
            return status === 'COMPLETED' || status === 'SUCCESS';
          });

          // 2. Fetch bonus logs as additional inflow
          const { rows: bRows } = await pool.query(`
            SELECT 
              'BONUS_LOG' as type, 
              amount, 
              created_at 
            FROM bonus_logs 
            WHERE user_id = $1
            ORDER BY created_at ASC
          `, [uid]);

          // 3. Fetch Game bets (Outflow)
          const { rows: gBetRows } = await pool.query(`
            SELECT 
              'GAME_BET' as type, 
              bet_amount as amount, 
              created_at 
            FROM games 
            WHERE (player_x = $1 OR player_o = $1)
            ORDER BY created_at ASC
          `, [uid]);

          // 4. Fetch Game wins (Inflow)
          const { rows: gWinRows } = await pool.query(`
            SELECT 
              'GAME_WIN' as type, 
              (bet_amount * 1.6) as amount, 
              finished_at as created_at 
            FROM games 
            WHERE winner = $1 AND status = 'completed' AND finished_at IS NOT NULL
            ORDER BY finished_at ASC
          `, [uid]);

          // Combine all events
          const allEvents = [
            ...validWRows.map(r => ({ ...r, amount: Number(r.amount) })),
            ...bRows.map(r => ({ ...r, amount: Number(r.amount) })),
            ...gBetRows.map(r => ({ ...r, amount: Number(r.amount) })),
            ...gWinRows.map(r => ({ ...r, amount: Number(r.amount) }))
          ];

          // Sort strictly by chronology
          allEvents.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

          // Run timeline reconstruction
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

          // Safety floors
          avail = Math.max(0, Math.round(avail));
          withdraw = Math.max(0, Math.round(withdraw));
          bonus = Math.max(0, Math.round(bonus));

          // Hard capping logic to prevent withdrawable exceeding actual availability
          if (withdraw > avail) withdraw = avail;
          if (bonus > avail) bonus = avail;

          // Commit to Database
          await pool.query(
            `UPDATE wallets SET available_balance = $1, withdrawable_balance = $2, bonus_balance = $3 WHERE user_id = $4`,
            [avail, withdraw, bonus, uid]
          );

        } catch (userErr) {
          console.error(`  [SKIP] Error for user ${uid}: ${userErr.message}`);
        }

        totalProcessed++;
        if (totalProcessed % 50 === 0) {
           console.log(`  Processed ${totalProcessed}/${totalUsers}...`);
        }
      }
      offset += BATCH;
    }

    console.log(`=== V13 RECONCILIATION COMPLETE — ${totalProcessed} wallets updated ===`);
  } catch (err) {
    console.error("V13 Reconcile Error:", err);
  } finally {
    await pool.end();
  }
}

reconcileV13();
