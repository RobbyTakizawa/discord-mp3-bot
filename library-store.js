const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { normalizeSafeBasename, UploadError } = require("./upload-storage");

const MAX_PINS = 500;
const MAX_MOVE_BATCH = 20;

function normalizeSong(value) {
  if (typeof value !== "string" || !value || value.length > 512 || /[\\\p{Cc}\p{Cf}]/u.test(value)) {
    throw new UploadError(400, "Invalid song identifier.", "INVALID_SONG");
  }
  // Library APIs use the exact catalog identifier; a basename can itself end in .mp3.
  const song = value;
  const parts = song.split("/");
  if (parts.length > 2 || parts.some((part) => !part || part === "." || part === "..")) {
    throw new UploadError(400, "Invalid song identifier.", "INVALID_SONG");
  }
  return parts.length === 2 && parts[0] === "uncategorized" ? parts[1] : song;
}

function createLibraryStore({ musicDir, fileSystem = fs }) {
  const root = path.resolve(musicDir);
  const filePath = path.join(root, ".session-board.json");
  let state = { version: 1, revision: 0, pins: [], pendingMove: null };

  function assertDirectory(directory) {
    const stats = fileSystem.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink() || fileSystem.realpathSync(directory) !== directory) {
      throw new UploadError(400, "Library folders must be real directories without symlinks.", "UNSAFE_DIRECTORY");
    }
    return directory;
  }

  // Accept a canonical parent path (macOS /tmp can itself be an alias), but never a symlinked music root.
  if (fileSystem.lstatSync(root).isSymbolicLink()) throw new Error("Music directory must not be a symlink.");
  const canonicalRoot = fileSystem.realpathSync(root);

  function directoryFor(category) {
    assertDirectory(canonicalRoot);
    if (category === "uncategorized") return canonicalRoot;
    const safeName = normalizeSafeBasename(category, "folder name");
    const directory = path.join(canonicalRoot, safeName);
    try {
      return assertDirectory(directory);
    } catch (err) {
      if (err.code === "ENOENT") throw new UploadError(400, "Destination folder does not exist.", "MISSING_DIRECTORY");
      throw err;
    }
  }

  function songPath(song) {
    const normalized = normalizeSong(song);
    const parts = normalized.split("/");
    // Existing catalog names can predate the upload naming policy; preserve their exact spelling.
    assertDirectory(canonicalRoot);
    if (parts.length === 2) {
      try { assertDirectory(path.join(canonicalRoot, parts[0])); } catch (err) {
        if (err.code === "ENOENT") throw new UploadError(404, "Song folder no longer exists.", "MISSING_SONG");
        throw err;
      }
    }
    return path.join(canonicalRoot, `${normalized}.mp3`);
  }

  function statFile(candidate) {
    try {
      const stats = fileSystem.lstatSync(candidate);
      if (!stats.isFile() || stats.isSymbolicLink()) {
        throw new UploadError(400, "Songs must be real files without symlinks.", "UNSAFE_FILE");
      }
      return stats;
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw err;
    }
  }

  function sameFile(stats, identity) {
    return stats && String(stats.dev) === identity.dev && String(stats.ino) === identity.ino;
  }

  function blockedFiles(paths) {
    return new Set(paths.map((candidate) => {
      try { return fileSystem.realpathSync(candidate); } catch { return path.resolve(candidate); }
    }));
  }

  function validState(value) {
    if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
      || !Array.isArray(value.pins) || value.pins.length > MAX_PINS) return false;
    const ids = new Set();
    const songs = new Set();
    for (const pin of value.pins) {
      if (!pin || typeof pin.id !== "string" || !/^[0-9a-f-]{36}$/.test(pin.id)
        || ids.has(pin.id) || songs.has(pin.song) || normalizeSong(pin.song) !== pin.song) return false;
      ids.add(pin.id);
      songs.add(pin.song);
    }
    const move = value.pendingMove;
    return move === null || Boolean(move && normalizeSong(move.from) === move.from
      && normalizeSong(move.to) === move.to && move.from !== move.to
      && /^\d+$/.test(move.identity?.dev) && /^\d+$/.test(move.identity?.ino));
  }

  function persist(next) {
    assertDirectory(canonicalRoot);
    if (fileSystem.existsSync(filePath) && fileSystem.lstatSync(filePath).isSymbolicLink()) {
      throw new Error("Session metadata must not be a symlink.");
    }
    const temporary = path.join(canonicalRoot, `.session-board-${crypto.randomUUID()}.tmp`);
    let descriptor;
    try {
      descriptor = fileSystem.openSync(temporary, "wx", 0o600);
      fileSystem.writeFileSync(descriptor, `${JSON.stringify(next)}\n`);
      fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = undefined;
      fileSystem.renameSync(temporary, filePath);
      state = next;
    } finally {
      if (descriptor !== undefined) fileSystem.closeSync(descriptor);
      try { fileSystem.unlinkSync(temporary); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }

  function commitMove(move) {
    const next = structuredClone(state);
    for (const pin of next.pins) {
      if (pin.song === move.from) pin.song = move.to;
    }
    next.pendingMove = null;
    next.revision += 1;
    persist(next);
  }

  function recoverMove(blockedPaths = []) {
    const move = state.pendingMove;
    if (!move) return;
    const source = songPath(move.from);
    const destination = songPath(move.to);
    const blocked = blockedFiles(blockedPaths);
    if (blocked.has(source) || blocked.has(destination)) {
      throw new UploadError(409, "Stop or unqueue the song involved in the interrupted move before retrying.", "RECOVERY_BUSY");
    }
    const sourceStats = statFile(source);
    const destinationStats = statFile(destination);
    if (sameFile(destinationStats, move.identity)) {
      if (sourceStats) {
        if (!sameFile(sourceStats, move.identity)) throw new Error("Interrupted move has an unexpected source; operator recovery required.");
        fileSystem.unlinkSync(source);
      }
      commitMove(move);
    } else if (sameFile(sourceStats, move.identity)) {
      // Publication never happened (or another destination won). Preserve both existing files.
      persist({ ...state, pendingMove: null });
    } else {
      throw new Error("Interrupted move cannot be recovered safely; restore a library backup before starting.");
    }
  }

  try {
    const metadataStats = fileSystem.lstatSync(filePath);
    if (!metadataStats.isFile() || metadataStats.isSymbolicLink() || metadataStats.size > 2 * 1024 * 1024) {
      throw new Error("Unsafe session metadata file.");
    }
    const saved = JSON.parse(fileSystem.readFileSync(filePath, "utf8"));
    if (!validState(saved)) throw new Error("Invalid session metadata.");
    state = saved;
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error("Cannot load session board; preserve the metadata and restore a valid backup.", { cause: err });
  }
  recoverMove();

  function snapshot() {
    return {
      revision: state.revision,
      pins: state.pins.map((pin) => {
        let available = false;
        try { available = Boolean(statFile(songPath(pin.song))); } catch {}
        return { ...pin, available };
      }),
    };
  }

  function editSession({ action, song, id, direction, revision }, blockedPaths = []) {
    recoverMove(blockedPaths);
    if (!Number.isSafeInteger(revision) || revision !== state.revision) {
      throw new UploadError(409, "The library changed in another window. Refresh and try again.", "STALE_LIBRARY");
    }
    const next = structuredClone(state);
    if (action === "pin") {
      const normalized = normalizeSong(song);
      if (!statFile(songPath(normalized))) throw new UploadError(404, "Song no longer exists.", "MISSING_SONG");
      if (next.pins.some((pin) => pin.song === normalized)) return snapshot();
      if (next.pins.length >= MAX_PINS) throw new UploadError(409, `Session board is limited to ${MAX_PINS} songs.`, "BOARD_FULL");
      next.pins.push({ id: crypto.randomUUID(), song: normalized });
    } else if (action === "clear") {
      next.pins = [];
    } else if (action === "unpin" || action === "reorder") {
      const index = next.pins.findIndex((pin) => pin.id === id);
      if (index < 0) throw new UploadError(404, "Pin no longer exists.", "MISSING_PIN");
      if (action === "unpin") next.pins.splice(index, 1);
      else {
        if (direction !== "up" && direction !== "down") throw new UploadError(400, "Choose up or down.", "INVALID_DIRECTION");
        const target = index + (direction === "up" ? -1 : 1);
        if (target < 0 || target >= next.pins.length) return snapshot();
        [next.pins[index], next.pins[target]] = [next.pins[target], next.pins[index]];
      }
    } else throw new UploadError(400, "Unknown session action.", "INVALID_ACTION");
    next.revision += 1;
    persist(next);
    return snapshot();
  }

  function createFolder(name, blockedPaths = []) {
    recoverMove(blockedPaths);
    assertDirectory(canonicalRoot);
    const normalized = normalizeSafeBasename(name, "folder name");
    if (normalized.toLowerCase() === "uncategorized") {
      throw new UploadError(400, "Uncategorized is reserved for the root folder.", "RESERVED_CATEGORY");
    }
    try { fileSystem.mkdirSync(path.join(canonicalRoot, normalized), { mode: 0o750 }); } catch (err) {
      if (err.code === "EEXIST") throw new UploadError(409, "A folder or file with that name already exists.", "DUPLICATE_CATEGORY");
      throw err;
    }
    return normalized;
  }

  function moveSongs(songs, category, blockedPaths = []) {
    recoverMove(blockedPaths);
    if (!Array.isArray(songs) || songs.length < 1 || songs.length > MAX_MOVE_BATCH) {
      throw new UploadError(400, `Select between 1 and ${MAX_MOVE_BATCH} songs.`, "INVALID_BATCH");
    }
    const normalizedSongs = songs.map(normalizeSong);
    if (new Set(normalizedSongs).size !== normalizedSongs.length) throw new UploadError(400, "Select each song once.", "INVALID_BATCH");
    const directory = directoryFor(category);
    const blocked = blockedFiles(blockedPaths);
    const results = [];
    for (const song of normalizedSongs) {
      try {
        const source = songPath(song);
        const stats = statFile(source);
        if (!stats) throw new UploadError(404, "Song no longer exists.", "MISSING_SONG");
        const destination = path.join(directory, path.basename(source));
        if (source === destination) {
          results.push({ song, status: "unchanged", message: "Already in this folder." });
          continue;
        }
        if (blocked.has(source) || blocked.has(destination)) {
          throw new UploadError(409, "Stop this song or remove it from the queue before moving it.", "SONG_BUSY");
        }
        const to = path.relative(canonicalRoot, destination).split(path.sep).join("/").slice(0, -4);
        if (statFile(destination) || state.pins.some((pin) => pin.song === to)) {
          throw new UploadError(409, "Destination already has this filename or an unavailable pin. Nothing was overwritten.", "DUPLICATE_SONG");
        }
        const move = { from: song, to, identity: { dev: String(stats.dev), ino: String(stats.ino) } };
        persist({ ...state, pendingMove: move });
        // Exclusive publication avoids rename's implicit overwrite. The journal repairs either crash window.
        try { fileSystem.linkSync(source, destination); } catch (err) {
          persist({ ...state, pendingMove: null });
          if (err.code === "EEXIST") throw new UploadError(409, "Destination already has this filename. Nothing was overwritten.", "DUPLICATE_SONG");
          if (err.code === "EXDEV") throw new UploadError(400, "Folders must be on the same filesystem to move songs.", "CROSS_DEVICE_MOVE");
          throw err;
        }
        fileSystem.unlinkSync(source);
        commitMove(move);
        results.push({ song, to, status: "moved", message: "Moved." });
      } catch (err) {
        // Unexpected failures can leave a durable journal. Stop the batch so recovery always precedes further writes.
        if (!(err instanceof UploadError)) throw err;
        results.push({ song, status: "error", message: err.message });
      }
    }
    return results;
  }

  return { createFolder, editSession, moveSongs, snapshot };
}

module.exports = { MAX_MOVE_BATCH, MAX_PINS, createLibraryStore };
