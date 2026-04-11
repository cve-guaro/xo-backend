const { pool } = require('../src/db/index');
const schema = `
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID REFERENCES users(id),
  action TEXT NOT NULL,
  target_id UUID,
  details JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT now()
);
`;

async function run() {
  try {
    await pool.query(schema);
    console.log('admin_audit_logs table verified/created');
    process.exit(0);
  } catch (err) {
    console.error('Error creating table:', err);
    process.exit(1);
  }
}

run();
