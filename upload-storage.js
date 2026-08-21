const { execFile } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;
const RESERVED_WINDOWS_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SAFE_BASENAME = /^[\p{L}\p{N}][\p{L}\p{N} _().\[\]-]*$/u;

class UploadError extends Error {
  constructor(status, message, code) {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

function normalizeSafeBasename(value, label = "name") {
  if (typeof value !== "string") {
    throw new UploadError(400, `Invalid ${label}.`, "INVALID_NAME");
  }

  const normalized = value.normalize("NFC").trim();
  const characterCount = Array.from(normalized).length;
  if (!normalized || characterCount > 100 || normalized === "." || normalized === "..") {
    throw new UploadError(400, `Invalid ${label}.`, "INVALID_NAME");
  }
  if (normalized.endsWith(".") || /[\/\\\p{Cc}\p{Cf}]/u.test(normalized)) {
    throw new UploadError(400, `Invalid ${label}.`, "INVALID_NAME");
  }
  if (!SAFE_BASENAME.test(normalized) || RESERVED_WINDOWS_NAME.test(normalized)) {
    throw new UploadError(400, `Invalid ${label}.`, "INVALID_NAME");
  }

  return normalized;
}

function isContained(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function canonicalDirectory(directory, label) {
  let stats;
  try {
    stats = fs.lstatSync(directory);
  } catch {
    throw new UploadError(400, `${label} does not exist.`, "MISSING_DIRECTORY");
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new UploadError(400, `${label} must be a real directory.`, "UNSAFE_DIRECTORY");
  }

  return fs.realpathSync(directory);
}

function resolveUploadDestination({ musicDir, category, customName, originalName }) {
  const canonicalMusicDir = canonicalDirectory(path.resolve(musicDir), "Music directory");
  const requestedCategoryValue = category || "uncategorized";
  if (typeof requestedCategoryValue !== "string") {
    throw new UploadError(400, "Invalid category.", "INVALID_CATEGORY");
  }
  const normalizedCategory = requestedCategoryValue.normalize("NFC").trim();
  let targetDirectory = canonicalMusicDir;

  if (normalizedCategory !== "uncategorized") {
    const safeCategory = normalizeSafeBasename(normalizedCategory, "category");
    const requestedCategory = path.resolve(canonicalMusicDir, safeCategory);
    if (!isContained(canonicalMusicDir, requestedCategory) || path.dirname(requestedCategory) !== canonicalMusicDir) {
      throw new UploadError(400, "Invalid category.", "INVALID_CATEGORY");
    }
    targetDirectory = canonicalDirectory(requestedCategory, "Category");
    if (!isContained(canonicalMusicDir, targetDirectory) || path.dirname(targetDirectory) !== canonicalMusicDir) {
      throw new UploadError(400, "Category symlinks are not allowed.", "UNSAFE_CATEGORY");
    }
  }

  if (customName !== undefined && typeof customName !== "string") {
    throw new UploadError(400, "Invalid filename.", "INVALID_NAME");
  }
  let requestedName = customName && customName.trim()
    ? customName
    : path.basename(String(originalName || "").replaceAll("\\", "/"));
  if (/\.mp3$/i.test(requestedName)) requestedName = requestedName.slice(0, -4);
  const safeName = normalizeSafeBasename(requestedName, "filename");
  const destination = path.resolve(targetDirectory, `${safeName}.mp3`);

  if (!isContained(canonicalMusicDir, destination) || path.dirname(destination) !== targetDirectory) {
    throw new UploadError(400, "Invalid upload destination.", "UNSAFE_DESTINATION");
  }

  try {
    fs.lstatSync(destination);
    throw new UploadError(409, "A track with that name already exists.", "DUPLICATE_UPLOAD");
  } catch (err) {
    if (err instanceof UploadError) throw err;
    if (err.code !== "ENOENT") throw err;
  }

  return {
    destination,
    relativePath: path.relative(canonicalMusicDir, destination),
  };
}

function validateMp3WithFfprobe(filePath, {
  command = "ffprobe",
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS,
  execFileImpl = execFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=codec_name,codec_type",
      "-of", "json",
      filePath,
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) {
        if (err.code === "ENOENT") {
          return reject(new UploadError(500, "FFprobe is required to validate uploads.", "FFPROBE_MISSING"));
        }
        return resolve(false);
      }

      try {
        const result = JSON.parse(stdout);
        return resolve(Array.isArray(result.streams) && result.streams.some((stream) => (
          stream.codec_type === "audio" && stream.codec_name === "mp3"
        )));
      } catch {
        return resolve(false);
      }
    });
  });
}

