import { fapiJson } from "./binance.js";

/**
 * ORDERFLOW X-RAY — footprint / delta / CVD / DOM / absorption, as a live CONTEXT panel.
 *
 * HONEST FRAME (keep it): every signal in this family was MEASURED on this book and came back NOISE net of fees —
 * CVD/aggressive-flow (`cvdedge`), funding-as-sentiment (`fundingsent`, a 166-day "+0.43R" that was a regime
 * artifact), and OI/long-short can't even be validated (30-day API cap, `oiedge`). A prettier, tick-level view of
 * those same inputs is an AWARENESS upgrade, not an edge upgrade. So: nothing here gates, sizes, or triggers a
 * trade. `pressureScore`/`trend` are DESCRIPTIVE composites of what just happened — they are explicitly NOT
 * predictions, and must never be rendered as a buy/sell call. See EDGE-REPORT.md 2026-07-18.
 *
 * Data: all free Binance futures REST (the futures WebSocket delivers zero frames on this network — known):
 *   /fapi/v1/aggTrades  → per-trade price/qty/side  → footprint, delta, CVD, absorption
 *   /fapi/v1/depth      → resting book              → imbalance, liquidity walls
 *   /fapi/v1/openInterest + /fapi/v1/premiumIndex   → OI, funding
 */

export interface AggTrade { p: string; q: string; T: number; m: boolean } // m = buyer is maker ⇒ aggressor was the SELLER
export interface FootprintLevel { price: number; buyUsd: number; sellUsd: number; deltaUsd: number }
export interface Wall { side: "BID" | "ASK"; price: number; usd: number }

export interface XraySnapshot {
  asOf: string; symbol: string; price: number;
  buyUsd: number; sellUsd: number; tradeDeltaUsd: number; totalUsd: number;
  footprint: FootprintLevel[];
  cvd: number[]; // running cumulative delta over the window (for the chart)
  bookImbalancePct: number; // + = bids heavier, − = asks heavier
  absorptionPct: number; // share of flow that was two-sided (absorbed) rather than net-directional
  walls: Wall[];
  oiUsd: number | null; funding: number | null;
  pressureScore: number; // −100..+100 composite of delta / book / CVD slope
  trend: "LONG" | "SHORT" | "WAIT";
  reasons: string[]; // plain-language translation of the numbers
}

/** Notional (USD) of one aggTrade. */
const usd = (t: AggTrade) => Number(t.p) * Number(t.q);

/**
 * Bucket trades into `levels` price bands → per-price buy vs sell notional (the footprint ladder).
 * Aggressor: `m === false` means the buyer was the taker ⇒ aggressive BUY; `m === true` ⇒ aggressive SELL. Pure.
 */
export function buildFootprint(trades: AggTrade[], levels = 18): FootprintLevel[] {
  if (!trades.length || levels < 1) return [];
  const prices = trades.map((t) => Number(t.p)).filter(Number.isFinite);
  if (!prices.length) return [];
  const lo = Math.min(...prices), hi = Math.max(...prices);
  const span = hi - lo;
  if (!(span > 0)) { // all trades at one price
    let b = 0, s = 0;
    for (const t of trades) (t.m ? (s += usd(t)) : (b += usd(t)));
    return [{ price: lo, buyUsd: b, sellUsd: s, deltaUsd: b - s }];
  }
  const size = span / levels;
  const map = new Map<number, { b: number; s: number }>();
  for (const t of trades) {
    const p = Number(t.p); if (!Number.isFinite(p)) continue;
    const idx = Math.min(levels - 1, Math.floor((p - lo) / size));
    const key = lo + idx * size;
    const cur = map.get(key) ?? { b: 0, s: 0 };
    if (t.m) cur.s += usd(t); else cur.b += usd(t);
    map.set(key, cur);
  }
  return [...map.entries()]
    .map(([price, v]) => ({ price, buyUsd: v.b, sellUsd: v.s, deltaUsd: v.b - v.s }))
    .sort((a, b) => b.price - a.price); // highest price first, like a DOM ladder
}

/** Running cumulative delta (USD) across the trade window — the CVD line. Pure. */
export function cvdSeriesOf(trades: AggTrade[], points = 60): number[] {
  if (!trades.length) return [];
  const step = Math.max(1, Math.floor(trades.length / points));
  const out: number[] = [];
  let run = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i]!;
    run += t.m ? -usd(t) : usd(t);
    if (i % step === 0) out.push(run);
  }
  if (out[out.length - 1] !== run) out.push(run);
  return out;
}

