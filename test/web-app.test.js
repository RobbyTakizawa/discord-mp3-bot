const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCatalog } = require("../catalog");
const { renderControlPanel } = require("../render");
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

function createFixtureApp(options = {}) {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-web-"));
  const musicDir = path.join(fixtureDir, "music");
  const stagingDir = path.join(fixtureDir, "staging");
  fs.mkdirSync(musicDir);
  fs.mkdirSync(path.join(musicDir, "effects"));
  fs.writeFileSync(path.join(musicDir, "airhorn.mp3"), "original audio");
  const catalog = createCatalog({ musicDir });
  const calls = [];
  const app = createWebApp({
    config: { webUser: "uploader", webPass: "secret" },
    catalog,
    controlHandlers: {
      play: async (song) => {
        calls.push(["play", song]);
        return `Playing ${song}`;
      },
      stop: async () => calls.push(["stop"]),
    },
    csrfToken: "test-csrf-token",
    rateLimitOptions: {
      authentication: { max: 200 },
      mutation: { max: 200 },
    },
    uploadOptions: { stagingDir, ...options.uploadOptions },
    validateAudio: options.validateAudio || (async () => true),
  });
  return { app, calls, fixtureDir, musicDir, stagingDir };
}

function uploadForm({
  category = "uncategorized",
  customName = "new-track",
  contents = "valid mp3 fixture",
  filename = "source.mp3",
  type = "audio/mpeg",
  csrfToken = "test-csrf-token",
} = {}) {
  const form = new FormData();
  form.append("csrfToken", csrfToken);
  form.append("category", category);
  form.append("mp3Name", customName);
  form.append("mp3", new Blob([contents], { type }), filename);
  return form;
}

function authenticatedPostHeaders(extra = {}) {
  return { authorization: authHeader(), ...extra };
}

function stagingFiles(stagingDir) {
  return fs.existsSync(stagingDir) ? fs.readdirSync(stagingDir) : [];
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

test("web app protects every route, requires CSRF, and supports relative proxy routing", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const unauthenticatedPanel = await server.request("/");
  assert.equal(unauthenticatedPanel.status, 401);
  const unauthenticatedUpload = await server.request("/upload", { method: "POST" });
  assert.equal(unauthenticatedUpload.status, 401);
  const unauthenticatedControl = await server.request("/api/control", { method: "POST" });
  assert.equal(unauthenticatedControl.status, 401);

  const panelResponse = await server.request("/", {
    headers: { authorization: authHeader() },
  });
  const panel = await panelResponse.text();
  assert.equal(panelResponse.status, 200);
  assert.match(panel, /action="upload"/);
  assert.match(panel, /name="csrfToken" value="test-csrf-token"/);
  assert.match(panel, /fetch\('api\/control'/);
  assert.doesNotMatch(panel, /\/discord\//);
  assert.doesNotMatch(panel, /on(?:click|error)=/i);
  assert.equal(panelResponse.headers.get("x-powered-by"), null);
  const csp = panelResponse.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'nonce-/);
  assert.doesNotMatch(csp, /unsafe-inline/);

  const missingCsrf = await server.request("/api/control", {
    method: "POST",
    headers: authenticatedPostHeaders({ "content-type": "application/json" }),
    body: JSON.stringify({ action: "stop" }),
  });
  assert.equal(missingCsrf.status, 403);
  assert.deepEqual(fixture.calls, []);

  const stopResponse = await server.request("/api/control", {
    method: "POST",
    headers: authenticatedPostHeaders({
      "content-type": "application/json",
      "x-csrf-token": "test-csrf-token",
    }),
    body: JSON.stringify({ action: "stop" }),
  });
  assert.equal(stopResponse.status, 200);
  assert.deepEqual(fixture.calls, [["stop"]]);

  const proxyApp = express();
  proxyApp.use("/discord", fixture.app);
  const proxyServer = await startApp(proxyApp);
  t.after(proxyServer.close);

  const proxiedPanelResponse = await proxyServer.request("/discord/", {
    headers: { authorization: authHeader() },
  });
  const proxiedPanel = await proxiedPanelResponse.text();
  assert.equal(proxiedPanelResponse.status, 200);
  assert.match(proxiedPanel, /action="upload"/);

  const proxiedStopResponse = await proxyServer.request("/discord/api/control", {
    method: "POST",
    headers: authenticatedPostHeaders({
      "content-type": "application/json",
      "x-csrf-token": "test-csrf-token",
    }),
    body: JSON.stringify({ action: "stop" }),
  });
  assert.equal(proxiedStopResponse.status, 200);
  assert.deepEqual(fixture.calls, [["stop"], ["stop"]]);
});

test("valid uploads publish from staging into root or an existing category", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const rootResponse = await server.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "Café tone" }),
  });
  assert.equal(rootResponse.status, 200, await rootResponse.text());
  assert.equal(fs.readFileSync(path.join(fixture.musicDir, "Café tone.mp3"), "utf8"), "valid mp3 fixture");

  const categoryResponse = await server.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ category: "effects", customName: "laser" }),
  });
  assert.equal(categoryResponse.status, 200, await categoryResponse.text());
  assert.equal(fs.readFileSync(path.join(fixture.musicDir, "effects", "laser.mp3"), "utf8"), "valid mp3 fixture");
  assert.deepEqual(stagingFiles(fixture.stagingDir), []);
});

