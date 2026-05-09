const { Client } = require('pg');
require('dotenv').config();

async function checkUser() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  
  try {
    const res = await client.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'users'");
    console.log("User Columns:", res.rows.map(r => r.column_name));
    
    const userRes = await client.query("SELECT * FROM users WHERE username ILIKE '%Zats%'");
    console.log("Users:", userRes.rows);
    
    if (userRes.rows.length > 0) {
      const userId = userRes.rows[0].id;
      const txRes = await client.query("SELECT id, amount, type, status, created_at, reference FROM transactions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5", [userId]);
      console.log("Transactions:", txRes.rows);
      
      const gameRes = await client.query("SELECT COUNT(*) FROM matches WHERE player1_id = $1 OR player2_id = $1", [userId]);
      console.log("Total Games in Matches table:", gameRes.rows[0].count);
    }
  } catch (err) {
    console.error(err);
  } finally {
    await client.end();
  }
}

checkUser();
