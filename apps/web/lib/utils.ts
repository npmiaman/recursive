import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's class helper: clsx for conditionals, tailwind-merge to resolve conflicts. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ", ";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRelative(iso: string): string {
  const delta = Date.now() - Date.parse(iso);
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return ", ";
  return `${(value * 100).toFixed(0)}%`;
}
