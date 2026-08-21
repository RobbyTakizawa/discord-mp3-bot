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
const { createOperationalLogger } = require("./operational-logger");
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

function createRuntimeState(client) {
  let discordAuthenticated = false;
  let shuttingDown = false;

  return {
    setDiscordAuthenticated(value) {
      discordAuthenticated = Boolean(value);
    },
    setShuttingDown(value) {
      shuttingDown = Boolean(value);
    },
    snapshot() {
      const clientReady = typeof client.isReady !== "function" || client.isReady();
      const discordReady = discordAuthenticated && clientReady;
      return {
        discordReady,
        ready: discordReady && !shuttingDown,
        shuttingDown,
      };
    },
  };
}

function createRuntime(config, dependencies = {}) {
  fs.mkdirSync(config.musicDir, { recursive: true });

  const catalog = dependencies.catalog || createCatalog({ musicDir: config.musicDir });
  const client = dependencies.client || createDiscordClient();
  const player = dependencies.player || createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Stop },
  });
  const logger = dependencies.logger || console;
  const runtimeState = dependencies.runtimeState || createRuntimeState(client);
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
    runtimeState,
    controlHandlers: { play: discordAdapter.playWeb, stop: discordAdapter.stopWeb },
  });

  const runtime = {
    app,
    catalog,
    client,
    config,
    discordAdapter,
    logger,
    player,
    runtimeState,
    voiceSession,
  };
  let shutdownPromise = null;
  runtime.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    runtimeState.setDiscordAuthenticated(false);
    runtimeState.setShuttingDown(true);
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

function listen(runtime) {
  return new Promise((resolve, reject) => {
    const server = runtime.app.listen(runtime.config.webPort, runtime.config.webHost);
    runtime.server = server;
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    const onError = (err) => {
      server.off("listening", onListening);
      reject(err);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function startRuntime(runtime) {
  try {
    const server = await listen(runtime);
    runtime.logger.info?.("http_listening", {
      host: runtime.config.webHost,
      port: server.address()?.port || runtime.config.webPort,
    });
  } catch (err) {
    runtime.logger.error("http_listen_failed", err);
    await runtime.shutdown().catch((shutdownErr) => {
      runtime.logger.error("startup_cleanup_failed", shutdownErr);
    });
    throw err;
  }

  try {
    await runtime.client.login(runtime.config.token);
    runtime.runtimeState.setDiscordAuthenticated(true);
    runtime.logger.info?.("discord_ready", {
      guildCount: runtime.client.guilds?.cache?.size || 0,
    });
    return runtime;
  } catch (err) {
    runtime.runtimeState.setDiscordAuthenticated(false);
    runtime.logger.error("discord_login_failed", err);
    await runtime.shutdown().catch((shutdownErr) => {
      runtime.logger.error("startup_cleanup_failed", shutdownErr);
    });
    throw err;
  }
}

async function main(dependencies = {}) {
  const logger = dependencies.logger || createOperationalLogger();
  let config;
  try {
    config = validateConfig((dependencies.loadConfig || loadConfig)());
    (dependencies.runRuntimePreflight || runRuntimePreflight)();
  } catch (err) {
    logger.error("startup_preflight_failed", err);
    process.exitCode = 1;
    return null;
  }

  let runtime;
  try {
    runtime = createRuntime(config, { ...dependencies, logger });
  } catch (err) {
    logger.error("runtime_initialization_failed", err);
    process.exitCode = 1;
    return null;
  }
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info?.("shutdown_started", { signal });
    try {
      await runtime.shutdown();
      logger.info?.("shutdown_completed", { signal });
    } catch (err) {
      logger.error("shutdown_failed", err, { signal });
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  try {
    return await startRuntime(runtime);
  } catch {
    process.exitCode = 1;
    return null;
  }
}

if (require.main === module) void main();

module.exports = {
  createDiscordClient,
  createRuntime,
  createRuntimeState,
  listen,
  main,
  startRuntime,
};
