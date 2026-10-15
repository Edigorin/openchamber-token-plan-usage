// Local service for the Token Plans extension.
// Runs under the app's Node runtime on 127.0.0.1, reachable only through the host proxy.
//
// Data sources:
// - Alibaba Cloud Model Studio (Token Plan): `bl usage token-plan --output json` (Bailian CLI, console auth)
// - Xiaomi MiMo Token Plan: https://platform.xiaomimimo.com/api/v1/{balance,tokenPlan/detail,tokenPlan/usage}
//   with a browser session cookie (see README).
import { execFile } from "node:child_process";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}

const CONFIG_DIR = path.join(os.homedir(), ".config", "openchamber-token-plan-usage");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const BL_CONFIG_FILE = path.join(process.env.BAILIAN_CONFIG_DIR ?? path.join(os.homedir(), ".bailian"), "config.json");

type Config = {
  mimoCookie?: string;
  mimoApiUrl?: string;
  blConsoleSite?: string;
  blConsoleRegion?: string;
};

type ProviderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; hint?: string; needsConsoleLogin?: boolean; needsCookie?: boolean; raw?: unknown };

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

async function readConfig(): Promise<Config> {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8")) as Config;
  } catch {
    return {};
  }
}

async function writeConfig(next: Config): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Bailian CLI config (~/.bailian/config.json) — console token handling.
// The console login flow binds 127.0.0.1 on this machine, which a browser on
// another computer cannot reach, so the token may arrive through the panel
// instead and is stored exactly where `bl` expects it.
// ---------------------------------------------------------------------------

async function readBlConfig(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(BL_CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function blConsoleTokenState(): Promise<{ profile: string; loggedIn: boolean }> {
  const cfg = await readBlConfig();
  const profile = typeof cfg.active_config === "string" && cfg.active_config ? cfg.active_config : "default";
  const entry = (cfg[profile] ?? {}) as Record<string, unknown>;
  return { profile, loggedIn: Boolean(typeof entry.access_token === "string" && entry.access_token.trim()) };
}

async function storeBlConsoleToken(token: string): Promise<{ profile: string }> {
  const cfg = await readBlConfig();
  const profile = typeof cfg.active_config === "string" && cfg.active_config ? cfg.active_config : "default";
  cfg.active_config = profile;
  const value = token.trim();
  // `bl` reads the active profile and top-level keys, but never the `default`
  // entry for console tokens — write both places to cover either layout.
  cfg[profile] = { ...((cfg[profile] ?? {}) as Record<string, unknown>), access_token: value };
  cfg.access_token = value;
  await fs.mkdir(path.dirname(BL_CONFIG_FILE), { recursive: true });
  await fs.writeFile(BL_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  return { profile };
}

function runBl(args: string[]): Promise<{ stdout: string; stderr: string; error?: Error }> {
  return new Promise((resolve) => {
    void (async () => {
      const binary = await resolveBl();
      execFile(binary, args, { timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: error ?? undefined });
      });
    })();
  });
}

// The service gets only a trimmed environment, so fall back to common install
// locations when `bl` is not on PATH.
let blPath: string | null = null;
async function resolveBl(): Promise<string> {
  if (blPath) return blPath;
  const home = os.homedir();
  const candidates = ["bl", "/usr/local/bin/bl", "/usr/bin/bl", path.join(home, ".local/bin/bl")];
  try {
    for (const entry of await fs.readdir(path.join(home, ".nvm/versions/node"))) {
      candidates.push(path.join(home, ".nvm/versions/node", entry, "bin/bl"));
    }
  } catch {
    // no nvm install
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bl");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      blPath = candidate;
      return candidate;
    } catch {
      // keep looking
    }
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, fs.constants.X_OK);
      blPath = candidate;
      return candidate;
    } catch {
      // keep looking
    }
  }
  blPath = "bl";
  return "bl";
}

// ---------------------------------------------------------------------------
// Alibaba Cloud Model Studio (Token Plan) via the Bailian CLI
// ---------------------------------------------------------------------------