function validateDecodeWithFfmpeg(filePath, {
  command = "ffmpeg",
  timeoutMs,
  execFileImpl = execFile,
} = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, [
      "-v", "error",
      "-nostdin",
      "-i", filePath,
      "-map", "0:a:0",
      "-t", "30",
      "-f", "null",
      "-",
    ], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
    }, (err) => {
      if (err?.code === "ENOENT") {
        return reject(new UploadError(500, "FFmpeg is required to validate uploads.", "FFMPEG_MISSING"));
      }
      return resolve(!err);
    });
  });
}

async function validateMp3Audio(filePath, {
  timeoutMs = DEFAULT_VALIDATION_TIMEOUT_MS,
  execFileImpl = execFile,
  ffprobeCommand = "ffprobe",
  ffmpegCommand = "ffmpeg",
} = {}) {
  const startedAt = Date.now();
  const hasMp3Stream = await validateMp3WithFfprobe(filePath, {
    command: ffprobeCommand,
    timeoutMs: Math.min(3_000, timeoutMs),
    execFileImpl,
  });
  if (!hasMp3Stream) return false;

  const remainingMs = timeoutMs - (Date.now() - startedAt);
  if (remainingMs <= 0) return false;
  return validateDecodeWithFfmpeg(filePath, {
    command: ffmpegCommand,
    timeoutMs: remainingMs,
    execFileImpl,
  });
}

function createStagingDirectory(musicDir, requestedStagingDir) {
  const resolvedMusicDir = path.resolve(musicDir);
  const stagingDir = path.resolve(requestedStagingDir || path.join(
    path.dirname(resolvedMusicDir),
    ".discord-mp3-upload-staging",
  ));
  if (isContained(resolvedMusicDir, stagingDir)) {
    throw new Error("Upload staging directory must be outside the music catalog.");
  }

  fs.mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(stagingDir);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("Upload staging path must be a real directory.");
  }
  return fs.realpathSync(stagingDir);
}

function createStagingStorage(multer, musicDir, { stagingDir } = {}) {
  const canonicalStagingDir = createStagingDirectory(musicDir, stagingDir);
  const storage = multer.diskStorage({
    destination: (req, file, callback) => callback(null, canonicalStagingDir),
    filename: (req, file, callback) => {
      const stagedName = `${crypto.randomUUID()}.upload`;
      req.stagedUploadPath = path.join(canonicalStagingDir, stagedName);
      callback(null, stagedName);
    },
  });
  return { canonicalStagingDir, storage };
}

async function publishUpload({ musicDir, file, fields, validateAudio = validateMp3Audio }) {
  if (!file?.path) throw new UploadError(400, "No MP3 file was uploaded.", "MISSING_FILE");

  const stagedPath = file.path;
  try {
    const destination = resolveUploadDestination({
      musicDir,
      category: fields.category,
      customName: fields.mp3Name,
      originalName: file.originalname,
    });
    if (!await validateAudio(stagedPath)) {
      throw new UploadError(415, "The uploaded file is not valid MP3 audio.", "INVALID_AUDIO");
    }

    try {
      await fs.promises.link(stagedPath, destination.destination);
    } catch (err) {
      if (err.code === "EEXIST") {
        throw new UploadError(409, "A track with that name already exists.", "DUPLICATE_UPLOAD");
      }
      throw err;
    }

    await fs.promises.unlink(stagedPath);
    return destination.relativePath;
  } finally {
    await fs.promises.rm(stagedPath, { force: true }).catch(() => {});
  }
}

module.exports = {
  DEFAULT_MAX_UPLOAD_BYTES,
  UploadError,
  createStagingDirectory,
  createStagingStorage,
  normalizeSafeBasename,
  publishUpload,
  resolveUploadDestination,
  validateMp3Audio,
  validateMp3WithFfprobe,
};
