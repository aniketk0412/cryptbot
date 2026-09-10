/**
 * LIVE TRADING — STAGE 1: DRY-RUN SHADOW ONLY.  (see LIVE-TRADING-SPEC.md)
 *
 * This module mirrors the `filtered` paper account's decisions and LOGS the exact order it
 * WOULD place on Binance USDⓈ-M — and PLACES NOTHING. There is deliberately no import of any
 * private/authenticated Binance endpoint and no order-submission code in this file. The only
 * network call is the PUBLIC, read-only exchangeInfo (for faithful tick/step rounding).
 *
 * It also runs the safety RAILS in shadow (max concurrent, position-notional cap, daily-loss /
 * drawdown / consecutive-loss halts) and logs when a rail WOULD have blocked an entry — so the
 * rails can be proven correct before a single real order is ever contemplated (Stage 2+).
 */
import { readFile, writeFile } from "node:fs/promises";
import { fapiJson } from "./binance.js";
import { config } from "./config.js";
import { fmtPrice, nowStr } from "./format.js";
import { paperApi } from "./paper.js";

// ── Types ────────────────────────────────────────────────────────────────────
export interface IntendedOrder {
  id: string; // the mirrored paper position id
  symbol: string;
  side: "BUY" | "SELL";
  type: "LIMIT" | "MARKET";
  qty: number;
  entry: number;
  notionalUsd: number;
  exposureX: number; // notional as a multiple of shadow equity
  stop: number;
  target: number;
  source: string;
  openedAt: string;
  blocked: string | null; // a rail reason if this entry would NOT have been placed
}
export interface ShadowState {
  seeded: boolean; // adopted the positions that were already open when the shadow started
  dayKey: string;
  dayPnlUsd: number;
  equityUsd: number;
  peakEquityUsd: number;
  realizedUsd: number;
  closedCount: number;
  wins: number;
  consecutiveLosses: number;
  halted: { daily: boolean; drawdown: boolean; streak: boolean };
  intended: IntendedOrder[];
  updatedAt: string;
}
type Caps = typeof config.live;

const FILE = "data/live-shadow.json";

// ── Gating: live runs ONLY if BOTH switches are on. Stage 1 is always dry-run. ─
export function liveEnabled(): boolean {
  return !!config.live.enabled && process.env.LIVE_TRADING === "on";
}
export const liveDryRun = (): true => true; // Stage 1: no real-order branch exists.

// ── Pure helpers (unit-tested in selftest) ───────────────────────────────────
/** Round DOWN to the exchange step/tick (never over-order). step<=0 → unchanged. */
export function roundToStep(v: number, step: number): number {
  if (!(step > 0)) return v;
  const n = Math.round(v / step); // guard fp; then floor toward the step grid
  const floored = Math.floor(v / step) * step;
  const dp = (String(step).split(".")[1] || "").length;
  return Number((Math.abs(n * step - v) < 1e-12 ? n * step : floored).toFixed(dp));
}
/** Decide whether a would-be entry passes the rails. Returns a block reason or null. */
export function entryDecision(
  halted: ShadowState["halted"],
  liveOpenCount: number,
  notionalUsd: number,
  caps: Caps,
): string | null {
  if (halted.daily) return `daily-loss halt (-$${caps.maxDailyLossUsd})`;
  if (halted.drawdown) return `drawdown halt (${caps.maxDrawdownPct}%)`;
  if (halted.streak) return `${caps.maxConsecutiveLosses}-loss streak halt`;
  if (liveOpenCount >= caps.maxConcurrent) return `max ${caps.maxConcurrent} concurrent positions`;
  if (notionalUsd > caps.maxPositionUsd) return `notional $${notionalUsd.toFixed(0)} > cap $${caps.maxPositionUsd}`;
  return null;
}

