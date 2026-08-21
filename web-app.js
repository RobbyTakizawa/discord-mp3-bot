const crypto = require("node:crypto");
const fs = require("node:fs");

const express = require("express");
const multer = require("multer");

const { renderControlPanel, renderUploadSuccess } = require("./render");
const {
  DEFAULT_MAX_UPLOAD_BYTES,
  UploadError,
  createStagingStorage,
  publishUpload,
} = require("./upload-storage");

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  "application/octet-stream",
  "audio/mp3",
  "audio/mpeg",
  "audio/x-mpeg",
]);

function logInfo(logger, event, fields) {
  if (typeof logger.info === "function") logger.info(event, fields);
  else logger.log?.(event, fields);
}

function createRequestContext({
  logger = console,
  now = Date.now,
  randomUUID = crypto.randomUUID,
} = {}) {
  return function requestContext(req, res, next) {
    const requestId = randomUUID();
    const startedAt = now();
    let logged = false;
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    const logRequest = (outcome) => {
      if (logged) return;
      logged = true;
      logInfo(logger, "http_request", {
        requestId,
        method: req.method,
        path: `${req.baseUrl || ""}${req.path}` || "/",
        statusCode: res.statusCode,
        durationMs: Math.max(0, now() - startedAt),
        outcome,
      });
    };
    res.once("finish", () => logRequest("completed"));
    res.once("close", () => {
      if (!res.writableEnded) logRequest("aborted");
    });
    next();
  };
}

function getReadiness(runtimeState) {
  if (typeof runtimeState?.snapshot === "function") return runtimeState.snapshot();
  return { ready: Boolean(runtimeState?.isReady?.()) };
}

function constantTimeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hasValidBasicCredentials(config, header) {
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator) !== "Basic") return false;

  let decoded;
  try {
    decoded = Buffer.from(header.slice(separator + 1), "base64").toString("utf8");
  } catch {
    return false;
  }
  const credentialSeparator = decoded.indexOf(":");
  if (credentialSeparator < 0) return false;
  const user = decoded.slice(0, credentialSeparator);
  const pass = decoded.slice(credentialSeparator + 1);
  const userMatches = constantTimeEqual(user, config.webUser);
  const passwordMatches = constantTimeEqual(pass, config.webPass);
  return userMatches && passwordMatches;
}

function createBasicAuth(config) {
  return function basicAuth(req, res, next) {
    if (!config.webPass) return res.status(500).send("WEB_PASS environment variable is not set");

    const header = req.headers.authorization || "";
    if (!header) {
      res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
      return res.status(401).send("Authentication required");
    }
    if (!hasValidBasicCredentials(config, header)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="MP3 Upload"');
      return res.status(401).send("Invalid credentials");
    }

    return next();
  };
}

function createRateLimiter({
  windowMs,
  max,
  maxKeys = 10_000,
  keyGenerator = (req) => req.socket.remoteAddress || "unknown",
  now = Date.now,
}) {
  const clients = new Map();

  return function rateLimiter(req, res, next) {
    const currentTime = now();
    const key = keyGenerator(req);
    let entry = clients.get(key);
    if (!entry || currentTime >= entry.resetAt) {
      if (!entry && clients.size >= maxKeys) {
        for (const [storedKey, storedEntry] of clients) {
          if (currentTime >= storedEntry.resetAt) clients.delete(storedKey);
        }
        if (clients.size >= maxKeys) {
          res.setHeader("Retry-After", Math.max(1, Math.ceil(windowMs / 1000)));
          return res.status(429).send("Too many requests. Try again later.");
        }
      }
      entry = { count: 0, resetAt: currentTime + windowMs };
      clients.set(key, entry);
    }

    entry.count += 1;
    if (entry.count > max) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)));
      return res.status(429).send("Too many requests. Try again later.");
    }
    return next();
  };
}

function createCsrfProtection(token, onReject = () => {}) {
  return function requireCsrf(req, res, next) {
    const supplied = req.get("x-csrf-token") || req.body?.csrfToken || "";
    if (!constantTimeEqual(supplied, token)) {
      onReject(req);
      return res.status(403).send("Invalid CSRF token.");
    }
    return next();
  };
}

function createUploadMiddleware(musicDir, {
  maxFileSize = DEFAULT_MAX_UPLOAD_BYTES,
  stagingDir,
} = {}) {
  const { storage } = createStagingStorage(multer, musicDir, { stagingDir });
  return multer({
    storage,
    limits: {
      fieldNameSize: 50,
      fieldSize: 200,
      fields: 4,
      fileSize: maxFileSize,
      files: 1,
      parts: 5,
    },
    fileFilter: (req, file, callback) => {
      if (!/\.mp3$/i.test(file.originalname) || !ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
        return callback(new UploadError(415, "Only MP3 audio uploads are accepted.", "INVALID_FILE_TYPE"));
      }
      return callback(null, true);
    },
  });
}

