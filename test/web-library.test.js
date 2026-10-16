const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createCatalog } = require("../catalog");
const { createWebApp } = require("../web-app");

const authorization = `Basic ${Buffer.from("uploader:secret").toString("base64")}`;

async function fixture(t, { prefix = "", max = 200, busyPaths = [], mediaMetadata = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundboard-web-library-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const musicDir = path.join(root, "music");
  const playCalls = [];
  fs.mkdirSync(musicDir);
  fs.writeFileSync(path.join(musicDir, "horn.mp3"), "horn bytes");
  const app = createWebApp({
    config: { webUser: "uploader", webPass: "secret" },
    catalog: createCatalog({ musicDir }),
    controlHandlers: { play: async (song, filePath) => { playCalls.push({ song, filePath }); } },
    mutateLibrary: (operation) => operation(busyPaths),
    mediaMetadata,
    csrfToken: "test-token",
    logger: { error() {}, info() {} },
    uploadOptions: { stagingDir: path.join(root, "staging") },
    rateLimitOptions: { mutation: { max } },
    validateAudio: async () => true,
  });
  const outer = express();
  outer.use(prefix || "/", app);
  const server = http.createServer(outer);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = (route, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${prefix}${route}`, options);
  const post = (route, payload, headers = {}) => request(route, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", "x-csrf-token": "test-token", ...headers },
    body: JSON.stringify(payload),
  });
  return { request, post, musicDir, busyPaths, playCalls };
}

for (const prefix of ["", "/discord"]) {
  test(`folder, move, upload and persistent session routes work at ${prefix || "/"}`, async (t) => {
    const { request, post, musicDir } = await fixture(t, { prefix });
    const folder = await post("/api/folders", { name: "Battle music" });
    assert.equal(folder.status, 201);
    const panel = await request("/", { headers: { authorization } });
    const html = await panel.text();
    assert.match(html, /BATTLE MUSIC \(0\)/);
    assert.match(html, /Next Session/);
    assert.match(html, /moveSelected/);
    assert.match(html, /librarySearch/);
    assert.doesNotMatch(html, /fetch\(['"]\//);
    assert.doesNotMatch(html, /on(?:click|change|submit)=/);
    const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];
    assert.doesNotThrow(() => new vm.Script(script));

    const pinResponse = await post("/api/session", { action: "pin", song: "horn", revision: 0 });
    assert.equal(pinResponse.status, 200);
    const pin = (await pinResponse.json()).session.pins[0];
    const moved = await post("/api/library/move", { songs: ["horn"], category: "Battle music" });
    assert.equal(moved.status, 200);
    assert.equal((await moved.json()).results[0].status, "moved");
    assert.equal(fs.existsSync(path.join(musicDir, "horn.mp3")), false);

    const libraryResponse = await request("/api/library", { headers: { authorization } });
    const library = await libraryResponse.json();
    assert.deepEqual(library.categories, ["Battle music"]);
    assert.deepEqual(library.session.pins, [{ ...pin, song: "Battle music/horn" }]);
    assert.ok(library.tracks.some((track) => track.song === "Battle music/horn"));
    assert.equal(JSON.stringify(library).includes(musicDir), false);
    const stale = await post("/api/session", { action: "clear", revision: 1 });
    assert.equal(stale.status, 409);
    const cleared = await post("/api/session", { action: "clear", revision: library.session.revision });
    assert.equal(cleared.status, 200);
    assert.equal(fs.readFileSync(path.join(musicDir, "Battle music", "horn.mp3"), "utf8"), "horn bytes");

    const form = new FormData();
    form.append("csrfToken", "test-token");
    form.append("category", "Battle music");
    form.append("mp3", new Blob(["audio"], { type: "audio/mpeg" }), "theme.mp3");
    const upload = await request("/upload", { method: "POST", headers: { authorization }, body: form });
    assert.equal(upload.status, 200);
    assert.ok(fs.existsSync(path.join(musicDir, "Battle music", "theme.mp3")));
  });
}

test("every library mutation requires authentication and CSRF and shares the mutation limiter", async (t) => {
  const { request, post, musicDir } = await fixture(t);
  for (const route of ["/api/folders", "/api/library/move", "/api/session"]) {
    assert.equal((await request(route, { method: "POST" })).status, 401);
    assert.equal((await post(route, {}, { "x-csrf-token": "wrong" })).status, 403);
  }
  assert.equal(fs.existsSync(path.join(musicDir, ".session-board.json")), false);
  const limited = await fixture(t, { max: 1 });
  assert.equal((await limited.post("/api/folders", { name: "one" })).status, 201);
  assert.equal((await limited.post("/api/session", { action: "pin", song: "horn", revision: 0 })).status, 429);
});

test("API reports busy and missing songs individually and rejects unsafe destinations", async (t) => {
  const { post, musicDir, busyPaths } = await fixture(t);
  await post("/api/folders", { name: "effects" });
  busyPaths.push(path.join(musicDir, "horn.mp3"));
  const response = await post("/api/library/move", { songs: ["horn", "missing"], category: "effects" });
  assert.equal(response.status, 200);
  const results = (await response.json()).results;
  assert.deepEqual(results.map((entry) => entry.status), ["error", "error"]);
  assert.match(results[0].message, /queue/);
  assert.equal((await post("/api/library/move", { songs: ["horn"], category: "../escape" })).status, 400);
  assert.equal((await post("/api/folders", { name: "uncategorized" })).status, 400);
  assert.equal((await post("/api/library/move", { songs: Array(21).fill("horn"), category: "effects" })).status, 400);
});

test("metadata and rendered pins escape legacy filenames and preserve unavailable entries", async (t) => {
  const { post, request, musicDir } = await fixture(t);
  const song = '<img src=x onerror=alert(1)>';
  fs.writeFileSync(path.join(musicDir, `${song}.mp3`), "legacy");
  const pinned = await post("/api/session", { action: "pin", song, revision: 0 });
  assert.equal(pinned.status, 200);
  fs.unlinkSync(path.join(musicDir, `${song}.mp3`));
  const library = await (await request("/api/library", { headers: { authorization } })).json();
  assert.equal(library.session.pins[0].available, false);
  const html = await (await request("/", { headers: { authorization } })).text();
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /\\u003cimg/);
  assert.doesNotMatch(html, /innerHTML/);
});

test("panel playback resolves exact catalog names before the optional extension alias", async (t) => {
  const { post, musicDir, playCalls } = await fixture(t);
  fs.writeFileSync(path.join(musicDir, "horn.mp3.mp3"), "different song");
  assert.equal((await post("/api/control", { action: "play", song: "horn.mp3" })).status, 200);
  assert.equal(playCalls[0].filePath, path.join(musicDir, "horn.mp3.mp3"));
  fs.unlinkSync(path.join(musicDir, "horn.mp3.mp3"));
  assert.equal((await post("/api/control", { action: "play", song: "horn.mp3" })).status, 200);
  assert.equal(playCalls[1].filePath, path.join(musicDir, "horn.mp3"));
});

test("bounded bulk route accepts twenty Unicode identifiers larger than the control JSON limit", async (t) => {
  const { post, musicDir } = await fixture(t);
  await post("/api/folders", { name: "effects" });
  const songs = Array.from({ length: 20 }, (_, index) => "曲".repeat(80) + index);
  for (const song of songs) fs.writeFileSync(path.join(musicDir, song + ".mp3"), "audio");
  const payload = { songs, category: "effects" };
  assert.ok(Buffer.byteLength(JSON.stringify(payload)) > 4096);
  const moved = await post("/api/library/move", payload);
  assert.equal(moved.status, 200);
  assert.equal((await moved.json()).results.filter((entry) => entry.status === "moved").length, 20);
  const oversized = await post("/api/library/move", { songs: ["x".repeat(70_000)], category: "effects" });
  assert.equal(oversized.status, 413);
});

test("library reads rescan when a move happens during asynchronous duration lookup", async (t) => {
  let probed;
  const started = new Promise((resolve) => { probed = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const { post, request } = await fixture(t, { mediaMetadata: {
    getDurationMs: async () => {
      calls += 1;
      if (calls === 1) { probed(); await gate; }
      return 1000;
    },
  } });
  await post("/api/folders", { name: "effects" });
  const pendingRead = request("/api/library", { headers: { authorization } });
  await started;
  const moved = await post("/api/library/move", { songs: ["horn"], category: "effects" });
  assert.equal(moved.status, 200);
  release();
  const response = await pendingRead;
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).tracks.map((track) => track.song), ["effects/horn"]);
});
