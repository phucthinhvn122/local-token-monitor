"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type { TimeseriesPoint } from "@cgw/shared";
import { cn, formatTokens, QUOTA_COLOR, type QuotaLevel } from "@/lib/utils";

/*
 * Chart colour policy
 * -------------------
 * Series identity uses the validated two-slot categorical palette (blue,
 * orange), stepped separately for each surface. The violet accent is reserved
 * for actions and for single-series charts where there is no identity to
 * distinguish. The green/amber/red ramp is reserved for quota state and is
 * never used as a series colour, so a warm mark always means "quota".
 */
const SERIES = {
  dark: { input: "#3987e5", output: "#d95926", accent: "#9085e9" },
  light: { input: "#2a78d6", output: "#eb6834", accent: "#4a3aa7" }
} as const;

function useSeriesColors() {
  const [mode, setMode] = React.useState<"dark" | "light">("dark");

  React.useEffect(() => {
    const read = () =>
      setMode(document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark");
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return SERIES[mode];
}

const AXIS_STYLE = {
  fontSize: 11,
  fill: "var(--text-faint)"
} as const;

function formatBucket(value: string, bucket: "hour" | "day" | "week"): string {
  const date = new Date(value);
  if (bucket === "hour") return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/* ------------------------------------------------------------ progress ring */

/**
 * Quota ring. The number in the middle is the headline; the ring is the
 * secondary read, so the arc stays thin and the label carries the value.
 */
export function ProgressRing({
  percent,
  level,
  size = 148,
  label,
  sublabel
}: {
  percent: number;
  level: QuotaLevel;
  size?: number;
  label: string;
  sublabel?: string;
}) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.min(100, Math.max(0, percent));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        role="img"
        aria-label={`${Math.round(clamped)} percent of quota used`}
        className="-rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--bg-subtle)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={QUOTA_COLOR[level]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="transition-[stroke-dashoffset] duration-700 ease-out"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="tabular text-2xl font-semibold tracking-tight">{label}</span>
        {sublabel && <span className="mt-0.5 text-[12px] text-[var(--text-muted)]">{sublabel}</span>}
      </div>
    </div>
  );
}

export function ProgressBar({ percent, level }: { percent: number; level: QuotaLevel }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full transition-[width] duration-500"
        style={{ width: `${clamped}%`, background: QUOTA_COLOR[level] }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------- sparkline */

/** Trend-only mark: no axes, no tooltip, sized to sit inside a stat tile. */
export function Sparkline({
  data,
  className,
  height = 32
}: {
  data: Array<{ value: number }>;
  className?: string;
  height?: number;
}) {
  const colors = useSeriesColors();
  if (data.length < 2) return <div style={{ height }} className={className} />;

  return (
    <div className={cn("w-full", className)} style={{ height }} aria-hidden="true">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
          <Line
            type="monotone"
            dataKey="value"
            stroke={colors.accent}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ------------------------------------------------------------------ tooltip */

function ChartTooltip({
  active,
  payload,
  label,
  bucket,
  unit
}: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string; dataKey?: string }>;
  label?: string;
  bucket: "hour" | "day" | "week";
  unit: string;
}) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, item) => sum + Number(item.value ?? 0), 0);

  return (
    <div className="rounded-lg border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-[12px] shadow-lg">
      <p className="mb-1.5 font-medium">{label ? formatBucket(label, bucket) : ""}</p>
      {payload.map((item) => (
        <div key={item.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-[var(--text-muted)]">
            <span className="h-2 w-2 rounded-[2px]" style={{ background: item.color }} />
            {item.name}
          </span>
          <span className="tabular font-medium">{formatTokens(Number(item.value ?? 0))}</span>
        </div>
      ))}
      {payload.length > 1 && (
        <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-1.5">
          <span className="text-[var(--text-muted)]">Total {unit}</span>
          <span className="tabular font-medium">{formatTokens(total)}</span>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- usage chart */

/**
 * Token usage over time, input and output stacked.
 *
 * Two series means a legend is mandatory; both are also direct-labelled in the
 * legend row with their current totals, so identity never rests on colour alone.
 */
export function UsageAreaChart({
  data,
  bucket = "day",
  height = 260
}: {
  data: TimeseriesPoint[];
  bucket?: "hour" | "day" | "week";
  height?: number;
}) {
  const colors = useSeriesColors();
  const totals = React.useMemo(
    () => ({
      input: data.reduce((sum, point) => sum + point.inputTokens, 0),
      output: data.reduce((sum, point) => sum + point.outputTokens, 0)
    }),
    [data]
  );

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-4 px-1 text-[12px]">
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: colors.input }} />
          <span className="text-[var(--text-muted)]">Input</span>
          <span className="tabular font-medium">{formatTokens(totals.input)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-[2px]" style={{ background: colors.output }} />
          <span className="text-[var(--text-muted)]">Output</span>
          <span className="tabular font-medium">{formatTokens(totals.output)}</span>
        </span>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <defs>
              <linearGradient id="cgw-input" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.input} stopOpacity={0.32} />
                <stop offset="100%" stopColor={colors.input} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="cgw-output" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors.output} stopOpacity={0.32} />
                <stop offset="100%" stopColor={colors.output} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis
              dataKey="bucket"
              tickFormatter={(value: string) => formatBucket(value, bucket)}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={(value: number) => formatTokens(value)}
              tick={AXIS_STYLE}
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <Tooltip
              content={<ChartTooltip bucket={bucket} unit="tokens" />}
              cursor={{ stroke: "var(--border-strong)", strokeWidth: 1 }}
            />
            <Area
              type="monotone"
              dataKey="inputTokens"
              name="Input"
              stackId="tokens"
              stroke={colors.input}
              strokeWidth={2}
              fill="url(#cgw-input)"
            />
            <Area
              type="monotone"
              dataKey="outputTokens"
              name="Output"
              stackId="tokens"
              stroke={colors.output}
              strokeWidth={2}
              fill="url(#cgw-output)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/**
 * Request volume. A single series carries no identity, so it takes the accent
 * and needs no legend — the card title names it. Bars turn red where the
 * bucket contains failures, which is a status read, not a second series.
 */
export function RequestsBarChart({
  data,
  bucket = "day",
  height = 200
}: {
  data: TimeseriesPoint[];
  bucket?: "hour" | "day" | "week";
  height?: number;
}) {
  const colors = useSeriesColors();

  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(value: string) => formatBucket(value, bucket)}
            tick={AXIS_STYLE}
            tickLine={false}
            axisLine={false}
            minTickGap={28}
          />
          <YAxis tick={AXIS_STYLE} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
          <Tooltip
            content={<ChartTooltip bucket={bucket} unit="requests" />}
            cursor={{ fill: "var(--bg-subtle)" }}
          />
          <Bar dataKey="requests" name="Requests" radius={[4, 4, 0, 0]} maxBarSize={28}>
            {data.map((point) => (
              <Cell
                key={point.bucket}
                fill={point.errors > 0 ? QUOTA_COLOR.critical : colors.accent}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* --------------------------------------------------------------- stat tile */

export function StatTile({
  label,
  value,
  hint,
  trend,
  tone
}: {
  label: string;
  value: string;
  hint?: string;
  trend?: Array<{ value: number }>;
  tone?: QuotaLevel;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border)] bg-[var(--bg-elevated)] p-4 shadow-[var(--shadow-card)]">
      <p className="text-[12px] font-medium uppercase tracking-wide text-[var(--text-faint)]">{label}</p>
      <p
        className="tabular mt-1.5 text-2xl font-semibold tracking-tight"
        style={tone ? { color: QUOTA_COLOR[tone] } : undefined}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">{hint}</p>}
      {trend && trend.length > 1 && <Sparkline data={trend} className="mt-2" />}
    </div>
  );
}
