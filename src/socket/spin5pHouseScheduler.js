// src/socket/spin5pHouseScheduler.js
// ────────────────────────────────────────────────────────────────────────────
// 4-Window House Scheduler for 5-Player Spin Rooms
//
// Rules:
// 1. Timer runs from 2:00 down to 0:00 (0 to 120 seconds elapsed).
// 2. 4 Windows:
//    - Window 1: 1s to 30s   (Timer: 1:59 to 1:30)
//    - Window 2: 31s to 60s  (Timer: 1:29 to 1:00)
//    - Window 3: 61s to 90s  (Timer: 0:59 to 0:30)
//    - Window 4: 91s to 118s (Timer: 0:29 to 0:02)
//    - Lock: 120s            (Timer: 0:00)
// 3. At most one bot per window at a random second (crypto.randomInt).
// 4. Bot joins only if at least 1 real user is currently present.
// 5. If a real user joins in a window before that window's bot time, that window's bot is cancelled.
// 6. Real users keep priority until lock. If room is full, newest house seat yields.
// 7. If the last real user leaves before lock, round is cancelled and all bots cleared.
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

function createHouseScheduler(round, options = {}) {
  const { mockSeconds, onBotSpawn, onBotYield, onRoundCancel, logger = console } = options;

  let cancelled = false;
  let elapsedSeconds = 0;

  // Plan 4 windows
  const plan = WINDOW_BOUNDS.map((b, idx) => {
    let sec;
    if (mockSeconds && mockSeconds[idx] !== undefined) {
      sec = mockSeconds[idx];
    } else {
      // crypto.randomInt(min, max + 1)
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
      // 1. Check if room is full. If full, newest bot yields seat
      if (round.players.length >= round.maxPlayers) {
        // Find newest bot (last bot in round.players)
        let newestBotIdx = -1;
        for (let i = round.players.length - 1; i >= 0; i--) {
          if (round.players[i].isBot) {
            newestBotIdx = i;
            break;
          }
        }

        if (newestBotIdx !== -1) {
          const yieldedBot = round.players.splice(newestBotIdx, 1)[0];
          round.players.forEach((p, idx) => { p.seatIndex = idx; });
          if (onBotYield) onBotYield(yieldedBot);
        }
      }

      // Add real player
      player.seatIndex = round.players.length;
      round.players.push(player);

      // 2. Window cancellation check:
      // If this real player arrived during window w before that window's bot time, cancel that bot!
      const currentWindow = getWindowForSecond(elapsedSeconds);
      if (currentWindow) {
        const item = plan.find(p => p.window === currentWindow);
        if (item && !item.fired && elapsedSeconds < item.second) {
          item.cancelled = true;
          item.cancelReason = "real_joined_before_time";
        }
      }
    } else {
      // Bot joins
      player.seatIndex = round.players.length;
      round.players.push(player);
    }
  }

  function onPlayerLeft({ userId }) {
    if (cancelled) return;

    const idx = round.players.findIndex(p => p.userId === userId);
    if (idx !== -1) {
      round.players.splice(idx, 1);
      round.players.forEach((p, i) => { p.seatIndex = i; });
    }

    // Check if any real users remain
    const remainingReal = round.players.filter(p => !p.isBot);
    if (remainingReal.length === 0) {
      // Last real user left before lock: cancel round, remove all bots, clear
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
        // Bot entry check:
        // - At least 1 real user present
        // - Seats not full (< 5)
        if (realUsers.length >= 1 && round.players.length < round.maxPlayers) {
          item.fired = true;
          const botId = `bot_${round.id}_w${item.window}_${Date.now()}`;
          const botUsername = `XO_Player_${item.window}`;

          const botPlayer = {
            userId: botId,
            username: botUsername,
            isBot: true,
            isHouse: true,
            seatIndex: round.players.length,
            stake: round.betAmount || 100,
            window: item.window,
            second: item.second,
          };

          if (onBotSpawn) {
            onBotSpawn(botPlayer);
          } else {
            round.players.push(botPlayer);
          }
        } else {
          item.cancelled = true;
          item.cancelReason = realUsers.length < 1 ? "no_real_users" : "room_full";
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
  createHouseScheduler,
  WINDOW_BOUNDS,
  getWindowForSecond,
};
