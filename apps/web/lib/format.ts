/**
 * Display formatting shared across dashboard pages.
 *
 * Separate from the pages because Next.js route files may only export the
 * framework's own fields, a helper exported from a `page.tsx` fails the build
 * with "not a valid Page export field".
 */

export function formatDuration(ms: number | null): string {
  if (ms === null) return ", ";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/** Relative for anything inside a day, absolute beyond it. */
export function formatWhen(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
