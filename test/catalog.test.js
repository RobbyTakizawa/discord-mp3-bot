const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createCatalog } = require("../catalog");

function makeMusicFixture() {
  const musicDir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-mp3-bot-"));
  fs.writeFileSync(path.join(musicDir, "airhorn.mp3"), "root");
  fs.writeFileSync(path.join(musicDir, "ignored.MP3"), "uppercase extension");
  fs.mkdirSync(path.join(musicDir, "villains"));
  fs.writeFileSync(path.join(musicDir, "villains", "boss_theme.mp3"), "category");
  fs.mkdirSync(path.join(musicDir, "villains", "nested"));
  fs.writeFileSync(path.join(musicDir, "villains", "nested", "hidden.mp3"), "deep");
  return musicDir;
}

test("catalog discovers root and immediate category MP3s only", (t) => {
  const musicDir = makeMusicFixture();
  t.after(() => fs.rmSync(musicDir, { recursive: true, force: true }));

  const catalog = createCatalog({ musicDir });

  assert.deepEqual(catalog.getMusicStructure(), {
    uncategorized: ["airhorn"],
    villains: ["boss_theme"],
  });
  assert.deepEqual(catalog.getCategories(), ["villains"]);
});

test("safeResolveMp3 accepts supported identifiers and rejects unsafe depth", (t) => {
  const musicDir = makeMusicFixture();
  t.after(() => fs.rmSync(musicDir, { recursive: true, force: true }));

  const catalog = createCatalog({ musicDir });

  assert.equal(catalog.safeResolveMp3("airhorn"), path.join(musicDir, "airhorn.mp3"));
  assert.equal(catalog.safeResolveMp3("airhorn.mp3"), path.join(musicDir, "airhorn.mp3"));
  assert.equal(catalog.safeResolveMp3("villains/boss_theme"), path.join(musicDir, "villains", "boss_theme.mp3"));
  assert.equal(catalog.safeResolveMp3("uncategorized/airhorn"), path.join(musicDir, "airhorn.mp3"));

  assert.equal(catalog.safeResolveMp3("missing"), null);
  assert.equal(catalog.safeResolveMp3("../airhorn"), null);
  assert.equal(catalog.safeResolveMp3("villains/../../airhorn"), null);
  assert.equal(catalog.safeResolveMp3("villains/nested/hidden"), null);
  assert.equal(catalog.safeResolveMp3("villains\\boss_theme"), null);
});
