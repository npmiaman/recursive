/**
 * @recursive/sdk, the browser agent installed into a customer's application.
 *
 *   <script src="/recursive.js"></script>
 *   <script>
 *     Recursive.init({
 * projectId: "acme-web",
 * endpoint: "https://ingest.recursive.dev/v1/signals",
 * release: "2026.07.23-a1b2c3",
 *     });
 *   </script>
 *
 * THE PRIME DIRECTIVE OF THIS FILE: fail open.
 *
 * If Recursive is down, unreachable, misconfigured, or buggy, the host
 * application must continue working exactly as if this script were never
 * loaded. Every entry point is wrapped, no exception escapes into host code, no
 * host API is replaced without delegating to the original, and no network
 * failure is ever surfaced. That property is worth more than every feature here.
 *
 * Deliberately dependency-free and framework-agnostic, this runs in other
 * people's build pipelines.
 */
(function (global) {
  "use strict";

  var VERSION = "0.1.0";

  var config = {
    projectId: null,
    endpoint: null,
    release: undefined,
    /** Fraction of sessions that report telemetry. */
    sampleRate: 1.0,
    /** Milliseconds between flushes. */
    flushIntervalMs: 10000,
    /** Max events held before an early flush. */
    maxBatch: 50,
    /** ms to wait after a click before declaring it dead. */
    deadClickThresholdMs: 500,
    /** clicks on one element within this window to count as rage. */
    rageClickWindowMs: 1200,
    rageClickCount: 3,
    debug: false,
  };

  var queue = [];
  var started = false;
  var sampled = true;
  var flagState = Object.create(null);

  // ------------------------------------------------------------ safety

  /** Wrap any function so it can never throw into host code. */
  function safe(fn, label) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (err) {
        if (config.debug && global.console) {
          global.console.warn("[recursive] suppressed error in " + label, err);
        }
        return undefined;
      }
    };
  }

  /**
   * Dead-man's switch. The customer can disable all autonomous behaviour from
   * their own side, instantly, without contacting us and without our
   * cooperation (ARCHITECTURE.md §4). Checked on every directive application.
   */
  function autonomyDisabledLocally() {
    try {
      if (global.__RECURSIVE_DISABLE_AUTONOMY === true) return true;
      if (global.localStorage && global.localStorage.getItem("recursive:disable-autonomy")) {
        return true;
      }
    } catch (_) {
      /* storage can throw in private mode, treat as not disabled */
    }
    return false;
  }

  // ------------------------------------------------------------ scrubbing

  // PII is redacted here, in the customer's own process, BEFORE transmission.
  // We should never be in a position to leak what we never received.
  // ORDER IS LOAD-BEARING, specific patterns before greedy ones, or a greedy
  // pattern wins and mislabels, or partially matches and leaves the secret
  // behind. Must stay in sync with SCRUBBERS in src/detect/ingest.ts, which is
  // the second, server-side pass over the same data.
  var SCRUBBERS = [
    [/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "<jwt>"],
    [/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/gi, "<token>"],
    [/\b(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "<auth>"],
    [
      /\b(authorization|api[-_]?key|apikey|password|passwd|pwd|secret|token|credential|session[-_]?id)\b\s*["']?\s*[:=]\s*["']?[^\s"',;)}\]]{4,}/gi,
      "$1=<redacted>",
    ],
    [/\b\d{13,19}\b/g, "<card>"],
    [/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>"],
    [/\b\+?\d{1,3}[\s-]?\d{3,5}[\s-]?\d{3,5}\b/g, "<phone>"],
  ];

  function scrub(text) {
    if (typeof text !== "string") return undefined;
    var out = text;
    for (var i = 0; i < SCRUBBERS.length; i++) {
      out = out.replace(SCRUBBERS[i][0], SCRUBBERS[i][1]);
    }
    return out.slice(0, 2000);
  }

  function route() {
    try {
      return global.location.pathname || "/";
    } catch (_) {
      return "/";
    }
  }

  function selectorFor(el) {
    try {
      if (!el || el.nodeType !== 1) return undefined;
      if (el.id) return "#" + el.id;
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && parts.length < 4) {
        var part = node.tagName.toLowerCase();
        var cls = typeof node.className === "string" ? node.className.trim().split(/\s+/)[0] : null;
        if (cls) part += "." + cls;
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(">");
    } catch (_) {
      return undefined;
    }
  }

  // ------------------------------------------------------------ queue

  function record(cls, fields) {
    if (!sampled || !config.projectId) return;
    var event = {
      class: cls,
      at: new Date().toISOString(),
      route: route(),
    };
    for (var key in fields) {
      if (fields[key] !== undefined && fields[key] !== null) event[key] = fields[key];
    }
    queue.push(event);
    if (queue.length >= config.maxBatch) flush();
  }

  var flush = safe(function flush(useBeacon) {
    if (queue.length === 0 || !config.endpoint) return;
    var batch = queue.splice(0, config.maxBatch);

    var payload = {
      projectId: config.projectId,
      release: config.release,
      sdkVersion: VERSION,
      session: sessionInfo(),
      events: batch,
    };
    var body = JSON.stringify(payload);

    // On page hide, sendBeacon is the only transport that survives unload.
    if (useBeacon && global.navigator && global.navigator.sendBeacon) {
      try {
        global.navigator.sendBeacon(config.endpoint, body);
        return;
      } catch (_) {
        /* fall through to fetch */
      }
    }

    try {
      global
        .fetch(config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body,
          keepalive: true,
          // Telemetry must never carry the customer's session cookies.
          credentials: "omit",
          mode: "cors",
        })
        .catch(function () {
          /* telemetry failure is never surfaced to the host app */
        });
    } catch (_) {
      /* no fetch available, drop silently */
    }
  }, "flush");

  function sessionInfo() {
    try {
      var ua = global.navigator.userAgent || "";
      var device = /Mobi|Android/i.test(ua)
        ? "mobile"
        : /Tablet|iPad/i.test(ua)
          ? "tablet"
          : "desktop";
      var browser = /Edg\//.test(ua)
        ? "Edge"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : /Firefox\//.test(ua)
              ? "Firefox"
              : "Other";
      return {
        browser: browser,
        os: /Windows/.test(ua)
          ? "Windows"
          : /Mac OS/.test(ua)
            ? "macOS"
            : /Android/.test(ua)
              ? "Android"
              : /iPhone|iPad/.test(ua)
                ? "iOS"
                : /Linux/.test(ua)
                  ? "Linux"
                  : "Other",
        device: device,
        locale: global.navigator.language,
      };
    } catch (_) {
      return {};
    }
  }

  // ------------------------------------------------------------ loud signals

  function installErrorCapture() {
    global.addEventListener(
      "error",
      safe(function (e) {
        // Resource load failures have no `error` object; they're still signal.
        if (!e.error && e.target && e.target !== global) {
          record("failed-request", {
            message:
              "Resource failed to load: " + scrub(String(e.target.src || e.target.href || "")),
          });
          return;
        }
        record("exception", {
          message: scrub(String(e.message || (e.error && e.error.message) || "Unknown error")),
          stack: scrub(e.error && e.error.stack),
        });
      }, "onerror"),
      true,
    );

    global.addEventListener(
      "unhandledrejection",
      safe(function (e) {
        var reason = e.reason;
        record("unhandled-rejection", {
          message: scrub(String((reason && reason.message) || reason || "Unhandled rejection")),
          stack: scrub(reason && reason.stack),
        });
      }, "onrejection"),
    );
  }

  function installFetchCapture() {
    if (!global.fetch) return;
    var nativeFetch = global.fetch.bind(global);
    global.fetch = function (input, init) {
      var url;
      try {
        url = typeof input === "string" ? input : input && input.url;
      } catch (_) {
        url = undefined;
      }
      // Never instrument our own telemetry, that path must not recurse.
      if (url && config.endpoint && String(url).indexOf(config.endpoint) === 0) {
        return nativeFetch(input, init);
      }
      return nativeFetch(input, init).then(
        function (response) {
          try {
            if (response && response.status >= 500) {
              record("failed-request", {
                message: "HTTP " + response.status + " " + scrub(stripQuery(String(url || ""))),
              });
            }
          } catch (_) {}
          return response;
        },
        function (error) {
          try {
            record("failed-request", {
              message: "Network failure " + scrub(stripQuery(String(url || ""))),
              stack: scrub(error && error.stack),
            });
          } catch (_) {}
          // Rethrow, we observe, we never change host behaviour.
          throw error;
        },
      );
    };
  }

  function stripQuery(url) {
    var q = url.indexOf("?");
    return q === -1 ? url : url.slice(0, q);
  }

  // ------------------------------------------------------- silent signals

  /**
   * Dead-click and rage-click detection, live.
   *
   * This is the part conventional error tracking has no equivalent for: nothing
   * throws, so nothing is reported, and the defect survives for weeks. We click-
   * watch instead, if an interaction produces no DOM mutation, no network
   * request and no navigation within the threshold, the user got nothing back.
   */
  function installInteractionCapture() {
    var mutations = 0;
    var requests = 0;

    try {
      var observer = new global.MutationObserver(function (records) {
        mutations += records.length;
      });
      var startObserving = function () {
        var root = global.document.documentElement || global.document.body;
        if (root) {
          observer.observe(root, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
          });
        }
      };
      if (global.document.documentElement) startObserving();
      else global.document.addEventListener("DOMContentLoaded", startObserving, { once: true });
    } catch (_) {
      /* no MutationObserver, dead-click detection degrades, everything else works */
    }

    // Count requests via a lightweight hook that delegates to whatever fetch is
    // current (including our own wrapper above).
    try {
      var xhrOpen = global.XMLHttpRequest && global.XMLHttpRequest.prototype.open;
      if (xhrOpen) {
        global.XMLHttpRequest.prototype.open = function () {
          requests++;
          return xhrOpen.apply(this, arguments);
        };
      }
    } catch (_) {}

    var recentClicks = [];

    global.document.addEventListener(
      "click",
      safe(function (event) {
        var target = event.target;
        if (!target || target.nodeType !== 1) return;

        var selector = selectorFor(target);
        var now = Date.now();

        // --- rage detection: repeated clicks on the same element ---
        recentClicks = recentClicks.filter(function (c) {
          return now - c.at < config.rageClickWindowMs;
        });
        recentClicks.push({ selector: selector, at: now });
        var sameTarget = recentClicks.filter(function (c) {
          return c.selector === selector;
        });
        if (sameTarget.length === config.rageClickCount) {
          record("rage-click", { selector: selector, flag: activeFlagFor(target) });
        }

        // --- dead-click detection: did anything happen? ---
        var beforeMutations = mutations;
        var beforeRequests = requests;
        var beforeUrl = global.location.href;

        global.setTimeout(
          safe(function () {
            var responded =
              mutations > beforeMutations ||
              requests > beforeRequests ||
              global.location.href !== beforeUrl;
            if (!responded) {
              record("dead-click", { selector: selector, flag: activeFlagFor(target) });
            }
          }, "deadClickCheck"),
          config.deadClickThresholdMs,
        );
      }, "onclick"),
      true,
    );
  }

  /** If the host tagged an element with a flag, attribute the signal to it. */
  function activeFlagFor(el) {
    try {
      var node = el;
      while (node && node.nodeType === 1) {
        var flag = node.getAttribute && node.getAttribute("data-recursive-flag");
        if (flag) return flag;
        node = node.parentElement;
      }
    } catch (_) {}
    return undefined;
  }

  function installLifecycle() {
    global.addEventListener(
      "visibilitychange",
      safe(function () {
        if (global.document.visibilityState === "hidden") flush(true);
      }, "visibilitychange"),
    );
    global.addEventListener(
      "pagehide",
      safe(function () {
        flush(true);
      }, "pagehide"),
    );
  }

  // ------------------------------------------------------------ flags

  /**
   * The Tier 0 kill mechanism.
   *
   * The host wraps risky features in `Recursive.enabled("checkout-v2")`. When
   * Recursive contains an incident, it flips that flag off and the feature stops
   * running, no deploy, no code change, reversible by a single inverse operation.
   *
   * Defaults to ENABLED on any failure to resolve. An unreachable Recursive must
   * never dark-launch a customer's working feature.
   */
  var enabled = safe(function enabled(flagName, defaultValue) {
    var fallback = defaultValue === undefined ? true : defaultValue;
    if (autonomyDisabledLocally()) return fallback;
    var value = flagState[flagName];
    return typeof value === "boolean" ? value : fallback;
  }, "enabled");

  /** Apply directives fetched from Recursive. Honours the local kill switch. */
  var applyDirectives = safe(function applyDirectives(directives) {
    if (autonomyDisabledLocally()) return;
    if (!directives || typeof directives !== "object") return;
    var flags = directives.flags;
    if (flags && typeof flags === "object") {
      for (var name in flags) {
        if (typeof flags[name] === "boolean") flagState[name] = flags[name];
      }
    }
  }, "applyDirectives");

  var refreshDirectives = safe(function refreshDirectives() {
    if (!config.endpoint || autonomyDisabledLocally()) return;
    var url =
      config.endpoint.replace(/\/signals$/, "/directives") +
      "?projectId=" +
      encodeURIComponent(config.projectId);
    global
      .fetch(url, { credentials: "omit", mode: "cors" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(applyDirectives)
      .catch(function () {
        /* fail open, keep whatever flag state we already have */
      });
  }, "refreshDirectives");

  // ------------------------------------------------------------ public API

  var init = safe(function init(options) {
    if (started) return;
    started = true;

    for (var key in options) {
      if (Object.prototype.hasOwnProperty.call(config, key)) config[key] = options[key];
    }
    if (!config.projectId) {
      if (config.debug && global.console) global.console.warn("[recursive] projectId is required");
      return;
    }

    sampled = Math.random() < config.sampleRate;
    if (!sampled) return;

    installErrorCapture();
    installFetchCapture();
    installInteractionCapture();
    installLifecycle();

    global.setInterval(
      safe(function () {
        flush(false);
      }, "tick"),
      config.flushIntervalMs,
    );
    refreshDirectives();
    global.setInterval(refreshDirectives, 60000);
  }, "init");

  global.Recursive = {
    version: VERSION,
    init: init,
    enabled: enabled,
    flush: function () {
      flush(false);
    },
    /** Explicit health beacon for critical paths: Recursive.check("checkout", ok) */
    check: safe(function (name, ok, detail) {
      if (!ok) {
        record("health-check-failed", {
          message:
            "Health check '" + name + "' failed" + (detail ? ": " + scrub(String(detail)) : ""),
        });
      }
    }, "check"),
    /** Host-side kill switch, callable at runtime. */
    disableAutonomy: function () {
      try {
        global.__RECURSIVE_DISABLE_AUTONOMY = true;
        global.localStorage.setItem("recursive:disable-autonomy", "1");
      } catch (_) {}
    },
  };
})(typeof window !== "undefined" ? window : globalThis);
