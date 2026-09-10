import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { state } from "./dashboardState.js";
import { getLivePrice } from "./liveprice.js";

/**
 * MANUAL TRADE LOG — the user's OWN real trades, recorded by hand (the bot does NOT place these).
 * Kept entirely separate from the paper accounts. Open trades are marked to the live price; closing one
 * books its realized P&L. Persisted to data/manual-trades.json (atomic write + .bak, like the paper engine).
 */
export interface ManualTrade {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  size: number; // position size in units of the base asset
  stop?: number;
  target?: number;
  note?: string;
  status: "open" | "closed";
  openedAt: string;
  closedAt?: string;
  exit?: number;
  pnlUsd?: number;
}

const FILE = "data/manual-trades.json";
let trades: ManualTrade[] = [];
let loaded = false;
let seq = 0;

async function load(): Promise<void> {
  if (loaded) return;
  for (const f of [FILE, `${FILE}.bak`]) {
    try {
      const parsed = JSON.parse(await readFile(f, "utf8"));
      if (Array.isArray(parsed)) {
        trades = parsed;
        loaded = true;
        return;
      }
    } catch {
      /* try next / fresh */
    }
  }
  loaded = true;
}

async function save(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(trades, null, 2), "utf8");
  await rename(tmp, FILE);
  await copyFile(FILE, `${FILE}.bak`).catch(() => {});
}

function priceOf(sym: string): number {
  const lp = getLivePrice(sym);
  if (lp && lp > 0) return lp;
  return state.symbols.find((s) => s.symbol === sym)?.price ?? 0;
}

function genId(): string {
  seq += 1;
  return `m-${Date.now()}-${seq}`;
}

export async function addManualTrade(t: Omit<ManualTrade, "id" | "status" | "openedAt">): Promise<ManualTrade | { ok: false; error: string }> {
  if (!t.symbol || !Number.isFinite(t.entry) || t.entry <= 0 || !Number.isFinite(t.size) || t.size <= 0) {
    return { ok: false, error: "need a symbol, a positive entry, and a positive size" };
  }
  await load();
  const trade: ManualTrade = {
    id: genId(),
    symbol: t.symbol,
    direction: t.direction === "SHORT" ? "SHORT" : "LONG",
    entry: t.entry,
    size: t.size,
    stop: t.stop,
    target: t.target,
    note: t.note,
    status: "open",
    openedAt: new Date().toISOString(),
  };
  trades.unshift(trade);
  await save();
  return trade;
}

export async function closeManualTrade(id: string, exit?: number): Promise<ManualTrade | null> {
  await load();
  const t = trades.find((x) => x.id === id);
  if (!t || t.status === "closed") return null;
  const px = exit && exit > 0 ? exit : priceOf(t.symbol) || t.entry;
  const sign = t.direction === "LONG" ? 1 : -1;
  t.exit = px;
  t.pnlUsd = sign * (px - t.entry) * t.size;
  t.status = "closed";
  t.closedAt = new Date().toISOString();
  await save();
  return t;
}

export async function deleteManualTrade(id: string): Promise<boolean> {
  await load();
  const before = trades.length;
  trades = trades.filter((x) => x.id !== id);
  if (trades.length !== before) {
    await save();
    return true;
  }
  return false;
}

/** Snapshot for the dashboard: each trade marked to live price (open) or its exit (closed), plus totals. */
export async function manualApi() {
  await load();
  const list = trades.map((t) => {
    if (t.status === "open") {
      const px = priceOf(t.symbol) || t.entry;
      const sign = t.direction === "LONG" ? 1 : -1;
      return { ...t, price: px, uPnlUsd: sign * (px - t.entry) * t.size };
    }
    return { ...t, price: t.exit ?? t.entry, uPnlUsd: 0 };
  });
  const closed = trades.filter((t) => t.status === "closed");
  const realizedUsd = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const open = list.filter((t) => t.status === "open");
  const unrealizedUsd = open.reduce((s, t) => s + t.uPnlUsd, 0);
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  return {
    trades: list,
    count: trades.length,
    openCount: open.length,
    closedCount: closed.length,
    wins,
    winRate: closed.length ? (wins / closed.length) * 100 : 0,
    realizedUsd,
    unrealizedUsd,
  };
}
