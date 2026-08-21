const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");

const { createRuntimeState, startRuntime } = require("../index");

test("importing the application does not require a token or start services", () => {
  const result = spawnSync(process.execPath, ["-e", "require('./index')"], {
    cwd: path.resolve(__dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, DISCORD_TOKEN: "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("startup fails before opening services when required credentials are missing", () => {
  const cwd = path.resolve(__dirname, "..");
  const missingToken = spawnSync(process.execPath, ["index.js"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DISCORD_TOKEN: "", WEB_PASS: "password" },
  });
  assert.equal(missingToken.status, 1);
  assert.match(missingToken.stderr, /Missing DISCORD_TOKEN env var/);
  assert.equal(missingToken.stdout, "");

  const missingWebPass = spawnSync(process.execPath, ["index.js"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DISCORD_TOKEN: "test-token", WEB_PASS: "" },
  });
  assert.equal(missingWebPass.status, 1);
  assert.match(missingWebPass.stderr, /Missing WEB_PASS env var/);
  assert.equal(missingWebPass.stdout, "");
});

function createFakeStartupRuntime(login) {
  const events = [];
  const server = new EventEmitter();
  server.address = () => ({ port: 4321 });
  const client = {
    guilds: { cache: new Map() },
    isReady: () => true,
    login,
  };
  const runtimeState = createRuntimeState(client);
  const runtime = {
    app: {
      listen(port, host) {
        events.push(["listen", host, port]);
        queueMicrotask(() => server.emit("listening"));
        return server;
      },
    },
    client,
    config: { token: "test-token", webHost: "127.0.0.1", webPort: 3000 },
    logger: {
      error(event) { events.push(["error", event]); },
      info(event) { events.push(["info", event]); },
    },
    runtimeState,
    async shutdown() { events.push(["shutdown"]); },
  };
  return { events, runtime };
}

test("HTTP starts before Discord login and readiness follows the live client state", async () => {
  let resolveLogin;
  const loginPromise = new Promise((resolve) => { resolveLogin = resolve; });
  const { events, runtime } = createFakeStartupRuntime(async () => {
    events.push(["login"]);
    await loginPromise;
  });

  const startup = startRuntime(runtime);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(0, 3), [
    ["listen", "127.0.0.1", 3000],
    ["info", "http_listening"],
    ["login"],
  ]);
  assert.equal(runtime.runtimeState.snapshot().ready, false);

  resolveLogin();
  await startup;
  assert.equal(runtime.runtimeState.snapshot().ready, true);
  assert.deepEqual(events.at(-1), ["info", "discord_ready"]);
});

test("readiness drops when an authenticated Discord client disconnects or shutdown begins", () => {
  let clientReady = true;
  const runtimeState = createRuntimeState({ isReady: () => clientReady });
  runtimeState.setDiscordAuthenticated(true);
  assert.equal(runtimeState.snapshot().ready, true);

  clientReady = false;
  assert.deepEqual(runtimeState.snapshot(), {
    discordReady: false,
    ready: false,
    shuttingDown: false,
  });

  clientReady = true;
  runtimeState.setShuttingDown(true);
  assert.deepEqual(runtimeState.snapshot(), {
    discordReady: true,
    ready: false,
    shuttingDown: true,
  });
});

test("Discord login rejection is logged and closes the partial runtime", async () => {
  const { events, runtime } = createFakeStartupRuntime(async () => {
    throw new Error("rejected");
  });

  await assert.rejects(startRuntime(runtime), /rejected/);
  assert.equal(runtime.runtimeState.snapshot().ready, false);
  assert.ok(events.some((entry) => entry[0] === "error" && entry[1] === "discord_login_failed"));
  assert.deepEqual(events.at(-1), ["shutdown"]);
});
