import type { Page } from "playwright";

/**
 * Page observation, the single biggest lever on speed and cost.
 *
 * The default approach for browsing agents is to screenshot the page and send it
 * to a vision model. That costs roughly 1,000-2,000 tokens per step, is slow to
 * encode, and is *worse* at the thing we actually need: identifying which
 * control to click. A screenshot makes the model infer a selector from pixels.
 *
 * Instead we extract the interactive elements ourselves and hand the model a
 * numbered list, typically 150-400 tokens. The model answers with an index,
 * not a description, which removes selector-guessing from the loop entirely.
 *
 *   [0] button "Add to cart" testid=add-to-cart
 *   [1] link   "Cart (0)"           → /cart
 *   [2] input email  "Email" required
 *
 * That is ~5-10× cheaper per step, materially faster, and more reliable. A
 * screenshot is still available as a fallback for genuinely visual questions
 * ("is this layout broken?"), but it is no longer the default path.
 */

export interface InteractiveElement {
  /** Index the model refers to. */
  index: number;
  tag: string;
  /** button | link | textbox | checkbox …, the accessibility role. */
  role: string;
  /** Visible label, aria-label, placeholder, or value. */
  label: string;
  /** Ranked selectors, most stable first. See trace.ts for why this matters. */
  selectors: string[];
  /** Present for links. */
  href?: string;
  /** Input type, for form fields. */
  inputType?: string;
  required?: boolean;
  disabled?: boolean;
  /** Roughly above the fold, the model should prefer these. */
  inViewport: boolean;
}

export interface Observation {
  url: string;
  title: string;
  elements: InteractiveElement[];
  /** Visible page text, trimmed. Enough for the model to judge state. */
  text: string;
  /** Errors seen in the console since the last observation. */
  consoleErrors: string[];
  /** Cheap change-detection so we can skip re-planning identical pages. */
  hash: string;
}

/**
 * Runs in page context. Kept as a string rather than a typed function so it can
 * be injected without a build step, matching how instrument.ts works.
 */
const EXTRACT = `
(() => {
 const INTERACTIVE = 'a,button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="option"],[role="switch"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';

  /**
   * Elements that only LOOK clickable, a div with cursor:pointer, a card with a
   * button-ish class. They carry no semantics, so the selector above misses them.
   *
   * They must be indexed anyway: a user clicks what looks clickable, and a
   * lookalike that does nothing is the single most common silent defect. An
   * agent that cannot see the fake button cannot test whether it works, which
   * would blind the sweep to precisely the failure class it exists to catch.
   */
 function looksClickable(el) {
 if (el.matches(INTERACTIVE)) return false; // already covered
 const style = getComputedStyle(el);
 if (style.cursor === 'pointer') return true;
 const cls = typeof el.className === 'string' ? el.className : '';
 return /\\b(btn|button|cta|clickable|card--action|tile--action)\\b/i.test(cls);
  }

 function visible(el) {
 const rect = el.getBoundingClientRect();
 if (rect.width < 4 || rect.height < 4) return false;
 const style = getComputedStyle(el);
 if (style.visibility === 'hidden' || style.display === 'none') return false;
 if (parseFloat(style.opacity || '1') < 0.05) return false;
 return true;
  }

 function label(el) {
 const aria = el.getAttribute('aria-label');
 if (aria) return aria.trim();
 const labelledBy = el.getAttribute('aria-labelledby');
 if (labelledBy) {
 const target = document.getElementById(labelledBy);
 if (target && target.textContent) return target.textContent.trim();
    }
 if (el.tagName === 'INPUT') {
 const id = el.getAttribute('id');
 if (id) {
 const bound = document.querySelector('label[for="' + CSS.escape(id) + '"]');
 if (bound && bound.textContent) return bound.textContent.trim();
      }
 const ph = el.getAttribute('placeholder');
 if (ph) return ph.trim();
 const val = el.getAttribute('value');
 if (val) return val.trim();
 const name = el.getAttribute('name');
 if (name) return name.trim();
    }
 const text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
 if (text) return text.slice(0, 80);
 const title = el.getAttribute('title');
 return title ? title.trim() : '';
  }

 function role(el) {
 const explicit = el.getAttribute('role');
 if (explicit) return explicit;
 const tag = el.tagName.toLowerCase();
 if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
 if (tag === 'button') return 'button';
 if (tag === 'select') return 'combobox';
 if (tag === 'textarea') return 'textbox';
 if (tag === 'input') {
 const t = (el.getAttribute('type') || 'text').toLowerCase();
 if (t === 'checkbox') return 'checkbox';
 if (t === 'radio') return 'radio';
 if (t === 'submit' || t === 'button') return 'button';
 return 'textbox';
    }
 return 'generic';
  }

  /**
   * Ranked selectors, most stable first. This ordering is the whole reason
   * replay survives a redesign: a test id outlives a class rename, and a
   * role+name outlives a DOM restructure. CSS is the last resort.
   */
 function selectorsFor(el) {
 const out = [];
 for (const attr of ['data-testid', 'data-test-id', 'data-test', 'data-cy']) {
 const v = el.getAttribute(attr);
 if (v) out.push('[' + attr + '="' + CSS.escape(v) + '"]');
    }
 const id = el.getAttribute('id');
 if (id && !/^[0-9]/.test(id) && !/:r[0-9a-z]+:/i.test(id)) out.push('#' + CSS.escape(id));
 const name = el.getAttribute('name');
 if (name) out.push(el.tagName.toLowerCase() + '[name="' + CSS.escape(name) + '"]');
 const aria = el.getAttribute('aria-label');
 if (aria) out.push('[aria-label="' + CSS.escape(aria) + '"]');

    // Structural fallback: a short path with nth-of-type.
 let node = el, parts = [];
 while (node && node.nodeType === 1 && parts.length < 4) {
 let part = node.tagName.toLowerCase();
 const parent = node.parentElement;
 if (parent) {
 const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
 if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
 parts.unshift(part);
 node = node.parentElement;
    }
 if (parts.length) out.push(parts.join(' > '));
 return out;
  }

 const seen = new Set();
 const elements = [];
 let index = 0;

  // Semantic controls first, then lookalikes, so real buttons get the low
  // indices the model tends to prefer.
 const candidates = Array.from(document.querySelectorAll(INTERACTIVE));
 for (const el of document.querySelectorAll('div,span,li,td,section,article')) {
 if (looksClickable(el)) candidates.push(el);
  }

 for (const el of candidates) {
 if (!visible(el) || seen.has(el)) continue;
 seen.add(el);

    // Skip a control wrapped inside another interactive control, the outer one
    // is what a user clicks, and listing both just confuses the model.
 let wrapped = false;
 for (let p = el.parentElement; p; p = p.parentElement) {
 if (seen.has(p)) { wrapped = true; break; }
    }
 if (wrapped) continue;

 const rect = el.getBoundingClientRect();
 const semantic = el.matches(INTERACTIVE);
 elements.push({
 index: index++,
 tag: el.tagName.toLowerCase(),
      // Flagged so the model knows this only *looks* like a control. If clicking
      // it does nothing, that is a finding, not a reason to try something else.
 role: semantic ? role(el) : 'looks-clickable',
 label: label(el),
 selectors: selectorsFor(el),
 href: el.getAttribute('href') || undefined,
 inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text') : undefined,
 required: el.hasAttribute('required') || undefined,
 disabled: el.hasAttribute('disabled') || undefined,
 inViewport: rect.top < window.innerHeight && rect.bottom > 0,
    });
 if (elements.length >= 120) break;
  }

 const text = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 3000);

 return { url: location.href, title: document.title, elements, text };
})();
`;

