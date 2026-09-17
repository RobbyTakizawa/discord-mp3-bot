const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createMediaMetadata } = require("../media-metadata");

function makeAudioFixture(contents = "fake mp3 bytes") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-meta-"));
  const filePath = path.join(dir, "track.mp3");
  fs.writeFileSync(filePath, contents);
  return { dir, filePath };
}

test("duration probe returns milliseconds and caches by size and mtime", async (t) => {
  const { dir, filePath } = makeAudioFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let probeCalls = 0;
  const metadata = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => {
      probeCalls += 1;
      assert.equal(command, "ffprobe");
      callback(null, "12.345\n");
    },
  });

  assert.equal(await metadata.getDurationMs(filePath), 12345);
  assert.equal(await metadata.getDurationMs(filePath), 12345);
  assert.equal(probeCalls, 1);
  assert.equal(metadata.cacheSize(), 1);
});

test("probe failures resolve to null without breaking callers", async (t) => {
  const { dir, filePath } = makeAudioFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const failing = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => callback(new Error("ffprobe failed"), ""),
  });
  assert.equal(await failing.getDurationMs(filePath), null);

  const invalidOutput = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => callback(null, "not-a-duration\n"),
  });
  invalidOutput.clearCache();
  assert.equal(await invalidOutput.getDurationMs(filePath), null);

  const missing = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => callback(null, "1.0\n"),
  });
  assert.equal(await missing.getDurationMs(path.join(dir, "missing.mp3")), null);
});

test("cache invalidates when file size or mtime changes", async (t) => {
  const { dir, filePath } = makeAudioFixture("one");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let duration = "10.0\n";
  let probeCalls = 0;
  const metadata = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => {
      probeCalls += 1;
      callback(null, duration);
    },
  });

  assert.equal(await metadata.getDurationMs(filePath), 10000);
  fs.writeFileSync(filePath, "one-changed-contents-longer");
  duration = "20.0\n";
  assert.equal(await metadata.getDurationMs(filePath), 20000);
  assert.equal(probeCalls, 2);
});

test("concurrent probes are bounded", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-meta-conc-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const files = [];
  for (let index = 0; index < 8; index += 1) {
    const filePath = path.join(dir, `track-${index}.mp3`);
    fs.writeFileSync(filePath, `contents-${index}`);
    files.push(filePath);
  }
  let active = 0;
  let maxActive = 0;
  const metadata = createMediaMetadata({
    maxConcurrent: 2,
    execFileImpl: (command, args, options, callback) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      setTimeout(() => {
        active -= 1;
        callback(null, "5.0\n");
      }, 20);
    },
  });

  const results = await Promise.all(files.map((filePath) => metadata.getDurationMs(filePath)));
  assert.deepEqual(results, Array(8).fill(5000));
  assert.ok(maxActive <= 2);
});

test("concurrent requests for the same file share one probe", async (t) => {
  const { dir, filePath } = makeAudioFixture();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let probeCalls = 0;
  const metadata = createMediaMetadata({
    execFileImpl: (command, args, options, callback) => {
      probeCalls += 1;
      setTimeout(() => callback(null, "7.5\n"), 30);
    },
  });

  const results = await Promise.all([
    metadata.getDurationMs(filePath),
    metadata.getDurationMs(filePath),
    metadata.getDurationMs(filePath),
  ]);
  assert.deepEqual(results, [7500, 7500, 7500]);
  assert.equal(probeCalls, 1);
});
