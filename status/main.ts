// Compact usage summary for the Work Status panel.
// Renders one thin bar per real quota window, straight from the same local
// service the rail panel uses.
import { connectHost, HostRequestError } from "@openchamber/sdk";
import { applyHostReady } from "@openchamber/sdk/ui";

const host = connectHost();
const root = document.querySelector("#root") as HTMLElement;

type Window = { label: string; used: number; limit: number; percent: number };
type ProviderResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string; hint?: string };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function renderGroup(title: string, windows: Window[], note?: string): HTMLElement {
  const group = el("div", "group");
  group.append(el("div", "group-title", title));
  for (const win of windows.slice(0, 3)) {
    const row = el("div", "row");
    const head = el("div", "row-head");
    head.append(el("div", "row-label", win.label));
    head.append(el("div", "row-value", `${Math.round(win.percent)}%`));
    const bar = el("div", "bar");
    const fill = el("div", "bar-fill");
    fill.style.width = `${Math.max(0, Math.min(100, win.percent))}%`;
    if (win.percent >= 90) fill.classList.add("critical");
    else if (win.percent >= 70) fill.classList.add("warn");
    bar.append(fill);
    row.append(head, bar);
    group.append(row);
  }
  if (note) group.append(el("div", "note", note));
  return group;
}

async function load(): Promise<void> {
  root.replaceChildren();
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/usage" });
    if (result.status !== 200) throw new Error(`service answered ${result.status}`);
    const payload = JSON.parse(result.body) as {
      alibaba: ProviderResult;
      xiaomi: ProviderResult;
    };
    const parts: Array<["Alibaba" | "Xiaomi", ProviderResult]> = [
      ["Alibaba", payload.alibaba],
      ["Xiaomi", payload.xiaomi],
    ];
    let height = 16;
    for (const [title, provider] of parts) {
      if (!provider.ok) {
        root.append(renderGroup(title, [], provider.error));
        height += 36;
        continue;
      }
      const windows = (provider.data.windows ?? []) as Window[];
      root.append(renderGroup(title, windows));
      height += 22 + 26 * Math.min(3, windows.length);
    }
    await host.setHeight(Math.min(320, Math.max(24, height)));
  } catch (error) {
    const text = error instanceof HostRequestError ? error.code : String(error);
    root.append(el("div", "note", `Token plan usage unavailable (${text}).`));
    await host.setHeight(40);
  }
}

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  void load();
  setInterval(() => void load(), 5 * 60 * 1000);
});
