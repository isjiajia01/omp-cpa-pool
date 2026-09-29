import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CACHE_MAX_AGE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 3_000;
const POOL_TOKEN_SERVICE = "cpa_pool_read_token";
const DEFAULT_POOL_URL = "https://api.zhangjiajia.me/v0/codex-pool";
const PLUGIN_VERSION = "0.2.0";
const STALE_AFTER_MS = 2 * CACHE_MAX_AGE_MS;
const NO_DATA = "Codex pool quota unavailable; OMP continues normally.";

type PoolValue = { remainingPct: number | null; accountEquivalent: number; knownAccounts: number; eligibleAccounts: number; complete: boolean };
type FiveHourPool = { limitedAccounts: number; unrestrictedAccounts: number; unknownAccounts: number; constrainedPoolRemainingPct: number | null; limitedEquivalent: number; complete: boolean };
type PoolSnapshot = { schemaVersion: 1; accountsTotal: number; accountsAvailable: number; weekly: PoolValue; fiveHour: FiveHourPool; updatedAt: number; complete: boolean; stale: boolean; staleSeconds: number; lastError: string | null };
type Runtime = { lastCompleteSnapshot: PoolSnapshot | null; lastSnapshot: PoolSnapshot | null; request: Promise<PoolSnapshot | null> | null; endpoint: string; credentialSource: string; lastErrorCategory: string | null; lastSuccessAt: number | null; refreshCycles: number; httpRequests: number; renderRequests: number; inputRequests: number };
type CommandContext = { hasUI: boolean; ui: { notify(message: string, level: string): void; setStatus(key: string, text: string | undefined): void; custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: () => void) => { render(width: number): readonly string[]; handleInput?(data: string): void; dispose?(): void }): Promise<void> } };
type ExtensionApi = { registerCommand(name: string, options: { description: string; handler(args: string, ctx: CommandContext): Promise<void> }): void; on(event: string, handler: (event: unknown, ctx?: CommandContext) => void): void; logger?: { info(message: string): void } };

const host = globalThis as typeof globalThis & { __ompCpaPoolV3?: Runtime };
const runtime = host.__ompCpaPoolV3 ??= { lastCompleteSnapshot: null, lastSnapshot: null, request: null, endpoint: "", credentialSource: "unknown", lastErrorCategory: null, lastSuccessAt: null, refreshCycles: 0, httpRequests: 0, renderRequests: 0, inputRequests: 0 };
const subscribers = new Set<(snapshot: PoolSnapshot | null) => void>();

