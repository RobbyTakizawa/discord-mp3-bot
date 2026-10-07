const DISCORD_MESSAGE_LIMIT = 2000;
const { parseDice, parseGoal } = require("./downtime-store");

const SUPPORTED_COMMANDS = new Set([
  "help", "list", "play", "stop", "downtime_goal", "roll_downtime",
  "downtime_progress", "downtime_scoreboard", "undo_downtime",
]);
const CONTROL_COMMANDS = new Set(["play", "stop"]);
const MARKDOWN_CHARACTERS = new Set(["\\", "`", "*", "_", "~", "|", "[", "]", "(", ")", "<", ">", "#"]);

function sanitizeDiscordText(value) {
  const withoutControls = String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "�");
  return Array.from(withoutControls, (character) => (
    MARKDOWN_CHARACTERS.has(character) ? `\\${character}` : character
  )).join("");
}

function parseCommand(content, prefix) {
  if (typeof content !== "string" || !prefix || !content.startsWith(prefix)) return null;
  const commandText = content.slice(prefix.length).trim();
  if (!commandText) return null;
  const [rawCommand, ...args] = commandText.split(/\s+/);
  return {
    command: rawCommand.toLowerCase(),
    argument: args.join(" "),
  };
}

function chunkLines(lines, limit = DISCORD_MESSAGE_LIMIT) {
  const chunks = [];
  let current = "";

  for (const originalLine of lines) {
    let line = String(originalLine);
    if (current && current.length + 1 + line.length <= limit) {
      current += `\n${line}`;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    while (line.length > limit) {
      chunks.push(line.slice(0, limit));
      line = line.slice(limit);
    }
    current = line;
  }

  if (current) chunks.push(current);
  return chunks;
}

function formatCatalogChunks(structure) {
  const lines = [];
  for (const [category, tracks] of Object.entries(structure)) {
    lines.push(`**[${sanitizeDiscordText(category.toUpperCase())}]**`);
    for (const track of tracks) {
      const identifier = category === "uncategorized" ? track : `${category}/${track}`;
      lines.push(`  ${sanitizeDiscordText(identifier)}`);
    }
  }
  return lines.length > 0 ? chunkLines(lines) : ["No MP3 files found."];
}

function messagePayload(content) {
  return {
    content,
    allowedMentions: { parse: [], repliedUser: false },
  };
}

async function sendReply(message, content) {
  return message.reply(messagePayload(content));
}

async function sendCatalog(message, structure) {
  const chunks = formatCatalogChunks(structure);
  await sendReply(message, chunks[0]);
  for (const chunk of chunks.slice(1)) {
    await message.channel.send(messagePayload(chunk));
  }
}

function createDiscordAdapter({
  client,
  catalog,
  config,
  voiceSession,
  downtimeStore,
  logger = console,
  now = Date.now,
}) {
  const allowedGuildIds = new Set(config.discordAllowedGuildIds || []);
  const controllerRoleIds = config.discordControllerRoleIds || [];
  const cooldownMs = config.discordCommandCooldownMs || 0;
  const userCooldowns = new Map();
  let attached = false;

  function isGuildAllowed(message) {
    return allowedGuildIds.size === 0 || allowedGuildIds.has(message.guild?.id);
  }

  function hasControllerRole(message) {
    if (controllerRoleIds.length === 0) return true;
    return controllerRoleIds.some((roleId) => message.member?.roles?.cache?.has(roleId));
  }

  function isCoolingDown(message) {
    if (cooldownMs === 0 || !message.author?.id) return false;
    const currentTime = now();
    const availableAt = userCooldowns.get(message.author.id) || 0;
    if (currentTime < availableAt) return true;
    userCooldowns.set(message.author.id, currentTime + cooldownMs);
    if (userCooldowns.size > 10_000) {
      for (const [userId, expiresAt] of userCooldowns) {
        if (expiresAt <= currentTime) userCooldowns.delete(userId);
      }
    }
    return false;
  }

  async function playDiscord(message, name) {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return sendReply(message, "Join a voice channel first.");

    const filePath = catalog.safeResolveMp3(name);
    if (!filePath) return sendReply(message, "File not found.");

    try {
      await voiceSession.play({ guild: message.guild, channel: voiceChannel, filePath, song: name });
      return sendReply(message, `Playing ${sanitizeDiscordText(name)}`);
    } catch (err) {
      logger.error("Discord play failed:", err);
      return sendReply(message, "Failed to play track.");
    }
  }

  function formatProgress(goal) {
    if (!goal) return "No downtime goal set. Use !downtime_goal set <origin|general> <feat name> [--points N].";
    const label = `${sanitizeDiscordText(goal.name)} (${goal.type})`;
    if (goal.status === "completed") return `${label}: completed at ${goal.target}/${goal.target} points.`;
    return `${label}: ${goal.points}/${goal.target} points; ${goal.target - goal.points} remaining.`;
  }

  async function handleDowntime(message, parsed) {
    if (!downtimeStore) return sendReply(message, "Downtime tracking is unavailable.");
    if (!message.guild?.id || !message.author?.id) return sendReply(message, "Use downtime commands in a server.");
    const guildId = message.guild.id;
    const userId = message.author.id;
    const displayName = message.member?.displayName || message.author.username || userId;
    try {
      if (parsed.command === "downtime_goal") {
        const request = parseGoal(parsed.argument);
        const goal = downtimeStore.setGoal(guildId, userId, displayName, request);
        return sendReply(message, `Downtime goal ${request.action === "replace" ? "replaced" : "set"}: ${formatProgress(goal)}`);
      }
      if (parsed.command === "roll_downtime") {
        const dice = parseDice(parsed.argument);
        const outcome = downtimeStore.roll(guildId, userId, displayName, message.id, dice);
        if (outcome.duplicate) return sendReply(message, "This downtime roll was already recorded.");
        const { goal, roll } = outcome;
        const detail = `${roll.expression} → [${roll.results.join(", ")}]${roll.modifier ? ` + ${roll.modifier}` : ""} = ${roll.total}`;
        return sendReply(message, `${detail}. ${formatProgress(goal)}${goal.status === "completed" ? " Feat earned! Excess points are lost." : ""}`);
      }
      if (parsed.command === "downtime_progress") {
        if (parsed.argument) throw new Error("Use: !downtime_progress.");
        return sendReply(message, formatProgress(downtimeStore.progress(guildId, userId)));
      }
      if (parsed.command === "undo_downtime") {
        if (parsed.argument) throw new Error("Use: !undo_downtime (your own latest roll only).");
        const { goal, roll } = downtimeStore.undo(guildId, userId, displayName);
        return sendReply(message, `Undid your ${roll.expression} roll of ${roll.total} points. ${formatProgress(goal)}`);
      }
      if (parsed.argument) throw new Error("Use: !downtime_scoreboard.");
      const rows = downtimeStore.scoreboard(guildId).sort((a, b) => {
        const aPercent = a.goal.points / a.goal.target;
        const bPercent = b.goal.points / b.goal.target;
        return bPercent - aPercent || a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId);
      });
      if (rows.length === 0) return sendReply(message, "No downtime goals yet.");
      const lines = ["Downtime scoreboard:", ...rows.map(({ userId: id, displayName: name, goal }) => {
        const player = sanitizeDiscordText(name || id);
        const feat = sanitizeDiscordText(goal.name);
        const status = goal.status === "completed" ? " — completed" : "";
        return `${player} (${id}): ${feat} — ${goal.points}/${goal.target} (${Math.floor(100 * goal.points / goal.target)}%)${status}`;
      })];
      const chunks = chunkLines(lines);
      await sendReply(message, chunks[0]);
      for (const chunk of chunks.slice(1)) await message.channel.send(messagePayload(chunk));
      return;
    } catch (err) {
      if (err instanceof Error && !["SyntaxError", "TypeError"].includes(err.name)
        && !err.code) return sendReply(message, err.message);
      logger.error("Discord downtime command failed:", err);
      return sendReply(message, "Downtime tracking failed. No progress was changed.");
    }
  }

  async function handleMessage(message) {
    if (message.author?.bot) return;
    const parsed = parseCommand(message.content, config.prefix);
    if (!parsed || !SUPPORTED_COMMANDS.has(parsed.command)) return;

    if (!isGuildAllowed(message)) {
      return sendReply(message, "This server is not authorized to use the bot.");
    }
    if (CONTROL_COMMANDS.has(parsed.command) && !hasControllerRole(message)) {
      return sendReply(message, "You do not have permission to control playback.");
    }
    if (isCoolingDown(message)) {
      return sendReply(message, "Please wait before using another command.");
    }

    if (parsed.command === "help") {
      const prefix = sanitizeDiscordText(config.prefix);
      return sendReply(message, `Commands:\n${prefix}list\n${prefix}play <category/name or name>\n${prefix}stop\n${prefix}downtime_goal <set|replace> <origin|general> <feat name> [--points N]\n${prefix}roll_downtime <x>dy[+n]\n${prefix}downtime_progress\n${prefix}downtime_scoreboard\n${prefix}undo_downtime`);
    }

    if (parsed.command === "list") {
      return sendCatalog(message, catalog.getMusicStructure());
    }

    if (parsed.command === "play") {
      if (!parsed.argument) {
        return sendReply(message, `Usage: ${sanitizeDiscordText(config.prefix)}play <name> or ${sanitizeDiscordText(config.prefix)}play <category/name>`);
      }
      return playDiscord(message, parsed.argument);
    }

    if (parsed.command !== "stop") return handleDowntime(message, parsed);

    try {
      await voiceSession.stop();
      return sendReply(message, "Stopped.");
    } catch (err) {
      logger.error("Discord stop failed:", err);
      return sendReply(message, "Failed to stop playback.");
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
    await voiceSession.play({ guild: target.guild, channel: target.channel, filePath, song });
    return `Playing ${song}`;
  }

  async function enqueueWeb(song, filePath) {
    const activeConnection = typeof voiceSession.getState === "function"
      ? voiceSession.getState().connection
      : null;
    const fallbackTarget = findWebTarget();
    if (activeConnection) {
      if (fallbackTarget) {
        logger.log(`Web Control: Queueing "${song}" in channel ${fallbackTarget.channel.name}`);
        return voiceSession.enqueue({
          guild: fallbackTarget.guild,
          channel: fallbackTarget.channel,
          song,
          filePath,
        });
      }
      logger.log(`Web Control: Queueing "${song}"`);
      return voiceSession.enqueue({ song, filePath });
    }
    if (!fallbackTarget) {
      throw new Error("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
    }
    logger.log(`Web Control: Queueing "${song}" in channel ${fallbackTarget.channel.name}`);
    return voiceSession.enqueue({ guild: fallbackTarget.guild, channel: fallbackTarget.channel, song, filePath });
  }

  function attach() {
    if (attached) return;
    attached = true;
    client.on("messageCreate", (message) => {
      handleMessage(message).catch((err) => logger.error("Discord command handling failed:", err));
    });
    client.on("voiceStateUpdate", (oldState) => {
      voiceSession.handleVoiceStateUpdate(oldState).catch((err) => {
        logger.error("Voice-state handling failed:", err);
      });
    });
  }

  return {
    attach,
    clearQueueWeb: () => voiceSession.clearQueue(),
    enqueueWeb,
    findWebTarget,
    getPlaybackSnapshot: () => voiceSession.getSnapshot(),
    handleMessage,
    playWeb,
    removeQueuedWeb: (id) => voiceSession.removeQueued(id),
    setLoopWeb: (enabled) => voiceSession.setLoop(enabled),
    setVolumeWeb: (percent) => voiceSession.setVolume(percent),
    skipWeb: () => voiceSession.skip(),
    stopWeb: () => voiceSession.stop(),
  };
}

module.exports = {
  DISCORD_MESSAGE_LIMIT,
  chunkLines,
  createDiscordAdapter,
  formatCatalogChunks,
  parseCommand,
  sanitizeDiscordText,
};
