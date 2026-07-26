import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { QuotaStatus } from "@ltm/shared-types";
import {
  Activity, BarChart3, Bell, Bot, CircleDollarSign, Clock3, Database,
  Download, EyeOff, FolderGit2, Gauge, HardDrive, Info, LayoutDashboard, Menu,
  MoreHorizontal, PlugZap, RefreshCw, Search, Server, Settings, ShieldCheck, Sparkles,
  TerminalSquare, Trash2, X, Zap, ExternalLink, KeyRound
} from "lucide-react";
import {
  Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis
} from "recharts";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } }
});
const dashboardAnchorTime = Date.now();

type Row = Record<string, any>;
type RangeKey = "5m" | "15m" | "1h" | "24h" | "7d" | "30d";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers }
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status})`);
  return response.json() as Promise<T>;
}

const number = (value: number) =>
  new Intl.NumberFormat("en-US", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value || 0);
const money = (value: number) => `$${Number(value || 0).toFixed(value > 10 ? 2 : 3)}`;
const ago = (value?: string) => {
  if (!value) return "No activity";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
};
const shortId = (value: string) => `${value.slice(0, 8)}…`;
const rangeMilliseconds = (range: RangeKey) =>
  ({ "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 })[range];
const intervalFor = (range: RangeKey) => range === "5m" ? "5m" : range === "15m" ? "5m" : range === "1h" ? "15m" : range === "24h" ? "hour" : "day";
const percentageChange = (current: number, previous: number) =>
  previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
const windowLabel = (minutes?: number) => {
  if (!minutes) return "current window";
  if (minutes % 10_080 === 0) return `${minutes / 10_080}w window`;
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d window`;
  if (minutes % 60 === 0) return `${minutes / 60}h window`;
  return `${minutes}m window`;
};

function AccuracyBadge({ value }: { value: string }) {
  const normalized = value || "unavailable";
  return <span className={`accuracy accuracy-${normalized}`} title={
    normalized === "exact" ? "Reported directly by the provider" :
    normalized === "derived" ? "Calculated from exact component fields" :
    normalized === "estimated" ? "Estimated locally; not provider-reported" :
    "The provider did not expose enough information"
  }><i />{normalized[0].toUpperCase() + normalized.slice(1)}</span>;
}

function ProviderMark({ provider }: { provider: string }) {
  return <span className={`provider-mark ${provider}`}><span>{provider === "codex" ? "O" : "A"}</span>{provider === "codex" ? "Codex" : "Claude"}</span>;
}

function Delta({ value }: { value: number }) {
  const positive = value >= 0;
  return <span className={positive ? "delta positive" : "delta negative"}>{positive ? "↗" : "↘"} {Math.abs(value).toFixed(1)}%</span>;
}

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

function Sidebar({ page, setPage, mobileOpen, close }: { page: string; setPage: (page: string) => void; mobileOpen: boolean; close: () => void }) {
  const items = [
    ["overview", LayoutDashboard, "Overview"],
    ["providers", PlugZap, "NTTCodex"],
    ["nxtcodex", KeyRound, "NXTCODEX Quota"],
    ["projects", FolderGit2, "Projects"],
    ["sessions", TerminalSquare, "Sessions"],
    ["diagnostics", Gauge, "Diagnostics"]
  ] as const;
  return <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
    <button className="mobile-close" onClick={close} aria-label="Close navigation"><X size={20} /></button>
    <div className="brand"><div className="brand-mark"><Zap size={19} fill="currentColor" /></div><div><strong>Local Token</strong><span>MONITOR</span></div></div>
    <nav>
      <div className="nav-label">Workspace</div>
      {items.map(([id, Icon, label]) => <button key={id} className={page === id ? "active" : ""} onClick={() => { setPage(id); close(); }}>
        <Icon size={18} />{label}{id === "sessions" && <span className="nav-count">9</span>}
      </button>)}
    </nav>
    <div className="sidebar-bottom">
      <div className="privacy-card"><ShieldCheck size={18} /><div><strong>Local by design</strong><span>No telemetry. Ever.</span></div><span className="live-dot" /></div>
      <div className="version-row"><span>v0.1.0</span><span>MIT Licensed</span></div>
    </div>
  </aside>;
}

function Header({ status, settings, openSettings, openMenu }: { status?: Row; settings?: Row; openSettings: () => void; openMenu: () => void }) {
  const providers = status?.providers ?? [];
  const codex = providers.find((item: Row) => item.provider === "codex");
  const claude = providers.find((item: Row) => item.provider === "claude");
  return <header className="topbar">
    <button className="menu-button" onClick={openMenu} aria-label="Open navigation"><Menu size={20} /></button>
    <div className="server-state"><span className="pulse" /><div><strong>All systems local</strong><span>Updated {ago(status?.lastUpdatedAt)}</span></div></div>
    <div className="header-statuses">
      <span className="status-chip"><span className={`dot ${codex?.installation?.installed ? "green" : ""}`} />Codex <b>{codex?.running ? "Live" : codex?.installation?.installed ? "Ready" : "Off"}</b></span>
      <span className="status-chip"><span className={`dot ${claude?.installation?.installed ? "violet" : ""}`} />Claude <b>{claude?.running ? "Live" : claude?.installation?.installed ? "Ready" : "Off"}</b></span>
      <span className="status-chip collectors"><Activity size={14} />{status?.activeCollectors ?? 0} collectors</span>
    </div>
    <div className="header-actions">
      <span className="demo-pill"><Sparkles size={13} />{settings?.demoMode ? "Demo data" : "Live data"}</span>
      <button className="icon-button" aria-label="Notifications"><Bell size={17} /><i /></button>
      <button className="settings-button" onClick={openSettings}><Settings size={16} />Settings</button>
    </div>
  </header>;
}

function OverviewCard({ label, value, icon: Icon, delta, hint, accent }: any) {
  return <article className={`metric-card ${accent ?? ""}`}>
    <div className="metric-top"><span>{label}</span><span className="metric-icon"><Icon size={17} /></span></div>
    <strong>{value}</strong>
    <div className="metric-foot">{delta !== undefined && <Delta value={delta} />}<span>{hint}</span></div>
  </article>;
}

function UsageChart({ data, range, setRange, provider, setProvider, loading }: any) {
  const [visible, setVisible] = useState({ input: true, output: true, cache: true, reasoning: false });
  const chartData = data.map((item: Row) => ({
    ...item,
    label: new Date(item.timestamp).toLocaleDateString(undefined, range === "24h" ? { hour: "2-digit" } : { month: "short", day: "numeric" })
  }));
  const colors: Record<string, string> = { input: "#bff56b", output: "#8b7cf6", cache: "#56c9df", reasoning: "#f5ab5f" };
  return <section className="panel usage-panel">
    <div className="panel-head">
      <div><span className="eyebrow">REAL-TIME USAGE</span><h2>Token flow</h2></div>
      <div className="chart-controls">
        <select value={provider} onChange={(event) => setProvider(event.target.value)} aria-label="Provider filter">
          <option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude Code</option>
        </select>
        <div className="range-tabs">{(["5m","15m","1h","24h","7d","30d"] as RangeKey[]).map((item) =>
          <button className={range === item ? "active" : ""} key={item} onClick={() => setRange(item)}>{item.toUpperCase()}</button>)}
        </div>
      </div>
    </div>
    <div className="legend">
      {Object.entries(visible).map(([key, on]) => <button key={key} className={!on ? "off" : ""} onClick={() => setVisible({ ...visible, [key]: !on })}>
        <i style={{ background: colors[key] }} />{key[0].toUpperCase() + key.slice(1)}</button>)}
    </div>
    <div className="chart-wrap">
      {loading ? <Skeleton className="chart-skeleton" /> : chartData.length === 0 ? <div className="empty-chart"><BarChart3 size={28} /><strong>No token events in this range</strong><span>Try 7D or 30D, or switch to Demo Mode.</span></div> :
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ left: -20, right: 12, top: 12 }}>
          <defs>{Object.entries(colors).map(([key, color]) => <linearGradient id={`fill-${key}`} key={key} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity={.26}/><stop offset="100%" stopColor={color} stopOpacity={0}/></linearGradient>)}</defs>
          <CartesianGrid stroke="#242a32" vertical={false} strokeDasharray="3 6" />
          <XAxis dataKey="label" stroke="#69717d" tickLine={false} axisLine={false} tick={{ fontSize: 11 }} minTickGap={32} />
          <YAxis stroke="#69717d" tickLine={false} axisLine={false} tickFormatter={number} tick={{ fontSize: 11 }} />
          <Tooltip contentStyle={{ background: "#11161d", border: "1px solid #303841", borderRadius: 10, fontSize: 12 }} formatter={(value: any) => [number(Number(value)), "tokens"]} />
          {Object.entries(visible).map(([key, on]) => on && <Area key={key} type="monotone" dataKey={key} stroke={colors[key]} strokeWidth={2} fill={`url(#fill-${key})`} />)}
        </AreaChart>
      </ResponsiveContainer>}
    </div>
  </section>;
}

