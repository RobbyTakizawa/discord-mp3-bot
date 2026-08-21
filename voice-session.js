const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

function createVoiceSession({
  player,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  logger = console,
  readyTimeoutMs = 20_000,
  reconnectTimeoutMs = 5_000,
}) {
  let connection = null;
  let guildId = null;
  let channelId = null;
  let currentResource = null;
  let operationTail = Promise.resolve();
  let closed = false;

  function serialize(operation) {
    const result = operationTail.then(operation, operation);
    operationTail = result.catch(() => {});
    return result;
  }

  function schedule(operation, failureMessage) {
    serialize(operation).catch((err) => logger.error(failureMessage, err));
  }

  function getState() {
    return {
      guildId,
      channelId,
      connection,
      currentResource,
      closed,
    };
  }

  function clearState() {
    const previousConnection = connection;
    connection = null;
    guildId = null;
    channelId = null;
    currentResource = null;
    return previousConnection;
  }

  function stopNow() {
    const hadSession = Boolean(connection || guildId || channelId || currentResource);
    const previousConnection = clearState();
    const failures = [];
    if (hadSession) {
      try {
        player.stop(true);
      } catch (err) {
        failures.push(err);
      }
    }
    if (previousConnection) {
      try {
        previousConnection.destroy();
      } catch (err) {
        failures.push(err);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Voice session cleanup failed.");
  }

  async function recoverDisconnectedConnection(disconnectedConnection) {
    if (connection !== disconnectedConnection) return;

    try {
      await Promise.race([
        entersState(disconnectedConnection, VoiceConnectionStatus.Signalling, reconnectTimeoutMs),
        entersState(disconnectedConnection, VoiceConnectionStatus.Connecting, reconnectTimeoutMs),
      ]);
    } catch (err) {
      if (connection !== disconnectedConnection) return;
      logger.error("Voice connection recovery failed:", err);
      stopNow();
    }
  }

  function watchConnection(newConnection) {
    newConnection.on("error", (err) => {
      logger.error("Voice connection error:", err);
    });
    newConnection.on("stateChange", (oldState, newState) => {
      logger.log(`Voice connection state: ${oldState.status} -> ${newState.status}`);

      if (newState.status === VoiceConnectionStatus.Disconnected) {
        schedule(
          () => recoverDisconnectedConnection(newConnection),
          "Voice disconnect handling failed:",
        );
      } else if (newState.status === VoiceConnectionStatus.Destroyed) {
        schedule(() => {
          if (connection !== newConnection) return;
          clearState();
          player.stop(true);
        }, "Voice destruction handling failed:");
      }
    });
  }

  player.on("error", (err) => {
    logger.error("Audio player error:", err);
    schedule(() => stopNow(), "Audio player cleanup failed:");
  });
  player.on("stateChange", (oldState, newState) => {
    logger.log(`Audio player state: ${oldState.status} -> ${newState.status}`);
    if (newState.status === AudioPlayerStatus.Idle) currentResource = null;
  });

  async function play({ guild, channel, filePath }) {
    return serialize(async () => {
      if (closed) throw new Error("Voice session is shut down.");

      const resource = createAudioResource(filePath);
      const sameTarget = connection && guildId === guild.id && channelId === channel.id;

      if (!sameTarget) {
        stopNow();
        logger.log(`Joining voice channel ${channel.id}`);
        const newConnection = joinVoiceChannel({
          channelId: channel.id,
          guildId: guild.id,
          adapterCreator: guild.voiceAdapterCreator,
          selfDeaf: true,
        });
        connection = newConnection;
        guildId = guild.id;
        channelId = channel.id;
        watchConnection(newConnection);
      }

      const targetConnection = connection;
      try {
        await entersState(targetConnection, VoiceConnectionStatus.Ready, readyTimeoutMs);
        if (connection !== targetConnection) throw new Error("Voice target changed before it became ready.");
        targetConnection.subscribe(player);
        player.play(resource);
        currentResource = resource;
      } catch (err) {
        if (connection === targetConnection) {
          try {
            stopNow();
          } catch (cleanupErr) {
            logger.error("Voice play cleanup failed:", cleanupErr);
          }
        }
        logger.error("Voice play failed:", err);
        throw err;
      }

      return getState();
    });
  }

  function stop() {
    return serialize(() => {
      stopNow();
    });
  }

  function handleVoiceStateUpdate(oldState) {
    return serialize(() => {
      if (!connection || oldState.guild.id !== guildId) return false;

      const activeChannel = oldState.guild.channels.cache.get(channelId);
      if (!activeChannel) return false;

      const humans = activeChannel.members.filter((member) => !member.user.bot);
      if (humans.size > 0) return false;

      stopNow();
      return true;
    });
  }

  function shutdown() {
    closed = true;
    return serialize(() => {
      stopNow();
    });
  }

  function whenSettled() {
    return operationTail;
  }

  return {
    getState,
    handleVoiceStateUpdate,
    play,
    shutdown,
    stop,
    whenSettled,
  };
}

module.exports = { createVoiceSession };
