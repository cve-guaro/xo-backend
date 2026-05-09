require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 30000
});

const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY || process.env.CHAPA_PAYOUT_SECRET;

async function checkChapaStatus(txId) {
  try {
    const response = await fetch(`https://api.chapa.co/v1/transfers/verify/${txId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${CHAPA_SECRET_KEY}`
      }
    });
    const data = await response.json();
    return data;
  } catch (err) {
    return { status: 'error', message: err.message };
  }
}

async function crossCheck() {
  if (!CHAPA_SECRET_KEY) {
    console.error("No Chapa Secret Key found in environment variables.");
    process.exit(1);
  }

  console.log("Fetching withdrawals from April 25 to 27...");

  try {
    const { rows } = await pool.query(`
      SELECT t.id, t.user_id, u.username, t.amount, t.status as db_status, t.created_at
      FROM wallet_transactions t
      JOIN users u ON t.user_id = u.id
      WHERE t.tx_type = 'WITHDRAW_REQUEST' 
      AND t.created_at >= '2026-04-25' 
      AND t.created_at < '2026-04-28'
      ORDER BY t.created_at DESC
    `);

    console.log(`Found ${rows.length} withdrawal requests in this time range.\n`);
    console.log("Cross-checking with Chapa API...\n");

    const mismatches = [];
    const matched = [];

    for (const row of rows) {
      const chapaData = await checkChapaStatus(row.id);
      
      let chapaStatus = 'unknown';
      if (chapaData.status === 'success' && chapaData.data) {
        chapaStatus = chapaData.data.status; // 'success', 'failed', 'pending'
      } else if (chapaData.status === 'failed') {
          // If the verify endpoint fails, it might mean the transfer was never created on Chapa, 
          // or we used the wrong reference.
          chapaStatus = 'not_found_on_chapa';
      }

      // Normalize statuses for comparison
      // Chapa 'success' -> DB 'COMPLETED'
      // Chapa 'failed', 'cancelled', 'failed/cancelled' -> DB 'FAILED'
      // Chapa 'pending', 'processing' -> DB 'PENDING'
      
      let expectedDbStatus = '';
      if (['success'].includes(chapaStatus)) expectedDbStatus = 'COMPLETED';
      else if (['failed', 'cancelled', 'failed/cancelled', 'rejected'].includes(chapaStatus)) expectedDbStatus = 'FAILED';
      else if (['pending', 'processing'].includes(chapaStatus)) expectedDbStatus = 'PENDING';
      else expectedDbStatus = 'UNKNOWN';

      const result = {
        tx_id: row.id.substring(0,8)+'...',
        user: row.username,
        amount: row.amount,
        db_status: row.db_status,
        chapa_status: chapaStatus,
        date: row.created_at.toISOString().slice(0, 16)
      };

      // Check for dangerous mismatch: DB says COMPLETED but Chapa says FAILED
      if (row.db_status === 'COMPLETED' && ['failed', 'cancelled', 'failed/cancelled'].includes(chapaStatus)) {
          mismatches.push(result);
      } else {
          matched.push(result);
      }
      
      // Delay to avoid rate limiting
      await new Promise(res => setTimeout(res, 300));
    }

    console.log(`\n=== 🚨 CRITICAL MISMATCHES (DB = COMPLETED, Chapa = FAILED) ===`);
    console.log(`Total: ${mismatches.length}`);
    if (mismatches.length > 0) {
      console.table(mismatches);
    } else {
      console.log("No critical mismatches found! If DB says COMPLETED, Chapa says success.");
    }

    console.log(`\n=== ALL OTHER TRANSACTIONS (Matched or Expected) ===`);
    console.log(`Total: ${matched.length}`);
    if (matched.length > 0) {
      console.table(matched);
    }

  } catch (e) {
    console.error("Database error:", e);
  } finally {
    await pool.end();
  }
}

crossCheck();
