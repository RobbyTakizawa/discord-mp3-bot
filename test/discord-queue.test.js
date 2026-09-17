const assert = require("node:assert/strict");
const test = require("node:test");

const { createDiscordAdapter } = require("../discord-adapter");

function createAdapterFixture() {
  const { EventEmitter: EE } = require("node:events");
  const client = new EE();
  client.guilds = { cache: new Map() };
  const calls = { enqueues: [], plays: [], stops: 0 };
  let activeConnection = null;
  const voiceSession = {
    getState: () => ({ connection: activeConnection }),
    getSnapshot: async () => ({ queue: [] }),
    play: async (request) => { calls.plays.push(request); },
    enqueue: async (request) => { calls.enqueues.push(request); },
    stop: async () => { calls.stops += 1; },
    skip: async () => {},
    removeQueued: async () => {},
    clearQueue: async () => {},
    setLoop: async () => {},
    setVolume: async () => {},
  };
  const catalog = {
    getMusicStructure: () => ({}),
    safeResolveMp3: (name) => name === "track" ? "/music/track.mp3" : null,
  };
  const adapter = createDiscordAdapter({
    client,
    catalog,
    config: { prefix: "!", discordAllowedGuildIds: [], discordCommandCooldownMs: 0, discordControllerRoleIds: [] },
    voiceSession,
    logger: { error() {}, log() {} },
  });
  return {
    adapter,
    calls,
    client,
    setActiveConnection: (value) => { activeConnection = value; },
  };
}

test("enqueueWeb stays in the active channel when a session exists", async () => {
  const fixture = createAdapterFixture();
  fixture.setActiveConnection({ id: "active-connection" });

  await fixture.adapter.enqueueWeb("track", "/music/track.mp3");

  assert.deepEqual(fixture.calls.enqueues, [{ song: "track", filePath: "/music/track.mp3" }]);
  assert.equal(fixture.calls.plays.length, 0);
});

test("enqueueWeb includes a fallback target when active so a stale snapshot cannot ghost", async () => {
  const fixture = createAdapterFixture();
  fixture.setActiveConnection({ id: "active-connection" });
  const channel = {
    id: "voice-a",
    name: "General",
    isVoiceBased: () => true,
    members: {
      filter: (predicate) => new Map([["human", { user: { bot: false } }]].filter(([, member]) => predicate(member))),
    },
  };
  const guild = {
    id: "guild-a",
    channels: {
      cache: {
        filter: (predicate) => new Map([[channel.id, channel]].filter(([, candidate]) => predicate(candidate))),
      },
    },
  };
  fixture.client.guilds.cache.set(guild.id, guild);

  await fixture.adapter.enqueueWeb("track", "/music/track.mp3");

  assert.deepEqual(fixture.calls.enqueues, [{ guild, channel, song: "track", filePath: "/music/track.mp3" }]);
});

test("enqueueWeb selects the first human channel when idle and rejects without a target", async () => {
  const fixture = createAdapterFixture();
  await assert.rejects(
    fixture.adapter.enqueueWeb("track", "/music/track.mp3"),
    /at least one human/,
  );
  assert.equal(fixture.calls.enqueues.length, 0);

  const channel = {
    id: "voice-a",
    name: "General",
    isVoiceBased: () => true,
    members: {
      filter: (predicate) => new Map([["human", { user: { bot: false } }]].filter(([, member]) => predicate(member))),
    },
  };
  const guild = {
    id: "guild-a",
    channels: {
      cache: {
        filter: (predicate) => new Map([[channel.id, channel]].filter(([, candidate]) => predicate(candidate))),
      },
    },
  };
  fixture.client.guilds.cache.set(guild.id, guild);

  await fixture.adapter.enqueueWeb("track", "/music/track.mp3");
  assert.deepEqual(fixture.calls.enqueues, [{ guild, channel, song: "track", filePath: "/music/track.mp3" }]);
});

test("Discord play clears the web queue through immediate replacement", async () => {
  const { EventEmitter: EE } = require("node:events");
  const client = new EE();
  client.guilds = { cache: new Map() };
  const calls = { plays: [] };
  const catalog = {
    getMusicStructure: () => ({}),
    safeResolveMp3: (name) => name === "track" ? "/music/track.mp3" : null,
  };
  const voiceSession = {
    handleVoiceStateUpdate: async () => {},
    play: async (request) => calls.plays.push(request),
    stop: async () => {},
  };
  const adapter = createDiscordAdapter({
    client,
    catalog,
    config: { prefix: "!", discordAllowedGuildIds: [], discordCommandCooldownMs: 0, discordControllerRoleIds: [] },
    voiceSession,
    logger: { error() {}, log() {} },
  });

  const sent = [];
  const message = {
    author: { bot: false, id: "user-a" },
    channel: { send: async () => {} },
    content: "!play track",
    guild: { id: "guild-a" },
    member: {
      roles: { cache: new Map() },
      voice: { channel: { id: "voice-a" } },
    },
    reply: async (payload) => { sent.push(payload); return payload; },
  };
  await adapter.handleMessage(message);
  assert.equal(calls.plays[0].song, "track");
  assert.equal(sent[0].content, "Playing track");
});