/** Resting-book imbalance within `bandPct` of price: + = bids heavier, − = asks heavier. Pure. */
export function bookImbalance(bids: [string, string][], asks: [string, string][], price: number, bandPct: number): number {
  if (!(price > 0)) return 0;
  const band = price * (bandPct / 100);
  const sum = (rows: [string, string][], keep: (p: number) => boolean) =>
    rows.reduce((s, r) => { const p = +r[0], q = +r[1]; return keep(p) && Number.isFinite(p) && Number.isFinite(q) ? s + p * q : s; }, 0);
  const bid = sum(bids, (p) => p >= price - band);
  const ask = sum(asks, (p) => p <= price + band);
  const tot = bid + ask;
  return tot > 0 ? ((bid - ask) / tot) * 100 : 0;
}

/** Large resting orders = "liquidity walls": levels ≥ `mult` × the median level notional in the band. Pure. */
export function findWalls(bids: [string, string][], asks: [string, string][], price: number, bandPct: number, mult: number, max = 12): Wall[] {
  const band = price * (bandPct / 100);
  const rows: Wall[] = [];
  for (const [side, arr, keep] of [["BID", bids, (p: number) => p >= price - band], ["ASK", asks, (p: number) => p <= price + band]] as const) {
    for (const r of arr) {
      const p = +r[0], q = +r[1];
      if (Number.isFinite(p) && Number.isFinite(q) && keep(p)) rows.push({ side: side as "BID" | "ASK", price: p, usd: p * q });
    }
  }
  if (!rows.length) return [];
  const sorted = [...rows].map((r) => r.usd).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (!(median > 0)) return [];
  return rows.filter((r) => r.usd >= mult * median).sort((a, b) => b.usd - a.usd).slice(0, max);
}

/**
 * ABSORPTION — the share of aggressive flow that was TWO-SIDED (absorbed by passive orders) rather than
 * net-directional: 100 × (1 − |netDelta| / totalFlow). High = lots of volume trading against itself with little
 * net pressure (buyers and sellers absorbing each other); low = one-sided, directional flow. Pure.
 */
export function absorption(buyUsd: number, sellUsd: number): number {
  const total = buyUsd + sellUsd;
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, (1 - Math.abs(buyUsd - sellUsd) / total) * 100));
}

/**
 * PRESSURE SCORE (−100..+100) — a transparent average of the components we actually have: normalized trade delta,
 * resting-book imbalance, and the CVD slope. DESCRIPTIVE ONLY: it summarises what just happened, it does NOT
 * predict. Every component measured as noise for forecasting on this book. Pure.
 */