/** Canonical boundary guard for untrusted JSON in this package. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function numeric(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|unauthorized|token/i.test(message)) return "pool-auth";
  if (/timeout|abort/i.test(message)) return "timeout";
  if (/schema|invalid|json/i.test(message)) return "invalid-pool-response";
  if (/fetch|network|econn|enotfound|socket/i.test(message)) return "network";
  return "pool-request";
}
function poolEndpoint(): string {
  const configured = process.env.CPA_POOL_URL?.trim() || DEFAULT_POOL_URL;
  const url = new URL(configured);
  if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "localhost") throw new Error("invalid pool endpoint");
  return url.toString();
}
async function readPoolToken(): Promise<string | null> {
  const direct = process.env.CPA_POOL_READ_TOKEN?.trim();
  if (direct) { runtime.credentialSource = "env:CPA_POOL_READ_TOKEN"; return direct; }
  try {
    const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", POOL_TOKEN_SERVICE, "-w"], { timeout: REQUEST_TIMEOUT_MS, maxBuffer: 4096 });
    const token = stdout.trim();
    runtime.credentialSource = token ? `keychain:${POOL_TOKEN_SERVICE}` : "keychain:empty";
    return token || null;
  } catch {
    runtime.credentialSource = "keychain:unavailable";
    return null;
  }
}
function poolValue(raw: unknown, field: "weekly"): PoolValue | null {
  if (!record(raw)) return null;
  const known = numeric(raw.known_accounts);
  const eligible = numeric(raw.eligible_accounts);
  const equivalent = numeric(raw.account_equivalent);
  if (known === null || eligible === null || equivalent === null) return null;
  const remaining = numeric(raw.remaining_pct);
  return { remainingPct: remaining, accountEquivalent: equivalent, knownAccounts: known, eligibleAccounts: eligible, complete: raw.complete === true && remaining !== null };
}
function fiveHourValue(raw: unknown): FiveHourPool | null {
  if (!record(raw)) return null;
  const limited = numeric(raw.limited_accounts);
  const unrestricted = numeric(raw.unrestricted_accounts);
  const unknown = numeric(raw.unknown_accounts);
  const equivalent = numeric(raw.limited_equivalent);
  if (limited === null || unrestricted === null || unknown === null || equivalent === null) return null;
  return { limitedAccounts: limited, unrestrictedAccounts: unrestricted, unknownAccounts: unknown, constrainedPoolRemainingPct: numeric(raw.constrained_pool_remaining_pct), limitedEquivalent: equivalent, complete: raw.complete === true && unknown === 0 };
}
function parseSnapshot(payload: unknown): PoolSnapshot | null {
  if (!record(payload) || numeric(payload.schema_version) !== 1 || payload.provider !== "codex") return null;
  const weekly = poolValue(payload.weekly, "weekly");
  const fiveHour = fiveHourValue(payload.five_hour);
  const total = numeric(payload.accounts_total);
  const available = numeric(payload.accounts_available);
  const updatedAt = numeric(payload.updated_at);
  if (!weekly || !fiveHour || total === null || available === null || updatedAt === null) return null;
  return { schemaVersion: 1, accountsTotal: total, accountsAvailable: available, weekly, fiveHour, updatedAt, complete: payload.complete === true && weekly.complete, stale: payload.stale === true, staleSeconds: numeric(payload.stale_seconds) ?? 0, lastError: typeof payload.last_error === "string" && payload.last_error ? payload.last_error : null };
}
async function performRefresh(force: boolean): Promise<PoolSnapshot | null> {
  if (!force && runtime.lastSnapshot && Date.now() - runtime.lastSnapshot.updatedAt < CACHE_MAX_AGE_MS) return runtime.lastSnapshot;
  if (runtime.request) return runtime.request;
  runtime.request = (async () => {
    runtime.refreshCycles += 1;
    try {
      const endpoint = poolEndpoint();
      runtime.endpoint = endpoint;
      const token = await readPoolToken();
      if (!token) throw new Error("pool token unavailable");
      runtime.httpRequests += 1;
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`pool HTTP ${response.status}`);
      const snapshot = parseSnapshot(await response.json());
      if (!snapshot) throw new Error("invalid pool response schema");
      runtime.lastErrorCategory = snapshot.lastError;
      runtime.lastSuccessAt = Date.now();
      runtime.lastSnapshot = snapshot;
      if (snapshot.complete) runtime.lastCompleteSnapshot = snapshot;
      return snapshot;
    } catch (error) {
      runtime.lastErrorCategory = classifyError(error);
      return runtime.lastSnapshot;
    } finally {
      runtime.request = null;
      for (const subscriber of subscribers) subscriber(displaySnapshot());
    }
  })();
  return runtime.request;
}
function displaySnapshot(): PoolSnapshot | null { return runtime.lastCompleteSnapshot ?? runtime.lastSnapshot; }
function ageLabel(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`;
}
function percent(value: number | null): string { return value === null ? "—" : `${Math.round(value)}%`; }
function statusText(snapshot: PoolSnapshot | null): string {
  runtime.renderRequests += 1;
  if (!snapshot) return "";
  const weekly = snapshot.weekly;
  const five = snapshot.fiveHour;
  const fivePart = five.unrestrictedAccounts > 0 ? ` · 5h ${percent(five.constrainedPoolRemainingPct)} +${five.unrestrictedAccounts}∞${five.unknownAccounts > 0 ? ` ?${five.unknownAccounts}` : ""}` : five.unknownAccounts > 0 ? ` · 5h ? ${five.limitedAccounts}+${five.unknownAccounts}` : five.limitedAccounts > 0 ? ` · 5h ${percent(five.constrainedPoolRemainingPct)}` : "";
  const lastSuccess = runtime.lastSuccessAt;
  const overdue = lastSuccess !== null && Date.now() - lastSuccess > STALE_AFTER_MS;
  const stale = snapshot.stale || overdue ? ` · stale ${ageLabel(lastSuccess ?? snapshot.updatedAt)}` : "";
  if (!weekly.complete) {
    const equivalent = weekly.knownAccounts > 0 ? `${weekly.accountEquivalent.toFixed(2)}× · ` : "";
    return `Codex W? · ${equivalent}${weekly.knownAccounts}/${weekly.eligibleAccounts}${fivePart}${stale}`;
  }
  const low = weekly.remainingPct !== null && weekly.remainingPct < 10 || five.constrainedPoolRemainingPct !== null && five.constrainedPoolRemainingPct < 10 ? " · 🔴" : weekly.remainingPct !== null && weekly.remainingPct < 30 || five.constrainedPoolRemainingPct !== null && five.constrainedPoolRemainingPct < 30 ? " · ⚠" : "";
  return `Codex W${percent(weekly.remainingPct)}${low} · ${weekly.accountEquivalent.toFixed(2)}×${fivePart}${stale}`;
}
function detailLines(snapshot: PoolSnapshot | null): string[] {
  const five = snapshot?.fiveHour;
  const header = ["Codex Pool", "", `Accounts        ${snapshot ? `${snapshot.accountsAvailable}/${snapshot.accountsTotal}` : "—"} available`, `Weekly          ${snapshot ? percent(snapshot.weekly.remainingPct) : "—"}${snapshot?.weekly.complete ? "" : " (partial)"}`, `Coverage        weekly ${snapshot ? `${snapshot.weekly.knownAccounts}/${snapshot.weekly.eligibleAccounts}` : "0/0"}`, `Remaining       ${snapshot ? `${snapshot.weekly.accountEquivalent.toFixed(2)}×` : "—"}`, "5h Pool", `Limited accounts       ${five?.limitedAccounts ?? 0}`, `Unrestricted accounts  ${five?.unrestrictedAccounts ?? 0}`, `Unknown accounts       ${five?.unknownAccounts ?? 0}`, `Limited-pool remaining ${percent(five?.constrainedPoolRemainingPct ?? null)} (${five?.limitedAccounts ?? 0} limited accounts only)`, `Updated         ${snapshot ? `${ageLabel(snapshot.updatedAt)} ago` : "never"}${snapshot?.stale ? " (stale)" : ""}`, `Source          ${runtime.endpoint || "unresolved"}`];
  if (snapshot?.lastError) header.push(`Last issue      ${snapshot.lastError}`);
  return header;
}
function debugLines(): string[] {
  return ["Codex Pool diagnostics", "", `Version         ${PLUGIN_VERSION}`, `Endpoint        ${runtime.endpoint || "unresolved"}`, `Credential      ${runtime.credentialSource}`, `Refresh cycles  ${runtime.refreshCycles}`, `HTTP requests   ${runtime.httpRequests}`, `Status renders  ${runtime.renderRequests}`, `Input requests  ${runtime.inputRequests}`, `Last error      ${runtime.lastErrorCategory ?? "none"}`, `Snapshot        ${runtime.lastSnapshot ? `${ageLabel(runtime.lastSnapshot.updatedAt)} ago` : "none"}`, `Complete snap   ${runtime.lastCompleteSnapshot ? `${ageLabel(runtime.lastCompleteSnapshot.updatedAt)} ago` : "none"}`, "", "Statusline renders and key presses never issue HTTP; refreshes occur on session start and /quota when stale or forced.", "", "Press Enter or Esc to close."];
}
async function showPanel(ctx: CommandContext, lines: string[]): Promise<void> {
  const text = lines.join("\n");
  if (!ctx.hasUI) { ctx.ui.notify(text, "info"); return; }
  await ctx.ui.custom((_tui, _theme, _keys, done) => ({
    render: (width: number) => text.split("\n").map(line => line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line),
    handleInput: (data: string) => { runtime.inputRequests += 1; if (data === "\u001b" || data === "\r" || data === "\n") done(); },
  }));
}

export default function (pi: ExtensionApi): void {
  let activeContext: CommandContext | null = null;
  const publish = () => activeContext?.ui.setStatus("cpa-pool", statusText(displaySnapshot()) || undefined);
  pi.registerCommand("quota", {
    description: "Show Codex account-pool quota (/quota refresh, /quota debug)",
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (action === "debug") { await showPanel(ctx, debugLines()); return; }
      const snapshot = await performRefresh(action === "refresh");
      await showPanel(ctx, snapshot ? detailLines(snapshot) : [NO_DATA]);
      if (runtime.lastErrorCategory) ctx.ui.notify(`Codex pool: last refresh issue = ${runtime.lastErrorCategory}; showing last successful snapshot where available.`, "warning");
    },
  });
  pi.on("session_start", (_event, ctx) => {
    if (!ctx) return;
    activeContext = ctx;
    subscribers.add(publish);
    void performRefresh(true).then(publish);
  });
  pi.on("session_switch", (_event, ctx) => { if (!ctx) return; activeContext = ctx; publish(); });
  pi.on("session_shutdown", (_event, ctx) => {
    if (activeContext !== ctx) return;
    activeContext = null;
    subscribers.delete(publish);
  });
  pi.logger?.info("CPA Codex pool extension loaded; use /quota, /quota refresh, /quota debug");
}
