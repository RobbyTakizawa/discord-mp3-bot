const assert = require("node:assert/strict");
const test = require("node:test");

const {
  requireExecutable,
  requireOpusEncoder,
  runRuntimePreflight,
} = require("../runtime-preflight");

test("runtime preflight checks FFmpeg, FFprobe, and an initialized Opus encoder", () => {
  const commands = [];
  let encoderDeleted = false;
  class FakeOpusScript {
    static Application = { AUDIO: 2049 };

    constructor(rate, channels, application) {
      assert.deepEqual([rate, channels, application], [48_000, 2, 2049]);
    }

    delete() {
      encoderDeleted = true;
    }
  }

  runRuntimePreflight({
    execFileSyncImpl(command, args, options) {
      commands.push({ command, args, options });
    },
    loadOpusScript: () => FakeOpusScript,
  });

  assert.deepEqual(commands.map(({ command }) => command), ["ffmpeg", "ffprobe"]);
  assert.ok(commands.every(({ args }) => args[0] === "-version"));
  assert.equal(encoderDeleted, true);
});

test("runtime preflight reports missing and broken executables clearly", () => {
  assert.throws(
    () => requireExecutable("ffmpeg", "FFmpeg", () => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }),
    /FFmpeg executable "ffmpeg" was not found on PATH/,
  );
  assert.throws(
    () => requireExecutable("ffprobe", "FFprobe", () => {
      throw new Error("failed");
    }),
    /FFprobe executable "ffprobe" could not run successfully/,
  );
});

test("runtime preflight reports Opus load and initialization failures clearly", () => {
  assert.throws(
    () => requireOpusEncoder(() => {
      throw new Error("missing module");
    }),
    /opusscript Opus encoder could not be loaded: missing module/,
  );

  class BrokenOpusScript {
    static Application = { AUDIO: 2049 };

    constructor() {
      throw new Error("bad encoder");
    }
  }
  assert.throws(
    () => requireOpusEncoder(() => BrokenOpusScript),
    /opusscript Opus encoder could not initialize: bad encoder/,
  );
});
