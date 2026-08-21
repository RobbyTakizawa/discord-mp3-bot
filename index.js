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
const { createWebApp } = require("./web-app");
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

  async function playDiscord(msg, name) {
    const voiceChannel = msg.member?.voice?.channel;
    if (!voiceChannel) return msg.reply("Join a voice channel first.");

    const filePath = catalog.safeResolveMp3(name);
    if (!filePath) return msg.reply("File not found.");

    try {
      await voiceSession.play({ guild: msg.guild, channel: voiceChannel, filePath });
      return msg.reply(`Playing ${name}`);
    } catch (err) {
      logger.error(err);
      return msg.reply("Failed to play track.");
    }
  }

  function findWebTarget() {
    for (const [, guild] of client.guilds.cache) {
      const voiceChannels = guild.channels.cache.filter((channel) => channel.isVoiceBased());
      for (const [, channel] of voiceChannels) {
        const humans = channel.members.filter((member) => !member.user.bot);
        if (humans.size > 0) return { channel, guild };
      }
    }

    return null;
  }

  async function playWeb(song, filePath) {
    const target = findWebTarget();
    if (!target) {
      throw new Error("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
    }

    logger.log(`Web Control: Playing "${song}" in channel ${target.channel.name}`);
    await voiceSession.play({ guild: target.guild, channel: target.channel, filePath });
    return `Playing ${song}`;
  }

  const app = createWebApp({
    config,
    catalog,
    logger,
    controlHandlers: { play: playWeb, stop: () => voiceSession.stop() },
  });

  client.on("messageCreate", async (msg) => {
    if (msg.author.bot) return;
    if (!msg.content.startsWith(config.prefix)) return;

    const [cmd, ...args] = msg.content.slice(config.prefix.length).trim().split(/\s+/);

    if (cmd === "help") {
      return msg.reply(`Commands:
!list
!play <category/name or name>
!stop`);
    }

    if (cmd === "list") {
      const structure = catalog.getMusicStructure();
      let replyStr = "";

      for (const [category, tracks] of Object.entries(structure)) {
        replyStr += `**[${category.toUpperCase()}]**\n`;
        tracks.forEach((track) => {
          replyStr += `  ${category === "uncategorized" ? "" : category + "/"}${track}\n`;
        });
      }

      return msg.reply(replyStr || "No MP3 files found.");
    }

    if (cmd === "play") {
      const name = args.join(" ");
      if (!name) return msg.reply("Usage: !play <name> or !play <category/name>");
      return playDiscord(msg, name);
    }

    if (cmd === "stop") {
      try {
        await voiceSession.stop();
        return msg.reply("Stopped.");
      } catch (err) {
        logger.error("Discord stop failed:", err);
        return msg.reply("Failed to stop playback.");
      }
    }
  });

  client.on("voiceStateUpdate", (oldState) => {
    voiceSession.handleVoiceStateUpdate(oldState).catch((err) => {
      logger.error("Voice-state handling failed:", err);
    });
  });

  const runtime = { app, catalog, client, config, player, voiceSession };
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
