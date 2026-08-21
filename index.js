const fs = require("fs");

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  entersState,
} = require("@discordjs/voice");

const { loadConfig, validateConfig } = require("./config");
const { createCatalog } = require("./catalog");
const { createDiscordAdapter } = require("./discord-adapter");
const { createWebApp } = require("./web-app");
const { runRuntimePreflight } = require("./runtime-preflight");
const { createVoiceSession } = require("./voice-session");

function createDiscordClient() {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
}

function createRuntime(config, dependencies = {}) {
  fs.mkdirSync(config.musicDir, { recursive: true });

  const catalog = dependencies.catalog || createCatalog({ musicDir: config.musicDir });
  const client = dependencies.client || createDiscordClient();
  const player = dependencies.player || createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  const logger = dependencies.logger || console;
  const voiceSession = dependencies.voiceSession || createVoiceSession({
    player,
    createAudioResource: dependencies.createAudioResource || createAudioResource,
    entersState: dependencies.entersState || entersState,
    joinVoiceChannel: dependencies.joinVoiceChannel || joinVoiceChannel,
    logger,
  });

  const discordAdapter = dependencies.discordAdapter || createDiscordAdapter({
    client,
    catalog,
    config,
    voiceSession,
    logger,
  });
  discordAdapter.attach();

  const app = createWebApp({
    config,
    catalog,
    logger,
    controlHandlers: { play: discordAdapter.playWeb, stop: discordAdapter.stopWeb },
  });

  const runtime = { app, catalog, client, config, discordAdapter, player, voiceSession };
  let shutdownPromise = null;
  runtime.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      const failures = [];
      if (runtime.server?.listening) {
        try {
          await new Promise((resolve, reject) => {
            runtime.server.close((err) => err ? reject(err) : resolve());
          });
        } catch (err) {
          failures.push(err);
        }
      }
      try {
        await voiceSession.shutdown();
      } catch (err) {
        failures.push(err);
      }
      try {
        await client.destroy();
      } catch (err) {
        failures.push(err);
      }
      if (failures.length > 0) throw new AggregateError(failures, "Runtime shutdown failed.");
    })();
    return shutdownPromise;
  };
  return runtime;
}

function main() {
  let config;
  try {
    config = validateConfig(loadConfig());
    runRuntimePreflight();
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return null;
  }

  const runtime = createRuntime(config);
  runtime.client.login(config.token).catch((err) => {
    console.error("Discord login failed:", err);
    process.exitCode = 1;
  });
  runtime.server = runtime.app.listen(config.webPort, config.webHost, () => {
    console.log(`Uploader and remote controller running at http://${config.webHost}:${config.webPort}`);
  });
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down.`);
    try {
      await runtime.shutdown();
    } catch (err) {
      console.error("Graceful shutdown failed:", err);
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  return runtime;
}

if (require.main === module) main();

module.exports = { createDiscordClient, createRuntime, main };
