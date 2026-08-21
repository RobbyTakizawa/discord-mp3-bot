const path = require("path");

function loadConfig(env = process.env, baseDir = __dirname) {
  const webPort = Number(env.WEB_PORT || 3000);

  return {
    token: env.DISCORD_TOKEN,
    prefix: "!",
    musicDir: path.resolve(baseDir, "music"),
    webHost: env.WEB_HOST || "127.0.0.1",
    webPort,
    webUser: env.WEB_USER || "uploader",
    webPass: env.WEB_PASS,
  };
}

function validateConfig(config, { requireToken = true } = {}) {
  if (requireToken && !config.token) {
    throw new Error("Missing DISCORD_TOKEN env var");
  }

  if (!Number.isInteger(config.webPort) || config.webPort < 1 || config.webPort > 65535) {
    throw new Error("WEB_PORT must be an integer between 1 and 65535");
  }

  return config;
}

module.exports = { loadConfig, validateConfig };
