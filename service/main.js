// service/main.ts
import { execFile } from "node:child_process";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!port || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var CONFIG_DIR = path.join(os.homedir(), ".config", "openchamber-token-plan-usage");
var CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
var BL_CONFIG_FILE = path.join(process.env.BAILIAN_CONFIG_DIR ?? path.join(os.homedir(), ".bailian"), "config.json");
var json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};
var readBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => resolve(body));
  req.on("error", reject);
});
async function readConfig() {
  try {
    return JSON.parse(await fs.readFile(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function writeConfig(next) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}
`, { mode: 384 });
}
async function readBlConfig() {
  try {
    return JSON.parse(await fs.readFile(BL_CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}
async function blConsoleTokenState() {
  const cfg = await readBlConfig();
  const profile = typeof cfg.active_config === "string" && cfg.active_config ? cfg.active_config : "default";
  const entry = cfg[profile] ?? {};
  return { profile, loggedIn: Boolean(typeof entry.access_token === "string" && entry.access_token.trim()) };
}
async function storeBlConsoleToken(token2) {
  const cfg = await readBlConfig();
  const profile = typeof cfg.active_config === "string" && cfg.active_config ? cfg.active_config : "default";
  cfg.active_config = profile;
  const value = token2.trim();
  cfg[profile] = { ...cfg[profile] ?? {}, access_token: value };
  cfg.access_token = value;
  await fs.mkdir(path.dirname(BL_CONFIG_FILE), { recursive: true });
  await fs.writeFile(BL_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}
`, { mode: 384 });
  return { profile };
}
function runBl(args) {
  return new Promise((resolve) => {
    void (async () => {
      const binary = await resolveBl();
      execFile(binary, args, { timeout: 45e3, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), error: error ?? void 0 });
      });
    })();
  });
}
var blPath = null;
async function resolveBl() {
  if (blPath) return blPath;
  const home = os.homedir();
  const candidates = ["bl", "/usr/local/bin/bl", "/usr/bin/bl", path.join(home, ".local/bin/bl")];
  try {
    for (const entry of await fs.readdir(path.join(home, ".nvm/versions/node"))) {
      candidates.push(path.join(home, ".nvm/versions/node", entry, "bin/bl"));
    }
  } catch {
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bl");
    try {
      await fs.access(candidate, fs.constants.X_OK);
      blPath = candidate;
      return candidate;
    } catch {
    }
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      await fs.access(candidate, fs.constants.X_OK);
      blPath = candidate;
      return candidate;
    } catch {
    }
  }
  blPath = "bl";
  return "bl";
}
async function fetchAlibaba(cfg) {
  const flags = [];
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
      ...flags
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
      ...flags
    ])
  ]);
  const { stdout, stderr, error } = usageCall;
  const text = `${stdout}
${stderr}`;
  const needsLogin = /no console access token|auth login --console/i.test(text);
  const loginHint = "The console login callback lands on this machine's 127.0.0.1 only. Either forward the login port over SSH (see README), or run `bl auth login --console` on your own computer and paste the console token into Settings below.";
  if (error && /ENOENT|not found/i.test(String(error))) {
    return {
      ok: false,
      error: "The Bailian CLI (bl) is not on PATH.",
      hint: "Install it with `npm install -g bailian-cli`, then retry."
    };
  }
  let payload;
  for (const candidate of [stdout, stderr]) {
    try {
      payload = JSON.parse(candidate);
      break;
    } catch {
    }
  }
  if (payload === void 0) {
    return {
      ok: false,
      error: text.trim() || String(error ?? "bl exited with an error"),
      needsConsoleLogin: needsLogin,
      hint: needsLogin ? loginHint : void 0
    };
  }
  const record = payload ?? {};
  if (record.error) {
    const err = record.error;
    return {
      ok: false,
      error: err.message ?? "bl reported an error",
      hint: err.hint ?? (needsLogin ? loginHint : void 0),
      needsConsoleLogin: needsLogin,
      raw: record
    };
  }
  const data = normalizeAlibaba(record);
  const addons = readConsoleData(addonListCall);
  const addonSummary = readConsoleData(addonSummaryCall);
  const addonWindows = [];
  const addonItems = Array.isArray(addons?.items) ? addons.items : [];
  for (const [index, item] of addonItems.entries()) {
    const total = number(item.totalCredits) ?? 0;
    const remaining = number(item.remainingCredits) ?? 0;
    const used = Math.max(0, total - remaining);
    const endMs = number(item.endTime);
    addonWindows.push({
      label: `Quota add-on (${item.addonTier ?? `pack ${index + 1}`})`,
      used,
      limit: total,
      percent: total > 0 ? used / total * 100 : 0,
      resetsAt: endMs !== null ? new Date(endMs).toISOString() : null
    });
  }
  const windows = [...data.windows ?? [], ...addonWindows];
  return {
    ok: true,
    data: {
      ...data,
      windows,
      addonSummary: addonSummary ?? null,
      addonCount: addonSummary ? number(addonSummary.activeCount) ?? addonItems.length : addonItems.length
    }
  };
}
function readConsoleData(call) {
  let payload;
  for (const candidate of [call.stdout, call.stderr]) {
    try {
      payload = JSON.parse(candidate);
      break;
    } catch {
    }
  }
  const inner = payload?.data?.DataV2?.data;
  if (!inner || inner.code !== "SUCCESS" || !inner.data || typeof inner.data !== "object") return null;
  return inner.data;
}
function normalizeAlibaba(raw) {
  const windows = [];
  const labels = {
    per1Month: "Monthly quota",
    per1Week: "Weekly quota",
    per1Day: "Daily quota"
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
      resetsAt: resetMs !== null ? new Date(resetMs).toISOString() : null
    });
  }
  if (windows.length === 0) {
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (!value || typeof value !== "object") return;
      const entry = value;
      const used = number(entry.used ?? entry.currentValue ?? entry.consumed ?? entry.usage);
      const limit = number(entry.limit ?? entry.total ?? entry.quota ?? entry.max);
      if (used !== null && limit !== null && limit > 0) {
        windows.push({
          label: entry.name ?? entry.label ?? entry.window ?? entry.type ?? entry.model ?? "usage",
          used,
          limit,
          percent: number(entry.percent ?? entry.percentage ?? entry.usedPercent) ?? Math.round(used / limit * 100),
          resetsAt: entry.resetsAt ?? entry.resetAt ?? entry.reset_time ?? entry.expiresAt ?? null
        });
      }
      for (const child of Object.values(entry)) visit(child);
    };
    visit(raw);
  }
  return { raw, windows: windows.slice(0, 12) };
}
function number(value) {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
var MIMO_DEFAULT_API = "https://platform.xiaomimimo.com/api/v1";
var MIMO_ITEM_LABELS = {
  month_total_token: "Monthly credits",
  plan_total_token: "Plan credits",
  compensation_total_token: "Compensation credits"
};
async function mimoFetch(url, cookie) {
  const response = await fetch(url, {
    redirect: "manual",
    // never forward the session cookie across a redirect
    headers: {
      Accept: "application/json, text/plain, */*",
      Cookie: cookie,
      "Accept-Language": "en-US,en;q=0.9",
      "x-timeZone": "UTC+01:00",
      Origin: "https://platform.xiaomimimo.com",
      Referer: "https://platform.xiaomimimo.com/#/console/balance",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
    }
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}
async function fetchXiaomi(cfg) {
  const cookie = (cfg.mimoCookie ?? "").trim();
  if (!cookie) {
    return {
      ok: false,
      error: "No Xiaomi MiMo session configured.",
      hint: "Paste the Cookie header from platform.xiaomimimo.com below.",
      needsCookie: true
    };
  }
  const base = (cfg.mimoApiUrl ?? MIMO_DEFAULT_API).replace(/\/+$/, "");
  const loginStates = (status, code) => status === 401 || status === 403 || status >= 300 && status < 400 || code === 401 || code === 403;
  const [detail, usage, balance, subscription] = await Promise.all([
    mimoFetch(`${base}/tokenPlan/detail`, cookie),
    mimoFetch(`${base}/tokenPlan/usage`, cookie),
    mimoFetch(`${base}/balance`, cookie),
    mimoFetch(`${base}/tokenPlan/subscription/status`, cookie)
  ]);
  const detailBody = detail.body;
  const usageBody = usage.body;
  if (loginStates(detail.status, detailBody?.code) && loginStates(usage.status, usageBody?.code)) {
    return {
      ok: false,
      error: "Xiaomi MiMo rejected the stored session.",
      hint: "The cookie is expired or the account logged out. Copy a fresh Cookie header from platform.xiaomimimo.com/#/console/plan-manage and save it below.",
      needsCookie: true
    };
  }
  if (detail.status !== 200 && usage.status !== 200) {
    return {
      ok: false,
      error: `Xiaomi MiMo requests failed (HTTP ${detail.status} / ${usage.status}).`
    };
  }
  const detailData = detailBody?.data ?? {};
  const usageData = usageBody?.data ?? {};
  const monthUsage = usageData.monthUsage ?? usageData;
  const items = Array.isArray(monthUsage.items) ? monthUsage.items : Array.isArray(usageData.items) ? usageData.items : [];
  const first = items[0] ?? monthUsage;
  const lifetime = (usageData.usage ?? {}).items ?? [];
  const toItem = (item) => {
    const used2 = number(item.used) ?? 0;
    const limit2 = number(item.limit) ?? 0;
    const fraction2 = number(item.percent);
    return {
      name: MIMO_ITEM_LABELS[String(item.name ?? "")] ?? (item.name ?? null),
      used: used2,
      limit: limit2,
      percent: limit2 > 0 ? used2 / limit2 * 100 : fraction2 !== null ? fraction2 <= 1 ? fraction2 * 100 : fraction2 : 0
    };
  };
  const used = number(first.used ?? monthUsage.used) ?? 0;
  const limit = number(first.limit ?? monthUsage.limit ?? monthUsage.monthlyQuota) ?? 0;
  const fraction = number(first.percent ?? monthUsage.percent);
  const percent = limit > 0 ? used / limit * 100 : fraction !== null ? fraction <= 1 ? fraction * 100 : fraction : 0;
  const extraItems = lifetime.filter((item) => (number(item.limit) ?? 0) > 0).filter((item) => !(number(item.used) === used && number(item.limit) === limit)).map(toItem);
  const balanceData = balance.status === 200 ? balance.body?.data ?? {} : {};
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
      apiOrigin: base
    }
  };
}
var server = http.createServer((req, res) => {
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
      json(res, 200, { fetchedAt: (/* @__PURE__ */ new Date()).toISOString(), alibaba, xiaomi });
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
        blProfile: blState.profile
      });
    })();
    return;
  }
  if (url.pathname === "/config" && req.method === "PUT") {
    void (async () => {
      try {
        const body = JSON.parse(await readBody(req) || "{}");
        const current = await readConfig();
        const next = { ...current };
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
          blProfile: blState.profile
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
