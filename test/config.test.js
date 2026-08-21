const assert = require("node:assert/strict");
const test = require("node:test");

const { loadConfig, validateConfig } = require("../config");

test("Discord access-control configuration is optional and parsed from environment values", () => {
  const config = loadConfig({
    DISCORD_ALLOWED_GUILD_IDS: "123456789012345678, 234567890123456789",
    DISCORD_COMMAND_COOLDOWN_MS: "1500",
    DISCORD_CONTROLLER_ROLE_IDS: "345678901234567890",
    WEB_PASS: "password",
    WEB_PORT: "3001",
  }, "/tmp/discord-config-fixture");

  assert.deepEqual(config.discordAllowedGuildIds, ["123456789012345678", "234567890123456789"]);
  assert.deepEqual(config.discordControllerRoleIds, ["345678901234567890"]);
  assert.equal(config.discordCommandCooldownMs, 1500);
  assert.equal(validateConfig(config, { requireToken: false }), config);
});

test("Discord access-control configuration rejects invalid IDs and cooldowns", () => {
  const invalidId = loadConfig({ DISCORD_ALLOWED_GUILD_IDS: "not-an-id" });
  assert.throws(
    () => validateConfig(invalidId, { requireToken: false, requireWebPass: false }),
    /DISCORD_ALLOWED_GUILD_IDS/,
  );

  const invalidCooldown = loadConfig({ DISCORD_COMMAND_COOLDOWN_MS: "1.5" });
  assert.throws(
    () => validateConfig(invalidCooldown, { requireToken: false, requireWebPass: false }),
    /DISCORD_COMMAND_COOLDOWN_MS/,
  );
});

test("web listener and credential configuration is validated at startup", () => {
  assert.throws(
    () => validateConfig(loadConfig({ WEB_HOST: "bad host" }), {
      requireToken: false,
      requireWebPass: false,
    }),
    /WEB_HOST/,
  );
  assert.throws(
    () => validateConfig(loadConfig({ WEB_USER: "bad:user" }), {
      requireToken: false,
      requireWebPass: false,
    }),
    /WEB_USER/,
  );
  assert.throws(
    () => validateConfig(loadConfig({}), { requireToken: false }),
    /WEB_PASS/,
  );

  const config = loadConfig({ WEB_HOST: "::1", WEB_PASS: "password" });
  assert.equal(validateConfig(config, { requireToken: false }), config);
});
