import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * Warm browser pool.
 *
 * Launching Chromium costs 1-2 seconds. Doing it per flow means a 12-flow sweep
 * burns 15-25 seconds on process startup alone, which is small next to a slow
 * agent run, but dominates once replay makes the runs themselves fast. Fixing
 * the model cost only to leave the launch cost in place would be pointless.
 *
 * One browser process, one fresh CONTEXT per flow. Contexts are cheap (~50ms)
 * and give the isolation that matters: separate cookies, storage, and cache, so
 * flows can't leak state into each other and create phantom failures.
 */

export interface PoolOptions {
  headless?: boolean;
  /** Reuse a logged-in session, most core flows sit behind auth. */
  storageStatePath?: string;
  viewport?: { width: number; height: number };
}

export class BrowserPool {
  private browser?: Browser;
  private options: PoolOptions;

  constructor(options: PoolOptions = {}) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: this.options.headless !== false,
      // Shaves noticeable startup time and avoids sandbox trouble in CI
      // containers, which is where sweeps mostly run.
      args: ["--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check"],
    });
  }

  /** A fresh, isolated context. Always paired with `release`. */
  async acquire(): Promise<{ context: BrowserContext; page: Page }> {
    if (!this.browser) await this.start();

    const context = await this.browser!.newContext({
      viewport: this.options.viewport ?? { width: 1280, height: 800 },
      locale: "en-US",
      ...(this.options.storageStatePath ? { storageState: this.options.storageStatePath } : {}),
    });

    // Images and fonts are irrelevant to whether a button works, and they are
    // most of the bytes. Blocking them is a large, free latency win, the agent
    // reads the accessibility tree, not pixels.
    await context.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "font" || type === "media") return route.abort();
      return route.continue();
    });

    const page = await context.newPage();
    return { context, page };
  }

  async release(context: BrowserContext): Promise<void> {
    await context.close().catch(() => {});
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = undefined;
  }

  /**
   * Save a logged-in session for reuse.
   *
   * The equivalent of rhai's `login` step: authenticate once by hand, persist the
   * cookies, and every later flow starts signed in. Without this, testing any
   * core flow means re-authenticating on every run, which is slow, brittle, and
   * frequently blocked by 2FA.
   */
  async saveStorageState(context: BrowserContext, path: string): Promise<void> {
    await context.storageState({ path });
  }
}