test("upload destination policy blocks traversal, unknown categories, and reserved filenames", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  for (const form of [
    uploadForm({ category: "../outside", customName: "escape" }),
    uploadForm({ category: "missing", customName: "escape" }),
    uploadForm({ customName: "../escape" }),
    uploadForm({ customName: "CON" }),
    uploadForm({ customName: ".." }),
    uploadForm({ customName: "bad\u0001name" }),
  ]) {
    const response = await server.request("/upload", {
      method: "POST",
      headers: authenticatedPostHeaders(),
      body: form,
    });
    assert.equal(response.status, 400, await response.text());
  }

  assert.equal(fs.existsSync(path.join(fixture.fixtureDir, "outside", "escape.mp3")), false);
  assert.equal(fs.existsSync(path.join(fixture.fixtureDir, "escape.mp3")), false);
  assert.deepEqual(stagingFiles(fixture.stagingDir), []);
});

test("duplicates are rejected without overwriting the existing track", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const response = await server.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "airhorn", contents: "replacement" }),
  });
  assert.equal(response.status, 409);
  assert.equal(fs.readFileSync(path.join(fixture.musicDir, "airhorn.mp3"), "utf8"), "original audio");
  assert.deepEqual(stagingFiles(fixture.stagingDir), []);
});

test("upload CSRF failures and aborted requests remove staged files", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const csrfResponse = await server.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "csrf-rejected", csrfToken: "wrong-token" }),
  });
  assert.equal(csrfResponse.status, 403);
  assert.equal(fs.existsSync(path.join(fixture.musicDir, "csrf-rejected.mp3")), false);
  assert.equal(await waitFor(() => stagingFiles(fixture.stagingDir).length === 0), true);

  const boundary = "----discordMp3AbortBoundary";
  const multipartStart = [
    `--${boundary}\r\nContent-Disposition: form-data; name="csrfToken"\r\n\r\ntest-csrf-token\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="category"\r\n\r\nuncategorized\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="mp3Name"\r\n\r\naborted\r\n`,
    `--${boundary}\r\nContent-Disposition: form-data; name="mp3"; filename="source.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`,
    "x".repeat(128 * 1024),
  ].join("");

  const request = http.request({
    host: "127.0.0.1",
    port: server.port,
    path: "/upload",
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": `multipart/form-data; boundary=${boundary}`,
      "content-length": Buffer.byteLength(multipartStart) + 1024 * 1024,
    },
  });
  request.on("error", () => {});
  request.write(multipartStart);
  assert.equal(await waitFor(() => stagingFiles(fixture.stagingDir).length > 0), true);
  request.destroy();
  assert.equal(await waitFor(() => stagingFiles(fixture.stagingDir).length === 0), true);
  assert.equal(fs.existsSync(path.join(fixture.musicDir, "aborted.mp3")), false);
});

