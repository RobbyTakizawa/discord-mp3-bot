const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const { createVoiceSession } = require("../voice-session");

class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.played = [];
    this.stopCalls = 0;
  }

  play(resource) {
    this.played.push(resource);
  }

  stop(force) {
    this.stopCalls += 1;
    this.lastStopForce = force;
    return true;
  }
}

class FakeConnection extends EventEmitter {
  constructor(joinConfig) {
    super();
    this.joinConfig = joinConfig;
    this.destroyCalls = 0;
    this.subscriptions = [];
  }

  subscribe(player) {
    this.subscriptions.push(player);
    return { unsubscribe() {} };
  }

  destroy() {
    this.destroyCalls += 1;
  }
}

function createMembers(memberList) {
  return {
    filter(predicate) {
      return { size: memberList.filter(predicate).length };
    },
  };
}

function createTarget(guildId, channelId, memberList = [{ user: { bot: false } }]) {
  const channel = { id: channelId, members: createMembers(memberList) };
  const guild = {
    id: guildId,
    voiceAdapterCreator: { guildId },
    channels: { cache: new Map([[channelId, channel]]) },
  };
  return { guild, channel };
}

function createHarness(overrides = {}) {
  const player = new FakePlayer();
  const connections = [];
  const stateRequests = [];
  const errors = [];
  const logs = [];
  const createResource = overrides.createAudioResource || ((filePath) => ({ filePath }));
  const waitForState = overrides.entersState || (async (connection, status, timeout) => {
    stateRequests.push({ connection, status, timeout });
    return connection;
  });
  const session = createVoiceSession({
    player,
    createAudioResource: createResource,
    entersState: waitForState,
    joinVoiceChannel: (joinConfig) => {
      const connection = new FakeConnection(joinConfig);
      connections.push(connection);
      return connection;
    },
    logger: {
      error: (...args) => errors.push(args),
      log: (...args) => logs.push(args),
    },
  });
  return { connections, errors, logs, player, session, stateRequests };
}

test("play creates one ready connection and replaces resources on the same target", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");

  await harness.session.play({ ...target, filePath: "one.mp3" });
  await harness.session.play({ ...target, filePath: "two.mp3" });

  assert.equal(harness.connections.length, 1);
  assert.deepEqual(harness.connections[0].joinConfig, {
    channelId: "channel-a",
    guildId: "guild-a",
    adapterCreator: target.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  assert.equal(harness.connections[0].subscriptions.length, 2);
  assert.deepEqual(harness.player.played, [{ filePath: "one.mp3" }, { filePath: "two.mp3" }]);
  assert.equal(harness.player.stopCalls, 0);
  assert.equal(harness.session.getState().currentResource.filePath, "two.mp3");
});

test("play destroys the old connection before moving the global session", async () => {
  const harness = createHarness();
  const first = createTarget("guild-a", "channel-a");
  const second = createTarget("guild-b", "channel-b");

  await harness.session.play({ ...first, filePath: "one.mp3" });
  await harness.session.play({ ...second, filePath: "two.mp3" });

  assert.equal(harness.connections.length, 2);
  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.connections[1].destroyCalls, 0);
  assert.equal(harness.player.stopCalls, 1);
  assert.deepEqual(harness.session.getState(), {
    guildId: "guild-b",
    channelId: "channel-b",
    connection: harness.connections[1],
    currentResource: { filePath: "two.mp3" },
    closed: false,
  });
});

test("resource creation failure does not disturb the active session", async () => {
  const harness = createHarness({
    createAudioResource(filePath) {
      if (filePath === "invalid.mp3") throw new Error("invalid resource");
      return { filePath };
    },
  });
  const first = createTarget("guild-a", "channel-a");
  const second = createTarget("guild-b", "channel-b");
  await harness.session.play({ ...first, filePath: "one.mp3" });

  await assert.rejects(
    harness.session.play({ ...second, filePath: "invalid.mp3" }),
    /invalid resource/,
  );

  assert.equal(harness.connections.length, 1);
  assert.equal(harness.connections[0].destroyCalls, 0);
  assert.equal(harness.session.getState().channelId, "channel-a");
  assert.equal(harness.session.getState().currentResource.filePath, "one.mp3");
});

