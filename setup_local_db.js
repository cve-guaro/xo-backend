/**
 * setup_local_db.js
 * 
 * This script:
 * 1. Connects to the PRODUCTION database (read-only)
 * 2. Exports the full schema (tables, types, functions, indexes)
 * 3. Copies 10 sample users with their wallets, games, and transactions
 * 4. Creates everything in the LOCAL database
 * 
 * Run: node setup_local_db.js
 */
const { Pool } = require('pg');
require('dotenv').config();

const PROD_URL = process.env.DATABASE_URL; // Current production URL
const LOCAL_URL = 'postgresql://postgres:postgres@localhost:5432/xoet_local';

async function run() {
  console.log('🔌 Connecting to PRODUCTION (read-only)...');
  const prod = new Pool({ connectionString: PROD_URL, ssl: { rejectUnauthorized: false } });

  // First, create the local database
  console.log('🏗️  Creating local database...');
  const localAdmin = new Pool({ connectionString: 'postgresql://postgres:postgres@localhost:5432/postgres' });
  
  try {
    await localAdmin.query('DROP DATABASE IF EXISTS xoet_local');
    await localAdmin.query('CREATE DATABASE xoet_local');
    console.log('✅ Database xoet_local created');
  } catch (err) {
    if (err.message.includes('already exists')) {
      console.log('ℹ️  Database xoet_local already exists, continuing...');
    } else {
      console.error('❌ Failed to create database:', err.message);
      process.exit(1);
    }
  } finally {
    await localAdmin.end();
  }

  const local = new Pool({ connectionString: LOCAL_URL });

  try {
    // ─── STEP 1: Get all custom ENUM types ───
    console.log('\n📋 Exporting ENUM types...');
    const { rows: enums } = await prod.query(`
      SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
      FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_namespace n ON t.typnamespace = n.oid
      WHERE n.nspname = 'public'
      GROUP BY t.typname
    `);

    for (const en of enums) {
      const labels = en.labels.split(',').map(l => `'${l}'`).join(', ');
      try {
        await local.query(`CREATE TYPE ${en.typname} AS ENUM (${labels})`);
        console.log(`  ✅ Type: ${en.typname}`);
      } catch (e) {
        if (e.message.includes('already exists')) {
          console.log(`  ℹ️  Type ${en.typname} already exists`);
        } else {
          console.log(`  ⚠️  Type ${en.typname}: ${e.message}`);
        }
      }
    }

    // ─── STEP 2: Get all table DDL ───
    console.log('\n📋 Exporting table structures...');
    const { rows: tables } = await prod.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    for (const t of tables) {
      const tn = t.table_name;
      // Get columns
      const { rows: cols } = await prod.query(`
        SELECT column_name, data_type, column_default, is_nullable, 
               character_maximum_length, udt_name, numeric_precision, numeric_scale
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1 
        ORDER BY ordinal_position
      `, [tn]);

      if (cols.length === 0) continue;

      const colDefs = cols.map(c => {
        let type = c.data_type;
        if (type === 'USER-DEFINED') type = c.udt_name;
        if (type === 'character varying') type = c.character_maximum_length ? `varchar(${c.character_maximum_length})` : 'text';
        if (type === 'numeric' && c.numeric_precision) type = `numeric(${c.numeric_precision},${c.numeric_scale || 0})`;
        if (type === 'ARRAY') type = c.udt_name.replace(/^_/, '') + '[]';
        if (type === 'timestamp with time zone') type = 'timestamptz';
        if (type === 'timestamp without time zone') type = 'timestamp';

        let def = '';
        if (c.column_default) {
          def = ` DEFAULT ${c.column_default}`;
        }
        const nullable = c.is_nullable === 'NO' ? ' NOT NULL' : '';
        return `  "${c.column_name}" ${type}${def}${nullable}`;
      }).join(',\n');

      const createSQL = `CREATE TABLE IF NOT EXISTS "${tn}" (\n${colDefs}\n)`;
      try {
        await local.query(createSQL);
        console.log(`  ✅ Table: ${tn} (${cols.length} columns)`);
      } catch (e) {
        console.log(`  ⚠️  Table ${tn}: ${e.message.split('\n')[0]}`);
      }
    }

    // ─── STEP 3: Get primary keys and unique constraints ───
    console.log('\n📋 Exporting constraints...');
    const { rows: constraints } = await prod.query(`
      SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
             string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.table_schema = 'public' 
        AND tc.constraint_type IN ('PRIMARY KEY', 'UNIQUE')
      GROUP BY tc.table_name, tc.constraint_name, tc.constraint_type
    `);

    for (const c of constraints) {
      const cols = c.columns.split(', ').map(col => `"${col}"`).join(', ');
      try {
        if (c.constraint_type === 'PRIMARY KEY') {
          await local.query(`ALTER TABLE "${c.table_name}" ADD PRIMARY KEY (${cols})`);
        } else {
          await local.query(`ALTER TABLE "${c.table_name}" ADD CONSTRAINT "${c.constraint_name}" UNIQUE (${cols})`);
        }
      } catch (e) {
        // Ignore if already exists
      }
    }
    console.log(`  ✅ ${constraints.length} constraints applied`);

    // ─── STEP 4: Get indexes ───
    console.log('\n📋 Exporting indexes...');
    const { rows: indexes } = await prod.query(`
      SELECT indexdef FROM pg_indexes 
      WHERE schemaname = 'public' 
        AND indexname NOT LIKE '%_pkey'
        AND indexdef NOT LIKE '%UNIQUE%'
    `);
    let idxCount = 0;
    for (const idx of indexes) {
      try {
        await local.query(idx.indexdef);
        idxCount++;
      } catch (e) { /* ignore duplicates */ }
    }
    console.log(`  ✅ ${idxCount} indexes created`);

    // ─── STEP 5: Get functions ───
    console.log('\n📋 Exporting functions...');
    const { rows: funcs } = await prod.query(`
      SELECT pg_get_functiondef(p.oid) AS funcdef
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      WHERE n.nspname = 'public'
        AND p.prokind = 'f'
    `);
    let fnCount = 0;
    for (const f of funcs) {
      try {
        await local.query(f.funcdef);
        fnCount++;
      } catch (e) {
        console.log(`  ⚠️  Function error: ${e.message.split('\n')[0]}`);
      }
    }
    console.log(`  ✅ ${fnCount} functions created`);

    // ─── STEP 6: Copy 10 sample users + their data ───
    console.log('\n📋 Copying 10 sample users from production...');
    
    // Get 10 users (mix of admins + regular users with activity)
    const { rows: users } = await prod.query(`
      (SELECT * FROM users WHERE number IN ('251961111106', '251939484533', '251995270894') LIMIT 3)
      UNION ALL
      (SELECT * FROM users WHERE role = 'user' ORDER BY created_at DESC LIMIT 7)
    `);
    
    if (users.length === 0) {
      console.log('  ⚠️  No users found in production!');
    } else {
      // Get column names from the users table
      const { rows: userCols } = await prod.query(`
        SELECT column_name FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = 'users' 
        ORDER BY ordinal_position
      `);
      const colNames = userCols.map(c => c.column_name);

      for (const user of users) {
        const vals = colNames.map((col, i) => `$${i + 1}`).join(', ');
        const colList = colNames.map(c => `"${c}"`).join(', ');
        const values = colNames.map(c => user[c]);
        try {
          await local.query(
            `INSERT INTO users (${colList}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
            values
          );
        } catch (e) {
          console.log(`  ⚠️  User ${user.username || user.number}: ${e.message.split('\n')[0]}`);
        }
      }
      console.log(`  ✅ ${users.length} users copied`);

      // Copy their wallets
      const userIds = users.map(u => u.id);
      const { rows: wallets } = await prod.query(
        `SELECT * FROM wallets WHERE user_id = ANY($1::uuid[])`, [userIds]
      );
      
      if (wallets.length > 0) {
        const { rows: walletCols } = await prod.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'wallets' 
          ORDER BY ordinal_position
        `);
        const wColNames = walletCols.map(c => c.column_name);

        for (const w of wallets) {
          const vals = wColNames.map((_, i) => `$${i + 1}`).join(', ');
          const colList = wColNames.map(c => `"${c}"`).join(', ');
          const values = wColNames.map(c => w[c]);
          try {
            await local.query(
              `INSERT INTO wallets (${colList}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
              values
            );
          } catch (e) { /* ignore */ }
        }
        console.log(`  ✅ ${wallets.length} wallets copied`);
      }

      // Copy recent games (last 20 per user, max 50 total)
      const { rows: games } = await prod.query(`
        SELECT * FROM games 
        WHERE player_x = ANY($1::uuid[]) OR player_o = ANY($1::uuid[])
        ORDER BY created_at DESC LIMIT 50
      `, [userIds]);

      if (games.length > 0) {
        const { rows: gameCols } = await prod.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'games' 
          ORDER BY ordinal_position
        `);
        const gColNames = gameCols.map(c => c.column_name);

        for (const g of games) {
          const vals = gColNames.map((_, i) => `$${i + 1}`).join(', ');
          const colList = gColNames.map(c => `"${c}"`).join(', ');
          const values = gColNames.map(c => g[c]);
          try {
            await local.query(
              `INSERT INTO games (${colList}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
              values
            );
          } catch (e) { /* ignore */ }
        }
        console.log(`  ✅ ${games.length} games copied`);
      }

      // Copy recent transactions (last 30 per user)
      const { rows: txs } = await prod.query(`
        SELECT * FROM wallet_transactions 
        WHERE user_id = ANY($1::uuid[])
        ORDER BY created_at DESC LIMIT 100
      `, [userIds]);

      if (txs.length > 0) {
        const { rows: txCols } = await prod.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = 'wallet_transactions' 
          ORDER BY ordinal_position
        `);
        const tColNames = txCols.map(c => c.column_name);

        for (const tx of txs) {
          const vals = tColNames.map((_, i) => `$${i + 1}`).join(', ');
          const colList = tColNames.map(c => `"${c}"`).join(', ');
          const values = tColNames.map(c => tx[c]);
          try {
            await local.query(
              `INSERT INTO wallet_transactions (${colList}) VALUES (${vals}) ON CONFLICT DO NOTHING`,
              values
            );
          } catch (e) { /* ignore */ }
        }
        console.log(`  ✅ ${txs.length} transactions copied`);
      }

      // Copy global_settings
      const { rows: settings } = await prod.query(`SELECT * FROM global_settings`);
      if (settings.length > 0) {
        for (const s of settings) {
          try {
            await local.query(
              `INSERT INTO global_settings (key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING`,
              [s.key, JSON.stringify(s.value)]
            );
          } catch (e) { /* ignore */ }
        }
        console.log(`  ✅ ${settings.length} global settings copied`);
      }
    }

    // ─── STEP 7: Summary ───
    console.log('\n═══════════════════════════════════════');
    console.log('✅ LOCAL DATABASE SETUP COMPLETE!');
    console.log('═══════════════════════════════════════');
    console.log(`Connection: ${LOCAL_URL}`);
    console.log('');
    console.log('Next: Update your .env file:');
    console.log('  DATABASE_URL="postgresql://postgres:postgres@localhost:5432/xoet_local"');
    console.log('');
    console.log('Then restart your backend with: npm run dev');

  } catch (err) {
    console.error('❌ Setup failed:', err);
  } finally {
    await prod.end();
    await local.end();
  }
}

run();
