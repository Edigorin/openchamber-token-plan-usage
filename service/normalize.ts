// Pure quota-window normalization for the Xiaomi MiMo Token Plan. Extracted
// from the service so it can be tested directly; the service fetches, these
// functions shape.

export type UsageWindow = {
  label: string;
  used: number;
  limit: number;
  percent: number;
  resetsAt: string | null;
};

export type CreditsItem = {
  name: string | null;
  used: number;
  limit: number;
  percent: number;
};

export const MIMO_ITEM_LABELS: Record<string, string> = {
  month_total_token: "Monthly credits",
  plan_total_token: "Plan credits",
  compensation_total_token: "Compensation credits",
};

export const number = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

export const creditsLabel = (used: number, limit: number): string => {
  const fmt = (value: number) =>
    value >= 1_000_000_000
      ? `${(value / 1_000_000_000).toFixed(1)}B`
      : value >= 1_000_000
        ? `${(value / 1_000_000).toFixed(1)}M`
        : value >= 1_000
          ? `${(value / 1_000).toFixed(1)}k`
          : String(Math.round(value));
  return `${fmt(used)} / ${fmt(limit)} credits`;
};

// The API reports `percent` as a used fraction (0..1). Derive the percentage
// from used/limit when possible and normalize to 0..100 either way.
export const toCreditsItem = (item: Record<string, unknown>): CreditsItem => {
  const used = number(item?.used) ?? 0;
  const limit = number(item?.limit) ?? 0;
  const fraction = number(item?.percent);
  return {
    name: MIMO_ITEM_LABELS[String(item?.name ?? "")] ?? ((item?.name as string | undefined) ?? null),
    used,
    limit,
    percent: limit > 0 ? (used / limit) * 100 : fraction !== null ? (fraction <= 1 ? fraction * 100 : fraction) : 0,
  };
};

/**
 * The API reports the same quota twice: `monthUsage` (the monthly window) and
 * `usage.usage` ("plan total"). Keep only the extras that are actually a
 * distinct bucket (e.g. compensation credits).
 */
export const pickExtraItems = (lifetime: Array<Record<string, unknown>>, used: number, limit: number): CreditsItem[] =>
  lifetime
    .filter((item) => (number(item?.limit) ?? 0) > 0)
    .filter((item) => !(number(item?.used) === used && number(item?.limit) === limit))
    .map(toCreditsItem);

// `currentPeriodEnd` is UTC without a zone marker ("yyyy-MM-dd HH:mm:ss").
export const parseUtcReset = (value: unknown): string | null => {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(`${value.trim().replace(" ", "T")}Z`);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
};

/**
 * One window per real quota: the monthly window (which carries the period
 * reset), remaining month items, and distinct extras. When the monthly limit
 * is missing or zero there is no synthetic window — the items stand alone,
 * exactly as the panel rendered them before this moved server-side.
 */
export const buildXiaomiWindows = (input: {
  used: number;
  limit: number;
  percent: number;
  items: CreditsItem[];
  extras: CreditsItem[];
  periodEnd: unknown;
}): UsageWindow[] => {
  const resetAt = parseUtcReset(input.periodEnd);
  const toWindow = (item: CreditsItem, resetsAt: string | null): UsageWindow => ({
    label: item.name ?? "Credits",
    used: item.used,
    limit: item.limit,
    percent: item.percent,
    resetsAt,
  });
  const extras = input.extras.map((item) => toWindow(item, null));
  if (input.limit > 0) {
    return [
      { label: "Monthly credits", used: input.used, limit: input.limit, percent: input.percent, resetsAt: resetAt },
      ...input.items.slice(1).map((item) => toWindow(item, null)),
      ...extras,
    ];
  }
  return [...input.items.map((item) => toWindow(item, null)), ...extras];
};