/** Cheap hash so an unchanged page can skip a model call entirely. */
function hashOf(url: string, elements: InteractiveElement[], text: string): string {
  const basis =
    url + "|" + elements.map((e) => `${e.role}:${e.label}`).join(",") + "|" + text.slice(0, 500);
  let hash = 0;
  for (let i = 0; i < basis.length; i++) {
    hash = (hash * 31 + basis.charCodeAt(i)) | 0;
  }
  return String(hash);
}

export async function observe(page: Page, consoleErrors: string[] = []): Promise<Observation> {
  const raw = (await page.evaluate(EXTRACT)) as {
    url: string;
    title: string;
    elements: InteractiveElement[];
    text: string;
  };

  return {
    url: raw.url,
    title: raw.title,
    elements: raw.elements,
    text: raw.text,
    consoleErrors: consoleErrors.slice(-5),
    hash: hashOf(raw.url, raw.elements, raw.text),
  };
}

/**
 * Render an observation for the model.
 *
 * Compact on purpose: this string is sent on every step, so every token saved is
 * multiplied by the number of steps in every flow in every sweep.
 */
export function renderObservation(observation: Observation, maxElements = 60): string {
  // In-viewport elements first, the model should prefer what a user can see.
  const ordered = [...observation.elements].sort(
    (a, b) => Number(b.inViewport) - Number(a.inViewport),
  );

  const lines = ordered.slice(0, maxElements).map((element) => {
    const bits = [
      `[${element.index}]`,
      element.role.padEnd(8),
      element.label ? `"${element.label}"` : "(no label)",
    ];
    if (element.inputType && element.inputType !== "text") bits.push(`type=${element.inputType}`);
    if (element.href) bits.push(`→ ${element.href}`);
    if (element.required) bits.push("required");
    if (element.disabled) bits.push("DISABLED");
    if (!element.inViewport) bits.push("(below fold)");
    return "  " + bits.join(" ");
  });

  return [
    `URL: ${observation.url}`,
    `Title: ${observation.title}`,
    "",
    "Interactive elements:",
    ...lines,
    ordered.length > maxElements ? `  … ${ordered.length - maxElements} more` : "",
    "",
    "Visible text:",
    observation.text.slice(0, 1200),
    observation.consoleErrors.length
      ? `\nConsole errors: ${observation.consoleErrors.join(" | ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}
