
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function globalSearch() {
  try {
    const term = '89136b-5efc-4d8a-adc7-714521ed837';
    console.log('Searching for term:', term);

    const tables = ['transactions', 'wallet_transactions', 'wallets', 'users'];
    for (const table of tables) {
        const { rows: cols } = await pool.query(
            "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
            [table]
        );
        
        for (const col of cols) {
            if (col.data_type.includes('char') || col.data_type.includes('text') || col.data_type.includes('uuid')) {
                const q = `SELECT * FROM ${table} WHERE "${col.column_name}"::text LIKE $1 LIMIT 1`;
                const { rows } = await pool.query(q, [`%${term}%`]);
                if (rows.length > 0) {
                    console.log(`Found in table ${table}, column ${col.column_name}`);
                    console.log(JSON.stringify(rows[0], null, 2));
                    return;
                }
            }
        }
    }
    console.log('Not found in any table.');
  } catch (err) {
    console.error('Error:', err);
  } finally {
    await pool.end();
  }
}

globalSearch();