async function fetchAlibaba(cfg: Config): Promise<ProviderResult> {
  const flags: string[] = [];
  if (cfg.blConsoleSite) flags.push("--console-site", cfg.blConsoleSite);
  if (cfg.blConsoleRegion) flags.push("--console-region", cfg.blConsoleRegion);

  const [usageCall, addonListCall, addonSummaryCall] = await Promise.all([
    runBl(["usage", "token-plan", "--output", "json", ...flags]),
    runBl([
      "console",
      "call",
      "--api",
      "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/list",
      "--data",
      "{}",
      "--output",
      "json",
      ...flags,
    ]),
    runBl([
      "console",
      "call",
      "--api",
      "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/addon/summary",
      "--data",
      "{}",
      "--output",
      "json",
      ...flags,
    ]),
  ]);

  const { stdout, stderr, error } = usageCall;
  const text = `${stdout}\n${stderr}`;
  const needsLogin = /no console access token|auth login --console/i.test(text);
  const loginHint =
    "The console login callback lands on this machine's 127.0.0.1 only. Either forward the login port over SSH " +
    "(see README), or run `bl auth login --console` on your own computer and paste the console token into Settings below.";

  if (error && /ENOENT|not found/i.test(String(error))) {
    return {
      ok: false,
      error: "The Bailian CLI (bl) is not on PATH.",
      hint: "Install it with `npm install -g bailian-cli`, then retry.",
    };
  }

  let payload: unknown;
  for (const candidate of [stdout, stderr]) {
    try {
      payload = JSON.parse(candidate);
      break;
    } catch {
      // try the next stream
    }
  }
  if (payload === undefined) {
    return {
      ok: false,
      error: text.trim() || String(error ?? "bl exited with an error"),
      needsConsoleLogin: needsLogin,
      hint: needsLogin ? loginHint : undefined,
    };
  }

  const record = (payload ?? {}) as Record<string, unknown>;
  if (record.error) {
    const err = record.error as { message?: string; hint?: string };
    return {
      ok: false,
      error: err.message ?? "bl reported an error",
      hint: err.hint ?? (needsLogin ? loginHint : undefined),
      needsConsoleLogin: needsLogin,
      raw: record,
    };
  }

  const data = normalizeAlibaba(record);

  // Quota add-ons ("额外用量包" / boost packs) live on the console gateway, not
  // in `bl usage token-plan` — best-effort on top of the plan quota.
  const addons = readConsoleData(addonListCall);
  const addonSummary = readConsoleData(addonSummaryCall);
  const addonWindows: Array<Record<string, unknown>> = [];
  const addonItems = Array.isArray(addons?.items) ? (addons.items as Array<Record<string, unknown>>) : [];
  for (const [index, item] of addonItems.entries()) {
    const total = number(item.totalCredits) ?? 0;
    const remaining = number(item.remainingCredits) ?? 0;
    const used = Math.max(0, total - remaining);
    const endMs = number(item.endTime);
    addonWindows.push({
      label: `Quota add-on (${item.addonTier ?? `pack ${index + 1}`})`,
      used,
      limit: total,
      percent: total > 0 ? (used / total) * 100 : 0,
      resetsAt: endMs !== null ? new Date(endMs).toISOString() : null,
    });
  }
  const windows = [...((data.windows as Array<Record<string, unknown>>) ?? []), ...addonWindows];
  return {
    ok: true,
    data: {
      ...data,
      windows,
      addonSummary: addonSummary ?? null,
      addonCount: addonSummary ? number(addonSummary.activeCount) ?? addonItems.length : addonItems.length,
    },
  };
}

// `bl console call` wraps the gateway answer as data.DataV2.data.data.
function readConsoleData(call: { stdout: string; stderr: string }): Record<string, unknown> | null {
  let payload: unknown;
  for (const candidate of [call.stdout, call.stderr]) {
    try {
      payload = JSON.parse(candidate);
      break;
    } catch {
      // try the next stream
    }
  }
  const inner = (payload as { data?: { DataV2?: { data?: { code?: string; data?: unknown } } } } | null)?.data?.DataV2?.data;
  if (!inner || inner.code !== "SUCCESS" || !inner.data || typeof inner.data !== "object") return null;
  return inner.data as Record<string, unknown>;
}

