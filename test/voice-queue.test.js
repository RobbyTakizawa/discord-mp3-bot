const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const { createVoiceSession, MAX_QUEUE_ENTRIES } = require("../voice-session");

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
  const channel = { id: channelId, name: `channel-${channelId}`, members: createMembers(memberList) };
  const guild = {
    id: guildId,
    name: `guild-${guildId}`,
    voiceAdapterCreator: { guildId },
    channels: { cache: new Map([[channelId, channel]]) },
  };
  return { guild, channel };
}

function createHarness(overrides = {}) {
  const player = new FakePlayer();
  const connections = [];
  const errors = [];
  const logs = [];
  const createdResources = [];
  const createResource = overrides.createAudioResource || ((filePath, options) => {
    const resource = { filePath, metadata: options?.metadata, playbackDuration: 0 };
    createdResources.push(resource);
    return resource;
  });
  const waitForState = overrides.entersState || (async (connection) => connection);
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
    musicDir: overrides.musicDir,
    fileSystem: overrides.fileSystem,
  });
  return { connections, createdResources, errors, logs, player, session };
}

test("enqueue starts immediately when idle and queues when playing", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");

  const idleSnapshot = await harness.session.enqueue({
    ...target,
    song: "one",
    filePath: "one.mp3",
  });
  assert.equal(idleSnapshot.current.song, "one");
  assert.deepEqual(idleSnapshot.queue, []);
  assert.equal(harness.connections.length, 1);
  assert.equal(harness.player.played.length, 1);

  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.enqueue({ song: "three", filePath: "three.mp3" });
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "one");
  assert.deepEqual(snapshot.queue.map((entry) => entry.song), ["two", "three"]);
  assert.equal(harness.player.played.length, 1);
  assert.equal(harness.connections.length, 1);
});

test("natural completion advances through the queue without dropping the connection", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.enqueue({ song: "three", filePath: "three.mp3" });

  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();
  let snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "two");
  assert.deepEqual(snapshot.queue.map((entry) => entry.song), ["three"]);
  assert.equal(harness.connections.length, 1);
  assert.equal(harness.connections[0].destroyCalls, 0);

  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();
  snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "three");
  assert.deepEqual(snapshot.queue, []);

  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();
  snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current, null);
  assert.equal(snapshot.status, "idle");
  assert.equal(harness.connections[0].destroyCalls, 0);
});

test("loop recreates a fresh resource and makes the queue wait; skip moves forward while looping", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.setLoop(true);

  const firstResource = harness.session.getState().currentResource;
  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();

  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "one");
  assert.deepEqual(snapshot.queue.map((entry) => entry.song), ["two"]);
  assert.notEqual(harness.session.getState().currentResource, firstResource);
  assert.equal(harness.player.played.length, 2);

  await harness.session.skip();
  const skipped = await harness.session.getSnapshot();
  assert.equal(skipped.current.song, "two");
  assert.deepEqual(skipped.queue, []);
  assert.equal(skipped.loop, true);
});

test("Play Now replaces the track and clears the pending queue", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.enqueue({ song: "three", filePath: "three.mp3" });

  await harness.session.play({ ...target, song: "four", filePath: "four.mp3" });
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "four");
  assert.deepEqual(snapshot.queue, []);
  assert.equal(harness.player.played.length, 2);
});

test("stop, departure, disconnect failure, and shutdown clear queue and loop state", async () => {
  const harness = createHarness({
    entersState: async (connection, status) => {
      if (status === VoiceConnectionStatus.Ready) return connection;
      throw new Error("reconnect failed");
    },
  });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.setLoop(true);

  await harness.session.stop();
  let snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current, null);
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.loop, false);
  assert.equal(harness.connections[0].destroyCalls, 1);

  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.setLoop(true);
  target.channel.members = createMembers([{ user: { bot: true } }]);
  assert.equal(await harness.session.handleVoiceStateUpdate({ guild: target.guild }), true);
  snapshot = await harness.session.getSnapshot();
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.loop, false);

  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  harness.connections[harness.connections.length - 1].emit(
    "stateChange",
    { status: VoiceConnectionStatus.Ready },
    { status: VoiceConnectionStatus.Disconnected },
  );
  await harness.session.whenSettled();
  snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current, null);
  assert.deepEqual(snapshot.queue, []);
});