export function pressureScore(buyUsd: number, sellUsd: number, bookImbPct: number, cvd: number[]): number {
  const parts: number[] = [];
  const total = buyUsd + sellUsd;
  if (total > 0) parts.push(((buyUsd - sellUsd) / total) * 100);
  if (Number.isFinite(bookImbPct)) parts.push(Math.max(-100, Math.min(100, bookImbPct)));
  if (cvd.length >= 2) {
    const first = cvd[0]!, last = cvd[cvd.length - 1]!;
    const range = Math.max(...cvd.map(Math.abs)) || 1;
    parts.push(Math.max(-100, Math.min(100, ((last - first) / range) * 100)));
  }
  if (!parts.length) return 0;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** Plain-language translation of the numbers (what the panel shows under "why"). Pure. */
export function explain(s: Omit<XraySnapshot, "reasons">): string[] {
  const out: string[] = [];
  const m = (n: number) => `$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  out.push(s.tradeDeltaUsd >= 0
    ? `Trade delta is POSITIVE (+${m(s.tradeDeltaUsd)}): aggressive buyers lifted more than sellers hit.`
    : `Trade delta is NEGATIVE (−${m(s.tradeDeltaUsd)}): aggressive sellers hit bids harder than buyers lifted.`);
  out.push(s.bookImbalancePct >= 0
    ? `Book imbalance +${s.bookImbalancePct.toFixed(1)}%: more resting size on the BID side.`
    : `Book imbalance ${s.bookImbalancePct.toFixed(1)}%: more resting size on the ASK side.`);
  const cvdUp = s.cvd.length >= 2 && s.cvd[s.cvd.length - 1]! >= s.cvd[0]!;
  out.push(`CVD slope is ${cvdUp ? "UP" : "DOWN"} — that is the recent direction of aggressive flow.`);
  out.push(s.absorptionPct >= 60
    ? `Absorption ${s.absorptionPct.toFixed(0)}%: flow is heavily two-sided — orders are being absorbed, not driving price.`
    : `Absorption ${s.absorptionPct.toFixed(0)}%: flow is fairly one-sided/directional.`);
  if (s.oiUsd != null || s.funding != null) {
    out.push(`${s.oiUsd != null ? `Open interest $${(s.oiUsd / 1e6).toFixed(0)}M. ` : ""}${s.funding != null ? `Funding ${(s.funding * 100).toFixed(4)}% (cost of the crowded side).` : ""}`);
  }
  out.push(`NOTE: this is CONTEXT, not a signal — each of these measured as noise for prediction on this book.`);
  return out;
}

// Short cache — aggTrades(1000) + depth(500) are heavy calls and the panel polls; the tape barely changes in a few
// seconds. Keeps us well inside Binance rate limits no matter how many dashboards are open.
const xrayCache = new Map<string, { at: number; snap: XraySnapshot }>();
/** Cached X-ray (default 5s). Falls back to the last good snapshot on a transient failure. Never throws. */
export async function getXray(symbol: string, maxAgeMs = 5000): Promise<XraySnapshot | null> {
  const hit = xrayCache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.snap;
  try {
    const snap = await fetchXray(symbol);
    if (snap) xrayCache.set(symbol, { at: Date.now(), snap });
    return snap ?? hit?.snap ?? null;
  } catch {
    return hit?.snap ?? null;
  }
}

/** Assemble the full X-ray for one symbol from free REST endpoints. Resilient: any failed feed degrades, never throws. */
export async function fetchXray(symbol: string, opts?: { tradeLimit?: number; bandPct?: number; wallMult?: number }): Promise<XraySnapshot | null> {
  const tradeLimit = opts?.tradeLimit ?? 1000;
  const bandPct = opts?.bandPct ?? 0.5;
  const wallMult = opts?.wallMult ?? 5;
  const [trades, depth, oi, prem] = await Promise.all([
    fapiJson<AggTrade[]>(`/fapi/v1/aggTrades?symbol=${symbol}&limit=${tradeLimit}`),
    fapiJson<{ bids: [string, string][]; asks: [string, string][] }>(`/fapi/v1/depth?symbol=${symbol}&limit=500`),
    fapiJson<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${symbol}`),
    fapiJson<{ lastFundingRate: string; markPrice: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`),
  ]);
  if (!Array.isArray(trades) || !trades.length) return null;

  let buyUsd = 0, sellUsd = 0;
  for (const t of trades) { const v = usd(t); if (!Number.isFinite(v)) continue; if (t.m) sellUsd += v; else buyUsd += v; }
  const price = Number(trades[trades.length - 1]!.p) || (prem ? Number(prem.markPrice) : 0);
  const bids = depth?.bids ?? [], asks = depth?.asks ?? [];
  const imb = bookImbalance(bids, asks, price, bandPct);
  const cvd = cvdSeriesOf(trades);
  const mark = prem ? Number(prem.markPrice) : price;
  const oiUsd = oi && Number.isFinite(Number(oi.openInterest)) && Number.isFinite(mark) ? Number(oi.openInterest) * mark : null;

  const base = {
    asOf: new Date().toISOString(), symbol, price,
    buyUsd, sellUsd, tradeDeltaUsd: buyUsd - sellUsd, totalUsd: buyUsd + sellUsd,
    footprint: buildFootprint(trades),
    cvd,
    bookImbalancePct: imb,
    absorptionPct: absorption(buyUsd, sellUsd),
    walls: findWalls(bids, asks, price, bandPct, wallMult),
    oiUsd, funding: prem ? Number(prem.lastFundingRate) : null,
    pressureScore: pressureScore(buyUsd, sellUsd, imb, cvd),
    trend: "WAIT" as "LONG" | "SHORT" | "WAIT",
  };
  base.trend = base.pressureScore > 15 ? "LONG" : base.pressureScore < -15 ? "SHORT" : "WAIT";
  return { ...base, reasons: explain(base) };
}