function ProviderBreakdown({ rows }: { rows: Row[] }) {
  const total = rows.reduce((sum, row) => sum + row.total_tokens, 0) || 1;
  return <section className="panel provider-panel">
    <div className="panel-head"><div><span className="eyebrow">PROVIDERS</span><h2>Usage split</h2></div><button className="ghost-icon"><MoreHorizontal size={18}/></button></div>
    <div className="provider-list">
      {["codex","claude"].map((provider) => {
        const row = rows.find((item) => item.provider === provider) ?? { total_tokens: 0, sessions: 0, projects: 0, exact_rate: 0, estimated_cost: 0 };
        const percent = Math.round(row.total_tokens / total * 100);
        return <div className="provider-row" key={provider}>
          <div className={`provider-logo ${provider}`}>{provider === "codex" ? <Bot size={19}/> : <Sparkles size={19}/>}</div>
          <div className="provider-data">
            <div><strong>{provider === "codex" ? "OpenAI Codex" : "Claude Code"}</strong><span>{number(row.total_tokens)} tokens</span></div>
            <div className="meter"><i style={{ width: `${percent}%` }} /></div>
            <div className="provider-meta"><span>{percent}% share</span><span>{row.sessions} sessions</span><span>{row.projects} projects</span></div>
          </div>
          <div className="provider-cost"><strong>{money(row.estimated_cost)}</strong><span>{row.exact_rate ?? 0}% exact</span></div>
        </div>;
      })}
    </div>
    <div className="privacy-note"><ShieldCheck size={16}/><div><strong>Private collection</strong><span>Usage metadata never leaves this device.</span></div></div>
  </section>;
}

function ProjectTable({ projects, onSelect, limit }: { projects: Row[]; onSelect: (row: Row) => void; limit?: number }) {
  const [search, setSearch] = useState("");
  const [provider, setProvider] = useState("");
  const [sort, setSort] = useState("total_tokens");
  const visible = useMemo(() => projects
    .filter((row) => !search || row.name.toLowerCase().includes(search.toLowerCase()))
    .filter((row) => !provider || String(row.providers).includes(provider))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : Number(b[sort] ?? 0) - Number(a[sort] ?? 0))
    .slice(0, limit), [projects, search, provider, sort, limit]);
  return <section className="panel table-panel">
    <div className="panel-head table-title"><div><span className="eyebrow">PROJECTS</span><h2>Usage by workspace</h2></div>
      <div className="table-tools"><label className="search"><Search size={15}/><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects" /></label>
        <select value={provider} onChange={(e) => setProvider(e.target.value)}><option value="">All providers</option><option value="codex">Codex</option><option value="claude">Claude</option></select>
        <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="total_tokens">Most tokens</option><option value="last_activity">Recent</option><option value="name">Name</option></select>
      </div>
    </div>
    <div className="table-scroll"><table><thead><tr><th>Project</th><th>Provider</th><th>Model</th><th>Input</th><th>Output</th><th>Cache</th><th>Total</th><th>Est. cost</th><th>Accuracy</th><th>Last activity</th></tr></thead>
      <tbody>{visible.map((row) => <tr key={row.id} onClick={() => onSelect(row)}>
        <td><div className="project-cell"><span><FolderGit2 size={17}/></span><div><strong>{row.name}</strong><small>{row.git_branch || "local workspace"}</small></div></div></td>
        <td><div className="provider-stack">{String(row.providers ?? "").split(",").filter(Boolean).map((item) => <i key={item} className={item}>{item === "codex" ? "O" : "A"}</i>)}</div></td>
        <td className="muted">{String(row.models ?? "—").split(",")[0]}</td><td>{number(row.input_tokens)}</td><td>{number(row.output_tokens)}</td><td>{number(row.cache_tokens)}</td>
        <td><strong>{number(row.total_tokens)}</strong></td><td>{money(row.estimated_cost)}</td><td><AccuracyBadge value={Number(row.exact_rate) >= 90 ? "exact" : Number(row.exact_rate) >= 70 ? "derived" : "estimated"} /></td><td className="muted">{ago(row.last_activity)}</td>
      </tr>)}</tbody></table></div>
    {visible.length === 0 && <div className="empty-row">No projects match these filters.</div>}
  </section>;
}

function SessionTable({ sessions }: { sessions: Row[] }) {
  return <section className="panel table-panel full-page-panel">
    <div className="panel-head table-title"><div><span className="eyebrow">SESSION LOG</span><h2>Codex & Claude sessions</h2></div><span className="result-count">{sessions.length} sessions</span></div>
    <div className="table-scroll"><table><thead><tr><th>Session</th><th>Provider</th><th>Project</th><th>Model</th><th>Started</th><th>Duration</th><th>Input</th><th>Output</th><th>Total</th><th>Accuracy</th><th>Status</th></tr></thead>
      <tbody>{sessions.map((row) => {
        const duration = Math.max(1, Math.round((new Date(row.last_activity_at).getTime() - new Date(row.started_at).getTime()) / 60_000));
        return <tr key={row.id}><td><code title={row.id}>{shortId(row.id)}</code></td><td><ProviderMark provider={row.provider}/></td><td>{row.project_name}</td><td className="muted">{row.model || "Unknown"}</td><td className="muted">{new Date(row.started_at).toLocaleDateString()}</td><td>{duration}m</td><td>{number(row.input_tokens)}</td><td>{number(row.output_tokens)}</td><td><strong>{number(row.total_tokens)}</strong></td><td><AccuracyBadge value={row.usage_accuracy}/></td><td><span className={`session-status ${row.status}`}><i/>{row.status}</span></td></tr>;
      })}</tbody></table></div>
  </section>;
}

