const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const { renderControlPanel, renderUploadSuccess } = require("./render");

function createBasicAuth(config) {
  return function basicAuth(req, res, next) {
    if (!config.webPass) return res.status(500).send("WEB_PASS environment variable is not set");

    const header = req.headers.authorization || "";
    const [type, encoded] = header.split(" ");
    if (type !== "Basic" || !encoded) {
      res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
      return res.status(401).send("Authentication required");
    }

    const [user, pass] = Buffer.from(encoded, "base64").toString("utf8").split(":");
    if (user !== config.webUser || pass !== config.webPass) {
      res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
      return res.status(401).send("Invalid credentials");
    }

    next();
  };
}

function createUploadMiddleware(musicDir) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      const category = req.body.category || "uncategorized";
      const targetDir = category === "uncategorized" ? musicDir : path.join(musicDir, category);
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (req, file, cb) => {
      const customName = req.body.mp3Name ? req.body.mp3Name.trim() : null;
      const base = customName || path.parse(file.originalname).name;
      cb(null, base + ".mp3");
    },
  });

  return multer({ storage });
}

function createWebApp({ config, catalog, controlHandlers, upload, logger = console }) {
  const app = express();
  const basicAuth = createBasicAuth(config);
  const uploadMiddleware = upload || createUploadMiddleware(catalog.musicDir);

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.get("/", basicAuth, (req, res) => {
    res.send(renderControlPanel({
      musicStructure: catalog.getMusicStructure(),
      categories: catalog.getCategories(),
    }));
  });

  app.post("/upload", basicAuth, uploadMiddleware.single("mp3"), (req, res) => {
    if (!req.file) return res.status(400).send("Error: No file uploaded.");
    const relativePath = path.relative(catalog.musicDir, req.file.path);
    res.send(renderUploadSuccess(relativePath));
  });

  app.post("/api/control", basicAuth, async (req, res) => {
    const { action, song } = req.body;

    try {
      if (action === "stop") {
        await controlHandlers.stop();
        return res.send("Stopped.");
      }

      if (action === "play") {
        if (!song) return res.status(400).send("Missing song identifier.");
        const filePath = catalog.safeResolveMp3(song);
        if (!filePath) return res.status(404).send("File not found on server.");
        const result = await controlHandlers.play(song, filePath);
        return res.send(result || `Playing ${song}`);
      }
    } catch (err) {
      logger.error("Web control failure:", err);
      return res.status(500).send("Failed to control playback.");
    }

    return res.status(400).send("Unknown action.");
  });

  return app;
}

module.exports = { createBasicAuth, createUploadMiddleware, createWebApp };
