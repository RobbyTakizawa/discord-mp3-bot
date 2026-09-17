const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createRuntime } = require("../index");

function emitMessage(client, message) {
  return new Promise((resolve, reject) => {
    const msg = {
      author: { bot: false, id: "user-a" },
      channel: { send: () => Promise.resolve() },
      content: message.content,
      guild: message.guild,
      member: message.member,
      reply: (payload) => {
        resolve(payload.content);
        return Promise.resolve(payload);
      },
    };
    try {
      client.emit("messageCreate", msg);
    } catch (err) {
      reject(err);
    }
  });
}

test("Discord commands and voice-state events use the shared voice session", async (t) => {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-runtime-"));
  t.after(() => fs.rmSync(musicDir, { recursive: true, force: true }));

  const client = new EventEmitter();
  client.guilds = { cache: new Map() };
  client.destroyCalls = 0;
  client.destroy = () => { client.destroyCalls += 1; };
  const calls = { departures: [], plays: [], shutdowns: 0, stops: 0 };
  const voiceSession = {
    handleVoiceStateUpdate: async (oldState) => { calls.departures.push(oldState); },
    play: async (request) => { calls.plays.push(request); },
    shutdown: async () => { calls.shutdowns += 1; },
    stop: async () => { calls.stops += 1; },
  };
  const catalog = {
    musicDir,
    getCategories: () => [],
    getMusicStructure: () => ({}),
    safeResolveMp3: (name) => name === "sound" ? path.join(musicDir, "sound.mp3") : null,
  };
  const runtime = createRuntime({
    discordAllowedGuildIds: [],
    discordCommandCooldownMs: 0,
    discordControllerRoleIds: [],
    musicDir,
    prefix: "!",
    webPass: "password",
    webPort: 3000,
    webUser: "uploader",
  }, {
    catalog,
    client,
    logger: { error() {}, log() {} },
    player: {},
    voiceSession,
  });
  const guild = { id: "guild-a" };
  const channel = { id: "channel-a" };

  const outsideReply = await emitMessage(client, {
    content: "!play sound",
    guild,
    member: { voice: { channel: null } },
  });
  assert.equal(outsideReply, "Join a voice channel first.");
  assert.equal(calls.plays.length, 0);

  const playReply = await emitMessage(client, {
    content: "!play sound",
    guild,
    member: { voice: { channel } },
  });
  assert.equal(playReply, "Playing sound");
  assert.deepEqual(calls.plays[0], {
    guild,
    channel,
    filePath: path.join(musicDir, "sound.mp3"),
    song: "sound",
  });

  assert.equal(await emitMessage(client, { content: "!stop", guild }), "Stopped.");
  assert.equal(calls.stops, 1);

  const oldState = { guild };
  client.emit("voiceStateUpdate", oldState);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.departures, [oldState]);

  await runtime.shutdown();
  await runtime.shutdown();
  assert.equal(calls.shutdowns, 1);
  assert.equal(client.destroyCalls, 1);
});
