/**
 * Turn ON the emergency lockdown and clear Redis cache.
 * Run: node enable_lockdown.js
 */
const { Pool } = require('pg');
const Redis = require('ioredis');
require('dotenv').config();

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

  try {
    // 1. Turn ON the emergency lockout
    const r1 = await pool.query(
      "UPDATE global_settings SET value = 'true'::jsonb, updated_at = now() WHERE key = 'system_emergency_lockout' RETURNING *"
    );
    console.log('[DB] system_emergency_lockout set to TRUE:', r1.rows);

    // 2. Clear Redis cache so it picks up immediately
    await redis.del('system_lockdown_status');
    console.log('[REDIS] Cleared system_lockdown_status cache');

    // 3. Also clear any admin role caches so the bypass picks up fresh roles
    const keys = await redis.keys('lockdown_role:*');
    if (keys.length) {
      await redis.del(...keys);
      console.log('[REDIS] Cleared', keys.length, 'admin role caches');
    }

    // 4. Verify
    const verify = await pool.query(
      "SELECT key, value FROM global_settings WHERE key IN ('system_emergency_lockout', 'mobile_app_lockout')"
    );
    console.log('[VERIFY] Current settings:', verify.rows);

    console.log('\n✅ LOCKDOWN ENABLED! Regular users are now locked out.');
    console.log('   Super admin and maintenance admin will bypass the lock via JWT.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
    redis.disconnect();
  }
}

main();