test("state-changing routes are rate limited without penalizing valid authentication", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.fixtureDir, { recursive: true, force: true }));
  const limitedApp = createWebApp({
    config: { webUser: "uploader", webPass: "secret" },
    catalog: createCatalog({ musicDir: fixture.musicDir }),
    controlHandlers: { play: async () => {}, stop: async () => {} },
    csrfToken: "test-csrf-token",
    uploadOptions: { stagingDir: fixture.stagingDir },
    validateAudio: async () => true,
    rateLimitOptions: {
      authentication: { max: 1 },
      mutation: { max: 1 },
    },
  });
  const server = await startApp(limitedApp);
  t.after(server.close);

  for (let index = 0; index < 3; index += 1) {
    const panel = await server.request("/", { headers: { authorization: authHeader() } });
    assert.equal(panel.status, 200);
  }

  const firstInvalidAuth = await server.request("/", {
    headers: { authorization: authHeader("uploader", "wrong") },
  });
  assert.equal(firstInvalidAuth.status, 401);
  const limitedInvalidAuth = await server.request("/", {
    headers: { authorization: authHeader("uploader", "wrong") },
  });
  assert.equal(limitedInvalidAuth.status, 429);

  const requestOptions = {
    method: "POST",
    headers: authenticatedPostHeaders({
      "content-type": "application/json",
      "x-csrf-token": "test-csrf-token",
    }),
    body: JSON.stringify({ action: "stop" }),
  };
  assert.equal((await server.request("/api/control", requestOptions)).status, 200);
  const limited = await server.request("/api/control", requestOptions);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);
});

test("invalid, misleading, and oversized uploads are rejected and cleaned up", async (t) => {
  const invalidFixture = createFixtureApp({ validateAudio: async () => false });
  t.after(() => fs.rmSync(invalidFixture.fixtureDir, { recursive: true, force: true }));
  const invalidServer = await startApp(invalidFixture.app);
  t.after(invalidServer.close);

  const invalidResponse = await invalidServer.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "invalid" }),
  });
  assert.equal(invalidResponse.status, 415);
  assert.equal(fs.existsSync(path.join(invalidFixture.musicDir, "invalid.mp3")), false);
  assert.deepEqual(stagingFiles(invalidFixture.stagingDir), []);

  const mimeResponse = await invalidServer.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "text", type: "text/plain" }),
  });
  assert.equal(mimeResponse.status, 415);
  assert.deepEqual(stagingFiles(invalidFixture.stagingDir), []);

  const oversizedFixture = createFixtureApp({ uploadOptions: { maxFileSize: 8 } });
  t.after(() => fs.rmSync(oversizedFixture.fixtureDir, { recursive: true, force: true }));
  const oversizedServer = await startApp(oversizedFixture.app);
  t.after(oversizedServer.close);
  const oversizedResponse = await oversizedServer.request("/upload", {
    method: "POST",
    headers: authenticatedPostHeaders(),
    body: uploadForm({ customName: "too-big", contents: "0123456789abcdef" }),
  });
  assert.equal(oversizedResponse.status, 413);
  assert.equal(fs.existsSync(path.join(oversizedFixture.musicDir, "too-big.mp3")), false);
  assert.deepEqual(stagingFiles(oversizedFixture.stagingDir), []);
});

test("rendering escapes filesystem-derived labels", () => {
  const html = renderControlPanel({
    categories: ['<script>alert("category")</script>'],
    musicStructure: {
      '<img src=x onerror=alert(1)>': ['<script>alert("track")</script>'],
    },
    csrfToken: "safe-token",
    nonce: "safe-nonce",
  });

  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\("track"\)<\/script>/);
});
