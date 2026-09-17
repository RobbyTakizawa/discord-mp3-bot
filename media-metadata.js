const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_MAX_CONCURRENT_PROBES = 4;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

function createMediaMetadata({
  execFileImpl = execFile,
  fileSystem = fs,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  maxConcurrent = DEFAULT_MAX_CONCURRENT_PROBES,
  ffprobeCommand = "ffprobe",
} = {}) {
  const cache = new Map();
  const inFlight = new Map();
  let activeProbes = 0;
  const waiters = [];

  function acquire() {
    if (activeProbes < maxConcurrent) {
      activeProbes += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    activeProbes = Math.max(0, activeProbes - 1);
    const next = waiters.shift();
    if (next) {
      activeProbes += 1;
      next();
    }
  }

  function statKey(filePath) {
    try {
      const resolved = path.resolve(filePath);
      const stats = fileSystem.statSync(resolved);
      if (!stats.isFile()) return null;
      return {
        key: resolved,
        size: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
      };
    } catch {
      return null;
    }
  }

  function probeDuration(filePath) {
    return new Promise((resolve) => {
      execFileImpl(ffprobeCommand, [
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filePath,
      ], {
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
      }, (err, stdout) => {
        if (err) return resolve(null);
        const seconds = Number.parseFloat(String(stdout || "").trim());
        if (!Number.isFinite(seconds) || seconds <= 0) return resolve(null);
        const durationMs = Math.round(seconds * 1000);
        if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_DURATION_MS) {
          return resolve(null);
        }
        return resolve(durationMs);
      });
    });
  }

  async function getDurationMs(filePath) {
    const stat = statKey(filePath);
    if (!stat) return null;
    const cached = cache.get(stat.key);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.durationMs;
    }
    const ongoing = inFlight.get(stat.key);
    if (ongoing) {
      try {
        return await ongoing;
      } catch {
        return null;
      }
    }
    const probePromise = (async () => {
      await acquire();
      try {
        const fresh = statKey(filePath);
        if (!fresh) {
          cache.delete(stat.key);
          return null;
        }
        const rechecked = cache.get(fresh.key);
        if (rechecked && rechecked.size === fresh.size && rechecked.mtimeMs === fresh.mtimeMs) {
          return rechecked.durationMs;
        }
        const durationMs = await probeDuration(fresh.key);
        cache.set(fresh.key, { size: fresh.size, mtimeMs: fresh.mtimeMs, durationMs });
        if (cache.size > 5000) {
          const oldest = cache.keys().next();
          if (!oldest.done) cache.delete(oldest.value);
        }
        return durationMs;
      } finally {
        release();
      }
    })();
    inFlight.set(stat.key, probePromise);
    try {
      return await probePromise;
    } finally {
      if (inFlight.get(stat.key) === probePromise) inFlight.delete(stat.key);
    }
  }

  function clearCache() {
    cache.clear();
    inFlight.clear();
  }

  function cacheSize() {
    return cache.size;
  }

  return { cacheSize, clearCache, getDurationMs };
}

module.exports = {
  DEFAULT_MAX_CONCURRENT_PROBES,
  DEFAULT_PROBE_TIMEOUT_MS,
  createMediaMetadata,
};
