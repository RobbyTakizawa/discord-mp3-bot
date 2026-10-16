const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLibraryStore } = require("../library-store");

function fixture(t, fileSystem = fs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "soundboard-library-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const musicDir = path.join(root, "music");
  fs.mkdirSync(musicDir);
  fs.mkdirSync(path.join(musicDir, "effects"));
  fs.writeFileSync(path.join(musicDir, "horn.mp3"), "horn bytes");
  fs.writeFileSync(path.join(musicDir, "rain.mp3"), "rain bytes");
  const store = createLibraryStore({ musicDir, fileSystem });
  const edit = (payload) => store.editSession({ ...payload, revision: store.snapshot().revision });
  return { root, musicDir, store, edit, metadata: path.join(musicDir, ".session-board.json") };
}

test("folders normalize names and reject duplicates, reserved names, traversal, and symlinks", (t) => {
  const { musicDir, root, store } = fixture(t);
  assert.equal(store.createFolder(" Cafe\u0301 scenes "), "Café scenes");
  assert.ok(fs.statSync(path.join(musicDir, "Café scenes")).isDirectory());
  for (const name of ["../escape", "a/b", "a\\b", "", ".", "..", "CON", "trailing.", "x\u0000y", "uncategorized", "Uncategorized", "a".repeat(101)]) {
    assert.throws(() => store.createFolder(name), { status: 400 });
  }
  assert.throws(() => store.createFolder("Café scenes"), { status: 409 });
  fs.symlinkSync(root, path.join(musicDir, "outside"), "dir");
  assert.throws(() => store.createFolder("outside"), { status: 409 });
  assert.throws(() => store.moveSongs(["horn"], "outside"), { status: 400 });
  assert.equal(fs.existsSync(path.join(root, "escape")), false);
});

test("shared session order persists, rejects stale edits, and never deletes songs when cleared", (t) => {
  const { store, musicDir, edit } = fixture(t);
  const first = edit({ action: "pin", song: "uncategorized/horn" }).pins[0];
  assert.equal(edit({ action: "pin", song: "horn" }).pins.length, 1);
  const second = edit({ action: "pin", song: "rain" }).pins[1];
  assert.throws(() => store.editSession({ action: "clear", revision: 0 }), { status: 409 });
  edit({ action: "reorder", id: second.id, direction: "up" });
  const restored = createLibraryStore({ musicDir });
  assert.deepEqual(restored.snapshot().pins.map((pin) => pin.id), [second.id, first.id]);
  assert.throws(() => edit({ action: "reorder", id: first.id, direction: "sideways" }), { status: 400 });
  edit({ action: "unpin", id: second.id });
  edit({ action: "clear" });
  assert.equal(store.snapshot().pins.length, 0);
  assert.equal(fs.readFileSync(path.join(musicDir, "horn.mp3"), "utf8"), "horn bytes");
});

test("moves preserve bytes, filenames, pin IDs and order, and support root destinations", (t) => {
  const { store, edit, musicDir } = fixture(t);
  const pin = edit({ action: "pin", song: "horn" }).pins[0];
  const results = store.moveSongs(["horn", "rain"], "effects");
  assert.deepEqual(results.map((entry) => entry.status), ["moved", "moved"]);
  assert.equal(fs.existsSync(path.join(musicDir, "horn.mp3")), false);
  assert.equal(fs.readFileSync(path.join(musicDir, "effects", "horn.mp3"), "utf8"), "horn bytes");
  assert.deepEqual(store.snapshot().pins, [{ ...pin, song: "effects/horn" }]);
  assert.equal(store.moveSongs(["effects/horn"], "effects")[0].status, "unchanged");
  assert.equal(store.moveSongs(["effects/horn"], "uncategorized")[0].status, "moved");
  assert.deepEqual(createLibraryStore({ musicDir }).snapshot().pins, [pin]);
});

