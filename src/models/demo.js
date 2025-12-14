const { createGame, addMove, finishGame, getGamesByUser } = require("./Db");
const { createUser } = require("./User");

async function demo() {
  console.log("Starting demo...");
  const u1 = await createUser("Alice", "251900000001");
  const u2 = await createUser("Bob", "251900000002");

  const game = await createGame(u1.id, u2.id, 50);

  await addMove(game.id, {
    index: 0,
    symbol: "X",
    user: u1.id,
    ts: new Date().toISOString(),
  });

  await addMove(game.id, {
    index: 4,
    symbol: "O",
    user: u2.id,
    ts: new Date().toISOString(),
  });

  const finished = await finishGame(game.id, "draw");

  const history = await getGamesByUser(u1.id);

  console.log("Game Finished:", finished);
  console.log("User Games:", history);
}

demo().catch(console.error);
