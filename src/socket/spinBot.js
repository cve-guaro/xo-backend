// src/socket/spinBot.js
// ────────────────────────────────────────────────────────────────────────────
// Dynamic Bot Subsystem for Spin Rooms — fills empty seats with fake players.
// Bots NEVER take a seat if a real player is waiting.
// Bots use realistic Ethiopian names and are invisible to users.
// ────────────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/index");

const LOG_PREFIX = "[SPIN_BOT]";

// ── Realistic Ethiopian First Name Fragments ──
const ETHIOPIAN_FIRST_NAMES = [
  "Yonas", "Selam", "Nardos", "Biniam", "Kaleb", "Hana", "Mekdes", "Dawit", 
  "Fitsum", "Rediet", "Samri", "Nahom", "Betty", "Meklit", "Robel", "Sara", 
  "Yohannes", "Liya", "Abel", "Mimi", "Naod", "Bethel", "Hermon", "Tsion", 
  "Sami", "Kidus", "Feven", "Elias", "Natnael", "Rahel", "Dagim", "Samuel", 
  "Winta", "Amanuel", "Kenean", "Estifanos", "Tsehay", "Helen", "Daniel", 
  "Kebede", "Biniyam", "Nebiyu", "Abiy", "Tegene", "Genet", "Mesfin", "Eyob", 
  "Biruk", "Bruk", "Tewodros", "Alem", "Solomon", "Yared", "Eleni", "Beza", 
  "Henok", "Getnet", "Abebe", "Zewdu", "Ashenafi", "Mulugeta", "Fikru", 
  "Girma", "Tadesse", "Haile", "Gashaw", "Kassahun"
];

// Casual full username patterns (first names, initials, casual numbers, plainness)
const CASUAL_STANDALONE_USERNAMES = [
  "Yonas14", "Selam_B", "Nardos22", "Biniam_M", "Kaleb01", "Hana_G", "Mekdes7", 
  "Dawit_A", "Fitsum99", "Rediet_N", "Samri23", "Nahom_T", "Betty_44", "Meklit_S", 
  "Robel19", "Sara_K", "Yohannes5", "Liya_B", "Abel_D", "Mimi_23", "Naod88", 
  "Bethel_G", "Hermon12", "Tsion_A", "Sami_45", "Kidus07", "Feven_M", "Elias_K", 
  "Natnael9", "Rahel22", "Dagim_T", "Samuel04", "Winta_B", "Amanuel7", 
  "player123", "newuser5", "guest22", "justme_1", "newplyer", "sosos", "abi1234", "neba143"
];

const INITIAL_LETTERS = ["A", "B", "C", "D", "E", "G", "H", "K", "L", "M", "N", "R", "S", "T", "W", "Y", "Z"];

const BOT_NAMES = CASUAL_STANDALONE_USERNAMES;
const ETHIOPIAN_NAMES = BOT_NAMES;

let _dbBotCache = null;

/**
 * Generates a realistic Ethiopian username dynamically without competitive-gamer branding.
 */
function generateCandidateUsername() {
  const randType = Math.random();
  
  // 30% chance: pick from casual standalone list
  if (randType < 0.3) {
    const picked = CASUAL_STANDALONE_USERNAMES[Math.floor(Math.random() * CASUAL_STANDALONE_USERNAMES.length)];
    const numAdd = Math.floor(Math.random() * 90) + 10;
    return `${picked}${Math.random() > 0.5 ? numAdd : ''}`;
  }
  
  const firstName = ETHIOPIAN_FIRST_NAMES[Math.floor(Math.random() * ETHIOPIAN_FIRST_NAMES.length)];
  
  // 40% chance: Firstname + 1-3 digit casual number (e.g. Yonas14, Dawit99, Hanna07)
  if (randType < 0.7) {
    const num = Math.floor(Math.random() * 900) + 1;
    const padNum = num < 10 ? `0${num}` : `${num}`;
    return `${firstName}${padNum}`;
  }
  
  // 20% chance: Firstname + underscore + initial (e.g. Selam_B, Biniam_M)
  if (randType < 0.9) {
    const letter = INITIAL_LETTERS[Math.floor(Math.random() * INITIAL_LETTERS.length)];
    return `${firstName}_${letter}`;
  }
  
  // 10% chance: Firstname + underscore + 2-digit number (e.g. Samri_23, Mimi_44)
  const num = Math.floor(Math.random() * 90) + 10;
  return `${firstName}_${num}`;
}