function ActivityFeed({ activity }: { activity: Row[] }) {
  return <section className="panel activity-panel"><div className="panel-head"><div><span className="eyebrow">LIVE ACTIVITY</span><h2>Collector events</h2></div><span className="live-label"><i/>LIVE</span></div>
    <div className="feed">{activity.slice(0, 7).map((item, index) => <div className="feed-item" key={`${item.timestamp}-${index}`}>
      <span className={`feed-icon ${item.provider ?? "system"}`}>{item.type === "settings" ? <Settings size={14}/> : item.provider === "claude" ? <Sparkles size={14}/> : <TerminalSquare size={14}/>}</span>
      <div><strong>{item.message ?? `${number(item.total_tokens)} tokens recorded`}</strong><span>{item.project_name ? `${item.project_name} · ` : ""}{item.provider ? (item.provider === "codex" ? "Codex" : "Claude") : "System"}</span></div><time>{new Date(item.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
    </div>)}</div>
  </section>;
}

function ProjectDetail({ projectId, close }: { projectId: string; close: () => void }) {
  const client = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["project", projectId], queryFn: () => api<Row>(`/api/projects/${projectId}`) });
  const updateProject = useMutation({
    mutationFn: (patch: Row) => api(`/api/projects/${projectId}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onSuccess: () => { client.invalidateQueries({ queryKey: ["projects"] }); client.invalidateQueries({ queryKey: ["project", projectId] }); }
  });
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
    <section className="detail-modal">{isLoading ? <Skeleton className="detail-skeleton"/> : data && <>
      <button className="modal-close" onClick={close} aria-label="Close project details"><X size={19}/></button>
      <div className="detail-kicker"><FolderGit2 size={16}/>PROJECT DETAILS</div><h2>{data.name}</h2><p>{data.git_remote || data.path}</p>
      <div className="detail-stats"><div><span>Total tokens</span><strong>{number(data.total_tokens)}</strong></div><div><span>Estimated cost</span><strong>{money(data.estimated_cost)}</strong></div><div><span>Exact coverage</span><strong>{data.exact_rate || 0}%</strong></div></div>
      <div className="detail-grid"><div><span>Current branch</span><strong>{data.git_branch || "Not detected"}</strong></div><div><span>Providers</span><strong>{data.providers || "—"}</strong></div><div><span>Models</span><strong>{data.models || "—"}</strong></div><div><span>Last activity</span><strong>{ago(data.last_activity)}</strong></div></div>
      <h3>Daily input / output</h3><div className="mini-chart"><ResponsiveContainer width="100%" height="100%"><AreaChart data={data.timeline}><Area dataKey="input" stroke="#bff56b" fill="#bff56b22"/><Area dataKey="output" stroke="#8b7cf6" fill="#8b7cf622"/><XAxis dataKey="timestamp" hide/><YAxis hide/><Tooltip contentStyle={{background:"#11161d",border:"1px solid #303841"}}/></AreaChart></ResponsiveContainer></div>
      <form className="project-actions" onSubmit={(event) => { event.preventDefault(); const input = event.currentTarget.elements.namedItem("displayName") as HTMLInputElement; updateProject.mutate({ displayName: input.value }); }}><label>Display name<input name="displayName" defaultValue={data.name} /></label><button className="secondary-button" type="submit">Rename</button><button className="danger-link" type="button" onClick={() => { updateProject.mutate({ hidden: true }); close(); }}><EyeOff size={14}/>Hide project</button></form>
      <div className="detail-footer"><ShieldCheck size={15}/> This view contains usage metadata only—never prompts or source code.</div>
    </>}</section>
  </div>;
}

function DiagnosticsPage() {
  const { data, isLoading, refetch } = useQuery({ queryKey: ["diagnostics"], queryFn: () => api<Row>("/api/diagnostics") });
  if (isLoading) return <Skeleton className="page-skeleton"/>;
  return <div className="diagnostics-page">
    <div className="page-heading"><div><span className="eyebrow">SYSTEM CHECK</span><h1>Diagnostics</h1><p>Redacted health information for your local collectors.</p></div><div className="heading-actions"><button className="secondary-button" onClick={() => refetch()}><RefreshCw size={15}/>Run checks</button><a className="primary-button" href="/api/diagnostics/report"><Download size={15}/>Download report</a></div></div>
    <div className="diagnostic-overview"><div><Server/><span>Server</span><strong>Healthy</strong><small>Loopback only</small></div><div><HardDrive/><span>Platform</span><strong>{data?.platform} · {data?.arch}</strong><small>{data?.release}</small></div><div><TerminalSquare/><span>Runtime</span><strong>{data?.nodeVersion}</strong><small>Node.js</small></div><div><Database/><span>Storage</span><strong>SQLite WAL</strong><small>Local device</small></div></div>
    <div className="collector-diagnostics">{data?.collectors?.map((collector: Row) => <section className="panel diagnostic-card" key={collector.provider}>
      <div className="diagnostic-title"><div className={`provider-logo ${collector.provider}`}>{collector.provider === "codex" ? <Bot/> : <Sparkles/>}</div><div><h2>{collector.provider === "codex" ? "OpenAI Codex" : "Claude Code"}</h2><span>{collector.installation.installed ? `Detected · ${collector.installation.version ?? "version unknown"}` : "Not detected"}</span></div><span className={`health-tag ${collector.installation.installed ? "good" : ""}`}>{collector.running ? "Running" : collector.installation.installed ? "Ready" : "Unavailable"}</span></div>
      <div className="diag-numbers"><div><span>Files watched</span><strong>{collector.watchedFiles}</strong></div><div><span>Events collected</span><strong>{collector.collectedEvents}</strong></div><div><span>Duplicates skipped</span><strong>{collector.duplicateEvents}</strong></div></div>
      <h3>Candidate paths</h3><div className="path-list">{collector.candidatePaths.map((item: Row) => <div key={item.path}><i className={item.exists ? "exists" : ""}/><code>{item.path}</code><span>{item.exists ? "Found" : "Not found"}</span></div>)}</div>
      {collector.warning && <div className="warning"><Info size={15}/>{collector.warning}</div>}
    </section>)}</div>
  </div>;
}

function ProviderMetric({ metric }: { metric: Row }) {
  const primary = metric.remaining !== undefined
    ? `${number(metric.remaining)} left`
    : metric.used !== undefined ? `${number(metric.used)} used` : "Unavailable";
  return <div className="quota-metric">
    <span>{metric.label}</span>
    <strong>{primary}</strong>
    <small>
      {metric.limit !== undefined ? `${number(metric.limit)} limit` : metric.unit}
      {metric.resetsAt ? ` · resets ${ago(metric.resetsAt)}` : ""}
    </small>
  </div>;
}

function ThirdPartyProviderCard({ row }: { row: Row }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.config);
  const isNttCodex = row.config.id === "nttcodex";
  const browserBridge = row.browserBridge ?? { state: "disconnected", windowOpen: false, refreshSeconds: 30 };
  const invalidate = () => client.invalidateQueries({ queryKey: ["third-party-providers"] });
  const refresh = useMutation({
    mutationFn: () => api<Row>(`/api/third-party/providers/${row.config.id}/refresh`, {
      method: "POST",
      body: "{}"
    }),
    onSettled: invalidate
  });
  const connectBrowser = useMutation({
    mutationFn: () => api<Row>("/api/third-party/providers/nttcodex/browser/connect", {
      method: "POST",
      body: JSON.stringify({ confirm: "CONNECT NTTCODEX", refreshSeconds: 30 })
    }),
    onSettled: invalidate
  });
  const syncBrowser = useMutation({
    mutationFn: () => api<Row>("/api/third-party/providers/nttcodex/browser/refresh", {
      method: "POST",
      body: JSON.stringify({ confirm: "REFRESH NTTCODEX" })
    }),
    onSettled: invalidate
  });
  const disconnectBrowser = useMutation({
    mutationFn: () => api<Row>("/api/third-party/providers/nttcodex/browser/disconnect", {
      method: "POST",
      body: JSON.stringify({ confirm: "DISCONNECT NTTCODEX" })
    }),
    onSettled: invalidate
  });
  const discover = useMutation({
    mutationFn: () => api<Row>(`/api/third-party/providers/${row.config.id}/discover`, {
      method: "POST",
      body: JSON.stringify({ level: 0 })
    })
  });
  const save = useMutation({
    mutationFn: () => api<Row>(`/api/third-party/providers/${row.config.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        displayName: draft.displayName,
        baseUrl: draft.baseUrl || null,
        quotaEndpoint: draft.quotaEndpoint || null,
        apiKeyEnv: draft.apiKeyEnv || null,
        protocol: draft.protocol,
        enabled: Boolean(draft.enabled),
        refreshIntervalMinutes: Number(draft.refreshIntervalMinutes || 15)
      })
    }),
    onSuccess: (updated) => {
      setDraft(updated.config);
      setEditing(false);
      invalidate();
    }
  });
  const snapshot = row.snapshot;
  const status = snapshot?.status ?? (row.research.domainStatus === "verified" ? "unavailable" : "unverified");
  const metrics = snapshot?.metrics ?? [];
  const sources = snapshot?.sources?.length ? snapshot.sources : row.research.evidence;
  return <section className="panel third-party-card">
    <div className="provider-card-head">
      <div className="third-party-logo"><PlugZap size={19}/></div>
      <div><h2>{row.config.displayName}</h2><span>{row.research.domain || "Custom provider"}</span></div>
      <span className={`provider-state state-${status}`}>{status}</span>
    </div>
    <div className="provider-facts">
      <div><span>Protocol</span><strong>{row.config.protocol}</strong></div>
      <div><span>Domain</span><strong>{row.research.domainStatus}</strong></div>
      <div><span>Credential</span><strong>{isNttCodex ? `Browser ${browserBridge.state}` : row.credentialConfigured ? "Environment ready" : row.config.apiKeyEnv ? "Environment missing" : "Not configured"}</strong></div>
      <div><span>Confidence</span><strong>{snapshot?.confidence ?? "none"}</strong></div>
    </div>
    <div className="provider-endpoint"><code>{isNttCodex ? "https://nttcodex.com/account/keys" : row.config.baseUrl || "Base URL unavailable"}</code></div>
    {isNttCodex && <div className={`browser-bridge-strip bridge-${browserBridge.state}`}>
      <ShieldCheck size={15}/>
      <div>
        <strong>{
          browserBridge.state === "connected" ? "Đã kết nối trình duyệt" :
          browserBridge.state === "waiting-login" ? "Đang chờ bạn đăng nhập" :
          browserBridge.state === "starting" ? "Đang mở cửa sổ NTTCodex" :
          browserBridge.state === "error" ? "Cần kết nối lại" :
          "Chưa kết nối NTTCodex"
        }</strong>
        <span>{
          browserBridge.state === "connected"
            ? `Quota tự cập nhật mỗi ${browserBridge.refreshSeconds ?? 30} giây khi cửa sổ riêng còn mở.`
            : "Bấm Kết nối, sau đó đăng nhập trong cửa sổ Chrome riêng. Không cần nhập cookie hoặc API key."
        }</span>
      </div>
      <div className="browser-bridge-actions">
        {browserBridge.state !== "connected" &&
          <button className="primary-button" onClick={() => connectBrowser.mutate()} disabled={connectBrowser.isPending || browserBridge.state === "starting" || browserBridge.state === "waiting-login"}>
            <KeyRound size={14}/>{connectBrowser.isPending || browserBridge.state === "starting" || browserBridge.state === "waiting-login" ? "Đang chờ đăng nhập…" : "Kết nối NTTCodex"}
          </button>}
        {browserBridge.state === "connected" && <>
          <button className="primary-button" onClick={() => syncBrowser.mutate()} disabled={syncBrowser.isPending}><RefreshCw size={14}/>{syncBrowser.isPending ? "Đang đồng bộ…" : "Đồng bộ ngay"}</button>
          <button className="secondary-button" onClick={() => disconnectBrowser.mutate()} disabled={disconnectBrowser.isPending}><X size={14}/>Ngắt kết nối</button>
        </>}
      </div>
    </div>}
    <div className="quota-metrics">
      {metrics.length ? metrics.map((metric: Row, index: number) => <ProviderMetric key={`${metric.kind}-${index}`} metric={metric}/>) :
        <div className="provider-unavailable"><Gauge size={20}/><div><strong>Remaining quota unavailable</strong><span>{snapshot?.error ?? "No official quota or balance endpoint has been verified."}</span></div></div>}
    </div>
    {(snapshot?.warnings ?? row.research.notes).slice(0, 2).map((warning: string) =>
      <div className="provider-warning" key={warning}><Info size={14}/><span>{warning}</span></div>)}
    <div className="provider-evidence">
      <span>Evidence</span>
      {sources.slice(0, 3).map((source: Row) => source.url
        ? <a href={source.url} target="_blank" rel="noreferrer" key={source.url}>{source.label}<ExternalLink size={11}/></a>
        : <small key={source.label}>{source.label}</small>)}
    </div>
    {snapshot && <div className="provider-freshness">Last checked {ago(snapshot.fetchedAt)} · {snapshot.partial ? "partial snapshot" : "complete snapshot"}</div>}
    {discover.data && <div className="discovery-result">Level {discover.data.executedLevel} · no network request sent · {discover.data.capabilities?.quotaEndpointVerified ? "quota endpoint verified" : "quota endpoint not verified"}</div>}
    {(refresh.error || save.error || connectBrowser.error || syncBrowser.error || disconnectBrowser.error || browserBridge.lastError) &&
      <div className="provider-api-error">{(refresh.error ?? save.error ?? connectBrowser.error ?? syncBrowser.error ?? disconnectBrowser.error)?.message ?? browserBridge.lastError}</div>}
    <div className="provider-actions">
      <button className="secondary-button" onClick={() => discover.mutate()} disabled={discover.isPending}><Search size={14}/>{discover.isPending ? "Checking…" : "Discover L0"}</button>
      {!isNttCodex && <button className="secondary-button" onClick={() => refresh.mutate()} disabled={refresh.isPending}><RefreshCw size={14}/>{refresh.isPending ? "Refreshing…" : "Manual refresh"}</button>}
      <button className="secondary-button" onClick={() => { if (!editing) setDraft(row.config); setEditing(!editing); }}><Settings size={14}/>{editing ? "Close" : "Configure"}</button>
    </div>
    {editing && <div className="provider-config">
      <label>Display name<input value={draft.displayName} onChange={(event) => setDraft({...draft,displayName:event.target.value})}/></label>
      {!isNttCodex && <label>Protocol<select value={draft.protocol} onChange={(event) => setDraft({...draft,protocol:event.target.value})}><option value="unknown">Unknown</option><option value="openai">OpenAI-compatible</option><option value="anthropic">Anthropic-compatible</option></select></label>}
      {!isNttCodex && <label className="wide">Base URL<input value={draft.baseUrl ?? ""} onChange={(event) => setDraft({...draft,baseUrl:event.target.value})} placeholder="https://provider.example/v1"/></label>}
      {!isNttCodex && <label className="wide">Quota endpoint<input value={draft.quotaEndpoint ?? ""} onChange={(event) => setDraft({...draft,quotaEndpoint:event.target.value})} placeholder="Only a documented HTTPS GET endpoint"/></label>}
      {!isNttCodex && <label className="wide">API key environment variable<div className="env-input"><KeyRound size={14}/><input value={draft.apiKeyEnv ?? ""} onChange={(event) => setDraft({...draft,apiKeyEnv:event.target.value})} placeholder="PROVIDER_API_KEY"/></div></label>}
      <label>Minimum refresh (minutes)<input type="number" min="1" max="1440" value={draft.refreshIntervalMinutes} onChange={(event) => setDraft({...draft,refreshIntervalMinutes:event.target.value})}/></label>
      <label className="provider-enabled"><input type="checkbox" checked={Boolean(draft.enabled)} onChange={(event) => setDraft({...draft,enabled:event.target.checked})}/> Enabled</label>
      <div className="provider-config-note"><ShieldCheck size={14}/>{isNttCodex ? "NTTCodex authentication stays inside the dedicated browser profile. Only aggregate quota snapshots enter SQLite." : "Only the environment variable name is saved. Its value never enters this page or SQLite."}</div>
      <button className="primary-button wide" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save provider settings"}</button>
    </div>}
  </section>;
}

