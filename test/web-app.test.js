const assert = require("node:assert/strict");
const express = require("express");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCatalog } = require("../catalog");
const { createWebApp } = require("../web-app");
const { renderControlPanel } = require("../render");

function authHeader(user = "uploader", pass = "secret") {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

async function startApp(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    request: (url, options = {}) => fetch(`http://127.0.0.1:${port}${url}`, options),
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
  };
}

function createFixtureApp() {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-web-"));
  fs.writeFileSync(path.join(musicDir, "airhorn.mp3"), "audio");
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
  });
  return { app, calls, musicDir };
}

test("web app is independently constructible and protects every route", async (t) => {
  const fixture = createFixtureApp();
  t.after(() => fs.rmSync(fixture.musicDir, { recursive: true, force: true }));
  const server = await startApp(fixture.app);
  t.after(server.close);

  const unauthenticated = await server.request("/");
  assert.equal(unauthenticated.status, 401);

  const panelResponse = await server.request("/", {
    headers: { authorization: authHeader() },
  });
  const panel = await panelResponse.text();
  assert.equal(panelResponse.status, 200);
  assert.match(panel, /action="upload"/);
  assert.match(panel, /fetch\('api\/control'/);
  assert.doesNotMatch(panel, /\/discord\//);

  const stopResponse = await server.request("/api/control", {
    method: "POST",
    headers: {
      authorization: authHeader(),
      "content-type": "application/json",
    },
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
    headers: {
      authorization: authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ action: "stop" }),
  });
  assert.equal(proxiedStopResponse.status, 200);
  assert.deepEqual(fixture.calls, [["stop"], ["stop"]]);
});

test("rendering escapes filesystem-derived labels", () => {
  const html = renderControlPanel({
    categories: ['<script>alert("category")</script>'],
    musicStructure: {
      '<img src=x onerror=alert(1)>': ['<script>alert("track")</script>'],
    },
  });

  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<script>alert\("track"\)<\/script>/);
});
