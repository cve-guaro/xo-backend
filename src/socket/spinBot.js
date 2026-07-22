// src/socket/spinBot.js
// ────────────────────────────────────────────────────────────────────────────
// Bot subsystem for Spin rooms — fills empty seats with fake players.
// Bots NEVER take a seat if a real player is waiting.
// Bots use realistic Ethiopian names and are invisible to users.
// ────────────────────────────────────────────────────────────────────────────
const { v4: uuidv4 } = require("uuid");

const LOG_PREFIX = "[SPIN_BOT]";

// ── Pre-generated pool of Ethiopian-sounding names ─────────────────────────
const ETHIOPIAN_NAMES = [
  "Abebe_Pro", "Almaz_Star", "Bekele_XO", "Dawit_Champ", "Eyob_Play",
  "Fikru_Top", "Genet_ET", "Helen_Pro", "Ibrahim_XO", "Jemila_Star",
  "Kidus_Hero", "Liya_Champ", "Meron_Top", "Natnael_Pro", "Omega_Play",
  "Petros_XO", "Rahel_Star", "Samuel_Hero", "Tigist_Champ", "Yared_Top",
  "Zeritu_Pro", "Abnet_XO", "Beza_Star", "Chala_Hero", "Desta_Champ",
  "Elias_Play", "Feven_Pro", "Girmay_XO", "Hana_Star", "Iyasu_Hero",
  "Jalene_Top", "Kebede_Pro", "Lidya_XO", "Meseret_Star", "Nebil_Hero",
  "Omer_Champ", "Paulos_Play", "Ruth_Pro", "Selam_XO", "Tsion_Star",
  "Urael_Hero", "Winta_Champ", "Yonas_Top", "Zara_Pro", "Alem_XO",
  "Berhan_Star", "Dagne_Hero", "Eskinder_Champ", "Frezer_Play", "Haben_Pro",
];

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
function scheduleBotFill({ maxBots, currentPlayerCount, maxPlayers, onBotJoin, minDelayMs = 3000, maxDelayMs = 8000 }) {
  const botsNeeded = Math.min(maxBots, maxPlayers - currentPlayerCount);
  if (botsNeeded <= 0) return () => {};

  const timers = [];
  let cancelled = false;

  for (let i = 0; i < botsNeeded; i++) {
    const delay = minDelayMs + Math.random() * (maxDelayMs - minDelayMs);
    const totalDelay = delay * (i + 1); // stagger: each bot waits progressively longer

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
};
