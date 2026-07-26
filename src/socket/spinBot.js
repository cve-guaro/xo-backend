// src/socket/spinBot.js
// ────────────────────────────────────────────────────────────────────────────
// Bot subsystem for Spin rooms — fills empty seats with fake players.
// Bots NEVER take a seat if a real player is waiting.
// Bots use realistic Ethiopian names and are invisible to users.
// ────────────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require("uuid");

const LOG_PREFIX = "[SPIN_BOT]";

// ── Pre-generated pool of 40 natural Ethiopian usernames (no underscores/fake titles) ──
const BOT_NAMES = [
  "Abebe", "Almaz", "Bekele", "Dawit", "Eyob",
  "Fikru", "Genet", "Helen", "Ibrahim", "Jemila",
  "Kidus", "Liya", "Meron", "Natnael", "Petros",
  "Rahel", "Samuel", "Tigist", "Yared", "Zeritu",
  "Selam", "Tewodros", "Biniyam", "Kalkidan", "Robel",
  "Martha", "Daniel", "Ermias", "Tsehay", "Hana",
  "Sami", "Aman", "Miki", "Yohannes", "Aster",
  "Birtukan", "Fitsum", "Girma", "Haile", "Kassa"
];
const ETHIOPIAN_NAMES = BOT_NAMES;

// Each bot gets a stable UUID so we can track them in logs
const _botCache = new Map(); // name → { id, username }

function getBot() {
  // Pick a random name from the pool
  const name = ETHIOPIAN_NAMES[Math.floor(Math.random() * ETHIOPIAN_NAMES.length)];

  if (!_botCache.has(name)) {
    _botCache.set(name, {
      id: uuidv4(),
      username: name,
      isBot: true,
      avatar: null,
    });
  }

  // Return a fresh copy with a unique ID per instance (so same name can appear in different rooms)
  return {
    id: uuidv4(), // unique per room join
    username: name,
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

    const timer = setTimeout(() => {
      if (cancelled) return;
      const bot = getBot();
      console.log(`${LOG_PREFIX} Bot joining: ${bot.username} (delay=${Math.round(totalDelay)}ms)`);
      onBotJoin(bot);
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
