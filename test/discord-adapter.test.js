const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  DISCORD_MESSAGE_LIMIT,
  createDiscordAdapter,
  parseCommand,
  sanitizeDiscordText,
} = require("../discord-adapter");

function createMessage({
  authorId = "user-a",
  content,
  guildId = "123456789012345678",
  roleIds = [],
  voiceChannel = { id: "voice-a" },
} = {}) {
  const sent = [];
  const message = {
    author: { bot: false, id: authorId },
    channel: {
      send: async (payload) => {
        sent.push(payload);
        return payload;
      },
    },
    content,
    guild: { id: guildId },
    member: {
      roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) },
      voice: { channel: voiceChannel },
    },
    reply: async (payload) => {
      sent.push(payload);
      return payload;
    },
  };
  return { message, sent };
}

function createFixture(options = {}) {
  const client = new EventEmitter();
  client.guilds = { cache: new Map() };
  const calls = { plays: [], stops: 0 };
  const catalog = options.catalog || {
    getMusicStructure: () => ({}),
    safeResolveMp3: (name) => name === "two words" ? "/music/two words.mp3" : null,
  };
  const voiceSession = {
    handleVoiceStateUpdate: async () => {},
    play: async (request) => calls.plays.push(request),
    stop: async () => { calls.stops += 1; },
  };
  const adapter = createDiscordAdapter({
    client,
    catalog,
    config: {
      prefix: "!",
      discordAllowedGuildIds: options.allowedGuildIds || [],
      discordCommandCooldownMs: options.cooldownMs || 0,
      discordControllerRoleIds: options.controllerRoleIds || [],
    },
    voiceSession,
    logger: { error() {}, log() {} },
    now: options.now,
  });
  return { adapter, calls, client };
}

test("commands are parsed case-insensitively with normalized arguments", async () => {
  assert.deepEqual(parseCommand("!PlAy   two   words ", "!"), {
    command: "play",
    argument: "two words",
  });
  assert.equal(parseCommand("not-a-command", "!"), null);

  const { adapter, calls } = createFixture();
  const { message, sent } = createMessage({ content: "!PlAy   two   words " });
  await adapter.handleMessage(message);

  assert.equal(calls.plays.length, 1);
  assert.equal(calls.plays[0].filePath, "/music/two words.mp3");
  assert.equal(sent[0].content, "Playing two words");
});

test("catalog replies are mention-safe, Markdown-safe, and chunked below Discord's limit", async () => {
  const tracks = Array.from({ length: 55 }, (_, index) => `@everyone **track_${index}** ${"x".repeat(45)}`);
  const { adapter } = createFixture({
    catalog: {
      getMusicStructure: () => ({ "@everyone **effects**": tracks }),
      safeResolveMp3: () => null,
    },
  });
  const { message, sent } = createMessage({ content: "!list" });
  await adapter.handleMessage(message);

  assert.ok(sent.length > 1);
  for (const payload of sent) {
    assert.ok(payload.content.length <= DISCORD_MESSAGE_LIMIT);
    assert.deepEqual(payload.allowedMentions, { parse: [], repliedUser: false });
  }
  const combined = sent.map((payload) => payload.content).join("\n");
  assert.match(combined, /\\\*\\\*EFFECTS\\\*\\\*/);
  assert.match(combined, /\\_0/);
  assert.equal(
    sanitizeDiscordText("line\n**bold** <link>\u202e"),
    "line�\\*\\*bold\\*\\* \\<link\\>�",
  );
});

test("optional guild, controller-role, and per-user cooldown policies are enforced", async () => {
  const guildId = "123456789012345678";
  const roleId = "345678901234567890";
  let currentTime = 1_000;
  const { adapter, calls } = createFixture({
    allowedGuildIds: [guildId],
    controllerRoleIds: [roleId],
    cooldownMs: 1_000,
    now: () => currentTime,
  });

  const unauthorized = createMessage({ content: "!help", guildId: "999999999999999999" });
  await adapter.handleMessage(unauthorized.message);
  assert.equal(unauthorized.sent[0].content, "This server is not authorized to use the bot.");

  const missingRole = createMessage({ content: "!stop", guildId });
  await adapter.handleMessage(missingRole.message);
  assert.equal(missingRole.sent[0].content, "You do not have permission to control playback.");
  assert.equal(calls.stops, 0);

  const first = createMessage({ content: "!help", guildId, roleIds: [roleId] });
  await adapter.handleMessage(first.message);
  assert.match(first.sent[0].content, /^Commands:/);

  const limited = createMessage({ content: "!list", guildId, roleIds: [roleId] });
  await adapter.handleMessage(limited.message);
  assert.equal(limited.sent[0].content, "Please wait before using another command.");

  currentTime += 1_000;
  const allowedAgain = createMessage({ content: "!stop", guildId, roleIds: [roleId] });
  await adapter.handleMessage(allowedAgain.message);
  assert.equal(allowedAgain.sent[0].content, "Stopped.");
  assert.equal(calls.stops, 1);
});

test("web playback targets the first voice channel containing a human", async () => {
  const { adapter, calls, client } = createFixture();
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
  client.guilds.cache.set(guild.id, guild);

  assert.equal(await adapter.playWeb("track", "/music/track.mp3"), "Playing track");
  assert.deepEqual(calls.plays[0], { guild, channel, filePath: "/music/track.mp3", song: "track" });
});
