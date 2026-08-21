const fs = require("fs");

const { Client, GatewayIntentBits } = require("discord.js");
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const { loadConfig, validateConfig } = require("./config");
const { createCatalog } = require("./catalog");
const { createWebApp } = require("./web-app");

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
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  const voice = {
    createAudioResource: dependencies.createAudioResource || createAudioResource,
    entersState: dependencies.entersState || entersState,
    getVoiceConnection: dependencies.getVoiceConnection || getVoiceConnection,
    joinVoiceChannel: dependencies.joinVoiceChannel || joinVoiceChannel,
  };
  const logger = dependencies.logger || console;

  player.on("error", (err) => logger.error("Audio player error:", err));
  player.on("stateChange", (oldState, newState) => {
    logger.log(`Audio player state: ${oldState.status} -> ${newState.status}`);
  });

  async function ensureConnectionReady(guild, voiceChannel) {
    let connection = voice.getVoiceConnection(guild.id);

    if (!connection) {
      logger.log(`Joining voice channel ${voiceChannel.id}`);
      connection = voice.joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: true,
      });
    }

    try {
      await voice.entersState(connection, VoiceConnectionStatus.Ready, 20000);
    } catch (err) {
      logger.error("entersState READY failed:", err);
      throw err;
    }

    return connection;
  }

  async function playDiscord(msg, name) {
    const voiceChannel = msg.member?.voice?.channel;
    if (!voiceChannel) return msg.reply("Join a voice channel first.");

    const filePath = catalog.safeResolveMp3(name);
    if (!filePath) return msg.reply("File not found.");

    try {
      const connection = await ensureConnectionReady(msg.guild, voiceChannel);
      connection.subscribe(player);
      player.play(voice.createAudioResource(filePath));
      return msg.reply(`Playing ${name}`);
    } catch (err) {
      logger.error(err);
      return msg.reply("Failed to play track.");
    }
  }

  function stopDiscord(guildId) {
    player.stop(true);
    const connection = voice.getVoiceConnection(guildId);
    if (connection) connection.destroy();
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
    const connection = await ensureConnectionReady(target.guild, target.channel);
    connection.subscribe(player);
    player.play(voice.createAudioResource(filePath));
    return `Playing ${song}`;
  }

  function stopWeb() {
    player.stop(true);
    client.guilds.cache.forEach((guild) => {
      const connection = voice.getVoiceConnection(guild.id);
      if (connection) connection.destroy();
    });
  }

  const app = createWebApp({
    config,
    catalog,
    logger,
    controlHandlers: { play: playWeb, stop: stopWeb },
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
      stopDiscord(msg.guild.id);
      return msg.reply("Stopped.");
    }
  });

  client.on("voiceStateUpdate", (oldState) => {
    const connection = voice.getVoiceConnection(oldState.guild.id);
    if (!connection) return;

    const channel = oldState.guild.channels.cache.get(connection.joinConfig.channelId);
    if (!channel) return;

    const humans = channel.members.filter((member) => !member.user.bot);
    if (humans.size === 0) connection.destroy();
  });

  return { app, catalog, client, config, player };
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
  return runtime;
}

if (require.main === module) main();

module.exports = { createDiscordClient, createRuntime, main };