test("shutdown clears queue state and rejects later queue operations", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.shutdown();
  const snapshot = await harness.session.getSnapshot().catch(() => null);
  void snapshot;
  await assert.rejects(
    harness.session.enqueue({ song: "three", filePath: "three.mp3" }),
    /shut down/,
  );
  await assert.rejects(harness.session.skip(), /shut down/);
});

test("volume applies immediately and to future resources", async () => {
  const volumes = [];
  const harness = createHarness({
    createAudioResource: (filePath, options) => {
      const resource = {
        filePath,
        metadata: options?.metadata,
        playbackDuration: 0,
        volume: {
          setVolume(value) {
            volumes.push(value);
          },
        },
      };
      return resource;
    },
  });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  assert.deepEqual(volumes, [1]);

  await harness.session.setVolume(50);
  assert.deepEqual(volumes, [1, 0.5]);
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.volume, 50);

  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();
  assert.deepEqual(volumes, [1, 0.5, 0.5]);
  const advanced = await harness.session.getSnapshot();
  assert.equal(advanced.current.song, "two");
  assert.equal(advanced.volume, 50);

  await assert.rejects(harness.session.setVolume(101), /Volume must be an integer/);
  await assert.rejects(harness.session.setVolume(-1), /Volume must be an integer/);
  await assert.rejects(harness.session.setVolume(12.5), /Volume must be an integer/);
});

test("player errors skip to the next queued entry; empty-queue errors clear the session", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });

  harness.player.emit("error", new Error("decoder failed"));
  await harness.session.whenSettled();
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "two");
  assert.deepEqual(snapshot.queue, []);
  assert.equal(harness.connections.length, 1);

  harness.player.emit("error", new Error("decoder failed again"));
  await harness.session.whenSettled();
  const cleared = await harness.session.getSnapshot();
  assert.equal(cleared.current, null);
  assert.equal(harness.connections[0].destroyCalls, 1);
});

test("files deleted after enqueue are skipped when they start", async (t) => {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-queue-"));
  t.after(() => fs.rmSync(musicDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(musicDir, "one.mp3"), "audio-one");
  fs.writeFileSync(path.join(musicDir, "gone.mp3"), "audio-gone");
  fs.writeFileSync(path.join(musicDir, "three.mp3"), "audio-three");

  const harness = createHarness({ musicDir });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({
    ...target,
    song: "one",
    filePath: path.join(musicDir, "one.mp3"),
  });
  await harness.session.enqueue({ song: "gone", filePath: path.join(musicDir, "gone.mp3") });
  await harness.session.enqueue({ song: "three", filePath: path.join(musicDir, "three.mp3") });

  fs.rmSync(path.join(musicDir, "gone.mp3"));
  harness.player.emit("stateChange", { status: AudioPlayerStatus.Playing }, { status: AudioPlayerStatus.Idle });
  await harness.session.whenSettled();

  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "three");
  assert.deepEqual(snapshot.queue, []);
});

test("stale completion and error events cannot corrupt the new queue", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  const firstSnapshot = await harness.session.getSnapshot();
  void firstSnapshot;
  await harness.session.play({ ...target, song: "two", filePath: "two.mp3" });
  const second = await harness.session.getSnapshot();
  assert.equal(second.current.song, "two");

  const staleEntryId = 1;
  harness.player.emit(
    "stateChange",
    { status: AudioPlayerStatus.Playing, resource: { metadata: { entryId: staleEntryId } } },
    { status: AudioPlayerStatus.Idle },
  );
  await harness.session.whenSettled();
  const afterStale = await harness.session.getSnapshot();
  assert.equal(afterStale.current.song, "two");

  const staleError = new Error("stale decoder failure");
  staleError.resource = { metadata: { entryId: staleEntryId } };
  harness.player.emit("error", staleError);
  await harness.session.whenSettled();
  const afterStaleError = await harness.session.getSnapshot();
  assert.equal(afterStaleError.current.song, "two");
});

test("concurrent Discord and web operations are serialized", async () => {
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

  const playPromise = harness.session.play({ ...first, song: "one", filePath: "one.mp3" });
  const enqueuePromise = harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirst();
  await Promise.all([playPromise, enqueuePromise]);
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "one");
  assert.deepEqual(snapshot.queue.map((entry) => entry.song), ["two"]);
});