test("play operations are serialized while a connection becomes ready", async () => {
  let releaseFirst;
  let readyCalls = 0;
  const harness = createHarness({
    entersState: async (connection, status) => {
      if (status === VoiceConnectionStatus.Ready && readyCalls++ === 0) {
        await new Promise((resolve) => { releaseFirst = resolve; });
      }
      return connection;
    },
  });
  const first = createTarget("guild-a", "channel-a");
  const second = createTarget("guild-b", "channel-b");

  const firstPlay = harness.session.play({ ...first, filePath: "one.mp3" });
  const secondPlay = harness.session.play({ ...second, filePath: "two.mp3" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.connections.length, 1);

  releaseFirst();
  await Promise.all([firstPlay, secondPlay]);
  assert.equal(harness.connections.length, 2);
  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.session.getState().channelId, "channel-b");
});

test("stop is global and idempotent", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  await harness.session.stop();
  await harness.session.stop();

  assert.equal(harness.player.stopCalls, 1);
  assert.equal(harness.player.lastStopForce, true);
  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.deepEqual(harness.session.getState(), {
    guildId: null,
    channelId: null,
    connection: null,
    currentResource: null,
    closed: false,
  });
});

test("last-human departure clears only the active channel's session", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  const unrelated = createTarget("guild-b", "channel-b", []);
  assert.equal(await harness.session.handleVoiceStateUpdate({ guild: unrelated.guild }), false);
  assert.equal(harness.connections[0].destroyCalls, 0);

  target.channel.members = createMembers([{ user: { bot: true } }]);
  assert.equal(await harness.session.handleVoiceStateUpdate({ guild: target.guild }), true);
  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.session.getState().connection, null);
});

test("resource completion clears current resource without dropping the connection", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();

  assert.equal(harness.session.getState().currentResource, null);
  assert.equal(harness.session.getState().connection, harness.connections[0]);
  assert.equal(harness.connections[0].destroyCalls, 0);
});

test("an unrecoverable disconnect clears the session", async () => {
  const harness = createHarness({
    entersState: async (connection, status) => {
      if (status === VoiceConnectionStatus.Ready) return connection;
      throw new Error("reconnect failed");
    },
  });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  harness.connections[0].emit(
    "stateChange",
    { status: VoiceConnectionStatus.Ready },
    { status: VoiceConnectionStatus.Disconnected },
  );
  await harness.session.whenSettled();

  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.session.getState().connection, null);
  assert.equal(harness.player.stopCalls, 1);
  assert.match(harness.errors[0][0], /recovery failed/i);
});

test("a recoverable disconnect preserves the active session", async () => {
  const requestedStatuses = [];
  const harness = createHarness({
    entersState: async (connection, status) => {
      requestedStatuses.push(status);
      return connection;
    },
  });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  harness.connections[0].emit(
    "stateChange",
    { status: VoiceConnectionStatus.Ready },
    { status: VoiceConnectionStatus.Disconnected },
  );
  await harness.session.whenSettled();

  assert.deepEqual(requestedStatuses, [
    VoiceConnectionStatus.Ready,
    VoiceConnectionStatus.Signalling,
    VoiceConnectionStatus.Connecting,
  ]);
  assert.equal(harness.connections[0].destroyCalls, 0);
  assert.equal(harness.session.getState().connection, harness.connections[0]);
  assert.equal(harness.session.getState().currentResource.filePath, "one.mp3");
});

test("an audio player error clears the global session", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  harness.player.emit("error", new Error("decoder failed"));
  await harness.session.whenSettled();

  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.player.stopCalls, 1);
  assert.equal(harness.session.getState().connection, null);
  assert.equal(harness.errors[0][0], "Audio player error:");
});

test("shutdown clears the session and rejects later play requests", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, filePath: "one.mp3" });

  await harness.session.shutdown();

  assert.equal(harness.connections[0].destroyCalls, 1);
  assert.equal(harness.session.getState().closed, true);
  await assert.rejects(
    harness.session.play({ ...target, filePath: "two.mp3" }),
    /shut down/,
  );
});
