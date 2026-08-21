const assert = require("node:assert/strict");
const test = require("node:test");

const { createOperationalLogger } = require("../operational-logger");

function captureStream(chunks) {
  return { write: (chunk) => chunks.push(chunk) };
}

test("operational logger emits concise JSON and omits secret-named fields", () => {
  const stdout = [];
  const stderr = [];
  const logger = createOperationalLogger({
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    stdout: captureStream(stdout),
    stderr: captureStream(stderr),
  });

  logger.info("http_listening", {
    host: "127.0.0.1",
    port: 3000,
    authorization: "must-not-appear",
  });
  logger.error("discord_login_failed", Object.assign(new Error("bad credentials"), { code: "AUTH" }), {
    token: "must-not-appear",
  });

  assert.deepEqual(JSON.parse(stdout[0]), {
    timestamp: "2026-08-21T12:00:00.000Z",
    level: "info",
    event: "http_listening",
    host: "127.0.0.1",
    port: 3000,
  });
  assert.deepEqual(JSON.parse(stderr[0]), {
    timestamp: "2026-08-21T12:00:00.000Z",
    level: "error",
    event: "discord_login_failed",
    error: { name: "Error", message: "bad credentials", code: "AUTH" },
  });
});
