// Token Plans — Alibaba Cloud Model Studio + Xiaomi MiMo quota panel.
import { connectHost, HostRequestError } from "@openchamber/sdk";
import { applyHostReady, mountBadge, mountBanner, mountButton, mountProgress, mountSelect, mountTextField } from "@openchamber/sdk/ui";

const host = connectHost();
const root = document.querySelector("#root");
if (!root) throw new Error("Missing root");

type Window = { label: string; used: number; limit: number; percent: number; resetsAt: string | null };
type ProviderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; hint?: string; needsConsoleLogin?: boolean; needsCookie?: boolean };

const fmt = (value: number): string =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function renderWindows(container: HTMLElement, windows: Window[]): void {
  for (const win of windows.slice(0, 4)) {
    const row = el("div", "window");
    const label = el("div", "window-label", win.label);
    const value = el(
      "div",
      "window-value",
      win.limit > 1 ? `${fmt(win.used)} / ${fmt(win.limit)} · ${Math.round(win.percent)}%` : `${Math.round(win.percent)}% used`,
    );
    row.append(label, value);
    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.max(0, Math.min(100, win.percent))}%`;
    if (win.percent >= 90) fill.classList.add("critical");
    else if (win.percent >= 70) fill.classList.add("warn");
    bar.append(fill);
    row.append(bar);
    if (win.resetsAt) {
      const when = new Date(win.resetsAt);
      row.append(
        el("div", "window-reset", `resets ${Number.isNaN(when.getTime()) ? win.resetsAt : when.toLocaleString()}`),
      );
    }
    container.append(row);
  }
}

function renderError(container: HTMLElement, result: Extract<ProviderResult, { ok: false }>): void {
  mountBanner(container, {
    tone: result.needsCookie || result.needsConsoleLogin ? "warning" : "error",
    title: result.error,
    body: result.hint,
  });
}

// One-time initialization: onReady repeats on theme/session snapshots, and a
// second mount would orphan the built DOM while timers kept refreshing it.
let mounted = false;

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (mounted) return;
  mounted = true;
  root.replaceChildren();

  const header = el("div", "header");
  const title = el("h1", "title", "Token Plans");
  const badge = mountBadge(header, { label: "idle", tone: "neutral" });
  header.prepend(title);
  const refresh = mountButton(header, { label: "Refresh", variant: "secondary", size: "sm", onClick: () => void load() });
  root.append(header);

  const alibabaCard = el("section", "card");
  alibabaCard.append(el("h2", "card-title", "Alibaba Cloud Model Studio"));
  const alibabaBody = el("div", "card-body");
  alibabaCard.append(alibabaBody);
  root.append(alibabaCard);

  const xiaomiCard = el("section", "card");
  xiaomiCard.append(el("h2", "card-title", "Xiaomi MiMo Token Plan"));
  const xiaomiBody = el("div", "card-body");
  xiaomiCard.append(xiaomiBody);
  root.append(xiaomiCard);

  // ---- settings ------------------------------------------------------------
  const settings = el("details", "settings");
  settings.append(el("summary", "settings-summary", "Settings"));
  const settingsBody = el("div", "settings-body");
  settings.append(settingsBody);
  root.append(settings);

  let mimoCookie = "";
  let mimoApiUrl = "";
  let blConsoleSite = "";
  let blConsoleRegion = "";
  let blConsoleToken = "";

  const blStatus = el("div", "save-status", "");
  settingsBody.append(blStatus);
  const cookieField = mountTextField(settingsBody, {
    label: "Xiaomi MiMo cookie",
    value: "",
    password: true,
    multiline: true,
    rows: 2,
    mono: true,
    helper:
      "From platform.xiaomimimo.com/#/console/plan-manage: DevTools (F12) → Network → click any request → Request Headers → copy the whole cookie value (needs api-platform_serviceToken and userId).",
    onChange: (value: string) => {
      mimoCookie = value;
    },
  });
  const blTokenField = mountTextField(settingsBody, {
    label: "Bailian console token",
    value: "",
    password: true,
    mono: true,
    helper:
      "access_token from ~/.bailian/config.json after running `bl auth login --console` on your own computer (see README for the SSH-tunnel alternative).",
    onChange: (value: string) => {
      blConsoleToken = value;
    },
  });
  const siteField = mountSelect(settingsBody, {
    label: "Bailian console site",
    value: "",
    options: [
      { id: "", label: "Default" },
      { id: "domestic", label: "China (domestic)" },
      { id: "international", label: "International" },
    ],
    onChange: (value: string) => {
      blConsoleSite = value;
    },
  });
  const regionField = mountTextField(settingsBody, {
    label: "Bailian console region",
    value: "",
    placeholder: "e.g. ap-southeast-1",
    onChange: (value: string) => {
      blConsoleRegion = value;
    },
  });
  const saveRow = el("div", "row");
  settingsBody.append(saveRow);
  const saveStatus = el("div", "save-status", "");
  saveRow.append(saveStatus);
  const saveButton = mountButton(saveRow, {
    label: "Save settings",
    variant: "secondary",
    size: "sm",
    onClick: () => {
      saveButton.update({ loading: true });
      void (async () => {
        try {
          const result = await host.serviceRequest({
            method: "PUT",
            path: "/config",
            body: JSON.stringify({ mimoCookie, mimoApiUrl, blConsoleSite, blConsoleRegion, blConsoleToken }),
          });
          if (result.status !== 200) throw new Error(`service answered ${result.status}`);
          saveStatus.textContent = "Saved.";
          blConsoleToken = "";
          blTokenField.update({ value: "" });
          await load();
        } catch (error) {
          saveStatus.textContent = error instanceof Error ? error.message : String(error);
        } finally {
          saveButton.update({ loading: false });
        }
      })();
    },
  });

  async function loadSettings(): Promise<void> {
    try {
      const result = await host.serviceRequest({ method: "GET", path: "/config" });
      if (result.status !== 200) return;
      const cfg = JSON.parse(result.body) as {
        mimoCookieSet: boolean;
        mimoApiUrl: string;
        blConsoleSite: string;
        blConsoleRegion: string;
        blConsoleLogin: boolean;
        blProfile: string;
      };
      mimoApiUrl = cfg.mimoApiUrl;
      blConsoleSite = cfg.blConsoleSite;
      blConsoleRegion = cfg.blConsoleRegion;
      cookieField.update({ value: cfg.mimoCookieSet ? "•••••••• (saved — paste to replace)" : "" });
      siteField.update({ value: cfg.blConsoleSite });
      regionField.update({ value: cfg.blConsoleRegion });
      blStatus.textContent = cfg.blConsoleLogin
        ? `Bailian console login: connected (profile ${cfg.blProfile}).`
        : "Bailian console login: not connected — usage needs it.";
    } catch {
      // settings are optional; load() surfaces service problems
    }
  }

  // ---- data ---------------------------------------------------------------
  async function load(): Promise<void> {
    refresh.update({ loading: true });
    badge.update({ label: "loading", tone: "neutral" });
    try {
      const result = await host.serviceRequest({ method: "GET", path: "/usage" });
      if (result.status !== 200) {
        badge.update({ label: `HTTP ${result.status}`, tone: "error" });
        return;
      }
      const payload = JSON.parse(result.body) as { fetchedAt: string; alibaba: ProviderResult; xiaomi: ProviderResult };
      renderAlibaba(payload.alibaba);
      renderXiaomi(payload.xiaomi);
      const healthy = Number(payload.alibaba.ok) + Number(payload.xiaomi.ok);
      badge.update({
        label: healthy === 2 ? "up to date" : healthy === 1 ? "partial" : "no data",
        tone: healthy === 2 ? "success" : healthy === 1 ? "warning" : "error",
      });
    } catch (error) {
      const text = error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error);
      badge.update({ label: "failed", tone: "error" });
      alibabaBody.replaceChildren();
      xiaomiBody.replaceChildren();
      mountBanner(alibabaBody, { tone: "error", title: "Could not reach the local service", body: text });
    } finally {
      refresh.update({ loading: false });
    }
  }

  function renderAlibaba(result: ProviderResult): void {
    alibabaBody.replaceChildren();
    if (!result.ok) {
      renderError(alibabaBody, result);
      return;
    }
    const windows = (result.data.windows ?? []) as Window[];
    if (windows.length > 0) {
      renderWindows(alibabaBody, windows);
      const summary = result.data.addonSummary as { activeCount?: number; remainingCredits?: number; nearestExpireTime?: number } | null;
      if (summary && (summary.activeCount ?? 0) > 0) {
        const meta = el("div", "meta");
        meta.append(el("span", "chip", `${summary.activeCount} add-on pack${summary.activeCount === 1 ? "" : "s"}`));
        if (typeof summary.remainingCredits === "number") {
          meta.append(el("span", "chip", `${fmt(Math.round(summary.remainingCredits))} add-on credits left`));
        }
        if (typeof summary.nearestExpireTime === "number") {
          const when = new Date(summary.nearestExpireTime);
          meta.append(el("span", "chip", `nearest expires ${when.toLocaleDateString()}`));
        }
        alibabaBody.append(meta);
      }
      return;
    }
    const raw = result.data.raw ?? result.data;
    const pre = el("pre", "raw", JSON.stringify(raw, null, 2));
    alibabaBody.append(pre);
    alibabaBody.append(el("div", "note", "No quota fields recognized yet — raw response shown."));
  }

  function renderXiaomi(result: ProviderResult): void {
    xiaomiBody.replaceChildren();
    if (!result.ok) {
      renderError(xiaomiBody, result);
      return;
    }
    const data = result.data as unknown as {
      planCode: string | null;
      planName: string | null;
      periodEnd: string | null;
      expired: boolean;
      used: number;
      limit: number;
      percent: number;
      items: Window[];
      lifetimeItems: Window[];
      balance: string | null;
      currency: string | null;
      cashBalance: string | null;
      giftBalance: string | null;
    };
    const meta = el("div", "meta");
    const plan = data.planName ?? data.planCode;
    if (plan) meta.append(el("span", "chip", plan));
    if (data.expired) meta.append(el("span", "chip warn", "expired"));
    if (data.periodEnd) meta.append(el("span", "chip", `period ends ${data.periodEnd} UTC`));
    xiaomiBody.append(meta);
    const windows: Window[] =
      data.limit > 0
        ? [
            { label: "Monthly credits", used: data.used, limit: data.limit, percent: data.percent, resetsAt: data.periodEnd },
            ...data.items.slice(1),
            ...data.lifetimeItems,
          ]
        : [...data.items, ...data.lifetimeItems];
    if (windows.length > 0) renderWindows(xiaomiBody, windows);
    const balance = Number(data.balance ?? 0);
    const granted = Number(data.giftBalance ?? 0);
    const paid = Number(data.cashBalance ?? 0);
    if (balance > 0 || granted > 0 || paid > 0) {
      const balanceRow = el("div", "meta");
      const currency = (data.currency ?? "").trim();
      balanceRow.append(el("span", "chip", `balance ${data.balance} ${currency}`.trim()));
      if (data.cashBalance !== null && data.giftBalance !== null) {
        balanceRow.append(el("span", "chip", `paid ${data.cashBalance} / granted ${data.giftBalance}`));
      }
      xiaomiBody.append(balanceRow);
    }
  }

  void (async () => {
    await loadSettings();
    await load();
    setInterval(() => void load(), 5 * 60 * 1000);
  })();
});
