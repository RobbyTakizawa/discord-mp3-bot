const { execFileSync } = require("node:child_process");

const PREFLIGHT_TIMEOUT_MS = 3_000;

function requireExecutable(command, label, execFileSyncImpl = execFileSync) {
  try {
    execFileSyncImpl(command, ["-version"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      stdio: "pipe",
      timeout: PREFLIGHT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw new Error(`${label} executable \"${command}\" was not found on PATH`);
    }
    throw new Error(`${label} executable \"${command}\" could not run successfully`);
  }
}

function requireOpusEncoder(loadOpusScript = () => require("opusscript")) {
  let OpusScript;
  try {
    OpusScript = loadOpusScript();
  } catch (err) {
    throw new Error(`The opusscript Opus encoder could not be loaded: ${err.message}`);
  }

  let encoder;
  try {
    encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  } catch (err) {
    throw new Error(`The opusscript Opus encoder could not initialize: ${err.message}`);
  } finally {
    encoder?.delete?.();
  }
}

function runRuntimePreflight({
  execFileSyncImpl = execFileSync,
  loadOpusScript,
} = {}) {
  requireExecutable("ffmpeg", "FFmpeg", execFileSyncImpl);
  requireExecutable("ffprobe", "FFprobe", execFileSyncImpl);
  requireOpusEncoder(loadOpusScript);
}

module.exports = { requireExecutable, requireOpusEncoder, runRuntimePreflight };
