const { Client } = require('pg');
require('dotenv').config();

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    console.log("--- Inspecting 'games' table columns ---");
    const colsRes = await client.query(`
      SELECT column_name, data_type, udt_name 
      FROM information_schema.columns 
      WHERE table_name = 'games'
    `);
    console.log(colsRes.rows);

    console.log("--- Testing user 360 query manually ---");
    // Get a sample user who has games
    const sampleUserRes = await client.query(`
      SELECT id FROM users LIMIT 1
    `);
    if (sampleUserRes.rows.length === 0) {
      console.log("No users found in database.");
      return;
    }
    const userId = sampleUserRes.rows[0].id;
    console.log(`Using user ID: ${userId}`);

    try {
      const statsRes = await client.query(`
        SELECT
          COUNT(*) as total_games,
          SUM(CASE WHEN winner = $1::uuid THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN winner IS NOT NULL AND winner != $1::uuid THEN 1 ELSE 0 END) as losses,
          SUM(CASE WHEN winner IS NULL AND status = 'completed' THEN 1 ELSE 0 END) as draws
        FROM games WHERE (player_x = $1::uuid OR player_o = $1::uuid) AND status = 'completed'
      `, [userId]);
      console.log("Stats Success:", statsRes.rows);
    } catch (e) {
      console.error("Stats Error:", e.message);
    }

    try {
      const gamesRes = await client.query(`
        SELECT g.id, g.player_x, g.player_o, g.winner, g.bet_amount, g.status
        FROM games g
        WHERE (g.player_x = $1::uuid OR g.player_o = $1::uuid)
        ORDER BY g.created_at DESC LIMIT 5
      `, [userId]);
      console.log("Games Success:", gamesRes.rows);
    } catch (e) {
      console.error("Games Error:", e.message);
    }

  } catch (err) {
    console.error("Outer Error:", err);
  } finally {
    await client.end();
  }
}

run();
