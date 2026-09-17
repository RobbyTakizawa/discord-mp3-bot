const fs = require("node:fs");
const path = require("node:path");

const {
  AudioPlayerStatus,
  VoiceConnectionStatus,
} = require("@discordjs/voice");

const MAX_QUEUE_ENTRIES = 100;
const MIN_VOLUME_PERCENT = 0;
const MAX_VOLUME_PERCENT = 100;
const DEFAULT_VOLUME_PERCENT = 100;

function createVoiceSession({
  player,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  logger = console,
  readyTimeoutMs = 20_000,
  reconnectTimeoutMs = 5_000,
  musicDir = null,
  fileSystem = fs,
}) {
  const resolvedMusicDir = musicDir ? path.resolve(musicDir) : null;
  let connection = null;
  let guildId = null;
  let channelId = null;
  let guildName = null;
  let channelName = null;
  let currentResource = null;
  let currentTrack = null;
  let currentEntryId = null;
  let nextEntryId = 1;
  let queue = [];
  let nextQueuedId = 1;
  let loopCurrent = false;
  let volumePercent = DEFAULT_VOLUME_PERCENT;
  let playerStatus = AudioPlayerStatus.Idle;
  let revision = 0;
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

  function bumpRevision() {
    revision += 1;
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

  function snapshotSync() {
    let elapsedMs = 0;
    if (currentResource && Number.isFinite(currentResource.playbackDuration)) {
      elapsedMs = Math.max(0, Math.floor(currentResource.playbackDuration));
    }
    return {
      guildId,
      channelId,
      guildName,
      channelName,
      status: currentTrack ? "playing" : "idle",
      playerStatus,
      current: currentTrack ? { song: currentTrack.song, elapsedMs } : null,
      queue: queue.map((entry) => ({ id: entry.id, song: entry.song })),
      volume: volumePercent,
      loop: loopCurrent,
      revision,
    };
  }

  function getSnapshot() {
    return serialize(() => snapshotSync());
  }

  function isContained(candidate) {
    if (!resolvedMusicDir) return true;
    const relative = path.relative(resolvedMusicDir, candidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }

  function canPlayFile(filePath) {
    if (typeof filePath !== "string" || !filePath) return false;
    if (!resolvedMusicDir) return true;
    try {
      const resolved = path.resolve(filePath);
      if (!isContained(resolved)) return false;
      return fileSystem.statSync(resolved).isFile();
    } catch {
      return false;
    }
  }

  function applyVolume(resource) {
    if (!resource || !resource.volume) return;
    try {
      if (typeof resource.volume.setVolume === "function") {
        resource.volume.setVolume(volumePercent / 100);
      }
    } catch (err) {
      logger.error("Voice volume apply failed:", err);
    }
  }

  function deriveSong(filePath, song) {
    if (typeof song === "string" && song) return song;
    try {
      return path.basename(String(filePath), ".mp3");
    } catch {
      return String(filePath);
    }
  }

  function clearSessionState() {
    const previousConnection = connection;
    connection = null;
    guildId = null;
    channelId = null;
    guildName = null;
    channelName = null;
    currentResource = null;
    currentTrack = null;
    currentEntryId = null;
    queue = [];
    loopCurrent = false;
    playerStatus = AudioPlayerStatus.Idle;
    return previousConnection;
  }

  function stopNow() {
    const hadSession = Boolean(connection || guildId || channelId || currentResource || currentTrack || queue.length > 0 || loopCurrent);
    const previousConnection = clearSessionState();
    bumpRevision();
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

  function clearDestroyedConnection(destroyedConnection) {
    if (connection !== destroyedConnection) return;
    const previousConnection = clearSessionState();
    bumpRevision();
    try {
      player.stop(true);
    } catch (err) {
      logger.error("Voice destruction cleanup failed:", err);
    }
    void previousConnection;
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
          clearDestroyedConnection(newConnection);
        }, "Voice destruction handling failed:");
      }
    });
  }

  function isStaleResourceId(resourceEntryId) {
    if (resourceEntryId === undefined || resourceEntryId === null) return false;
    return resourceEntryId !== currentEntryId;
  }

  async function playNextQueued() {
    while (queue.length > 0) {
      const next = queue[0];
      if (!canPlayFile(next.filePath)) {
        queue.shift();
        bumpRevision();
        logger.error("Queued track is no longer available, skipping:", next.song);
        continue;
      }
      if (!connection) return false;
      const targetConnection = connection;
      const entryId = nextEntryId++;
      let resource;
      try {
        resource = createAudioResource(next.filePath, {
          inlineVolume: true,
          metadata: { entryId },
        });
      } catch (err) {
        queue.shift();
        bumpRevision();
        logger.error("Queued resource creation failed:", err);
        continue;
      }
      applyVolume(resource);
      try {
        await entersState(targetConnection, VoiceConnectionStatus.Ready, readyTimeoutMs);
        if (connection !== targetConnection) {
          nextEntryId -= 1;
          return false;
        }
        if (closed) {
          nextEntryId -= 1;
          return false;
        }
        targetConnection.subscribe(player);
        player.play(resource);
        queue.shift();
        currentResource = resource;
        currentTrack = { song: next.song, filePath: next.filePath };
        currentEntryId = entryId;
        playerStatus = AudioPlayerStatus.Playing;
        bumpRevision();
        return true;
      } catch (err) {
        logger.error("Queued play failed:", err);
        if (connection === targetConnection) {
          try {
            stopNow();
          } catch (cleanupErr) {
            logger.error("Voice play cleanup failed:", cleanupErr);
          }
        }
        return false;
      }
    }
    return false;
  }

  async function handleIdleCompletion(oldState) {
    const oldEntryId = oldState?.resource?.metadata?.entryId;
    if (isStaleResourceId(oldEntryId)) return;
    if (!currentTrack && queue.length === 0) {
      currentResource = null;
      currentEntryId = null;
      playerStatus = AudioPlayerStatus.Idle;
      return;
    }
    if (loopCurrent && currentTrack) {
      if (!canPlayFile(currentTrack.filePath)) {
        logger.error("Loop track is no longer available, advancing:", currentTrack.song);
        currentResource = null;
        currentEntryId = null;
        currentTrack = null;
        playerStatus = AudioPlayerStatus.Idle;
        bumpRevision();
        await playNextQueued();
        if (!currentTrack) {
          playerStatus = AudioPlayerStatus.Idle;
          bumpRevision();
        }
        return;
      }
      const loopTrack = { ...currentTrack };
      const entryId = nextEntryId++;
      let resource;
      try {
        resource = createAudioResource(loopTrack.filePath, {
          inlineVolume: true,
          metadata: { entryId },
        });
      } catch (err) {
        logger.error("Loop resource recreation failed:", err);
        currentResource = null;
        currentEntryId = null;
        currentTrack = null;
        playerStatus = AudioPlayerStatus.Idle;
        bumpRevision();
        await playNextQueued();
        return;
      }
      applyVolume(resource);
      try {
        if (!connection) {
          currentResource = null;
          currentEntryId = null;
          currentTrack = null;
          playerStatus = AudioPlayerStatus.Idle;
          bumpRevision();
          return;
        }
        const targetConnection = connection;
        targetConnection.subscribe(player);
        player.play(resource);
        currentResource = resource;
        currentEntryId = entryId;
        playerStatus = AudioPlayerStatus.Playing;
        bumpRevision();
        return;
      } catch (err) {
        logger.error("Loop replay failed:", err);
        currentResource = null;
        currentEntryId = null;
        currentTrack = null;
        playerStatus = AudioPlayerStatus.Idle;
        bumpRevision();
        return;
      }
    }
    currentResource = null;
    currentEntryId = null;
    const finishedTrack = currentTrack;
    currentTrack = null;
    playerStatus = AudioPlayerStatus.Idle;
    bumpRevision();
    void finishedTrack;
    await playNextQueued();
    if (!currentTrack) {
      playerStatus = AudioPlayerStatus.Idle;
    }
  }

  async function handlePlayerError(err) {
    const errorEntryId = err?.resource?.metadata?.entryId;
    if (isStaleResourceId(errorEntryId)) return;
    if (queue.length === 0) {
      try {
        stopNow();
      } catch (cleanupErr) {
        logger.error("Audio player cleanup failed:", cleanupErr);
      }
      return;
    }
    currentResource = null;
    currentEntryId = null;
    currentTrack = null;
    playerStatus = AudioPlayerStatus.Idle;
    bumpRevision();
    await playNextQueued();
  }

  player.on("error", (err) => {
    logger.error("Audio player error:", err);
    schedule(() => handlePlayerError(err), "Audio player cleanup failed:");
  });
  player.on("stateChange", (oldState, newState) => {
    logger.log(`Audio player state: ${oldState.status} -> ${newState.status}`);
    playerStatus = newState.status;
    if (newState.status === AudioPlayerStatus.Idle) {
      const completedState = oldState;
      schedule(() => handleIdleCompletion(completedState), "Queue advancement failed:");
    }
  });

  async function play({ guild, channel, filePath, song }) {
    return serialize(async () => {
      if (closed) throw new Error("Voice session is shut down.");
      if (!guild || !channel || !filePath) throw new Error("Voice play requires a guild, channel, and file.");

      const trackSong = deriveSong(filePath, song);
      const entryIdForCreation = nextEntryId;
      let resource;
      try {
        resource = createAudioResource(filePath, {
          inlineVolume: true,
          metadata: { entryId: entryIdForCreation },
        });
      } catch (err) {
        logger.error("Voice play failed:", err);
        throw err;
      }
      nextEntryId += 1;
      const entryId = entryIdForCreation;
      applyVolume(resource);

      const sameTarget = connection && guildId === guild.id && channelId === channel.id;

      if (!sameTarget) {
        const preserveLoop = loopCurrent;
        stopNow();
        loopCurrent = preserveLoop;
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
        guildName = guild.name || null;
        channelName = channel.name || null;
        queue = [];
        watchConnection(newConnection);
      } else {
        queue = [];
        guildName = guild.name || guildName;
        channelName = channel.name || channelName;
      }

      const targetConnection = connection;
      try {
        await entersState(targetConnection, VoiceConnectionStatus.Ready, readyTimeoutMs);
        if (connection !== targetConnection) throw new Error("Voice target changed before it became ready.");
        if (closed) throw new Error("Voice session is shut down.");
        targetConnection.subscribe(player);
        player.play(resource);
        currentResource = resource;
        currentTrack = { song: trackSong, filePath };
        currentEntryId = entryId;
        playerStatus = AudioPlayerStatus.Playing;
        bumpRevision();
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

  async function enqueue({ guild, channel, filePath, song }) {
    return serialize(async () => {
      if (closed) throw new Error("Voice session is shut down.");
      if (!filePath || typeof song !== "string" || !song) throw new Error("Queue requires a song identifier and file.");
      if (queue.length >= MAX_QUEUE_ENTRIES) throw new Error("Queue is full.");

      if (currentResource) {
        const id = nextQueuedId++;
        queue.push({ id, song, filePath });
        bumpRevision();
        return snapshotSync();
      }

      if (connection) {
        const id = nextQueuedId++;
        queue.push({ id, song, filePath });
        bumpRevision();
        await playNextQueued();
        return snapshotSync();
      }

      if (!guild || !channel) {
        throw new Error("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
      }
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
      guildName = guild.name || null;
      channelName = channel.name || null;
      watchConnection(newConnection);
      try {
        await entersState(newConnection, VoiceConnectionStatus.Ready, readyTimeoutMs);
      } catch (err) {
        logger.error("Queued play failed:", err);
        try {
          stopNow();
        } catch (cleanupErr) {
          logger.error("Voice play cleanup failed:", cleanupErr);
        }
        throw err;
      }
      if (connection !== newConnection) {
        throw new Error("The bot can't play music from the website unless at least one human user is inside a Discord Voice Channel first!");
      }

      const id = nextQueuedId++;
      queue.push({ id, song, filePath });
      bumpRevision();
      await playNextQueued();
      return snapshotSync();
    });
  }

  function skip() {
    return serialize(async () => {
      if (closed) throw new Error("Voice session is shut down.");
      if (!currentResource && queue.length === 0) return snapshotSync();

      currentEntryId = null;
      currentResource = null;
      currentTrack = null;
      try {
        player.stop(true);
      } catch (err) {
        logger.error("Voice skip stop failed:", err);
      }
      playerStatus = AudioPlayerStatus.Idle;
      bumpRevision();

      if (queue.length === 0) return snapshotSync();
      if (!connection) return snapshotSync();
      await playNextQueued();
      return snapshotSync();
    });
  }

  function removeQueued(id) {
    return serialize(() => {
      if (closed) throw new Error("Voice session is shut down.");
      const numericId = Number(id);
      if (!Number.isInteger(numericId) || numericId < 1) throw new Error("Invalid queue entry id.");
      const index = queue.findIndex((entry) => entry.id === numericId);
      if (index < 0) throw new Error("Queued entry not found.");
      queue.splice(index, 1);
      bumpRevision();
      return snapshotSync();
    });
  }

  function clearQueue() {
    return serialize(() => {
      if (closed) throw new Error("Voice session is shut down.");
      queue = [];
      bumpRevision();
      return snapshotSync();
    });
  }

  function setLoop(enabled) {
    return serialize(() => {
      if (closed) throw new Error("Voice session is shut down.");
      if (typeof enabled !== "boolean") throw new Error("Loop requires a boolean value.");
      loopCurrent = enabled;
      bumpRevision();
      return snapshotSync();
    });
  }

  function setVolume(percent) {
    return serialize(() => {
      if (closed) throw new Error("Voice session is shut down.");
      const numeric = Number(percent);
      if (!Number.isInteger(numeric) || numeric < MIN_VOLUME_PERCENT || numeric > MAX_VOLUME_PERCENT) {
        throw new Error("Volume must be an integer between 0 and 100.");
      }
      volumePercent = numeric;
      applyVolume(currentResource);
      bumpRevision();
      return snapshotSync();
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
    clearQueue,
    enqueue,
    getSnapshot,
    getState,
    handleVoiceStateUpdate,
    play,
    removeQueued,
    setLoop,
    setVolume,
    shutdown,
    skip,
    stop,
    whenSettled,
  };
}

module.exports = {
  DEFAULT_VOLUME_PERCENT,
  MAX_QUEUE_ENTRIES,
  MAX_VOLUME_PERCENT,
  MIN_VOLUME_PERCENT,
  createVoiceSession,
};
