const { Pool } = require('pg');
// Session-mode pooler (port 5432) instead of transaction-mode (6543)
const connectionString = 'postgresql://postgres.szfphzuygiabvxtxemiy:AsXBK4Pk0jirSODb@aws-1-eu-west-1.pooler.supabase.com:5432/postgres';
console.log('Connecting to production DB (session pooler, port 5432)...');
const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
pool.query(`
  SELECT column_name, data_type 
  FROM information_schema.columns 
  WHERE table_name = 'promo_popups'
  ORDER BY ordinal_position;
`).then(res => {
  console.log('Columns in promo_popups:');
  console.log(res.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
}).catch(err => {
  console.error('Error querying columns:', err.message);
}).finally(() => {
  pool.end();
  process.exit();
});