test("bulk moves report per-song conflicts, missing files, and busy tracks without overwriting", (t) => {
  const { musicDir, store } = fixture(t);
  fs.writeFileSync(path.join(musicDir, "effects", "horn.mp3"), "keep destination");
  let results = store.moveSongs(["horn", "missing", "unknown/song", "rain"], "effects");
  assert.deepEqual(results.map((entry) => entry.status), ["error", "error", "error", "moved"]);
  assert.equal(fs.readFileSync(path.join(musicDir, "horn.mp3"), "utf8"), "horn bytes");
  assert.equal(fs.readFileSync(path.join(musicDir, "effects", "horn.mp3"), "utf8"), "keep destination");
  results = store.moveSongs(["effects/rain"], "uncategorized", [path.join(musicDir, "effects", "rain.mp3")]);
  assert.equal(results[0].status, "error");
  assert.match(results[0].message, /queue/);
  assert.throws(() => store.moveSongs(["horn", "uncategorized/horn"], "effects"), { status: 400 });
  assert.throws(() => store.moveSongs(["../escape"], "effects"), { status: 400 });
  assert.throws(() => store.moveSongs(Array(21).fill("horn"), "effects"), { status: 400 });
});

test("missing pins remain visible and symlinked files cannot be pinned or moved", (t) => {
  const { store, edit, musicDir } = fixture(t);
  edit({ action: "pin", song: "horn" });
  fs.unlinkSync(path.join(musicDir, "horn.mp3"));
  assert.equal(store.snapshot().pins[0].available, false);
  assert.throws(() => edit({ action: "pin", song: "horn" }), { status: 404 });
  assert.throws(() => store.moveSongs(["rain"], "missing"), { status: 400 });
  fs.symlinkSync(path.join(musicDir, "rain.mp3"), path.join(musicDir, "link.mp3"));
  assert.throws(() => edit({ action: "pin", song: "link" }), { status: 400 });
  assert.equal(store.moveSongs(["link"], "effects")[0].status, "error");
  fs.symlinkSync(path.join(musicDir, "rain.mp3"), path.join(musicDir, "effects", "rain.mp3"));
  assert.equal(store.moveSongs(["rain"], "effects")[0].status, "error");
});

test("a crash after publication is recovered without losing bytes or pin identity", (t) => {
  let interrupt = true;
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key === "unlinkSync") return (candidate) => {
        if (interrupt && candidate.endsWith("/horn.mp3")) {
          interrupt = false;
          throw new Error("Simulated interruption after link");
        }
        return fs.unlinkSync(candidate);
      };
      return target[key];
    },
  });
  const { store, edit, musicDir, metadata } = fixture(t, fileSystem);
  const pin = edit({ action: "pin", song: "horn" }).pins[0];
  assert.throws(() => store.moveSongs(["horn"], "effects"), /Simulated interruption/);
  assert.ok(JSON.parse(fs.readFileSync(metadata)).pendingMove);
  assert.throws(() => store.createFolder("New folder", [path.join(musicDir, "horn.mp3")]), { status: 409 });
  assert.equal(fs.existsSync(path.join(musicDir, "horn.mp3")), true);
  const recovered = createLibraryStore({ musicDir });
  assert.deepEqual(recovered.snapshot().pins, [{ ...pin, song: "effects/horn" }]);
  assert.equal(fs.existsSync(path.join(musicDir, "horn.mp3")), false);
  assert.equal(fs.readFileSync(path.join(musicDir, "effects", "horn.mp3"), "utf8"), "horn bytes");
  assert.equal(JSON.parse(fs.readFileSync(metadata)).pendingMove, null);
});

