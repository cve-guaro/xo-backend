const { Pool } = require('pg');
const pool = new Pool({ connectionString: 'postgresql://postgres.szfphzuygiabvxtxemiy:r9Zn*Cw6%40tNg2Jx@aws-1-eu-west-1.pooler.supabase.com:5432/postgres' });
async function run() {
  try {
    const res = await pool.query(`SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'wallet_tx_status';`);
    console.log(res.rows);
    process.exit(0);
  } catch (e) {
    console.log(e);
    process.exit(1);
  }
}
run();
