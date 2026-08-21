const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  UploadError,
  normalizeSafeBasename,
  resolveUploadDestination,
  validateMp3Audio,
  validateMp3WithFfprobe,
} = require("../upload-storage");

test("upload basenames are normalized conservatively", () => {
  assert.equal(normalizeSafeBasename("  Cafe\u0301 tone  "), "Café tone");
  for (const value of ["", ".", "..", "../track", "folder\\track", "NUL", "bad:name", "trailing.", "bad\u0000name"]) {
    assert.throws(() => normalizeSafeBasename(value), UploadError);
  }
});

test("upload destinations reject category symlinks", (t) => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-symlink-"));
  t.after(() => fs.rmSync(fixtureDir, { recursive: true, force: true }));
  const musicDir = path.join(fixtureDir, "music");
  const outsideDir = path.join(fixtureDir, "outside");
  fs.mkdirSync(musicDir);
  fs.mkdirSync(outsideDir);

  try {
    fs.symlinkSync(outsideDir, path.join(musicDir, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (err) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes(err.code)) return t.skip("Directory symlinks are unavailable");
    throw err;
  }

  assert.throws(() => resolveUploadDestination({
    musicDir,
    category: "linked",
    customName: "escape",
    originalName: "source.mp3",
  }), (err) => err instanceof UploadError && err.code === "UNSAFE_DIRECTORY");
});

test("FFprobe validation is bounded and accepts only an MP3 audio stream", async () => {
  let invocation;
  const valid = await validateMp3WithFfprobe("staged.upload", {
    timeoutMs: 321,
    execFileImpl: (command, args, options, callback) => {
      invocation = { command, args, options };
      callback(null, JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3" }] }));
    },
  });
  assert.equal(valid, true);
  assert.equal(invocation.command, "ffprobe");
  assert.equal(invocation.options.timeout, 321);
  assert.equal(invocation.options.maxBuffer, 64 * 1024);

  const wrongCodec = await validateMp3WithFfprobe("staged.upload", {
    execFileImpl: (command, args, options, callback) => {
      callback(null, JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "aac" }] }));
    },
  });
  assert.equal(wrongCodec, false);

  const timeout = await validateMp3WithFfprobe("staged.upload", {
    execFileImpl: (command, args, options, callback) => callback(Object.assign(new Error("timeout"), { killed: true })),
  });
  assert.equal(timeout, false);
});

test("MP3 validation decodes a bounded sample after probing the codec", async () => {
  const invocations = [];
  const valid = await validateMp3Audio("staged.upload", {
    timeoutMs: 500,
    execFileImpl: (command, args, options, callback) => {
      invocations.push({ command, args, options });
      if (command === "ffprobe") {
        callback(null, JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "mp3" }] }));
      } else {
        callback(null, "");
      }
    },
  });

  assert.equal(valid, true);
  assert.deepEqual(invocations.map(({ command }) => command), ["ffprobe", "ffmpeg"]);
  assert.ok(invocations[1].args.includes("30"));
  assert.ok(invocations[1].options.timeout <= 500);
});
