
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function findMatch() {
  try {
    const id = '8354ba37-976b-4f81-b353-eb5df77fe248';
    console.log('Searching for wallet tx:', id);
    
    const { rows: wt } = await pool.query("SELECT * FROM wallet_transactions WHERE id = $1", [id]);
    if (wt.length === 0) { console.log('Not found'); return; }
    
    const tx = wt[0];
    console.log('Wallet Tx Details:', {
        userId: tx.user_id,
        amount: tx.amount,
        createdAt: tx.created_at,
        idem: tx.idempotency_key
    });

    // Try to find in transactions table by user_id and approximate time
    const { rows: t } = await pool.query(
        "SELECT id, provider_ext_id, metadata, created_at FROM transactions WHERE user_id = $1 AND amount_minor = $2 ORDER BY ABS(EXTRACT(EPOCH FROM (created_at - $3::timestamp))) LIMIT 5",
        [tx.user_id, Math.round(tx.amount * 100), tx.created_at]
    );
    
    console.log('Potential matches in transactions table:', t.length);
    t.forEach(m => {
        console.log('---');
        console.log('Match ID:', m.id);
        console.log('Provider Ext ID:', m.provider_ext_id);
        console.log('Time Diff (s):', Math.abs(new Date(m.created_at) - new Date(tx.created_at))/1000);
    });
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

findMatch();
