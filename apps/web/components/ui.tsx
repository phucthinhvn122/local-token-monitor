"use client";

import * as React from "react";
import { AlertCircle, Check, Copy, Inbox, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ button */

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-[var(--color-accent-500)] text-white hover:bg-[var(--color-accent-600)] disabled:hover:bg-[var(--color-accent-500)]",
  secondary:
    "bg-[var(--bg-subtle)] text-[var(--text)] border border-[var(--border-strong)] hover:bg-[var(--border)]",
  ghost: "text-[var(--text-muted)] hover:bg-[var(--bg-subtle)] hover:text-[var(--text)]",
  danger:
    "bg-transparent text-[var(--color-critical)] border border-[var(--color-critical)]/40 hover:bg-[var(--color-critical)]/10"
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className,
  children,
  disabled,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}) {
  return (
    <button
      {...props}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-3 text-[13px]" : "h-9 px-4 text-sm",
        BUTTON_VARIANTS[variant],
        className
      )}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------- card */

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...props}
      className={cn(
        "rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-elevated)]",
        "shadow-[var(--shadow-card)]",
        className
      )}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-5", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
        {description && <p className="mt-1 text-[13px] text-[var(--text-muted)]">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------- input */

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return (
      <input
        ref={ref}
        {...props}
        className={cn(
          "h-9 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-sm",
          "placeholder:text-[var(--text-faint)] transition-colors",
          "focus:border-[var(--color-accent-500)] focus:outline-none",
          "disabled:opacity-50",
          className
        )}
      />
    );
  }
);

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={cn(
        "h-9 w-full rounded-lg border border-[var(--border-strong)] bg-[var(--bg)] px-3 text-sm",
        "focus:border-[var(--color-accent-500)] focus:outline-none",
        className
      )}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  className
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-[var(--text-muted)]">{label}</span>
      {children}
      {error ? (
        <span className="mt-1 block text-[12px] text-[var(--color-critical)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] text-[var(--text-faint)]">{hint}</span>
      ) : null}
    </label>
  );
}

export function Toggle({
  checked,
  onChange,
  label
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        checked ? "bg-[var(--color-accent-500)]" : "bg-[var(--border-strong)]"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
          checked ? "translate-x-4.5" : "translate-x-0.5"
        )}
      />
    </button>
  );
}

/* ------------------------------------------------------------------- badge */

type BadgeTone = "neutral" | "accent" | "safe" | "warning" | "critical";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-[var(--bg-subtle)] text-[var(--text-muted)] border-[var(--border)]",
  accent: "bg-[var(--color-accent-500)]/12 text-[var(--color-accent-400)] border-[var(--color-accent-500)]/25",
  safe: "bg-[var(--color-safe)]/12 text-[var(--color-safe)] border-[var(--color-safe)]/25",
  warning: "bg-[var(--color-warning)]/12 text-[var(--color-warning)] border-[var(--color-warning)]/25",
  critical: "bg-[var(--color-critical)]/12 text-[var(--color-critical)] border-[var(--color-critical)]/25"
};

export function Badge({
  tone = "neutral",
  children,
  className
}: {
  tone?: BadgeTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium",
        BADGE_TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

/* --------------------------------------------------------------- feedback */

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4 w-full", className)} />;
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-3 rounded-full border border-[var(--border)] bg-[var(--bg-subtle)] p-3">
        <Icon className="h-5 w-5 text-[var(--text-faint)]" />
      </div>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="mt-1 max-w-sm text-[13px] text-[var(--text-muted)]">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <AlertCircle className="mb-3 h-5 w-5 text-[var(--color-critical)]" />
      <p className="text-sm font-medium">Something went wrong</p>
      <p className="mt-1 max-w-md text-[13px] text-[var(--text-muted)]">{message}</p>
      {onRetry && (
        <Button className="mt-4" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast {
  id: number;
  message: string;
  tone: "success" | "error" | "info";
}

const ToastContext = React.createContext<(message: string, tone?: Toast["tone"]) => void>(() => undefined);

export function useToast() {
  return React.useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const push = React.useCallback((message: string, tone: Toast["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 text-[13px]",
              "bg-[var(--bg-elevated)] shadow-lg",
              toast.tone === "success" && "border-[var(--color-safe)]/40",
              toast.tone === "error" && "border-[var(--color-critical)]/40",
              toast.tone === "info" && "border-[var(--border-strong)]"
            )}
          >
            {toast.tone === "success" && <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-safe)]" />}
            {toast.tone === "error" && (
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-critical)]" />
            )}
            <span className="flex-1">{toast.message}</span>
            <button
              onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}
              className="text-[var(--text-faint)] hover:text-[var(--text)]"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/* --------------------------------------------------------------- copy chip */

export function CopyButton({
  value,
  label = "Copy",
  size = "sm",
  className
}: {
  value: string;
  label?: string;
  size?: ButtonSize;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);
  const toast = useToast();

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access needs a secure context; say so instead of failing mute.
      toast("Clipboard unavailable — select the text and copy manually", "error");
    }
  };

  return (
    <Button size={size} onClick={copy} className={className}>
      {copied ? <Check className="h-3.5 w-3.5 text-[var(--color-safe)]" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </Button>
  );
}

/* ------------------------------------------------------------- side panel */

/**
 * Right-hand slide-over used instead of stacked modals, per the UI brief:
 * a panel keeps the underlying table visible while an item is edited.
 */
export function SidePanel({
  open,
  onClose,
  title,
  description,
  children,
  footer
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          "relative flex h-full w-full max-w-lg flex-col border-l border-[var(--border)]",
          "bg-[var(--bg-elevated)] shadow-2xl"
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-[var(--text-muted)]">{description}</p>}
          </div>
          <button onClick={onClose} aria-label="Close panel" className="text-[var(--text-faint)] hover:text-[var(--text)]">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-5">{children}</div>
        {footer && <footer className="border-t border-[var(--border)] px-5 py-4">{footer}</footer>}
      </aside>
    </div>
  );
}

/* ------------------------------------------------------------------ table */

export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  // Wide log tables scroll inside their own container; the page never does.
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full min-w-[44rem] border-collapse text-sm", className)}>{children}</table>
    </div>
  );
}

export function Th({
  children,
  sortable,
  active,
  direction,
  onSort,
  className
}: {
  children: React.ReactNode;
  sortable?: boolean;
  active?: boolean;
  direction?: "asc" | "desc";
  onSort?: () => void;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "border-b border-[var(--border)] px-4 py-2.5 text-left text-[12px] font-medium",
        "text-[var(--text-faint)] uppercase tracking-wide",
        className
      )}
    >
      {sortable ? (
        <button
          onClick={onSort}
          className={cn("inline-flex items-center gap-1 hover:text-[var(--text)]", active && "text-[var(--text)]")}
        >
          {children}
          <span aria-hidden="true" className="text-[10px]">
            {active ? (direction === "asc" ? "▲" : "▼") : "↕"}
          </span>
        </button>
      ) : (
        children
      )}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-[var(--border)] px-4 py-2.5 align-middle", className)}>{children}</td>;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-[13px] text-[var(--text-muted)]">
      <span className="tabular">
        {from}–{to} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <span className="tabular px-1">
          {page} / {pages}
        </span>
        <Button size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