function applySecurityHeaders(req, res, next) {
  const nonce = crypto.randomBytes(18).toString("base64url");
  res.locals.cspNonce = nonce;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; "));
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=()");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return next();
}

function removeStagedFile(req) {
  const stagedPath = req.file?.path || req.stagedUploadPath;
  if (stagedPath) fs.promises.rm(stagedPath, { force: true }).catch(() => {});
}

function createWebApp({
  config,
  catalog,
  controlHandlers,
  upload,
  uploadOptions,
  validateAudio,
  csrfToken = crypto.randomBytes(32).toString("base64url"),
  rateLimitOptions = {},
  runtimeState,
  logger = console,
}) {
  const app = express();
  const basicAuth = createBasicAuth(config);
  const csrfProtection = createCsrfProtection(csrfToken);
  const uploadCsrfProtection = createCsrfProtection(csrfToken, removeStagedFile);
  const uploadMiddleware = upload || createUploadMiddleware(catalog.musicDir, uploadOptions);
  const uploadSingle = typeof uploadMiddleware.single === "function"
    ? uploadMiddleware.single("mp3")
    : uploadMiddleware;
  const authenticationLimiter = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    ...rateLimitOptions.authentication,
  });
  const mutationLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    ...rateLimitOptions.mutation,
  });

  app.disable("x-powered-by");
  app.locals.csrfToken = csrfToken;
  app.use(createRequestContext({ logger }));
  app.use(applySecurityHeaders);
  app.get("/healthz", (req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (req, res) => {
    const readiness = getReadiness(runtimeState);
    const ready = readiness.ready === true;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ready" : "not_ready",
      discord: readiness.discordReady ? "ready" : "not_ready",
    });
  });
  app.use(express.urlencoded({ extended: false, limit: "4kb", parameterLimit: 10 }));
  app.use(express.json({ limit: "4kb", strict: true }));
  app.use((req, res, next) => {
    if (!config.webPass || hasValidBasicCredentials(config, req.headers.authorization || "")) {
      return basicAuth(req, res, next);
    }
    return authenticationLimiter(req, res, () => basicAuth(req, res, next));
  });
  app.use((req, res, next) => {
    req.on("aborted", () => removeStagedFile(req));
    res.on("close", () => {
      if (!res.writableEnded) removeStagedFile(req);
    });
    next();
  });

  app.get("/", (req, res) => {
    res.send(renderControlPanel({
      musicStructure: catalog.getMusicStructure(),
      categories: catalog.getCategories(),
      csrfToken,
      nonce: res.locals.cspNonce,
    }));
  });

  app.post("/upload", mutationLimiter, uploadSingle, (req, res, next) => {
    const allowedFields = new Set(["category", "csrfToken", "mp3Name"]);
    if (Object.keys(req.body).some((field) => !allowedFields.has(field))) {
      removeStagedFile(req);
      return res.status(400).send("Invalid upload request.");
    }
    return next();
  }, uploadCsrfProtection, async (req, res, next) => {
    try {
      const relativePath = await publishUpload({
        musicDir: catalog.musicDir,
        file: req.file,
        fields: req.body,
        validateAudio,
      });
      return res.send(renderUploadSuccess(relativePath, res.locals.cspNonce));
    } catch (err) {
      return next(err);
    }
  });

  app.post("/api/control", mutationLimiter, csrfProtection, async (req, res) => {
    const { action, song } = req.body || {};

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
      logger.error("web_control_failed", err, { requestId: req.requestId, action });
      return res.status(500).send("Failed to control playback.");
    }

    return res.status(400).send("Unknown action.");
  });

  app.use((err, req, res, next) => {
    removeStagedFile(req);
    if (req.aborted || err?.message === "Request aborted") return;
    if (res.headersSent) return next(err);

    if (err instanceof multer.MulterError) {
      const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      return res.status(status).send(status === 413 ? "Upload exceeds the configured size limit." : "Invalid upload request.");
    }
    if (err instanceof UploadError) return res.status(err.status).send(err.message);
    if (err?.type === "entity.too.large") return res.status(413).send("Request body is too large.");
    if (err instanceof SyntaxError && err?.type === "entity.parse.failed") {
      return res.status(400).send("Invalid request body.");
    }

    logger.error("web_request_failed", err, { requestId: req.requestId });
    return res.status(500).send("The request could not be completed.");
  });

  return app;
}

module.exports = {
  applySecurityHeaders,
  createBasicAuth,
  createCsrfProtection,
  createRequestContext,
  createRateLimiter,
  createUploadMiddleware,
  createWebApp,
};
