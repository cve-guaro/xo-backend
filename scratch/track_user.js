require('dotenv').config();
const { pool } = require('../src/db/index');

async function trackUser(username) {
  try {
    const { rows: uRows } = await pool.query(`SELECT id, username, number FROM users WHERE username = $1 OR number = $1`, [username]);
    if (uRows.length === 0) return console.log("User not found");
    const uid = uRows[0].id;
    console.log(`Tracking math for ${uRows[0].username} (${uid})...`);

    const { rows: inflowRows } = await pool.query(`
      SELECT 
        COALESCE(SUM(CASE WHEN tx_type = 'DEPOSIT' AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) AS deposits,
        COALESCE(SUM(CASE WHEN tx_type IN ('GIFT','BONUS','ADMIN_EDIT','ADJUSTMENT','REFUND') AND status = 'COMPLETED' THEN amount ELSE 0 END), 0) AS gifts
      FROM wallet_transactions WHERE user_id = $1
    `, [uid]);

    const { rows: outflowRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS withdrawals
      FROM wallet_transactions 
      WHERE user_id = $1 
        AND tx_type IN ('WITHDRAW_SETTLED', 'WITHDRAW_REQUEST') 
        AND status IN ('COMPLETED', 'PENDING', 'PENDING_MANUAL')
    `, [uid]);

    const { rows: bonusRows } = await pool.query(`
      SELECT COALESCE(SUM(amount), 0) AS bonus_total FROM bonus_logs WHERE user_id = $1
    `, [uid]);

    const { rows: winRows } = await pool.query(`
      SELECT COALESCE(SUM(bet_amount * 1.6), 0) AS game_wins
      FROM games WHERE winner = $1 AND status = 'completed'
    `, [uid]);

    const { rows: betRows } = await pool.query(`
      SELECT COALESCE(SUM(bet_amount), 0) AS game_bets
      FROM games 
      WHERE (player_x = $1 OR player_o = $1) 
        AND status IN ('completed', 'ongoing', 'abandoned')
    `, [uid]);

    const { rows: wRows } = await pool.query(`SELECT * FROM wallets WHERE user_id = $1`, [uid]);
    const wallet = wRows[0] || { available_balance: 0, withdrawable_balance: 0, bonus_balance: 0 };

    console.log(`\n--- DB LEDGER HISTORY ---`);
    console.log(`Deposits  (+): ${inflowRows[0].deposits}`);
    console.log(`Gifts     (+): ${inflowRows[0].gifts}`);
    console.log(`BonusLogs (+): ${bonusRows[0].bonus_total}`);
    console.log(`GameWins  (+): ${winRows[0].game_wins}`);
    
    console.log(`Withdraws (-): ${outflowRows[0].withdrawals}`);
    console.log(`GameBets  (-): ${betRows[0].game_bets}`);

    const totalIn = Number(inflowRows[0].deposits) + Number(inflowRows[0].gifts) + Number(bonusRows[0].bonus_total) + Number(winRows[0].game_wins);
    const totalOut = Number(outflowRows[0].withdrawals) + Number(betRows[0].game_bets);
    
    const trueAvailable = Math.max(0, totalIn - totalOut);
    const trueWithdrawable = Math.max(0, trueAvailable - Number(wallet.bonus_balance));

    console.log(`\n--- MATH CALCULATION ---`);
    console.log(`Total IN:  ${totalIn}`);
    console.log(`Total OUT: ${totalOut}`);
    console.log(`True Available (IN - OUT): ${trueAvailable}`);
    console.log(`True Withdrawable (Avail - Bonus[${wallet.bonus_balance}]): ${trueWithdrawable}`);

    console.log(`\n--- CURRENT DB ROWS ---`);
    console.log(`available: ${wallet.available_balance}`);
    console.log(`withdrawable: ${wallet.withdrawable_balance}`);
    
    // Auto-fix
    await pool.query(`UPDATE wallets SET available_balance = $1, withdrawable_balance = $2 WHERE user_id = $3`, [trueAvailable, trueWithdrawable, uid]);
    console.log(`\n=> Repaired DB to True Values.`);
  } catch(e) {
    console.error(e);
  } finally {
    process.exit(0);
  }
}

trackUser(process.argv[2] || 'Simon');
