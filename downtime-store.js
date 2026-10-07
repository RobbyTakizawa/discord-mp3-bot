const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_TARGETS = { origin: 20, general: 40 };
const MAX_TARGET = 1_000_000;
const DICE_PATTERN = /^(\d+)d(\d+)(?:\+(\d+))?$/i;

function parseDice(expression) {
  const match = DICE_PATTERN.exec(String(expression).trim());
  if (!match) throw new Error("Use dice like 2d6 or 2d6+1.");
  const count = Number(match[1]);
  const sides = Number(match[2]);
  const modifier = Number(match[3] || 0);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100
    || !Number.isSafeInteger(sides) || sides < 2 || sides > 1000
    || !Number.isSafeInteger(modifier) || modifier < 0 || modifier > 10000) {
    throw new Error("Dice limits: 1–100 dice, 2–1000 sides, and a +0–10000 modifier.");
  }
  return { count, sides, modifier, expression: `${count}d${sides}${modifier ? `+${modifier}` : ""}` };
}

function parseGoal(argument) {
  const match = /^(set|replace)\s+(origin|general)\s+(.+?)(?:\s+--points\s+(\d+))?$/i.exec(argument);
  if (!match) throw new Error("Use: !downtime_goal <set|replace> <origin|general> <feat name> [--points N].");
  const [, action, rawType, rawName, override] = match;
  const type = rawType.toLowerCase();
  const name = rawName.trim().normalize("NFC");
  const target = override === undefined ? DEFAULT_TARGETS[type] : Number(override);
  if (!name || name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name) || /--points/i.test(name)) {
    throw new Error("Feat name must be 1–80 characters without controls or --points.");
  }
  if (!Number.isSafeInteger(target) || target < 1 || target > MAX_TARGET) {
    throw new Error(`Point target must be an integer from 1 to ${MAX_TARGET}.`);
  }
  return { action: action.toLowerCase(), type, name, target };
}

function validSavedState(value) {
  if (value?.version !== 1 || !value.guilds || typeof value.guilds !== "object" || Array.isArray(value.guilds)) return false;
  for (const guild of Object.values(value.guilds)) {
    if (!guild || typeof guild !== "object" || Array.isArray(guild)) return false;
    for (const user of Object.values(guild)) {
      if (!user || typeof user.displayName !== "string" || !Array.isArray(user.goals)) return false;
      for (const goal of user.goals) {
        if (!goal || typeof goal.name !== "string" || !DEFAULT_TARGETS[goal.type]
          || !Number.isSafeInteger(goal.target) || goal.target < 1 || goal.target > MAX_TARGET
          || !Number.isSafeInteger(goal.points) || goal.points < 0 || goal.points > goal.target
          || !["active", "completed", "replaced"].includes(goal.status)
          || !Array.isArray(goal.rolls)) return false;
        for (const roll of goal.rolls) {
          if (!roll || typeof roll.messageId !== "string" || typeof roll.expression !== "string"
            || !Array.isArray(roll.results) || !Number.isSafeInteger(roll.total)
            || typeof roll.undone !== "boolean") return false;
        }
      }
    }
  }
  return true;
}

function createDowntimeStore({ filePath, randomInt = crypto.randomInt, now = () => new Date().toISOString() }) {
  let state = { version: 1, guilds: {} };
  if (fs.existsSync(filePath)) {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!validSavedState(state)) {
      throw new Error("Invalid downtime data file; restore a valid backup before starting.");
    }
  }

  function persist(next) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(next)}\n`);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = null;
      fs.renameSync(temporary, filePath);
      state = next;
    } finally {
      if (descriptor !== undefined && descriptor !== null) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (err) { if (err.code !== "ENOENT") throw err; }
    }
  }

  function mutate(guildId, userId, displayName, operation) {
    const next = structuredClone(state);
    const guild = next.guilds[guildId] ||= {};
    const user = guild[userId] ||= { displayName: "", goals: [] };
    if (displayName) user.displayName = String(displayName).slice(0, 80);
    const result = operation(user);
    persist(next);
    return result;
  }

  function latestGoal(user) {
    return user?.goals?.at(-1) || null;
  }

  function setGoal(guildId, userId, displayName, goal) {
    return mutate(guildId, userId, displayName, (user) => {
      const previous = latestGoal(user);
      if (goal.action === "set" && previous?.status === "active") {
        throw new Error("You already have an active goal. Use !downtime_goal replace to reset it.");
      }
      if (goal.action === "replace" && previous?.status !== "active") {
        throw new Error("You have no active goal to replace. Use !downtime_goal set.");
      }
      if (previous?.status === "active") previous.status = "replaced";
      const current = {
        id: crypto.randomUUID(), type: goal.type, name: goal.name, target: goal.target,
        points: 0, status: "active", createdAt: now(), rolls: [],
      };
      user.goals.push(current);
      return structuredClone(current);
    });
  }

  function roll(guildId, userId, displayName, messageId, dice) {
    if (typeof messageId !== "string" || !messageId) throw new Error("A Discord message ID is required to record a roll.");
    const existing = state.guilds[guildId]?.[userId]?.goals
      ?.flatMap((goal) => goal.rolls.map((entry) => ({ goal, entry })))
      .find(({ entry }) => entry.messageId === messageId);
    if (existing) return { goal: structuredClone(existing.goal), roll: structuredClone(existing.entry), duplicate: true };
    return mutate(guildId, userId, displayName, (user) => {
      const goal = latestGoal(user);
      if (goal?.status !== "active") throw new Error("Set an active downtime goal before rolling.");
      const results = Array.from({ length: dice.count }, () => randomInt(1, dice.sides + 1));
      const total = results.reduce((sum, value) => sum + value, dice.modifier);
      const entry = { messageId, expression: dice.expression, results, modifier: dice.modifier, total, undone: false, at: now() };
      goal.rolls.push(entry);
      goal.points = Math.min(goal.target, goal.points + total);
      if (goal.points >= goal.target) {
        goal.status = "completed";
        goal.completedAt = now();
      }
      return { goal: structuredClone(goal), roll: structuredClone(entry), duplicate: false };
    });
  }

  function undo(guildId, userId, displayName) {
    return mutate(guildId, userId, displayName, (user) => {
      const goal = latestGoal(user);
      if (!goal || goal.status === "replaced") throw new Error("There is no roll on your current goal to undo.");
      const entry = [...goal.rolls].reverse().find((roll) => !roll.undone);
      if (!entry) throw new Error("There is no roll on your current goal to undo.");
      entry.undone = true;
      entry.undoneAt = now();
      goal.points = Math.min(goal.target, goal.rolls.reduce((sum, roll) => sum + (roll.undone ? 0 : roll.total), 0));
      if (goal.status === "completed") {
        goal.status = "active";
        delete goal.completedAt;
      }
      return { goal: structuredClone(goal), roll: structuredClone(entry) };
    });
  }

  function progress(guildId, userId) {
    return structuredClone(latestGoal(state.guilds[guildId]?.[userId]));
  }

  function scoreboard(guildId) {
    return Object.entries(state.guilds[guildId] || {}).map(([userId, user]) => ({
      userId, displayName: user.displayName, goal: structuredClone(latestGoal(user)),
    })).filter(({ goal }) => goal && goal.status !== "replaced");
  }

  return { setGoal, roll, undo, progress, scoreboard };
}

module.exports = { createDowntimeStore, parseDice, parseGoal };
