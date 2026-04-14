const { pool } = require('../src/db/index');

async function migrate() {
  console.log('--- STARTING GIVEAWAY MIGRATION ---');
  try {
    // 1. Create giveaways table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS giveaways (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        amount DECIMAL(12, 2) NOT NULL, -- in ETB
        type VARCHAR(50) NOT NULL, -- 'NEW_USER', 'PROMOCODE', 'DIRECT_SELECT'
        status VARCHAR(50) DEFAULT 'ACTIVE', -- 'INACTIVE', 'ACTIVE', 'SCHEDULED', 'EXPIRED'
        starts_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        ends_at TIMESTAMP WITH TIME ZONE, -- NULL means none
        promo_code VARCHAR(100) UNIQUE, -- ONLY for 'PROMOCODE' type
        created_by UUID,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table "giveaways" ready.');

    // 2. Create giveaway_claims table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS giveaway_claims (
        id SERIAL PRIMARY KEY,
        giveaway_id INT REFERENCES giveaways(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        amount DECIMAL(12, 2) NOT NULL,
        claimed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(giveaway_id, user_id)
      )
    `);
    console.log('✅ Table "giveaway_claims" ready.');

    // 3. Insert default 10 ETB giveaway for new users
    // First check if it exists
    const { rows } = await pool.query("SELECT id FROM giveaways WHERE type = 'NEW_USER' AND status = 'ACTIVE' LIMIT 1");
    if (rows.length === 0) {
      await pool.query(`
        INSERT INTO giveaways (title, description, amount, type, status)
        VALUES (
          'Welcome Gift',
          'Automatic 10 ETB gift for all new players who join the platform.',
          10.00,
          'NEW_USER',
          'ACTIVE'
        )
      `);
      console.log('✅ Seeded default Welcome Gift giveaway.');
    } else {
      console.log('ℹ️ Default Welcome Gift already exists.');
    }

    console.log('--- MIGRATION COMPLETED SUCCESSFULLY ---');
  } catch (err) {
    console.error('❌ Migration failed:', err);
  } finally {
    await pool.end();
  }
}

migrate();
