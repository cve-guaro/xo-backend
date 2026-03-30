const { Client } = require('pg');
require('dotenv').config();

const client = new Client({ 
  connectionString: process.env.DATABASE_URL, 
  ssl: { rejectUnauthorized: false } 
});

async function cols(tableName) {
  const res = await client.query(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
    [tableName]
  );
  console.log(`\n--- ${tableName.toUpperCase()} TABLE ---`);
  if (!res.rows.length) console.log('  ⚠️  TABLE NOT FOUND');
  else console.log('  ' + res.rows.map(r => `${r.column_name} (${r.data_type})`).join('\n  '));
}

async function checkDB() {
  await client.connect();

  await cols('users');
  await cols('wallets');
  await cols('payment_transactions');
  await cols('global_settings');
  await cols('admin_audit_logs');
  await cols('games');

  console.log('\n--- GLOBAL_SETTINGS VALUES ---');
  try {
    const res = await client.query("SELECT key, value FROM global_settings");
    if (!res.rows.length) console.log('  (empty)');
    else res.rows.forEach(r => console.log(`  ${r.key} = ${JSON.stringify(r.value)}`));
  } catch(e) { console.log('  ERROR:', e.message); }

  console.log('\n--- SAMPLE TRANSACTIONS (5) ---');
  try {
    const res = await client.query("SELECT id, type, status, amount, tx_ref, provider_ref, created_at FROM payment_transactions ORDER BY created_at DESC LIMIT 5");
    if (!res.rows.length) console.log('  (no transactions)');
    else res.rows.forEach(r => console.log(`  [${r.type}] ${r.status} | ${r.amount} cents | tx_ref=${r.tx_ref} | provider_ref=${r.provider_ref}`));
  } catch(e) { console.log('  ERROR:', e.message); }

  console.log('\n--- RECENT AUDIT LOGS (5) ---');
  try {
    const res = await client.query("SELECT action, target_id, created_at FROM admin_audit_logs ORDER BY created_at DESC LIMIT 5");
    if (!res.rows.length) console.log('  (no audit logs yet — run the migration first!)');
    else res.rows.forEach(r => console.log(`  [${r.action}] target=${r.target_id} at=${r.created_at}`));
  } catch(e) { console.log('  ERROR:', e.message); }

  await client.end();
  console.log('\n✅ Schema check complete.');
}

checkDB().catch(console.error);