function ThirdPartyProvidersPage() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["third-party-providers"],
    queryFn: () => api<Row[]>("/api/third-party/providers"),
    staleTime: 2_000,
    refetchInterval: 2_000
  });
  const rows = [...(data ?? [])].sort((left, right) =>
    left.config.id === "nttcodex" ? -1 : right.config.id === "nttcodex" ? 1 : left.config.displayName.localeCompare(right.config.displayName)
  );
  return <div className="third-party-page">
    <div className="page-heading"><div><span className="eyebrow">NTTCODEX QUOTA</span><h1>NTTCodex & Providers</h1><p>Kết nối NTTCodex ngay tại đây để theo dõi quota hôm nay và tháng này.</p></div><button className="secondary-button" onClick={() => refetch()} disabled={isFetching}><RefreshCw size={15}/>{isFetching ? "Loading…" : "Reload local state"}</button></div>
    <div className="third-party-principles">
      <ShieldCheck size={18}/><div><strong>Local and explicit</strong><span>NTTCodex browser sync starts only when you click Connect. Other providers keep network access off by default.</span></div>
    </div>
    {isLoading ? <Skeleton className="page-skeleton"/> : <div className="third-party-grid">{rows.map((row) => <ThirdPartyProviderCard row={row} key={row.config.id}/>)}</div>}
  </div>;
}

