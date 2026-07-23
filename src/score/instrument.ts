/**
 * Page instrumentation injected before any site script runs.
 *
 * The central trick: we wrap `EventTarget.prototype.addEventListener` at
 * document-start and record every element that registers a click-ish handler.
 * That lets us answer the question Clarity's DeadClickCount implies but cannot
 * tell us, "does this element that *looks* clickable actually do anything?",
 * without heuristics or CDP spelunking.
 *
 * Everything here runs in page context and must be self-contained ES5-ish code.
 */

export const INSTRUMENTATION = `
(() => {
 if (window.__uxProbe) return;

 const clickable = new WeakSet();
 const CLICK_EVENTS = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart']);

 const nativeAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
 try {
 if (CLICK_EVENTS.has(type) && this instanceof Element) clickable.add(this);
    } catch (_) {}
 return nativeAdd.call(this, type, listener, opts);
  };

 const errors = [];
 window.addEventListener('error', (e) => {
 errors.push({ kind: 'error', message: String(e.message || e.error), source: e.filename || '' });
  });
 window.addEventListener('unhandledrejection', (e) => {
 errors.push({ kind: 'unhandledrejection', message: String(e.reason), source: '' });
  });

  // Mutation + network activity counters, used to detect whether an
  // interaction produced *any* observable response.
  //
  // This script runs at document-start, where document.documentElement is still
  // null. Observing it directly throws and would abort this whole IIFE before
  // __uxProbe is assigned, so defer until there is a root to watch.
 let mutations = 0;
 const observer = new MutationObserver((records) => { mutations += records.length; });
 const startObserving = () => {
 const root = document.documentElement || document.body;
 if (root) {
 observer.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    }
  };
 if (document.documentElement) startObserving();
 else document.addEventListener('DOMContentLoaded', startObserving, { once: true });

 let requests = 0;
 const nativeFetch = window.fetch;
 if (nativeFetch) {
 window.fetch = function (...args) { requests++; return nativeFetch.apply(this, args); };
  }
 const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) { requests++; return nativeOpen.apply(this, args); };

 function looksInteractive(el) {
 const style = getComputedStyle(el);
 if (style.cursor === 'pointer') return true;
 const cls = (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className) || '';
 if (typeof cls === 'string' && /\\b(btn|button|cta|link|clickable|tab|nav-item|card--action)\\b/i.test(cls)) return true;
 if (el.hasAttribute('onclick')) return true;
 return false;
  }

 function isNativelyActionable(el) {
 const tag = el.tagName.toLowerCase();
 if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
 if (tag === 'a') return el.hasAttribute('href');
 if (tag === 'input') return true;
 if (tag === 'label' && (el.hasAttribute('for') || el.querySelector('input,select,textarea'))) return true;
 if (tag === 'summary' || tag === 'option') return true;
 const role = el.getAttribute('role');
 if (role && ['button','link','tab','menuitem','checkbox','radio','switch','option'].includes(role)) return true;
 if (el.hasAttribute('contenteditable')) return true;
 return false;
  }

 function cssPath(el) {
 if (el.id) return '#' + CSS.escape(el.id);
 const parts = [];
 let node = el;
 while (node && node.nodeType === 1 && parts.length < 5) {
 let part = node.tagName.toLowerCase();
 const cls = typeof node.className === 'string' ? node.className.trim().split(/\\s+/).filter(Boolean)[0] : null;
 if (cls) part += '.' + CSS.escape(cls);
 const parent = node.parentElement;
 if (parent) {
 const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
 if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      }
 parts.unshift(part);
 if (node.id) { parts[0] = '#' + CSS.escape(node.id); break; }
 node = node.parentElement;
    }
 return parts.join(' > ');
  }

 window.__uxProbe = {
 errors: () => errors.slice(),
 counters: () => ({ mutations, requests }),
 resetCounters: () => { mutations = 0; requests = 0; },

    /**
     * Elements that present themselves as interactive. Each is tagged with
     * whether it is genuinely actionable (native semantics or a registered
     * listener), the ones that are not are dead-click candidates.
     */
 candidates: () => {
 const out = [];
 const all = document.querySelectorAll('*');
 for (const el of all) {
 if (!(el instanceof Element)) continue;
 const rect = el.getBoundingClientRect();
 if (rect.width < 8 || rect.height < 8) continue;
 const style = getComputedStyle(el);
 if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') continue;
 if (!looksInteractive(el)) continue;

        // Count only the OUTERMOST interactive-looking element. cursor:pointer
        // is inherited, so a card's inner <h3> and <p> would otherwise each be
        // reported as their own dead control, inflating the count several-fold
        // and pointing the fix agent at text nodes instead of the real control.
 let covered = false;
 for (let p = el.parentElement; p; p = p.parentElement) {
 if (isNativelyActionable(p) || clickable.has(p) || looksInteractive(p)) {
 covered = true;
 break;
          }
        }
 if (covered) continue;

 const actionable = isNativelyActionable(el) || clickable.has(el);
 out.push({
 selector: cssPath(el),
 tag: el.tagName.toLowerCase(),
 text: (el.textContent || '').trim().slice(0, 60),
 actionable,
 x: rect.left + rect.width / 2,
 y: rect.top + rect.height / 2,
 absoluteY: rect.top + window.scrollY,
        });
 if (out.length >= 120) break;
      }
 return out;
    },

    /** Document height vs viewport, and where the primary CTA sits. */
 layout: () => {
 const doc = document.documentElement;
 const height = Math.max(doc.scrollHeight, document.body ? document.body.scrollHeight : 0);
 const viewport = window.innerHeight;
 const CTA = /\\b(buy|start|sign ?up|get started|try|subscribe|checkout|add to cart|book|request|contact|continue|next)\\b/i;
 let ctaY = null;
 for (const el of document.querySelectorAll('a,button,[role="button"],input[type="submit"]')) {
 const text = (el.textContent || el.getAttribute('value') || '').trim();
 if (!CTA.test(text)) continue;
 const rect = el.getBoundingClientRect();
 if (rect.width < 8 || rect.height < 8) continue;
 const y = rect.top + window.scrollY;
 if (ctaY === null || y < ctaY) ctaY = y;
      }
 return { height, viewport, ctaY };
    },
  };
})();
`;

export interface Candidate {
  selector: string;
  tag: string;
  text: string;
  actionable: boolean;
  x: number;
  y: number;
  absoluteY: number;
}

export interface PageError {
  kind: string;
  message: string;
  source: string;
}

export interface Layout {
  height: number;
  viewport: number;
  ctaY: number | null;
}
