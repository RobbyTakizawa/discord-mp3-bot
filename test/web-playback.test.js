const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCatalog } = require("../catalog");
const { createWebApp } = require("../web-app");

function authHeader(user = "uploader", pass = "secret") {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function startApp(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    request: (url, options = {}) => fetch(`http://127.0.0.1:${port}${url}`, options),
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function createPlaybackFixture(options = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-playback-"));
  const musicDir = path.join(fixtureDir, "music");
  const stagingDir = path.join(fixtureDir, "staging");
  fs.mkdirSync(musicDir);
  fs.mkdirSync(path.join(musicDir, "effects"));
  fs.writeFileSync(path.join(musicDir, "airhorn.mp3"), "audio");
  fs.writeFileSync(path.join(musicDir, "effects", "laser.mp3"), "audio");
  const catalog = createCatalog({ musicDir });
  const calls = [];
  let snapshot = options.snapshot || {
    guildId: "guild-a",
    channelId: "channel-a",
    guildName: "Guild A",
    channelName: "<General>",
    status: "idle",
    playerStatus: "idle",
    current: null,
    queue: [],
    volume: 100,
    loop: false,
    revision: 1,
  };
  const controlHandlers = {
    play: async (song) => { calls.push(["play", song]); return `Playing ${song}`; },
    stop: async () => { calls.push(["stop"]); snapshot = { ...snapshot, current: null, queue: [] }; },
    enqueue: async (song) => {
      calls.push(["enqueue", song]);
      snapshot = { ...snapshot, queue: [...snapshot.queue, { id: snapshot.queue.length + 1, song }] };
    },
    skip: async () => { calls.push(["skip"]); },
    removeQueued: async (id) => {
      calls.push(["remove", id]);
      if (id === 999) throw new Error("Queued entry not found.");
    },
    clearQueue: async () => { calls.push(["clearQueue"]); snapshot = { ...snapshot, queue: [] }; },
    setLoop: async (enabled) => { calls.push(["setLoop", enabled]); snapshot = { ...snapshot, loop: enabled }; },
    setVolume: async (volume) => {
      calls.push(["setVolume", volume]);
      if (volume < 0 || volume > 100) throw new Error("Volume must be an integer between 0 and 100.");
      snapshot = { ...snapshot, volume };
    },
    getSnapshot: async () => snapshot,
  };
  Object.assign(controlHandlers, options.controlOverrides || {});
  const app = createWebApp({
    config: { webUser: "uploader", webPass: "secret" },
    catalog,
    controlHandlers,
    csrfToken: "test-csrf-token",
    logger: { error() {}, info() {}, log() {} },
    rateLimitOptions: { authentication: { max: 200 }, mutation: { max: 200 } },
    uploadOptions: { stagingDir },
    validateAudio: async () => true,
    mediaMetadata: options.mediaMetadata || { getDurationMs: async () => 12345 },
  });
  return { app, calls, catalog, fixtureDir, musicDir, stagingDir, getSnapshot: () => snapshot };
}

function controlHeaders(extra = {}) {
  return {
    authorization: authHeader(),
    "content-type": "application/json",
    "x-csrf-token": "test-csrf-token",
    ...extra,
  };
}

async function postControl(server, body) {
  return server.request("/api/control", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify(body),
  });
}

test("playback and library reads require authentication and disclose no paths", async (t) => {
  const fixture = createPlaybackFixture();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  assert.equal((await server.request("/api/playback")).status, 401);
  assert.equal((await server.request("/api/library")).status, 401);

  const playback = await server.request("/api/playback", { headers: { authorization: authHeader() } });
  assert.equal(playback.status, 200);
  const playbackBody = await playback.json();
  assert.equal(playbackBody.snapshot.guildName, "Guild A");
  assert.ok(!JSON.stringify(playbackBody).includes(fixture.musicDir));
  assert.ok(!JSON.stringify(playbackBody).includes("music/airhorn"));

  const library = await server.request("/api/library", { headers: { authorization: authHeader() } });
  assert.equal(library.status, 200);
  const libraryBody = await library.json();
  assert.ok(Array.isArray(libraryBody.tracks));
  assert.ok(libraryBody.tracks.some((entry) => entry.song === "airhorn" && entry.durationMs === 12345));
  assert.ok(libraryBody.tracks.some((entry) => entry.song === "effects/laser"));
  assert.ok(!JSON.stringify(libraryBody).includes(fixture.musicDir));
});

test("control mutations validate inputs and return snapshots", async (t) => {
  const fixture = createPlaybackFixture();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const enqueue = await postControl(server, { action: "enqueue", song: "airhorn" });
  assert.equal(enqueue.status, 200);
  const enqueueBody = await enqueue.json();
  assert.match(enqueueBody.message, /Queued/);
  assert.equal(enqueueBody.snapshot.queue.length, 1);

  const missingSong = await postControl(server, { action: "enqueue" });
  assert.equal(missingSong.status, 400);
  const unknownTrack = await postControl(server, { action: "enqueue", song: "missing" });
  assert.equal(unknownTrack.status, 404);

  const badVolume = await postControl(server, { action: "setVolume", volume: 101 });
  assert.equal(badVolume.status, 400);
  const textVolume = await postControl(server, { action: "setVolume", volume: "loud" });
  assert.equal(textVolume.status, 400);
  const goodVolume = await postControl(server, { action: "setVolume", volume: 42 });
  assert.equal(goodVolume.status, 200);
  assert.equal((await goodVolume.json()).snapshot.volume, 42);

  const badLoop = await postControl(server, { action: "setLoop", enabled: "yes" });
  assert.equal(badLoop.status, 400);
  const goodLoop = await postControl(server, { action: "setLoop", enabled: true });
  assert.equal(goodLoop.status, 200);
  assert.equal((await goodLoop.json()).snapshot.loop, true);

  const badRemove = await postControl(server, { action: "remove" });
  assert.equal(badRemove.status, 400);
  const missingEntry = await postControl(server, { action: "remove", id: 999 });
  assert.equal(missingEntry.status, 404);

  const skip = await postControl(server, { action: "skip" });
  assert.equal(skip.status, 200);
  const clear = await postControl(server, { action: "clearQueue" });
  assert.equal(clear.status, 200);

  const unknown = await postControl(server, { action: "dance" });
  assert.equal(unknown.status, 400);
});

test("control mutations require CSRF and are rate limited", async (t) => {
  const fixture = createPlaybackFixture();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  function buildApp(mutationMax) {
    return createWebApp({
      config: { webUser: "uploader", webPass: "secret" },
      catalog: createCatalog({ musicDir: fixture.musicDir }),
      controlHandlers: {
        play: async () => {},
        stop: async () => {},
        enqueue: async () => {},
        skip: async () => {},
        removeQueued: async () => {},
        clearQueue: async () => {},
        setLoop: async () => {},
        setVolume: async () => {},
        getSnapshot: async () => ({
          guildId: null, channelId: null, guildName: null, channelName: null,
          status: "idle", playerStatus: "idle", current: null, queue: [],
          volume: 100, loop: false, revision: 0,
        }),
      },
      csrfToken: "test-csrf-token",
      logger: { error() {}, info() {}, log() {} },
      uploadOptions: { stagingDir: fixture.stagingDir },
      validateAudio: async () => true,
      mediaMetadata: { getDurationMs: async () => null },
      rateLimitOptions: { authentication: { max: 200 }, mutation: { max: mutationMax } },
    });
  }
  const csrfServer = await startApp(buildApp(200));
  t.after(csrfServer.close);

  for (const body of [
    { action: "enqueue", song: "airhorn" },
    { action: "skip" },
    { action: "setVolume", volume: 10 },
    { action: "setLoop", enabled: true },
    { action: "remove", id: 1 },
    { action: "clearQueue" },
  ]) {
    const withoutCsrf = await csrfServer.request("/api/control", {
      method: "POST",
      headers: { authorization: authHeader(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(withoutCsrf.status, 403);
  }

  const limitedServer = await startApp(buildApp(1));
  t.after(limitedServer.close);
  const limitedRequest = (body) => limitedServer.request("/api/control", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify(body),
  });

  const first = await limitedRequest({ action: "skip" });
  assert.equal(first.status, 200);
  const limited = await limitedRequest({ action: "skip" });
  assert.equal(limited.status, 429);
});

test("no-target enqueue requests fail with a 409 without disturbing the active session", async (t) => {
  const fixture = createPlaybackFixture({
    controlOverrides: {
      enqueue: async () => {
        throw new Error("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
      },
    },
  });
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const response = await server.request("/api/control", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({ action: "enqueue", song: "airhorn" }),
  });
  assert.equal(response.status, 409);
  assert.match(await response.text(), /at least one human/);

  const playback = await server.request("/api/playback", {
    headers: { authorization: authHeader() },
  });
  assert.equal(playback.status, 200);
  const playbackBody = await playback.json();
  assert.equal(playbackBody.snapshot.current, null);
  assert.deepEqual(playbackBody.snapshot.queue, []);
});

test("duration failures and cache behavior do not break library or playback", async (t) => {
  const fixture = createPlaybackFixture({
    mediaMetadata: { getDurationMs: async () => { throw new Error("probe crashed"); } },
  });
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const library = await server.request("/api/library", { headers: { authorization: authHeader() } });
  assert.equal(library.status, 200);
  const libraryBody = await library.json();
  assert.ok(libraryBody.tracks.every((entry) => entry.durationMs === null));

  const playback = await server.request("/api/playback", { headers: { authorization: authHeader() } });
  assert.equal(playback.status, 200);
});

test("new endpoints work through the prefix-stripping proxy with relative URLs", async (t) => {
  const fixture = createPlaybackFixture();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const proxyApp = express();
  proxyApp.use("/discord", fixture.app);
  const server = await startApp(proxyApp);
  t.after(server.close);

  const panel = await server.request("/discord/", { headers: { authorization: authHeader() } });
  assert.equal(panel.status, 200);
  const html = await panel.text();
  assert.match(html, /fetch\('api\/playback'/);
  assert.match(html, /fetch\('api\/library'/);
  assert.match(html, /fetch\('api\/control'/);
  assert.doesNotMatch(html, /\/discord\//);
  assert.match(html, /js-enqueue/);
  assert.match(html, /js-skip/);
  assert.match(html, /queueList/);
  assert.match(html, /volumeRange/);
  assert.match(html, /loopToggle/);
  assert.doesNotMatch(html, /innerHTML/);
  assert.match(html, /playbackInFlight/);
  assert.match(html, /libraryLoaded/);
  assert.doesNotMatch(html, /refreshAll/);

  const playback = await server.request("/discord/api/playback", {
    headers: { authorization: authHeader() },
  });
  assert.equal(playback.status, 200);
  const library = await server.request("/discord/api/library", {
    headers: { authorization: authHeader() },
  });
  assert.equal(library.status, 200);
  const skip = await server.request("/discord/api/control", {
    method: "POST",
    headers: controlHeaders(),
    body: JSON.stringify({ action: "skip" }),
  });
  assert.equal(skip.status, 200);
});

test("rendering escapes filesystem-derived and target names in the new panel", async (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-escape-"));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const musicDir = path.join(fixtureDir, "music");
  const stagingDir = path.join(fixtureDir, "staging");
  fs.mkdirSync(musicDir);
  fs.writeFileSync(path.join(musicDir, "ok.mp3"), "audio");
  const catalog = {
    musicDir,
    getCategories: () => ['<script>alert("category")</script>'],
    getMusicStructure: () => ({ '<img src=x onerror=alert(1)>': ['<script>alert("track")</script>'] }),
    safeResolveMp3: () => null,
  };
  const app = createWebApp({
    config: { webUser: "uploader", webPass: "secret" },
    catalog,
    controlHandlers: {
      play: async () => {},
      stop: async () => {},
      getSnapshot: async () => ({
        guildId: "g",
        channelId: "c",
        guildName: '<script>alert("guild")</script>',
        channelName: '<img src=x onerror=alert(1)>',
        status: "playing",
        playerStatus: "playing",
        current: { song: '<script>alert("now")</script>', elapsedMs: 0 },
        queue: [{ id: 1, song: '<b>queued</b>' }],
        volume: 100,
        loop: false,
        revision: 1,
      }),
    },
    csrfToken: "test-csrf-token",
    logger: { error() {}, info() {}, log() {} },
    uploadOptions: { stagingDir },
    validateAudio: async () => true,
    mediaMetadata: { getDurationMs: async () => null },
  });
  const server = await startApp(app);
  t.after(server.close);

  const panel = await server.request("/", { headers: { authorization: authHeader() } });
  const html = await panel.text();
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>alert\("track"\)<\/script>/);

  const playback = await server.request("/api/playback", { headers: { authorization: authHeader() } });
  const body = await playback.json();
  assert.equal(body.snapshot.guildName, '<script>alert("guild")</script>');
  assert.ok(!JSON.stringify(body).includes(musicDir));
});