test("a crash after source removal recovers metadata, while unpublished moves retain the source", (t) => {
  let replacements = 0;
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key === "renameSync") return (...args) => {
        replacements += 1;
        if (replacements === 3) throw new Error("Simulated interruption before metadata commit");
        return fs.renameSync(...args);
      };
      return target[key];
    },
  });
  const { store, edit, musicDir, metadata } = fixture(t, fileSystem);
  const pin = edit({ action: "pin", song: "horn" }).pins[0];
  assert.throws(() => store.moveSongs(["horn"], "effects"), /Simulated interruption/);
  assert.equal(fs.existsSync(path.join(musicDir, "horn.mp3")), false);
  assert.deepEqual(createLibraryStore({ musicDir }).snapshot().pins, [{ ...pin, song: "effects/horn" }]);
  const saved = JSON.parse(fs.readFileSync(metadata));
  const stats = fs.statSync(path.join(musicDir, "rain.mp3"));
  saved.pendingMove = { from: "rain", to: "effects/rain", identity: { dev: String(stats.dev), ino: String(stats.ino) } };
  fs.writeFileSync(metadata, JSON.stringify(saved));
  createLibraryStore({ musicDir });
  assert.equal(fs.existsSync(path.join(musicDir, "rain.mp3")), true);
  assert.equal(fs.existsSync(path.join(musicDir, "effects", "rain.mp3")), false);
  assert.equal(JSON.parse(fs.readFileSync(metadata)).pendingMove, null);
});

test("failed exclusive publication leaves both files untouched and invalid metadata fails closed", (t) => {
  const fileSystem = new Proxy(fs, {
    get(target, key) {
      if (key === "linkSync") return (source, destination) => {
        fs.writeFileSync(destination, "racing upload", { flag: "wx" });
        const err = new Error("Already exists");
        err.code = "EEXIST";
        throw err;
      };
      return target[key];
    },
  });
  const { store, musicDir, metadata } = fixture(t, fileSystem);
  assert.equal(store.moveSongs(["horn"], "effects")[0].status, "error");
  assert.equal(fs.readFileSync(path.join(musicDir, "horn.mp3"), "utf8"), "horn bytes");
  assert.equal(fs.readFileSync(path.join(musicDir, "effects", "horn.mp3"), "utf8"), "racing upload");
  fs.writeFileSync(metadata, '{"version":999}');
  assert.throws(() => createLibraryStore({ musicDir }), /Cannot load session board/);
  assert.equal(fs.readFileSync(metadata, "utf8"), '{"version":999}');
  fs.unlinkSync(metadata);
  fs.symlinkSync(path.join(musicDir, "horn.mp3"), metadata);
  assert.throws(() => createLibraryStore({ musicDir }), /Cannot load session board/);
});

test("catalog identifiers preserve basenames that themselves end in .mp3", (t) => {
  const { store, edit, musicDir } = fixture(t);
  fs.writeFileSync(path.join(musicDir, "horn.mp3.mp3"), "different song");
  const pin = edit({ action: "pin", song: "horn.mp3" }).pins[0];
  store.moveSongs(["horn.mp3"], "effects");
  assert.equal(fs.readFileSync(path.join(musicDir, "horn.mp3"), "utf8"), "horn bytes");
  assert.equal(fs.readFileSync(path.join(musicDir, "effects", "horn.mp3.mp3"), "utf8"), "different song");
  assert.deepEqual(createLibraryStore({ musicDir }).snapshot().pins, [{ ...pin, song: "effects/horn.mp3" }]);
});

test("unrecoverable journals fail closed and symlinked library roots are rejected", (t) => {
  const { musicDir, root, metadata } = fixture(t);
  const saved = { version: 1, revision: 0, pins: [], pendingMove: {
    from: "horn", to: "effects/horn", identity: { dev: "0", ino: "0" },
  } };
  fs.writeFileSync(metadata, JSON.stringify(saved));
  assert.throws(() => createLibraryStore({ musicDir }), /cannot be recovered safely/);
  assert.deepEqual(JSON.parse(fs.readFileSync(metadata)), saved);
  assert.equal(fs.readFileSync(path.join(musicDir, "horn.mp3"), "utf8"), "horn bytes");
  const alias = path.join(root, "alias");
  fs.symlinkSync(musicDir, alias, "dir");
  assert.throws(() => createLibraryStore({ musicDir: alias }), /must not be a symlink/);
});
