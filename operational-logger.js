const SECRET_FIELD_PATTERN = /authorization|cookie|credential|password|secret|token/i;

function cleanScalar(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
  return String(value);
}

function cleanFields(fields = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_FIELD_PATTERN.test(key) || value === undefined) continue;
    cleaned[key] = value && typeof value === "object" && !Array.isArray(value)
      ? cleanFields(value)
      : cleanScalar(value);
  }
  return cleaned;
}

function describeError(error) {
  if (!error) return undefined;
  const description = {
    name: error.name || "Error",
    message: cleanScalar(error.message || error),
  };
  if (error.code !== undefined) description.code = cleanScalar(error.code);
  return description;
}

function createOperationalLogger({
  now = () => new Date(),
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  function write(stream, level, event, fields = {}) {
    const timestamp = now();
    const record = {
      timestamp: timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
      level,
      event: cleanScalar(event),
      ...cleanFields(fields),
    };
    stream.write(`${JSON.stringify(record)}\n`);
  }

  return {
    error(event, error, fields = {}) {
      write(stderr, "error", event, {
        ...fields,
        ...(error ? { error: describeError(error) } : {}),
      });
    },
    info(event, fields) {
      write(stdout, "info", event, fields);
    },
    log(event, fields) {
      write(stdout, "info", event, fields);
    },
    warn(event, fields) {
      write(stderr, "warn", event, fields);
    },
  };
}

module.exports = { cleanFields, createOperationalLogger, describeError };