function SettingsDrawer({ settings, close }: { settings: Row; close: () => void }) {
  const client = useQueryClient();
  const [draft, setDraft] = useState(settings);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const save = useMutation({
    mutationFn: () => Promise.all([
      api("/api/settings", { method: "PATCH", body: JSON.stringify({
        port: Number(draft.port), retentionDays: Number(draft.retentionDays), pollingIntervalMs: Number(draft.pollingIntervalMs),
        codexCollectorEnabled: Boolean(draft.codexCollectorEnabled), claudeCollectorEnabled: Boolean(draft.claudeCollectorEnabled),
        tokenEstimationEnabled: Boolean(draft.tokenEstimationEnabled), costEstimationEnabled: Boolean(draft.costEstimationEnabled),
        privacyMode: Boolean(draft.privacyMode), demoMode: Boolean(draft.demoMode), allowNetwork: Boolean(draft.allowNetwork),
        providerNetworkEnabled: Boolean(draft.providerNetworkEnabled),
        customProviderPaths: draft.customProviderPaths ?? [], customLogPaths: draft.customLogPaths ?? []
      }) }),
      api("/api/settings/pricing", { method: "PUT", body: JSON.stringify(draft.pricing ?? []) })
    ]),
    onSuccess: () => { client.invalidateQueries(); close(); }
  });
  const toggle = (key: string) => <button className={`switch ${draft[key] ? "on" : ""}`} onClick={() => setDraft({ ...draft, [key]: !draft[key] })} aria-label={`Toggle ${key}`}><i/></button>;
  return <div className="drawer-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}><aside className="settings-drawer">
    <div className="drawer-head"><div><span className="eyebrow">LOCAL CONFIGURATION</span><h2>Settings</h2></div><button className="modal-close" onClick={close} aria-label="Close settings"><X size={19}/></button></div>
    <div className="drawer-body">
      <div className="setting-section"><h3>Data source</h3><div className="setting-row"><div><strong>Demo Mode</strong><span>Use isolated sample data across 30 days.</span></div>{toggle("demoMode")}</div>
        <div className="setting-row"><div><strong>Codex collector</strong><span>Read supported local usage metadata.</span></div>{toggle("codexCollectorEnabled")}</div>
        <div className="setting-row"><div><strong>Claude collector</strong><span>Read supported local usage metadata.</span></div>{toggle("claudeCollectorEnabled")}</div>
      </div>
      <div className="setting-section"><h3>Privacy & estimates</h3><div className="setting-row"><div><strong>Privacy Mode</strong><span>Hide paths, remotes, usernames and full IDs.</span></div>{toggle("privacyMode")}</div>
        <div className="setting-row"><div><strong>Token estimation</strong><span>Fallback only; always labeled Estimated.</span></div>{toggle("tokenEstimationEnabled")}</div>
        <div className="setting-row"><div><strong>Cost estimation</strong><span>Use the editable local pricing table.</span></div>{toggle("costEstimationEnabled")}</div>
        <div className="setting-row"><div><strong>Provider network</strong><span>Allow manual third-party quota GET requests. Discovery stays local.</span></div>{toggle("providerNetworkEnabled")}</div>
      </div>
      <div className="setting-section"><h3>Server & storage</h3><div className="field-grid"><label>Dashboard port<input type="number" value={draft.port} onChange={(e) => setDraft({...draft,port:e.target.value})}/></label><label>Retention (days)<input type="number" value={draft.retentionDays} onChange={(e) => setDraft({...draft,retentionDays:e.target.value})}/></label><label>Polling (ms)<input type="number" value={draft.pollingIntervalMs} onChange={(e) => setDraft({...draft,pollingIntervalMs:e.target.value})}/></label></div>
        <div className="locked-path"><Database size={15}/><span>{draft.databasePath}</span></div>
      </div>
      <div className="setting-section"><h3>Custom discovery paths</h3>
        <label className="stacked-field">Provider roots<textarea value={(draft.customProviderPaths ?? []).join("\n")} onChange={(event) => setDraft({...draft,customProviderPaths:event.target.value.split(/\r?\n/).filter(Boolean)})} placeholder="One absolute path per line" /></label>
        <label className="stacked-field">Log roots<textarea value={(draft.customLogPaths ?? []).join("\n")} onChange={(event) => setDraft({...draft,customLogPaths:event.target.value.split(/\r?\n/).filter(Boolean)})} placeholder="One absolute path per line" /></label>
        <div className="warning"><Info size={15}/>Custom paths expand local read access. Add only trusted, minimal directories.</div>
      </div>
      <div className="setting-section"><h3>Local model pricing</h3>
        <div className="pricing-list">{(draft.pricing ?? []).map((price: Row, index: number) => <div className="pricing-row" key={`${price.provider}-${index}`}>
          <span>{price.provider}</span>
          <input aria-label={`Pricing model pattern ${index + 1}`} value={price.modelPattern} onChange={(event) => { const pricing=[...draft.pricing]; pricing[index]={...price,modelPattern:event.target.value}; setDraft({...draft,pricing}); }} />
          <label>Input / M<input type="number" min="0" step=".001" value={price.inputPerMillion} onChange={(event) => { const pricing=[...draft.pricing]; pricing[index]={...price,inputPerMillion:Number(event.target.value)}; setDraft({...draft,pricing}); }} /></label>
          <label>Output / M<input type="number" min="0" step=".001" value={price.outputPerMillion} onChange={(event) => { const pricing=[...draft.pricing]; pricing[index]={...price,outputPerMillion:Number(event.target.value)}; setDraft({...draft,pricing}); }} /></label>
          <small>Effective {price.effectiveFrom}</small>
        </div>)}</div>
        <button className="secondary-button add-pricing" onClick={() => setDraft({...draft,pricing:[...(draft.pricing ?? []),{provider:"openai",modelPattern:"new-model",inputPerMillion:0,outputPerMillion:0,effectiveFrom:new Date().toISOString().slice(0,10)}]})}>+ Add model</button>
      </div>
      <div className="setting-section"><h3>Data tools</h3><div className="export-buttons"><a href="/api/export?format=json"><Download size={15}/>Export JSON</a><a href="/api/export?format=csv"><Download size={15}/>Export CSV</a></div>
        {!deleteConfirm ? <button className="danger-link" onClick={() => setDeleteConfirm(true)}><Trash2 size={15}/>Delete all local usage data</button> :
        <div className="confirm-delete"><span>This action resets the local database.</span><button onClick={async () => { await api("/api/data",{method:"DELETE",body:JSON.stringify({confirmation:"DELETE ALL LOCAL DATA"})}); client.invalidateQueries(); setDeleteConfirm(false); }}>Confirm delete</button></div>}
      </div>
    </div>
    <div className="drawer-footer"><button className="secondary-button" onClick={close}>Cancel</button><button className="primary-button" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? "Saving…" : "Save locally"}</button></div>
  </aside></div>;
}