// The console payload shape is passed through with a light normalization so the
// panel can draw a bar when the fields are recognized and still show everything
// when they are not.
function normalizeAlibaba(raw: Record<string, unknown>): Record<string, unknown> {
  const windows: Array<Record<string, unknown>> = [];

  // Token Plan personal usage: `per<Window>Percentage` is a used fraction
  // (0..1) with a matching `per<Window>ResetTime` epoch in milliseconds.
  const labels: Record<string, string> = {
    per1Month: "Monthly quota",
    per1Week: "Weekly quota",
    per1Day: "Daily quota",
  };
  for (const [key, value] of Object.entries(raw)) {
    const match = /^(.*)Percentage$/.exec(key);
    if (!match) continue;
    const fraction = number(value);
    if (fraction === null) continue;
    const prefix = match[1];
    const resetMs = number(raw[`${prefix}ResetTime`]);
    const percent = fraction <= 1 ? fraction * 100 : fraction;
    windows.push({
      label: labels[prefix] ?? (prefix.replace(/^per1?/, "").replace(/([a-z])([A-Z])/g, "$1 $2") || "usage"),
      used: fraction <= 1 ? fraction : percent / 100,
      limit: 1,
      percent,
      resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null,
    });
  }

  if (windows.length === 0) {
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      const entry = value as Record<string, unknown>;
      const used = number(entry.used ?? entry.currentValue ?? entry.consumed ?? entry.usage);
      const limit = number(entry.limit ?? entry.total ?? entry.quota ?? entry.max);
      if (used !== null && limit !== null && limit > 0) {
        windows.push({
          label: entry.name ?? entry.label ?? entry.window ?? entry.type ?? entry.model ?? "usage",
          used,
          limit,
          percent: number(entry.percent ?? entry.percentage ?? entry.usedPercent) ?? Math.round((used / limit) * 100),
          resetsAt: entry.resetsAt ?? entry.resetAt ?? entry.reset_time ?? entry.expiresAt ?? null,
        });
      }
      for (const child of Object.values(entry)) visit(child);
    };
    visit(raw);
  }
  return { raw, windows: windows.slice(0, 12) };
}