async function loadDbBots() {
  try {
    const { rows } = await pool.query(`SELECT id::text, username FROM users WHERE is_bot = true ORDER BY username ASC`);
    if (rows.length > 0) {
      _dbBotCache = rows;
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to load DB bots:`, err.message);
  }
}

/**
 * Creates and saves a new unique bot in the DB with uniqueness collision check.
 */
async function createNewUniqueBot(excludeUsernames = []) {
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidateName = generateCandidateUsername();
    
    // Check local exclude list
    if (excludeUsernames.includes(candidateName.toLowerCase())) {
      continue;
    }
    
    // Uniqueness check against DB (both real users and active bots)
    const checkRes = await pool.query(`SELECT id FROM users WHERE LOWER(username) = LOWER($1) LIMIT 1`, [candidateName]);
    if (checkRes.rows.length > 0) {
      continue;
    }
    
    // Insert unique bot into DB
    const botNum = `BOT_${candidateName}`;
    const insertRes = await pool.query(
      `INSERT INTO users (username, number, is_bot)
       VALUES ($1, $2, true)
       ON CONFLICT (username) DO UPDATE SET is_bot = true
       RETURNING id::text, username`,
      [candidateName, botNum]
    );
    
    const botId = insertRes.rows[0]?.id;
    if (botId) {
      await pool.query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [botId]);
      const newBot = { id: botId, username: candidateName };
      
      // Update cache
      if (_dbBotCache) {
        _dbBotCache.push(newBot);
      }
      return newBot;
    }
  }
  
  // Fallback if collision limit reached
  const fallbackName = `Player_${Math.floor(Math.random() * 8999) + 1000}`;
  const fallbackRes = await pool.query(
    `INSERT INTO users (username, number, is_bot) VALUES ($1, $2, true) ON CONFLICT (username) DO UPDATE SET is_bot = true RETURNING id::text, username`,
    [fallbackName, `BOT_${fallbackName}`]
  );
  return { id: fallbackRes.rows[0]?.id || uuidv4(), username: fallbackName };
}

async function getBot(excludeUserIds = []) {
  if (!_dbBotCache || _dbBotCache.length === 0) {
    await loadDbBots();
  }

  // Exclude bots already in the active room round
  const availableBots = (_dbBotCache || []).filter(b => !excludeUserIds.includes(b.id));
  
  let picked;
  if (availableBots.length > 0 && Math.random() > 0.3) {
    // Pick from existing DB bot pool (70% probability if available)
    picked = availableBots[Math.floor(Math.random() * availableBots.length)];
  } else {
    // Dynamically generate a brand-new unique bot
    const existingNames = (_dbBotCache || []).map(b => (b.username || '').toLowerCase());
    picked = await createNewUniqueBot(existingNames);
  }

  return {
    id: picked.id || uuidv4(),
    username: picked.username,
    isBot: true,
    avatar: null,
  };
}

// ── Bot fill scheduler ─────────────────────────────────────────────────────
// Schedules bots to join a room at staggered intervals.
// `onBotJoin(bot)` is called for each bot that should join.
// Returns a cancel function to abort pending bot joins.
function scheduleBotFill({ maxBots, currentPlayerCount, maxPlayers, onBotJoin, minDelayMs = 3000, maxDelayMs = 8000, staggerDelaysMs = null }) {
  const botsNeeded = Math.min(maxBots, maxPlayers - currentPlayerCount);
  if (botsNeeded <= 0) return () => {};

  const timers = [];
  let cancelled = false;

  for (let i = 0; i < botsNeeded; i++) {
    let totalDelay;
    if (Array.isArray(staggerDelaysMs) && staggerDelaysMs[i] !== undefined) {
      totalDelay = staggerDelaysMs[i];
    } else {
      const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
      totalDelay = delay * (i + 1); // stagger: each bot waits progressively longer
    }

    const timer = setTimeout(async () => {
      if (cancelled) return;
      const bot = await getBot();
      console.log(`${LOG_PREFIX} Bot joining: ${bot.username} (delay=${Math.round(totalDelay)}ms)`);
      await onBotJoin(bot);
    }, totalDelay);

    timers.push(timer);
  }

  // Return cancel function
  return () => {
    cancelled = true;
    timers.forEach(t => clearTimeout(t));
  };
}

module.exports = {
  getBot,
  scheduleBotFill,
  ETHIOPIAN_NAMES,
  BOT_NAMES,
  generateCandidateUsername,
};
