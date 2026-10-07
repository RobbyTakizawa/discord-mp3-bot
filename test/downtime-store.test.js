const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createDowntimeStore, parseDice, parseGoal } = require("../downtime-store");

function fixture(t, rolls = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "downtime-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, ".downtime-progress.json");
  const randomInt = () => rolls.shift();
  return { filePath, store: createDowntimeStore({ filePath, randomInt }) };
}

test("goal and dice parsing applies defaults and bounds", () => {
  assert.deepEqual(parseGoal("set origin Alert"), { action: "set", type: "origin", name: "Alert", target: 20 });
  assert.deepEqual(parseGoal("replace general Lucky --points 50"), { action: "replace", type: "general", name: "Lucky", target: 50 });
  assert.deepEqual(parseGoal("set general Heavy Armor Master --points 45"), {
    action: "set", type: "general", name: "Heavy Armor Master", target: 45,
  });
  assert.deepEqual(parseDice("2D6+1"), { count: 2, sides: 6, modifier: 1, expression: "2d6+1" });
  assert.throws(() => parseGoal("set origin Alert --points 0"), /Point target/);
  assert.throws(() => parseDice("101d6"), /Dice limits/);
  assert.throws(() => parseDice("2d6-1"), /Use dice/);
});

test("rolls persist per server and person; completion loses excess and undo reopens", (t) => {
  const { filePath, store } = fixture(t, [6, 6, 5, 6]);
  const ids = ["111111111111111111", "222222222222222222"];
  store.setGoal(...ids, "Alice", parseGoal("set origin Alert"));
  const first = store.roll(...ids, "Alice", "message-1", parseDice("2d6+1"));
  assert.deepEqual(first.roll.results, [6, 6]);
  assert.equal(first.roll.total, 13);
  assert.equal(first.goal.points, 13);
  const second = store.roll(...ids, "Alice", "message-2", parseDice("2d6"));
  assert.equal(second.roll.total, 11);
  assert.equal(second.goal.points, 20);
  assert.equal(second.goal.status, "completed");
  assert.throws(() => store.roll(...ids, "Alice", "message-3", parseDice("1d6")), /Set an active/);
  assert.equal(store.roll(...ids, "Alice", "message-2", parseDice("2d6")).duplicate, true);

  const reopened = createDowntimeStore({ filePath });
  assert.equal(reopened.progress(...ids).status, "completed");
  const undone = reopened.undo(...ids, "Alice");
  assert.equal(undone.goal.status, "active");
  assert.equal(undone.goal.points, 13);
  assert.equal(undone.roll.undone, true);
  assert.equal(reopened.progress(ids[0], "333333333333333333"), null);
  assert.deepEqual(reopened.scoreboard("999999999999999999"), []);
});

test("replacement resets progress and prevents undoing rolls on old goals", (t) => {
  const { store } = fixture(t, [5]);
  const ids = ["111111111111111111", "222222222222222222"];
  store.setGoal(...ids, "Alice", parseGoal("set origin Alert"));
  store.roll(...ids, "Alice", "message-1", parseDice("1d6"));
  assert.throws(() => store.setGoal(...ids, "Alice", parseGoal("set general Lucky")), /already have an active/);
  const newGoal = store.setGoal(...ids, "Alice", parseGoal("replace general Lucky --points 50"));
  assert.equal(newGoal.points, 0);
  assert.equal(newGoal.target, 50);
  assert.throws(() => store.undo(...ids, "Alice"), /no roll/);
  assert.equal(store.scoreboard(ids[0])[0].goal.name, "Lucky");
});

test("invalid stored JSON fails without resetting progress", (t) => {
  const { filePath } = fixture(t);
  fs.writeFileSync(filePath, "not json");
  assert.throws(() => createDowntimeStore({ filePath }), SyntaxError);
  assert.equal(fs.readFileSync(filePath, "utf8"), "not json");
});