function number(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// ---------------------------------------------------------------------------
// Xiaomi MiMo Token Plan via the platform console API
// ---------------------------------------------------------------------------

const MIMO_DEFAULT_API = "https://platform.xiaomimimo.com/api/v1";

const MIMO_ITEM_LABELS: Record<string, string> = {
  month_total_token: "Monthly credits",
  plan_total_token: "Plan credits",
  compensation_total_token: "Compensation credits",
};

async function mimoFetch(url: string, cookie: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    redirect: "manual", // never forward the session cookie across a redirect
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "Accept-Language": "en-US,en;q=0.9",
      "x-timeZone": "UTC+01:00",
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/#/console/balance",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

async function fetchXiaomi(cfg: Config): Promise<ProviderResult> {
  const cookie = (cfg.mimoCookie ?? "").trim();
  if (!cookie) {
    return {
      ok: false,
      error: "No Xiaomi MiMo session configured.",
      hint: "Paste the Cookie header from platform.xiaomimimo.com below.",
      needsCookie: true,
    };
  }

  const base = (cfg.mimoApiUrl ?? MIMO_DEFAULT_API).replace(/\/+$/, "");
  const loginStates = (status: number, code: unknown): boolean =>
    status === 401 || status === 403 || (status >= 300 && status < 400) || code === 401 || code === 403;

  // detail and usage are what the plan-manage page itself reads; balance is
  // pay-as-you-go only, so a subscription account may not answer it at all.
  const [detail, usage, balance, subscription] = await Promise.all([
    mimoFetch(`${base}/tokenPlan/detail`, cookie),
    mimoFetch(`${base}/tokenPlan/usage`, cookie),
    mimoFetch(`${base}/balance`, cookie),
    mimoFetch(`${base}/tokenPlan/subscription/status`, cookie),
  ]);

  const detailBody = detail.body as { code?: number; data?: Record<string, unknown> } | null;
  const usageBody = usage.body as { code?: number; data?: Record<string, unknown> } | null;

  if (loginStates(detail.status, detailBody?.code) && loginStates(usage.status, usageBody?.code)) {
    return {
      ok: false,
      error: "Xiaomi MiMo rejected the stored session.",
      hint: "The cookie is expired or the account logged out. Copy a fresh Cookie header from platform.xiaomimimo.com/#/console/plan-manage and save it below.",
      needsCookie: true,
    };
  }
  if (detail.status !== 200 && usage.status !== 200) {
    return {
      ok: false,
      error: `Xiaomi MiMo requests failed (HTTP ${detail.status} / ${usage.status}).`,
    };
  }

  const detailData = detailBody?.data ?? {};
  const usageData = usageBody?.data ?? {};
  // Tolerant usage parsing: the subscription API reports `monthUsage.items`,
  // other shapes expose `items` or used/limit directly.
  const monthUsage = (usageData.monthUsage ?? usageData) as Record<string, unknown>;
  const items = Array.isArray(monthUsage.items)
    ? (monthUsage.items as Array<Record<string, unknown>>)
    : Array.isArray(usageData.items)
      ? (usageData.items as Array<Record<string, unknown>>)
      : [];
  const first = (items[0] ?? monthUsage) as Record<string, unknown>;
  const lifetime = ((usageData.usage ?? {}) as { items?: Array<Record<string, unknown>> }).items ?? [];

  // The API reports `percent` as a used fraction (0..1). Derive the percentage
  // from used/limit when possible and normalize to 0..100 either way.
  const toItem = (item: Record<string, unknown>): Record<string, unknown> => {
    const used = number(item.used) ?? 0;
    const limit = number(item.limit) ?? 0;
    const fraction = number(item.percent);
    return {
      name: MIMO_ITEM_LABELS[String(item.name ?? "")] ?? (item.name ?? null),
      used,
      limit,
      percent: limit > 0 ? (used / limit) * 100 : fraction !== null ? (fraction <= 1 ? fraction * 100 : fraction) : 0,
    };
  };
  const used = number(first.used ?? monthUsage.used) ?? 0;
  const limit = number(first.limit ?? monthUsage.limit ?? monthUsage.monthlyQuota) ?? 0;
  const fraction = number(first.percent ?? monthUsage.percent);
  const percent = limit > 0 ? (used / limit) * 100 : fraction !== null ? (fraction <= 1 ? fraction * 100 : fraction) : 0;

  // The API reports the same quota twice: `monthUsage` (the monthly window) and
  // `usage.usage` ("plan total"). Keep only the extras that are actually a
  // distinct bucket (e.g. compensation credits), so the card shows one bar per
  // real quota.
  const extraItems = lifetime
    .filter((item) => (number(item.limit) ?? 0) > 0)
    .filter((item) => !(number(item.used) === used && number(item.limit) === limit))
    .map(toItem);

  const balanceData =
    balance.status === 200 ? (((balance.body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>) : {};

  return {
    ok: true,
    data: {
      planCode: detailData.planCode ?? null,
      planName: detailData.planName ?? null,
      periodEnd: detailData.currentPeriodEnd ?? null,
      expired: detailData.expired ?? false,
      used,
      limit,
      percent,
      items: items.map(toItem),
      lifetimeItems: extraItems,
      balance: balanceData.balance ?? null,
      currency: balanceData.currency ?? null,
      cashBalance: balanceData.cashBalance ?? null,
      giftBalance: balanceData.giftBalance ?? null,
      subscription: subscription.status === 200 ? subscription.body : null,
      detail: detailData,
      usage: usageData,
      apiOrigin: base,
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP surface (panel → host → here)
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/usage" && req.method === "GET") {
    void (async () => {
      const cfg = await readConfig();
      const [alibaba, xiaomi] = await Promise.all([fetchAlibaba(cfg), fetchXiaomi(cfg)]);
      json(res, 200, { fetchedAt: new Date().toISOString(), alibaba, xiaomi });
    })();
    return;
  }

  if (url.pathname === "/config" && req.method === "GET") {
    void (async () => {
      const cfg = await readConfig();
      const blState = await blConsoleTokenState();
      json(res, 200, {
        mimoCookieSet: Boolean(cfg.mimoCookie?.trim()),
        mimoApiUrl: cfg.mimoApiUrl ?? MIMO_DEFAULT_API,
        blConsoleSite: cfg.blConsoleSite ?? "",
        blConsoleRegion: cfg.blConsoleRegion ?? "",
        blConsoleLogin: blState.loggedIn,
        blProfile: blState.profile,
      });
    })();
    return;
  }

  if (url.pathname === "/config" && req.method === "PUT") {
    void (async () => {
      try {
        const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;
        const current = await readConfig();
        const next: Config = { ...current };
        if (typeof body.mimoCookie === "string" && body.mimoCookie.trim()) next.mimoCookie = body.mimoCookie.trim();
        if (typeof body.mimoApiUrl === "string" && body.mimoApiUrl.trim()) next.mimoApiUrl = body.mimoApiUrl.trim();
        else delete next.mimoApiUrl;
        if (typeof body.blConsoleSite === "string" && body.blConsoleSite.trim()) next.blConsoleSite = body.blConsoleSite.trim();
        else delete next.blConsoleSite;
        if (typeof body.blConsoleRegion === "string" && body.blConsoleRegion.trim()) next.blConsoleRegion = body.blConsoleRegion.trim();
        else delete next.blConsoleRegion;
        await writeConfig(next);
        if (typeof body.blConsoleToken === "string" && body.blConsoleToken.trim()) {
          await storeBlConsoleToken(body.blConsoleToken);
        }
        const blState = await blConsoleTokenState();
        json(res, 200, {
          ok: true,
          mimoCookieSet: Boolean(next.mimoCookie?.trim()),
          mimoApiUrl: next.mimoApiUrl ?? MIMO_DEFAULT_API,
          blConsoleSite: next.blConsoleSite ?? "",
          blConsoleRegion: next.blConsoleRegion ?? "",
          blConsoleLogin: blState.loggedIn,
          blProfile: blState.profile,
        });
      } catch (error) {
        json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return;
  }

  json(res, 404, { error: "not-found" });
});

server.listen(port, "127.0.0.1");
