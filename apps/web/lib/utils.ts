import clsx, { type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const full = new Intl.NumberFormat("en-US");

/** Compact above 10k so a 2,000,000-token grant reads as "2M" in a tile. */
export function formatTokens(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return Math.abs(n) >= 10_000 ? compact.format(n) : full.format(n);
}

export function formatNumber(value: number | null | undefined): string {
  return full.format(Number(value ?? 0));
}

export function formatCurrency(value: number | null | undefined): string {
  const n = Number(value ?? 0);
  return `$${n.toFixed(n < 10 ? 4 : 2)}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "Never";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  const days = Math.floor(minutes / 1440);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Maps a quota level to its semantic colour token. */
export const QUOTA_COLOR = {
  safe: "var(--color-safe)",
  warning: "var(--color-warning)",
  critical: "var(--color-critical)",
  depleted: "var(--color-critical)"
} as const;

export const QUOTA_TEXT_CLASS = {
  safe: "text-[var(--color-safe)]",
  warning: "text-[var(--color-warning)]",
  critical: "text-[var(--color-critical)]",
  depleted: "text-[var(--color-critical)]"
} as const;

export type QuotaLevel = keyof typeof QUOTA_COLOR;
