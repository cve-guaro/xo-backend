// export_users_template.js
// Run this file locally using: node export_users_template.js [DATABASE_URL]
// e.g. node export_users_template.js "postgresql://username:password@host:port/database"
// It will query the users table and export phone numbers formatted to 251... to user_phone_list.txt.

const fs = require('fs');
const { Pool } = require('pg');

async function exportUserPhones() {
  // Use connection string from CLI argument, default to DATABASE_URL in environment if not provided
  let connectionString = process.argv[2] || process.env.DATABASE_URL;

  if (!connectionString) {
    console.error('Error: No connection string provided.');
    console.error('Usage: node export_users_template.js "your-postgresql-connection-string"');
    process.exit(1);
  }

  // Parse connection string to log details safely without password
  try {
    const url = new URL(connectionString.replace('postgresql://', 'http://'));
    console.log(`Connecting to database host: ${url.host}, database: ${url.pathname.substring(1)}`);
  } catch (e) {
    console.log('Connecting to database...');
  }

  // Configure pool. SSL config is usually required for hosted platforms like Supabase.
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  try {
    const query = `
      SELECT DISTINCT
        CASE 
          WHEN number LIKE '09%' THEN '251' || SUBSTRING(number FROM 2)
          WHEN number LIKE '07%' THEN '251' || SUBSTRING(number FROM 2)
          WHEN number LIKE '+251%' THEN SUBSTRING(number FROM 2)
          WHEN number LIKE '251%' THEN number
          ELSE '251' || number
        END AS phone_number
      FROM users 
      WHERE number IS NOT NULL;
    `;
    
    const { rows } = await pool.query(query);
    console.log(`Successfully fetched ${rows.length} records.`);
    
    const numbersList = rows.map(r => r.phone_number).filter(Boolean).join('\n');
    
    fs.writeFileSync('user_phone_list.txt', numbersList, 'utf8');
    console.log('Successfully wrote formatted phone numbers to local file: user_phone_list.txt');
  } catch (error) {
    console.error('Error exporting phone numbers:', error);
  } finally {
    await pool.end();
  }
}

exportUserPhones();