test("queue is capped and entries can be removed or cleared", async () => {
  const harness = createHarness();
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "one", filePath: "one.mp3" });
  for (let index = 0; index < MAX_QUEUE_ENTRIES; index += 1) {
    await harness.session.enqueue({ song: `track-${index}`, filePath: `${index}.mp3` });
  }
  await assert.rejects(
    harness.session.enqueue({ song: "overflow", filePath: "overflow.mp3" }),
    /Queue is full/,
  );

  const snapshot = await harness.session.getSnapshot();
  const firstId = snapshot.queue[0].id;
  await harness.session.removeQueued(firstId);
  const removed = await harness.session.getSnapshot();
  assert.equal(removed.queue.length, MAX_QUEUE_ENTRIES - 1);
  await assert.rejects(harness.session.removeQueued(999999), /Queued entry not found/);
  await assert.rejects(harness.session.removeQueued("bad"), /Invalid queue entry id/);

  await harness.session.clearQueue();
  const cleared = await harness.session.getSnapshot();
  assert.deepEqual(cleared.queue, []);
  assert.equal(cleared.current.song, "one");
});

test("snapshot exposes target names, revision, and elapsed time without filesystem paths", async () => {
  const harness = createHarness({
    createAudioResource: (filePath, options) => ({
      filePath,
      metadata: options?.metadata,
      playbackDuration: 4242,
    }),
  });
  const target = createTarget("guild-a", "channel-a");
  await harness.session.play({ ...target, song: "effects/laser", filePath: "laser.mp3" });
  const first = await harness.session.getSnapshot();
  assert.equal(first.guildName, "guild-guild-a");
  assert.equal(first.channelName, "channel-channel-a");
  assert.equal(first.current.song, "effects/laser");
  assert.equal(first.current.elapsedMs, 4242);
  assert.equal(first.volume, 100);
  assert.equal(first.loop, false);
  assert.ok(first.revision >= 1);
  assert.ok(!JSON.stringify(first).includes(".mp3") || JSON.stringify(first).includes("effects/laser"));
});

test("cross-target Play Now preserves loop mode while clearing the queue", async () => {
  const harness = createHarness();
  const first = createTarget("guild-a", "channel-a");
  const second = createTarget("guild-b", "channel-b");
  await harness.session.play({ ...first, song: "one", filePath: "one.mp3" });
  await harness.session.enqueue({ song: "two", filePath: "two.mp3" });
  await harness.session.setLoop(true);

  await harness.session.play({ ...second, song: "three", filePath: "three.mp3" });
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current.song, "three");
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.loop, true);
  assert.equal(snapshot.guildId, "guild-b");
  assert.equal(snapshot.channelId, "channel-b");
  assert.equal(harness.connections[0].destroyCalls, 1);
});

test("a failed enqueue join leaves no ghost queue entry", async () => {
  const harness = createHarness({
    entersState: async () => { throw new Error("join failed"); },
  });
  const target = createTarget("guild-a", "channel-a");
  await assert.rejects(
    harness.session.enqueue({ ...target, song: "one", filePath: "one.mp3" }),
    /join failed/,
  );
  const snapshot = await harness.session.getSnapshot();
  assert.equal(snapshot.current, null);
  assert.deepEqual(snapshot.queue, []);
  assert.equal(snapshot.guildId, null);
});

test("a throwing joinVoiceChannel leaves no ghost queue entry", async () => {
  const player = new FakePlayer();
  const session = createVoiceSession({
    player,
    createAudioResource: (filePath, options) => ({ filePath, metadata: options?.metadata }),
    entersState: async (connection) => connection,
    joinVoiceChannel: () => { throw new Error("adapter unavailable"); },
    logger: { error() {}, log() {} },
  });
  const target = createTarget("guild-a", "channel-a");
  await assert.rejects(
    session.enqueue({ ...target, song: "one", filePath: "one.mp3" }),
    /adapter unavailable/,
  );
  const snapshot = await session.getSnapshot();
  assert.equal(snapshot.current, null);
  assert.deepEqual(snapshot.queue, []);
});

test("enqueue without a target while idle rejects instead of queueing a ghost", async () => {
  const harness = createHarness();
  await assert.rejects(
    harness.session.enqueue({ song: "one", filePath: "one.mp3" }),
    /at least one human/,
  );
  const snapshot = await harness.session.getSnapshot();
  assert.deepEqual(snapshot.queue, []);
});
