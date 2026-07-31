// src/socket/spinBot.js
// ────────────────────────────────────────────────────────────────────────────
// Bot subsystem for Spin rooms — fills empty seats with fake players.
// Bots NEVER take a seat if a real player is waiting.
// Bots use realistic Ethiopian names and are invisible to users.
// ────────────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require("uuid");

const LOG_PREFIX = "[SPIN_BOT]";

const { v4: uuidv4 } = require("uuid");
const { pool } = require("../db/index");

const LOG_PREFIX = "[SPIN_BOT]";

// ── Pool of 30 gaming nicknames for bots ──
const BOT_NAMES = [
  "Xo_King", "SpinMaster", "LuckyBirr", "EthioGamer", "Nati_Pro", 
  "HabeshaWin", "Abush99", "BetMaster", "GoldSpin", "MeronX",
  "DiceKing", "FastSpin", "TopPlayer", "WinnerET", "ProGamer99",
  "SpinLord", "BetaGamer", "XO_Champ", "LuckyStar", "CashKing",
  "GameOn", "EthioSpin", "PlayHard", "SpinGeek", "NoLuck",
  "BigWinner", "SilentBet", "NightOwl", "QuickSpin", "Ace_Player"
];
const ETHIOPIAN_NAMES = BOT_NAMES;

let _dbBotCache = null;

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

async function getBot(excludeUserIds = []) {
  if (!_dbBotCache || _dbBotCache.length === 0) {
    await loadDbBots();
  }

  const poolToUse = (_dbBotCache && _dbBotCache.length > 0) ? _dbBotCache : BOT_NAMES.map(name => ({ id: uuidv4(), username: name }));
  
  // Exclude bots already in the round
  const availableBots = poolToUse.filter(b => !excludeUserIds.includes(b.id));
  const candidatePool = availableBots.length > 0 ? availableBots : poolToUse;
  const picked = candidatePool[Math.floor(Math.random() * candidatePool.length)];

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
};
