const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDiscordAdapter } = require("../discord-adapter");
const { createDowntimeStore } = require("../downtime-store");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "discord-downtime-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createDowntimeStore({ filePath: path.join(directory, "progress.json"), randomInt: () => 6 });
  const client = new EventEmitter();
  client.guilds = { cache: new Map() };
  const adapter = createDiscordAdapter({
    client, catalog: {}, voiceSession: {}, downtimeStore: store,
    config: { prefix: "!", discordAllowedGuildIds: [], discordCommandCooldownMs: 0, discordControllerRoleIds: ["999999999999999999"] },
    logger: { error() {} },
  });
  let sequence = 0;
  async function send(content, { userId = "222222222222222222", guildId = "111111111111111111", name = "Alice" } = {}) {
    const replies = [];
    const message = {
      id: String(++sequence), content, author: { id: userId, bot: false, username: name },
      guild: { id: guildId }, member: { displayName: name, roles: { cache: new Map() } },
      reply: async (payload) => { replies.push(payload); },
      channel: { send: async (payload) => { replies.push(payload); } },
    };
    await adapter.handleMessage(message);
    return replies;
  }
  return { send, store };
}

test("anyone can set, roll, view scoreboard, and undo their own roll", async (t) => {
  const { send, store } = fixture(t);
  assert.match((await send("!DOWNTIME_GOAL set origin Alert"))[0].content, /Alert.*0\/20/);
  assert.match((await send("!roll_downtime 2d6+1"))[0].content, /\[6, 6\] \+ 1 = 13.*13\/20/);
  const completed = await send("!roll_downtime 2d6");
  assert.match(completed[0].content, /Feat earned/);
  const board = await send("!downtime_scoreboard");
  assert.match(board[0].content, /Alice.*20\/20.*completed/);
  assert.deepEqual(board[0].allowedMentions, { parse: [], repliedUser: false });
  assert.match((await send("!undo_downtime"))[0].content, /13\/20/);
  assert.equal(store.progress("111111111111111111", "222222222222222222").status, "active");
  assert.match((await send("!downtime_progress"))[0].content, /13\/20/);
});

test("undo acts only on caller and scoreboard is server scoped", async (t) => {
  const { send } = fixture(t);
  await send("!downtime_goal set general Lucky", { name: "Alice @everyone" });
  await send("!roll_downtime 1d6", { name: "Alice @everyone" });
  assert.match((await send("!undo_downtime", { userId: "333333333333333333" }))[0].content, /no roll/i);
  assert.match((await send("!downtime_scoreboard"))[0].content, /Alice @everyone/);
  assert.deepEqual((await send("!downtime_scoreboard", { guildId: "444444444444444444" }))[0].content, "No downtime goals yet.");
});

test("multiword feat names survive goal, roll, progress, and scoreboard commands", async (t) => {
  const { send } = fixture(t);
  assert.match((await send("!downtime_goal set general Heavy Armor Master --points 45"))[0].content, /Heavy Armor Master.*0\/45/);
  assert.match((await send("!roll_downtime 1d6"))[0].content, /Heavy Armor Master.*6\/45/);
  assert.match((await send("!downtime_progress"))[0].content, /Heavy Armor Master.*6\/45/);
  assert.match((await send("!downtime_scoreboard"))[0].content, /Heavy Armor Master.*6\/45/);
});

test("scoreboard includes all players and chunks long output safely", async (t) => {
  const { send } = fixture(t);
  for (let index = 0; index < 30; index += 1) {
    await send("!downtime_goal set general Alert", {
      userId: String(200000000000000000n + BigInt(index)),
      name: `Player ${index} ${"x".repeat(60)}`,
    });
  }
  const replies = await send("!downtime_scoreboard");
  assert.ok(replies.length > 1);
  for (const reply of replies) {
    assert.ok(reply.content.length <= 2000);
    assert.deepEqual(reply.allowedMentions, { parse: [], repliedUser: false });
  }
  assert.match(replies.map((reply) => reply.content).join("\n"), /Player 29/);
});
