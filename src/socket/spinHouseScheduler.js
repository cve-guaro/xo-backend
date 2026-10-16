// src/socket/spinHouseScheduler.js
// ────────────────────────────────────────────────────────────────────────────
// 4-Window House Bot Scheduler for Real Spin (Rail Mode)
//
// Timer: runs from 2:00 down to 0:00 (120 seconds countdown).
//
// 4 Windows:
// - Window 1: 1:59 to 1:30  (1s to 30s elapsed)
// - Window 2: 1:29 to 1:00  (31s to 60s elapsed)
// - Window 3: 0:59 to 0:30  (61s to 90s elapsed)
// - Window 4: 0:29 to 0:02  (91s to 118s elapsed)
// - Lock:     0:00          (120s elapsed -> wheel spins)
//
// Logic:
// 1. Real players always take priority.
// 2. Each window schedules at most one bot at a random second (crypto.randomInt).
// 3. Bot only enters if at least one real player is present in the room.
// 4. If another real user joins during the window before the bot's scheduled time,
//    that window's bot is cancelled/skipped.
// 5. If the lone real player leaves before lock, round is cancelled and bots cleared.
// ────────────────────────────────────────────────────────────────────────────
const crypto = require("crypto");

const WINDOW_BOUNDS = [
  { window: 1, min: 1, max: 30 },
  { window: 2, min: 31, max: 60 },
  { window: 3, min: 61, max: 90 },
  { window: 4, min: 91, max: 118 },
];

function getWindowForSecond(sec) {
  for (const b of WINDOW_BOUNDS) {
    if (sec >= b.min && sec <= b.max) return b.window;
  }
  return null;
}

function createRealHouseScheduler(round, options = {}) {
  const { mockSeconds, onBotSpawn, onRoundCancel, logger = console } = options;

  let cancelled = false;
  let elapsedSeconds = 0;

  // Plan 4 windows
  const plan = WINDOW_BOUNDS.map((b, idx) => {
    let sec;
    if (mockSeconds && mockSeconds[idx] !== undefined) {
      sec = mockSeconds[idx];
    } else {
      sec = crypto.randomInt(b.min, b.max + 1);
    }
    return {
      window: b.window,
      second: sec,
      fired: false,
      cancelled: false,
      cancelReason: null,
    };
  });

  function getPlan() {
    return plan.map(p => ({ ...p }));
  }

  function isCancelled() {
    return cancelled;
  }

  function cancelAll(reason = "cancelled") {
    cancelled = true;
    for (const p of plan) {
      if (!p.fired) {
        p.cancelled = true;
        p.cancelReason = reason;
      }
    }
  }

  function onPlayerJoined(player) {
    if (cancelled || round.status !== "waiting") return;

    if (!player.isBot) {
      if (!round.players.some(p => p.userId === player.userId)) {
        player.seatIndex = round.players.length;
        round.players.push(player);
      }

      // Check real players count. Only cancel the current window's bot if MORE THAN ONE
      // real player is now in the room (i.e. another real user joined before the bot's second).
      // A lone real user should NEVER cancel the bot; the bot is needed as their opponent!
      const realUsers = round.players.filter(p => !p.isBot);
      if (realUsers.length > 1) {
        const currentWindow = getWindowForSecond(elapsedSeconds);
        if (currentWindow) {
          const item = plan.find(p => p.window === currentWindow);
          if (item && !item.fired && elapsedSeconds < item.second) {
            item.cancelled = true;
            item.cancelReason = "real_joined_before_bot_second";
          }
        }
      }
    } else {
      if (!round.players.some(p => p.userId === player.userId)) {
        player.seatIndex = round.players.length;
        round.players.push(player);
      }
    }
  }

  function onPlayerLeft({ userId }) {
    if (cancelled) return;

    const idx = round.players.findIndex(p => p.userId === userId);
    if (idx !== -1) {
      round.players.splice(idx, 1);
      round.players.forEach((p, i) => { p.seatIndex = i; });
    }

    const remainingReal = round.players.filter(p => !p.isBot);
    if (remainingReal.length === 0) {
      cancelAll("last_real_left");
      round.status = "cancelled";
      round.players = [];
      if (onRoundCancel) onRoundCancel("last_real_left");
    }
  }

  function tickSecond(currentSecond) {
    elapsedSeconds = currentSecond;
    if (cancelled || round.status !== "waiting") return;

    const realUsers = round.players.filter(p => !p.isBot);

    for (const item of plan) {
      if (item.second === currentSecond && !item.fired && !item.cancelled) {
        if (realUsers.length >= 1) {
          item.fired = true;
          const botStake = 10 + Math.floor(Math.random() * 6) * 5; // 10, 15, 20, 25, 30, 35 ETB
          const botId = `bot_rail_${round.id}_w${item.window}_${Date.now()}`;
          const botUsername = `XO_Player_${item.window}`;

          const botPlayer = {
            userId: botId,
            username: botUsername,
            isBot: true,
            isHouse: true,
            seatIndex: round.players.length,
            stake: botStake,
            window: item.window,
            second: item.second,
          };

          if (onBotSpawn) {
            onBotSpawn(botPlayer);
          } else {
            if (!round.players.some(p => p.userId === botPlayer.userId)) {
              round.players.push(botPlayer);
            }
          }
        } else {
          item.cancelled = true;
          item.cancelReason = "no_real_users";
        }
      }
    }
  }

  return {
    getPlan,
    onPlayerJoined,
    onPlayerLeft,
    tickSecond,
    isCancelled,
    cancelAll,
    getElapsedSeconds: () => elapsedSeconds,
  };
}

module.exports = {
  createRealHouseScheduler,
  WINDOW_BOUNDS,
  getWindowForSecond,
};
