const path = require("path");
const net = require("node:net");

function parseCommaSeparatedList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadConfig(env = process.env, baseDir = __dirname) {
  const webPort = Number(env.WEB_PORT || 3000);
  const discordCommandCooldownMs = env.DISCORD_COMMAND_COOLDOWN_MS
    ? Number(env.DISCORD_COMMAND_COOLDOWN_MS)
    : 0;

  return {
    token: env.DISCORD_TOKEN,
    prefix: "!",
    discordAllowedGuildIds: parseCommaSeparatedList(env.DISCORD_ALLOWED_GUILD_IDS),
    discordControllerRoleIds: parseCommaSeparatedList(env.DISCORD_CONTROLLER_ROLE_IDS),
    discordCommandCooldownMs,
    musicDir: path.resolve(baseDir, "music"),
    webHost: env.WEB_HOST ?? "127.0.0.1",
    webPort,
    webUser: env.WEB_USER ?? "uploader",
    webPass: env.WEB_PASS,
  };
}

function isValidHostname(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return false;
  if (net.isIP(value)) return true;
  return value.split(".").every((label) => (
    label.length > 0
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}

function validateConfig(config, { requireToken = true, requireWebPass = true } = {}) {
  if (requireToken && (typeof config.token !== "string" || !config.token.trim())) {
    throw new Error("Missing DISCORD_TOKEN env var");
  }

  if (!isValidHostname(config.webHost)) {
    throw new Error("WEB_HOST must be an IP address or hostname");
  }

  if (!Number.isInteger(config.webPort) || config.webPort < 1 || config.webPort > 65535) {
    throw new Error("WEB_PORT must be an integer between 1 and 65535");
  }

  if (typeof config.webUser !== "string"
    || !config.webUser
    || /[:\p{Cc}]/u.test(config.webUser)) {
    throw new Error("WEB_USER must be non-empty and cannot contain a colon or control character");
  }

  if (requireWebPass && (typeof config.webPass !== "string" || !config.webPass)) {
    throw new Error("Missing WEB_PASS env var");
  }

  if (!Number.isInteger(config.discordCommandCooldownMs)
    || config.discordCommandCooldownMs < 0
    || config.discordCommandCooldownMs > 3_600_000) {
    throw new Error("DISCORD_COMMAND_COOLDOWN_MS must be an integer between 0 and 3600000");
  }

  for (const [name, values] of [
    ["DISCORD_ALLOWED_GUILD_IDS", config.discordAllowedGuildIds],
    ["DISCORD_CONTROLLER_ROLE_IDS", config.discordControllerRoleIds],
  ]) {
    if (!Array.isArray(values) || values.some((value) => !/^\d{17,20}$/.test(value))) {
      throw new Error(`${name} must be a comma-separated list of Discord IDs`);
    }
  }

  return config;
}

module.exports = { isValidHostname, loadConfig, parseCommaSeparatedList, validateConfig };
