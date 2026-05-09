const { Pool } = require('pg');
async function run() {
  const p = new Pool({connectionString: 'postgresql://postgres:postgres@localhost:5432/xoet_local'});
  try {
    const r = await p.query(`
      UPDATE wallet_transactions 
      SET status = 'FAILED', updated_at = now(),
          meta = COALESCE(meta, '{}'::jsonb) || '{"failed_reason": "Manual cleanup — user cancelled or abandoned"}'::jsonb
      WHERE tx_type = 'DEPOSIT' AND status = 'PENDING' 
        AND created_at < now() - interval '5 minutes'
    `);
    console.log('Cleaned up', r.rowCount, 'stuck pending deposits');
  } catch(e) { console.log(e.message); }
  finally { await p.end(); }
}
run();