// ── State ────────────────────────────────────────────────────────────────────
let S: ShadowState | null = null;
let loaded = false;
const todayKey = () => new Date().toISOString().slice(0, 10);
function fresh(): ShadowState {
  const eq = config.paper.startBalanceUsd;
  return {
    seeded: false, dayKey: todayKey(), dayPnlUsd: 0, equityUsd: eq, peakEquityUsd: eq,
    realizedUsd: 0, closedCount: 0, wins: 0, consecutiveLosses: 0,
    halted: { daily: false, drawdown: false, streak: false }, intended: [], updatedAt: new Date().toISOString(),
  };
}
async function load(): Promise<void> {
  if (loaded) return;
  loaded = true;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8"));
    if (raw && Array.isArray(raw.intended)) S = raw as ShadowState;
  } catch { /* first run */ }
  if (!S) S = fresh();
}
async function save(): Promise<void> {
  if (!S) return;
  S.updatedAt = new Date().toISOString();
  try { await writeFile(FILE, JSON.stringify(S, null, 2)); } catch { /* non-fatal */ }
}

// ── Exchange precision (public exchangeInfo, read-only) ──────────────────────
let precision: Record<string, { tick: number; step: number }> = {};
let precLoaded = false;
async function loadPrecision(): Promise<void> {
  if (precLoaded) return;
  precLoaded = true;
  try {
    const info = await fapiJson<{ symbols: { symbol: string; filters: { filterType: string; tickSize?: string; stepSize?: string }[] }[] }>("/fapi/v1/exchangeInfo");
    for (const s of info?.symbols ?? []) {
      const pf = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lf = s.filters.find((f) => f.filterType === "LOT_SIZE");
      if (pf?.tickSize && lf?.stepSize) precision[s.symbol] = { tick: Number(pf.tickSize), step: Number(lf.stepSize) };
    }
  } catch { /* rounding falls back to raw paper values */ }
}

