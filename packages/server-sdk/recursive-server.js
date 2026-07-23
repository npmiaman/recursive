/**
 * @recursive/server, the server-side half of the SDK.
 *
 * const { recursiveMiddleware } = require("@recursive/server");
 * app.use(recursiveMiddleware());
 *
 * The browser SDK sees what the *user* experienced. This sees what the *server*
 * actually did. Together they answer the question a UI-only check cannot:
 * "the screen said it worked, did it?"
 *
 * It keeps a bounded in-memory ring of recent requests, errors and logs, and
 * exposes them at `/__recursive/trace?since=<iso>`. During a sweep, Recursive
 * asks: "what did you do between when the flow started and when it ended?"
 *
 * PRIME DIRECTIVE, same as the browser SDK: fail open. Every hook is wrapped, the
 * buffer is capped, and nothing here can throw into a request path. An
 * observability tool that takes down the thing it observes is worse than no
 * observability tool.
 */

"use strict";

const DEFAULTS = {
  /** Requests retained. ~2k is a few minutes of a test environment, and bounded memory. */
  bufferSize: 2000,
  /** Guard the endpoint in any environment that isn't obviously local. */
  token: process.env.RECURSIVE_TRACE_TOKEN || null,
  /** Never record bodies by default, they carry PII and secrets. */
  captureBodies: false,
  path: "/__recursive/trace",
};

/** Bounded ring buffer, old entries are dropped, memory never grows. */
class Ring {
  constructor(size) {
    this.size = size;
    this.items = [];
  }
  push(item) {
    this.items.push(item);
    if (this.items.length > this.size) this.items.splice(0, this.items.length - this.size);
  }
  since(isoTime) {
    const cutoff = Date.parse(isoTime);
    if (!Number.isFinite(cutoff)) return this.items.slice();
    return this.items.filter((i) => Date.parse(i.at) >= cutoff);
  }
}

const requests = new Ring(DEFAULTS.bufferSize);
const errors = new Ring(500);

/** Collapse ids and numbers so /orders/123 and /orders/456 are one route. */
function normalizeRoute(url) {
  try {
    const path = url.split("?")[0];
    return path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
      .replace(/\/\d+/g, "/:id")
      .replace(/\/[0-9a-f]{16,}/gi, "/:id");
  } catch (_) {
    return url;
  }
}

function record(entry) {
  try {
    requests.push(entry);
  } catch (_) {
    /* never throw into a request */
  }
}

/**
 * Express/Connect middleware.
 *
 * Records method, normalized route, status and duration for every request, plus
 * any error that reaches the handler. Deliberately records NO bodies and no
 * headers unless explicitly enabled, this data leaves the process, and a
 * request body is the most likely place for a password or a card number.
 */
function recursiveMiddleware(options) {
  const settings = Object.assign({}, DEFAULTS, options || {});

  return function recursive(req, res, next) {
    // Never trace the trace endpoint, it would record its own reads forever.
    if (req.url && req.url.indexOf(settings.path) === 0) {
      return handleTraceRequest(req, res, settings);
    }

    const startedAt = Date.now();
    const at = new Date().toISOString();

    res.on("finish", function () {
      record({
        at,
        method: req.method,
        route: normalizeRoute(req.originalUrl || req.url || ""),
        status: res.statusCode,
        durationMs: Date.now() - startedAt,
      });
    });

    next();
  };
}

/** Error-handling middleware. Mount AFTER your routes: app.use(recursiveErrorHandler()). */
function recursiveErrorHandler() {
  return function recursiveError(err, req, res, next) {
    try {
      errors.push({
        at: new Date().toISOString(),
        route: normalizeRoute((req && (req.originalUrl || req.url)) || ""),
        name: (err && err.name) || "Error",
        message: String((err && err.message) || err).slice(0, 500),
        stack: err && err.stack ? String(err.stack).slice(0, 4000) : undefined,
        handled: true,
      });
    } catch (_) {
      /* swallow */
    }
    next(err);
  };
}

/**
 * Catch what never reaches a request handler.
 * A crashed background job is invisible to the UI and to per-request middleware,
 * and is exactly the kind of failure this whole feature exists to surface.
 */
function captureProcessErrors() {
  process.on("uncaughtException", (err) => {
    try {
      errors.push({
        at: new Date().toISOString(),
        route: "(process)",
        name: err.name || "UncaughtException",
        message: String(err.message || err).slice(0, 500),
        stack: err.stack ? String(err.stack).slice(0, 4000) : undefined,
        handled: false,
      });
    } catch (_) {}
  });
  process.on("unhandledRejection", (reason) => {
    try {
      errors.push({
        at: new Date().toISOString(),
        route: "(process)",
        name: "UnhandledRejection",
        message: String((reason && reason.message) || reason).slice(0, 500),
        stack: reason && reason.stack ? String(reason.stack).slice(0, 4000) : undefined,
        handled: false,
      });
    } catch (_) {}
  });
}

/** Manual marker for effects with no HTTP surface, a queue job, a webhook sent. */
function mark(name, data) {
  record({
    at: new Date().toISOString(),
    method: "MARK",
    route: name,
    status: 200,
    durationMs: 0,
    data: data || undefined,
  });
}

function handleTraceRequest(req, res, settings) {
  // The trace endpoint reveals internal routes and error messages. Require a
  // token unless it's explicitly disabled for local development.
  if (settings.token) {
    const provided =
      (req.headers && req.headers["x-recursive-token"]) ||
      (req.url.match(/[?&]token=([^&]+)/) || [])[1];
    if (provided !== settings.token) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
  }

  const since = (req.url.match(/[?&]since=([^&]+)/) || [])[1];
  const sinceIso = since ? decodeURIComponent(since) : new Date(0).toISOString();

  const windowRequests = requests.since(sinceIso);
  const windowErrors = errors.since(sinceIso);

  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      since: sinceIso,
      now: new Date().toISOString(),
      requests: windowRequests,
      errors: windowErrors,
      summary: {
        total: windowRequests.length,
        serverErrors: windowRequests.filter((r) => r.status >= 500).length,
        clientErrors: windowRequests.filter((r) => r.status >= 400 && r.status < 500).length,
        unhandledErrors: windowErrors.filter((e) => !e.handled).length,
        slowest: windowRequests.reduce((max, r) => Math.max(max, r.durationMs), 0),
      },
    }),
  );
}

module.exports = {
  recursiveMiddleware,
  recursiveErrorHandler,
  captureProcessErrors,
  mark,
};
