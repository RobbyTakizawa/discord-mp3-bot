const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

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
