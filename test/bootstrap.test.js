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
