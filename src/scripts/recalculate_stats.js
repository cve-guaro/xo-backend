// src/scripts/recalculate_stats.js
const { pool } = require("../db/index");
require('dotenv').config();

async function run() {
  console.log("---------------------------------------------------------");
  console.log("     Starting Full Statistics Re-calculation...           ");
  console.log("---------------------------------------------------------");
  
  try {
    // 1. Reset all users to zero baseline
    console.log("[1/3] Resetting all player statistics to zero...");
    await pool.query(`
      UPDATE users SET 
        room_1_wins = 0,
        r1_10_wins = 0,
        r1_25_wins = 0,
        r1_50_wins = 0,
        r1_99_wins = 0
    `);

    // 2. Fetch all completed/relevant game records
    console.log("[2/3] Fetching match history from 'games' table...");
    const { rows: games } = await pool.query(`
      SELECT id, player_x, player_o, bet_amount, status, winner 
      FROM games 
      WHERE status NOT IN ('ongoing', 'live')
    `);
    
    console.log(`      Found ${games.length} completed matches to process.`);

    let winsCount = 0;
    let drawsCount = 0;

    for (const game of games) {
      const { player_x, player_o, status, winner, bet_amount } = game;
      const betBirr = Math.round(Number(bet_amount) / 100);

      // Handle Wins/Losses
      if (winner) {
        winsCount++;
        const winnerId = winner;

        // Room 1 achievements logic
        if ([10, 25, 50, 90, 99].includes(betBirr)) {
          let tierCol = "";
          if (betBirr === 10) tierCol = "r1_10_wins";
          else if (betBirr === 25) tierCol = "r1_25_wins";
          else if (betBirr === 50) tierCol = "r1_50_wins";
          else if (betBirr === 99 || betBirr === 90) tierCol = "r1_99_wins";

          await pool.query(`
            UPDATE users SET 
              room_1_wins = room_1_wins + 1
              ${tierCol ? `, ${tierCol} = ${tierCol} + 1` : ''} 
            WHERE id = $1
          `, [winnerId]);
        }
      } 
      // Handle Draws
      else if (!winner) {
        drawsCount++;
      }
    }

    console.log("[3/3] Finalizing updates...");
    console.log("---------------------------------------------------------");
    console.log(`TOTAL PROCESSED: ${games.length}`);
    console.log(`WINS RE-SYNCED:  ${winsCount}`);
    console.log(`DRAWS RE-SYNCED: ${drawsCount}`);
    console.log("---------------------------------------------------------");
    console.log("SUCCESS: All user statistics and matrices have been unified.");
    console.log("---------------------------------------------------------");

  } catch (err) {
    console.error("FATAL ERROR during re-calculation:", err);
  } finally {
    await pool.end();
    process.exit(0);
  }
}

run();
