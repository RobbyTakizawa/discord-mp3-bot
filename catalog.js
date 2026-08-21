const fs = require("fs");
const path = require("path");

function createCatalog({ musicDir, logger = console }) {
  const resolvedMusicDir = path.resolve(musicDir);

  function getCategories() {
    try {
      return fs.readdirSync(resolvedMusicDir, { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);
    } catch (err) {
      logger.error("Error reading categories:", err);
      return [];
    }
  }

  function getMusicStructure() {
    const structure = {};

    try {
      const rootFiles = fs.readdirSync(resolvedMusicDir, { withFileTypes: true });
      const uncategorized = rootFiles
        .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".mp3"))
        .map((dirent) => path.basename(dirent.name, ".mp3"));

      if (uncategorized.length > 0) {
        structure.uncategorized = uncategorized;
      }

      for (const category of getCategories()) {
        const categoryPath = path.join(resolvedMusicDir, category);
        const files = fs.readdirSync(categoryPath, { withFileTypes: true })
          .filter((dirent) => dirent.isFile() && dirent.name.endsWith(".mp3"))
          .map((dirent) => path.basename(dirent.name, ".mp3"));

        if (files.length > 0) {
          structure[category] = files;
        }
      }
    } catch (err) {
      logger.error("Error scanning music structure:", err);
    }

    return structure;
  }

  function safeResolveMp3(songPathIdentifier) {
    if (typeof songPathIdentifier !== "string" || !songPathIdentifier || songPathIdentifier.includes("\0")) {
      return null;
    }

    const identifier = songPathIdentifier.endsWith(".mp3")
      ? songPathIdentifier.slice(0, -4)
      : songPathIdentifier;

    if (!identifier || identifier.includes("\\")) return null;

    const segments = identifier.split("/");
    if (segments.length > 2 || segments.some((segment) => !segment || segment === "." || segment === "..")) {
      return null;
    }

    const [first, second] = segments;
    const relativeParts = segments.length === 1 || first === "uncategorized"
      ? [segments.length === 1 ? first : second]
      : [first, second];
    const resolved = path.resolve(resolvedMusicDir, ...relativeParts) + ".mp3";
    const relative = path.relative(resolvedMusicDir, resolved);

    if (!relative || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) return null;
    if (!fs.existsSync(resolved)) return null;

    try {
      return fs.statSync(resolved).isFile() ? resolved : null;
    } catch {
      return null;
    }
  }

  return { getCategories, getMusicStructure, safeResolveMp3, musicDir: resolvedMusicDir };
}

module.exports = { createCatalog };