function NxtCodexQuotaDashboard() {
  const queryClient = useQueryClient();
  const [selectedProvider, setSelectedProvider] = useState<"nxtcodex" | "antigravity">("nxtcodex");
  const [autoRefreshIntervalMs, setAutoRefreshIntervalMs] = useState(60_000);
  const [now, setNow] = useState(() => Date.now());
  const [showRawHeaders, setShowRawHeaders] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const quotaQuery = useQuery({
    queryKey: ["quota", selectedProvider],
    queryFn: () => api<QuotaStatus>(`/api/quota?provider=${selectedProvider}`),
    refetchInterval: autoRefreshIntervalMs > 0 ? autoRefreshIntervalMs : false,
    retry: (failureCount) => failureCount < 3
  });

  const historyQuery = useQuery({
    queryKey: ["history", selectedProvider],
    queryFn: () => api<{ provider: string; history: QuotaStatus[]; stats: any }>(`/api/quota/history?provider=${selectedProvider}`),
    refetchInterval: autoRefreshIntervalMs > 0 ? autoRefreshIntervalMs : false
  });

  const refreshMutation = useMutation({
    mutationFn: () => api<QuotaStatus>(`/api/quota/refresh?provider=${selectedProvider}`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quota", selectedProvider] });
      queryClient.invalidateQueries({ queryKey: ["history", selectedProvider] });
    }
  });

  const quota = quotaQuery.data;
  const history = historyQuery.data?.history ?? [];
  const stats = historyQuery.data?.stats ?? {};

  const total = quota?.total ?? null;
  const remaining = quota?.remaining ?? null;
  const used = quota?.used ?? (total !== null && remaining !== null ? Math.max(0, total - remaining) : null);
  const remainingPercent = total && remaining !== null && total > 0 ? (remaining / total) * 100 : null;

  let countdownString = "Không có lịch reset";
  if (quota?.resetAt) {
    const resetMs = new Date(quota.resetAt).getTime();
    const diffMs = resetMs - now;
    if (diffMs <= 0) {
      countdownString = "Đã đến thời điểm reset";
    } else {
      const totalSec = Math.floor(diffMs / 1000);
      const days = Math.floor(totalSec / 86400);
      const hours = Math.floor((totalSec % 86400) / 3600);
      const minutes = Math.floor((totalSec % 3600) / 60);
      const seconds = totalSec % 60;
      countdownString = `${days.toString().padStart(2, "0")}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
    }
  } else if (quota?.secondsUntilReset !== null && quota?.secondsUntilReset !== undefined) {
    const totalSec = Math.max(0, quota.secondsUntilReset);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    countdownString = `${days.toString().padStart(2, "0")}d ${hours.toString().padStart(2, "0")}h ${minutes.toString().padStart(2, "0")}m ${seconds.toString().padStart(2, "0")}s`;
  }

  let progressBarColor = "#bff56b";
  let alertThreshold: "5%" | "10%" | "20%" | null = null;
  if (remainingPercent !== null) {
    if (remainingPercent <= 5) {
      progressBarColor = "#ef4444";
      alertThreshold = "5%";
    } else if (remainingPercent <= 10) {
      progressBarColor = "#f97316";
      alertThreshold = "10%";
    } else if (remainingPercent <= 20) {
      progressBarColor = "#eab308";
      alertThreshold = "20%";
    }
  }

  const chartData = [...history]
    .sort((a, b) => new Date(a.checkedAt).getTime() - new Date(b.checkedAt).getTime())
    .map((item) => ({
      time: new Date(item.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
      remaining: item.remaining ?? 0,
      used: item.used ?? 0,
      total: item.total ?? 0,
      source: item.source
    }));

  return (
    <div className="nxtcodex-dashboard">
      <div className="page-heading">
        <div>
          <div className="provider-toggle-tabs" style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem" }}>
            <button
              className={`secondary-button ${selectedProvider === "nxtcodex" ? "active" : ""}`}
              onClick={() => setSelectedProvider("nxtcodex")}
            >
              NXTCODEX Quota
            </button>
            <button
              className={`secondary-button ${selectedProvider === "antigravity" ? "active" : ""}`}
              onClick={() => setSelectedProvider("antigravity")}
            >
              Antigravity Quota
            </button>
          </div>
          <span className="eyebrow">{selectedProvider.toUpperCase()} DASHBOARD</span>
          <h1>{selectedProvider === "nxtcodex" ? "Codex & NXTCODEX Quota Monitor" : "Antigravity Quota Monitor"}</h1>
          <p>Tự động quét credentials local (auth.json) & API, theo dõi hạn ngạch và thời gian làm mới theo thời gian thực.</p>
        </div>
        <div className="heading-actions">
          <div className="refresh-interval-select">
            <Clock3 size={15} />
            <select
              value={autoRefreshIntervalMs}
              onChange={(e) => setAutoRefreshIntervalMs(Number(e.target.value))}
              aria-label="Auto refresh cycle"
            >
              <option value={10000}>Tự động: 10 giây</option>
              <option value={30000}>Tự động: 30 giây</option>
              <option value={60000}>Tự động: 60 giây (Mặc định)</option>
              <option value={300000}>Tự động: 5 phút</option>
              <option value={0}>Tắt tự động cập nhật</option>
            </select>
          </div>
          <button
            className="primary-button"
            onClick={() => refreshMutation.mutate()}
            disabled={refreshMutation.isPending || quotaQuery.isFetching}
          >
            <RefreshCw size={15} className={refreshMutation.isPending || quotaQuery.isFetching ? "spin" : ""} />
            {refreshMutation.isPending || quotaQuery.isFetching ? "Đang kiểm tra…" : "Kiểm tra ngay"}
          </button>
        </div>
      </div>

      {quota?.source === "auth_json" && (
        <div className="quota-alert-banner threshold-20" style={{ backgroundColor: "rgba(56, 189, 248, 0.1)", borderColor: "rgba(56, 189, 248, 0.3)", color: "#38bdf8" }}>
          <Sparkles size={18} />
          <div>
            <strong>Đã tự động phát hiện auth.json cục bộ!</strong>
            <span>Credentials đã được tự động quét và trích xuất từ <code>{selectedProvider === "nxtcodex" ? "~/.codex/auth.json" : "~/.gemini/antigravity"}</code>.</span>
          </div>
        </div>
      )}

      {alertThreshold && (
        <div className={`quota-alert-banner threshold-${alertThreshold.replace("%", "")}`}>
          <Bell size={18} />
          <div>
            <strong>
              {alertThreshold === "5%"
                ? "CẢNH BÁO NGUY CẤP: Quota còn lại dưới 5%!"
                : alertThreshold === "10%"
                ? "CẢNH BÁO QUAN TRỌNG: Quota còn lại dưới 10%!"
                : "CẢNH BÁO: Quota còn lại dưới 20%!"}
            </strong>
            <span>
              {alertThreshold === "5%"
                ? "Tài khoản gần hết quota hoàn toàn. Hãy nạp thêm hoặc đổi key."
                : alertThreshold === "10%"
                ? "Quota còn lại rất ít. Cân nhắc gia hạn dịch vụ."
                : "Hạn ngạch đang giảm xuống mức thấp."}
            </span>
          </div>
        </div>
      )}

      <div className="metric-grid">
        <article className="metric-card">
          <div className="metric-top">
            <span>Trạng thái Kết nối</span>
            <KeyRound size={17} />
          </div>
          <div className="status-badge-row">
            <span className={`status-badge state-${quota?.status ?? "unknown"}`}>
              {(quota?.status ?? "UNKNOWN").toUpperCase()}
            </span>
            <span className="source-tag">{quota?.source ?? "local_estimate"}</span>
          </div>
          <div className="metric-foot">
            <span>Key ID: <code>{quota?.keyId ?? "nxt_**** (chưa thiết lập)"}</code></span>
          </div>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>Quota Còn lại</span>
            <Zap size={17} />
          </div>
          <strong>{remaining !== null ? number(remaining) : "Không xác định"}</strong>
          <div className="metric-foot">
            <span>
              {remainingPercent !== null ? `${remainingPercent.toFixed(1)}% còn lại` : quota?.unit ?? "units"}
            </span>
          </div>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>Đã dùng / Tổng quota</span>
            <BarChart3 size={17} />
          </div>
          <strong>
            {used !== null ? number(used) : "—"} / {total !== null ? number(total) : "—"}
          </strong>
          <div className="metric-foot">
            <span>Đơn vị: {quota?.unit ?? "unknown"}</span>
          </div>
        </article>

        <article className="metric-card accent-lime">
          <div className="metric-top">
            <span>Đếm ngược đến Reset</span>
            <Clock3 size={17} />
          </div>
          <strong className="countdown-clock">{countdownString}</strong>
          <div className="metric-foot">
            <span>Thời điểm reset: {quota?.resetAt ? new Date(quota.resetAt).toLocaleString() : "Không rõ"}</span>
          </div>
        </article>
      </div>

      <div className="panel quota-progress-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">TIẾN TRÌNH QUOTA</span>
            <h2>Phần trăm Quota Khả dụng</h2>
          </div>
          <div className="checked-at-tag">
            <span>Kiểm tra gần nhất: {quota?.checkedAt ? ago(quota.checkedAt) : "Chưa có data"}</span>
          </div>
        </div>

        <div className="progress-bar-container">
          <div className="progress-bar-track">
            <div
              className="progress-bar-fill"
              style={{
                width: `${Math.min(100, Math.max(0, remainingPercent ?? 0))}%`,
                backgroundColor: progressBarColor
              }}
            />
          </div>
          <div className="progress-labels">
            <span>Đã dùng: {used !== null ? number(used) : "—"}</span>
            <span className="percent-indicator">{remainingPercent !== null ? `${remainingPercent.toFixed(1)}% còn lại` : "N/A"}</span>
            <span>Tổng: {total !== null ? number(total) : "—"}</span>
          </div>
        </div>
      </div>

      <div className="metric-grid">
        <article className="metric-card">
          <div className="metric-top">
            <span>Tốc độ Tiêu thụ Trung bình</span>
            <Activity size={17} />
          </div>
          <strong>{stats.avgRatePerMinute !== undefined ? `${stats.avgRatePerMinute} / phút` : "—"}</strong>
          <div className="metric-foot">
            <span>Tương đương: {stats.avgRatePerHour !== undefined ? `${stats.avgRatePerHour} / giờ` : "—"}</span>
          </div>
        </article>

        <article className="metric-card">
          <div className="metric-top">
            <span>Ước tính Thời điểm Hết Quota</span>
            <Gauge size={17} />
          </div>
          <strong>
            {stats.estimatedSecondsUntilDepletion
              ? `${Math.floor(stats.estimatedSecondsUntilDepletion / 3600)}h ${Math.floor((stats.estimatedSecondsUntilDepletion % 3600) / 60)}m nữa`
              : "Không cạn kiệt ở tốc độ hiện tại"}
          </strong>
          <div className="metric-foot">
            <span>
              {stats.estimatedDepletionAt
                ? `Dự kiến: ${new Date(stats.estimatedDepletionAt).toLocaleString()}`
                : "Tốc độ sử dụng bằng 0 hoặc chưa có dữ liệu lịch sử"}
            </span>
          </div>
        </article>
      </div>

      <div className="panel usage-panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">LỊCH SỬ TIÊU THỤ</span>
            <h2>Biểu đồ Quota Theo Thời gian</h2>
          </div>
        </div>
        <div className="chart-wrapper" style={{ minHeight: "260px", padding: "1rem" }}>
          {chartData.length > 0 ? (
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.1} />
                <XAxis dataKey="time" stroke="#94a3b8" fontSize={12} />
                <YAxis stroke="#94a3b8" fontSize={12} />
                <Tooltip
                  contentStyle={{ backgroundColor: "#1e293b", borderColor: "#334155", color: "#f8fafc" }}
                  formatter={(value: any, name: any) => [number(Number(value)), name === "remaining" ? "Còn lại" : name === "used" ? "Đã dùng" : "Tổng"]}
                />
                <Area type="monotone" dataKey="remaining" stroke="#bff56b" fill="#bff56b" fillOpacity={0.2} name="remaining" />
                <Area type="monotone" dataKey="used" stroke="#8b7cf6" fill="#8b7cf6" fillOpacity={0.2} name="used" />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="provider-unavailable">
              <BarChart3 size={24} />
              <div>
                <strong>Chưa có dữ liệu lịch sử quota</strong>
                <span>Nhấn "Kiểm tra ngay" để ghi nhận snapshot đầu tiên.</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="panel diagnostic-panel" style={{ padding: "1.25rem" }}>
        <div className="panel-head">
          <div>
            <span className="eyebrow">CHẨN ĐOÁN & RESPONSE HEADERS</span>
            <h2>Thông tin Request & Response Header</h2>
          </div>
          <button className="secondary-button" onClick={() => setShowRawHeaders(!showRawHeaders)}>
            {showRawHeaders ? "Ẩn Chi tiết Header" : "Xem Chi tiết Response Header"}
          </button>
        </div>
        {showRawHeaders && (
          <div className="raw-headers-view">
            {quota?.rawHeaders ? (
              <pre className="code-block">{JSON.stringify(quota.rawHeaders, null, 2)}</pre>
            ) : (
              <p>Chưa nhận được raw response headers từ server.</p>
            )}
            {quota?.error && <div className="provider-api-error">Lỗi chẩn đoán: {quota.error}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

function Dashboard() {
  const [page, setPage] = useState("overview");
  const [range, setRange] = useState<RangeKey>("7d");
  const [provider, setProvider] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>();
  const filterWindow = useMemo(() => {
    const end = dashboardAnchorTime;
    const duration = rangeMilliseconds(range);
    return { start: new Date(end - duration).toISOString(), previousStart: new Date(end - duration * 2).toISOString(), previousEnd: new Date(end - duration).toISOString() };
  }, [range]);
  const filters = useMemo(
    () => `from=${encodeURIComponent(filterWindow.start)}&interval=${intervalFor(range)}${provider ? `&provider=${provider}` : ""}`,
    [filterWindow, range, provider]
  );
  const previousFilters = useMemo(
    () => `from=${encodeURIComponent(filterWindow.previousStart)}&to=${encodeURIComponent(filterWindow.previousEnd)}&interval=${intervalFor(range)}${provider ? `&provider=${provider}` : ""}`,
    [filterWindow, range, provider]
  );
  const dayWindows = useMemo(() => {
    const today = new Date(dashboardAnchorTime); today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today.getTime() - 86_400_000);
    return {
      today: `from=${encodeURIComponent(today.toISOString())}${provider ? `&provider=${provider}` : ""}`,
      yesterday: `from=${encodeURIComponent(yesterday.toISOString())}&to=${encodeURIComponent(today.toISOString())}${provider ? `&provider=${provider}` : ""}`
    };
  }, [provider]);
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<Row>("/api/status"), refetchInterval: 15_000 });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api<Row>("/api/settings") });
  const summary = useQuery({ queryKey: ["summary", filters], queryFn: () => api<Row>(`/api/usage/summary?${filters}`) });
  const previousSummary = useQuery({ queryKey: ["summary", previousFilters], queryFn: () => api<Row>(`/api/usage/summary?${previousFilters}`) });
  const todaySummary = useQuery({ queryKey: ["summary", dayWindows.today], queryFn: () => api<Row>(`/api/usage/summary?${dayWindows.today}`) });
  const yesterdaySummary = useQuery({ queryKey: ["summary", dayWindows.yesterday], queryFn: () => api<Row>(`/api/usage/summary?${dayWindows.yesterday}`) });
  const timeline = useQuery({ queryKey: ["timeline", filters], queryFn: () => api<Row[]>(`/api/usage/timeline?${filters}`) });
  const breakdown = useQuery({ queryKey: ["breakdown", filters], queryFn: () => api<Row[]>(`/api/usage/breakdown?${filters}`) });
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api<Row[]>("/api/projects") });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => api<Row[]>("/api/sessions") });
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => api<Row[]>("/api/activity") });

  useEffect(() => {
    const source = new EventSource("/api/events");
    const refresh = () => {
      queryClient.invalidateQueries({ queryKey: ["summary"] });
      queryClient.invalidateQueries({ queryKey: ["timeline"] });
      queryClient.invalidateQueries({ queryKey: ["activity"] });
    };
    source.addEventListener("usage", refresh);
    source.addEventListener("settings", refresh);
    return () => source.close();
  }, []);

  const s = summary.data ?? {};
  const previous = previousSummary.data ?? {};
  const current = projects.data ?? [];
  const todayTokens = todaySummary.data?.totalTokens ?? 0;
  const codexLimits = status.data?.providers?.find((item: Row) => item.provider === "codex")?.usageLimits;
  const codexQuota = codexLimits?.primary ?? codexLimits?.secondary;
  return <div className="app-shell">
    <Sidebar page={page} setPage={setPage} mobileOpen={mobileOpen} close={() => setMobileOpen(false)} />
    <div className="main-shell">
      <Header status={status.data} settings={settings.data} openSettings={() => setSettingsOpen(true)} openMenu={() => setMobileOpen(true)} />
      <main>
        {page === "overview" && <>
          <div className="page-heading"><div><span className="eyebrow">LOCAL WORKSPACE</span><h1>Token intelligence, <em>without the telemetry.</em></h1><p>A live view of Codex and Claude Code usage on this machine.</p></div><div className="heading-actions"><span className="date-chip"><Clock3 size={15}/>{new Date().toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}</span><a className="secondary-button" href="/api/export?format=json"><Download size={15}/>Export</a></div></div>
          <div className="metric-grid">
            <OverviewCard label="Tokens today" value={number(todayTokens)} icon={Zap} delta={percentageChange(todayTokens, yesterdaySummary.data?.totalTokens ?? 0)} hint="vs yesterday" accent="lime" />
            <OverviewCard label={`Tokens · ${range.toUpperCase()}`} value={number(s.totalTokens)} icon={BarChart3} delta={percentageChange(s.totalTokens, previous.totalTokens)} hint="vs prior period" />
            <OverviewCard label="Input tokens" value={number(s.inputTokens)} icon={TerminalSquare} delta={percentageChange(s.inputTokens, previous.inputTokens)} hint={`${Math.round((s.inputTokens || 0)/(s.totalTokens || 1)*100)}% of total`} />
            <OverviewCard label="Output tokens" value={number(s.outputTokens)} icon={Sparkles} delta={percentageChange(s.outputTokens, previous.outputTokens)} hint={`${Math.round((s.outputTokens || 0)/(s.totalTokens || 1)*100)}% of total`} />
            <OverviewCard label="Cache tokens" value={number(s.cacheTokens)} icon={Database} delta={percentageChange(s.cacheTokens, previous.cacheTokens)} hint="read + write" />
            <OverviewCard label="Estimated cost" value={money(s.estimatedCost)} icon={CircleDollarSign} delta={percentageChange(s.estimatedCost, previous.estimatedCost)} hint="local pricing" />
            <OverviewCard
              label="Codex usage limit"
              value={codexQuota ? `${Math.round(codexQuota.usedPercent)}% used` : "Unavailable"}
              icon={Gauge}
              hint={codexQuota
                ? `${Math.max(0, Math.round(100 - codexQuota.usedPercent))}% left · ${windowLabel(codexQuota.windowMinutes)}`
                : "not reported by Codex"}
              accent="quota"
            />
            <OverviewCard label="Active sessions" value={number(status.data?.activeSessions || sessions.data?.filter((item) => item.status === "running").length || 0)} icon={Activity} hint="current snapshot" />
            <OverviewCard label="Active projects" value={number(current.length)} icon={FolderGit2} hint={`${s.exactRate || 0}% exact data`} />
          </div>
          <div className="dashboard-grid"><UsageChart data={timeline.data ?? []} range={range} setRange={setRange} provider={provider} setProvider={setProvider} loading={timeline.isLoading}/><ProviderBreakdown rows={breakdown.data ?? []}/></div>
          <ProjectTable projects={current} onSelect={(row) => setProjectId(row.id)} limit={5}/>
          <div className="bottom-grid"><SessionTable sessions={(sessions.data ?? []).slice(0, 5)}/><ActivityFeed activity={activity.data ?? []}/></div>
        </>}
        {page === "nxtcodex" && <NxtCodexQuotaDashboard />}
        {page === "projects" && <><div className="page-heading"><div><span className="eyebrow">WORKSPACE INDEX</span><h1>Projects</h1><p>Every detected workspace, with usage and accuracy at a glance.</p></div></div><ProjectTable projects={current} onSelect={(row) => setProjectId(row.id)}/></>}
        {page === "sessions" && <><div className="page-heading"><div><span className="eyebrow">LOCAL HISTORY</span><h1>Sessions</h1><p>Provider metadata only. Prompts and responses are never stored.</p></div></div><SessionTable sessions={sessions.data ?? []}/></>}
        {page === "providers" && <ThirdPartyProvidersPage/>}
        {page === "diagnostics" && <DiagnosticsPage/>}
      </main>
    </div>
    {settingsOpen && settings.data && <SettingsDrawer settings={settings.data} close={() => setSettingsOpen(false)}/>}
    {projectId && <ProjectDetail projectId={projectId} close={() => setProjectId(undefined)}/>}
  </div>;
}

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean; error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Dashboard ErrorBoundary caught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: "2rem", color: "#ef4444", backgroundColor: "#0f172a", fontFamily: "sans-serif", minHeight: "100vh" }}>
          <h2>Đã xảy ra lỗi trên giao diện Dashboard</h2>
          <pre style={{ background: "#1e293b", padding: "1rem", borderRadius: "0.5rem", color: "#f8fafc", overflowX: "auto" }}>
            {this.state.error?.toString()}
          </pre>
          <button
            style={{ marginTop: "1rem", padding: "0.5rem 1rem", background: "#38bdf8", color: "#0f172a", border: "none", borderRadius: "0.25rem", cursor: "pointer", fontWeight: "bold" }}
            onClick={() => window.location.reload()}
          >
            Tải lại trang
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Dashboard />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