// ── The reconcile loop — called once per scan cycle from index.ts ─────────────
export async function reconcileLiveShadow(): Promise<void> {
  if (!liveEnabled()) return;
  await load();
  await loadPrecision();
  if (!S) return;

  // roll the day (resets the daily-loss halt)
  const tk = todayKey();
  if (tk !== S.dayKey) { S.dayKey = tk; S.dayPnlUsd = 0; S.halted.daily = false; }

  const api = paperApi();
  const acc = (api.accounts ?? []).find((a) => (config.live.account === "strategy" ? !a.applyFilter : a.applyFilter));
  if (!acc) { await save(); return; }

  const openIds = new Set(acc.open.map((p) => p.id));
  const intendedIds = new Set(S.intended.map((o) => o.id));
  const caps = config.live;

  const toOrder = (p: (typeof acc.open)[number]): IntendedOrder => {
    const prec = precision[p.symbol];
    const q = p as unknown as { sizeUnits?: number };
    const qty = roundToStep(q.sizeUnits ?? 0, prec?.step ?? 0);
    const entry = prec?.tick ? roundToStep(p.entry, prec.tick) || p.entry : p.entry;
    const notionalUsd = qty * entry;
    return {
      id: p.id, symbol: p.symbol, side: p.direction === "LONG" ? "BUY" : "SELL",
      type: config.plan.confirmEntryAtClose ? "MARKET" : "LIMIT",
      qty, entry, notionalUsd, exposureX: notionalUsd / Math.max(1, S!.equityUsd),
      stop: p.stop, target: p.target, source: p.source, openedAt: new Date().toISOString(), blocked: null,
    };
  };

  // First run: ADOPT whatever was already open (mirror it going forward, don't log a phantom entry).
  if (!S.seeded) {
    S.seeded = true;
    for (const p of acc.open) if (!intendedIds.has(p.id)) { S.intended.push(toOrder(p)); intendedIds.add(p.id); }
    console.log(`${nowStr()}  LIVE-SHADOW [dry-run] started — mirroring '${acc.id}' account, adopted ${acc.open.length} open position(s). Places NOTHING.`);
  }

  // NEW filtered positions → the entry the shadow WOULD place (or the rail that blocks it).
  for (const p of acc.open) {
    if (intendedIds.has(p.id)) continue;
    const order = toOrder(p);
    const liveOpen = S.intended.filter((o) => !o.blocked).length;
    order.blocked = entryDecision(S.halted, liveOpen, order.notionalUsd, caps);
    S.intended.push(order);
    if (order.blocked) {
      console.log(`${nowStr()}  LIVE-SHADOW [dry-run] BLOCKED ${order.side} ${order.qty} ${order.symbol} @ ${fmtPrice(order.entry)} — ${order.blocked}`);
    } else {
      console.log(
        `${nowStr()}  LIVE-SHADOW [dry-run] WOULD ${order.type} ${order.side} ${order.qty} ${order.symbol} @ ${fmtPrice(order.entry)}` +
        `  SL ${fmtPrice(order.stop)}  TP ${fmtPrice(order.target)}  (~$${order.notionalUsd.toFixed(0)}, ${order.exposureX.toFixed(1)}x exposure) — PLACES NOTHING`,
      );
    }
  }

  // CLOSED filtered positions → the exit the shadow WOULD place; mirror realized P&L, update rails.
  for (const o of [...S.intended]) {
    if (openIds.has(o.id)) continue; // still open
    S.intended = S.intended.filter((x) => x.id !== o.id);
    const t = acc.closed.find((c) => c.id === o.id);
    if (!t) continue; // closed & already rotated out of the dashboard window — nothing to book
    if (o.blocked) continue; // was never "live" (blocked at entry) — don't book its P&L

    const pnl = t.pnlUsd;
    S.realizedUsd += pnl; S.equityUsd += pnl; S.dayPnlUsd += pnl; S.closedCount += 1;
    if (pnl > 0) { S.wins += 1; S.consecutiveLosses = 0; } else { S.consecutiveLosses += 1; }
    if (S.equityUsd > S.peakEquityUsd) S.peakEquityUsd = S.equityUsd;
    console.log(
      `${nowStr()}  LIVE-SHADOW [dry-run] WOULD CLOSE ${o.side === "BUY" ? "SELL" : "BUY"} ${o.qty} ${o.symbol} @ ${fmtPrice(t.exit)} (${t.exitReason})` +
      `  — shadow P&L ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)} (mirrors paper)`,
    );
    // Halts (each logs once as it trips)
    if (!S.halted.daily && S.dayPnlUsd <= -caps.maxDailyLossUsd) { S.halted.daily = true; console.log(`${nowStr()}  LIVE-SHADOW ⛔ HALT: daily P&L ≤ -$${caps.maxDailyLossUsd} — new entries paused for the day`); }
    const ddPct = S.peakEquityUsd > 0 ? ((S.peakEquityUsd - S.equityUsd) / S.peakEquityUsd) * 100 : 0;
    if (!S.halted.drawdown && ddPct >= caps.maxDrawdownPct) { S.halted.drawdown = true; console.log(`${nowStr()}  LIVE-SHADOW ⛔ HALT: drawdown ${ddPct.toFixed(1)}% ≥ ${caps.maxDrawdownPct}% — would disarm in live`); }
    if (!S.halted.streak && S.consecutiveLosses >= caps.maxConsecutiveLosses) { S.halted.streak = true; console.log(`${nowStr()}  LIVE-SHADOW ⛔ HALT: ${S.consecutiveLosses} losses in a row — new entries paused`); }
  }

  await save();
}

/** Snapshot for the dashboard (/api/live). Never contains keys or order-placing capability. */
export function liveApi() {
  const eq = S?.equityUsd ?? config.paper.startBalanceUsd;
  const ddPct = S && S.peakEquityUsd > 0 ? ((S.peakEquityUsd - S.equityUsd) / S.peakEquityUsd) * 100 : 0;
  return {
    enabled: liveEnabled(),
    dryRun: true,
    stage: 1,
    account: config.live.account,
    caps: {
      maxConcurrent: config.live.maxConcurrent, maxPositionUsd: config.live.maxPositionUsd,
      maxDailyLossUsd: config.live.maxDailyLossUsd, maxDrawdownPct: config.live.maxDrawdownPct,
      maxConsecutiveLosses: config.live.maxConsecutiveLosses, maxLeverage: config.live.maxLeverage,
    },
    equityUsd: eq,
    dayPnlUsd: S?.dayPnlUsd ?? 0,
    realizedUsd: S?.realizedUsd ?? 0,
    drawdownPct: ddPct,
    closedCount: S?.closedCount ?? 0,
    wins: S?.wins ?? 0,
    consecutiveLosses: S?.consecutiveLosses ?? 0,
    halted: S?.halted ?? { daily: false, drawdown: false, streak: false },
    intended: (S?.intended ?? []).map((o) => ({ ...o })),
    updatedAt: S?.updatedAt ?? null,
  };
}
