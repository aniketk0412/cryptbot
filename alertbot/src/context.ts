import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fapiJson } from "./binance.js";
import type { Candle } from "./types.js";

/**
 * MARKET-CONTEXT HUD — the "constant awareness" panel + forward-measurement log.
 *
 * HONEST FRAME (do not lose this): every one of these Tier-1 signals was MEASURED and came back NOISE net of fees —
 * CVD (`cvdedge`) and funding-as-sentiment (`fundingsent`) are noise over full history; OI / long-short are only
 * ~30-day backtestable (`oiedge`) so they can't be validated at all (see EDGE-REPORT 2026-07-18). So this module is
 * NOT a source of auto-trade signals. It is (a) DISCRETIONARY context for a human's read, and (b) a FORWARD-MEASUREMENT
 * log: `logContextAtSignal` records the context at each entry so we can eventually measure which signals precede good
 * moves over real forward time — the only honest way to test the ones we can't backtest (live OI, liquidations).
 * Nothing here gates or sizes a trade.
 */

export interface SymbolContext {
  asOf: string;
  funding: number | null; // last funding rate (fraction, e.g. 0.0001 = 0.01%)
  fundingPctl: number | null; // percentile of current funding within recent history (0..1); high = crowded longs
  oiUsd: number | null; // current open interest notional (USD), if derivable
  ls: number | null; // global long/short account ratio (>1 = more longs)
  flowLean: number; // net aggressive-taker lean over recent bars, ∈ [-1,1] (+buyers lifting / −sellers hitting)
  reads: string[]; // plain-English, clearly-labeled context lines (NOT signals)
}

/** Net aggressive-taker lean over the last `n` closed bars, normalized to [-1,1]. Pure. */
export function flowLean(candles: Candle[], n = 12): number {
  const closed = candles.filter((c) => c.closed).slice(-n);
  let delta = 0, vol = 0;
  for (const c of closed) { delta += 2 * c.takerBuyVolume - c.volume; vol += c.volume; }
  return vol > 0 ? Math.max(-1, Math.min(1, delta / vol)) : 0;
}

/** Fraction of `hist` values ≤ `x` (causal percentile). Pure. */
export function percentileOf(hist: number[], x: number): number {
  if (!hist.length) return 0.5;
  let le = 0; for (const v of hist) if (v <= x) le++;
  return le / hist.length;
}

interface FundingRow { fundingTime: number; fundingRate: string }

/** Fetch + assemble the context read for one symbol. Resilient: any failed feed → null field, never throws. */
export async function fetchContext(symbol: string, candles: Candle[]): Promise<SymbolContext> {
  const [oi, prem, lsArr, fundHist] = await Promise.all([
    fapiJson<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${symbol}`),
    fapiJson<{ lastFundingRate: string; markPrice: string }>(`/fapi/v1/premiumIndex?symbol=${symbol}`),
    fapiJson<{ longShortRatio: string }[]>(`/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`),
    fapiJson<FundingRow[]>(`/fapi/v1/fundingRate?symbol=${symbol}&limit=90`), // ~30 days of 8h funding, for the percentile
  ]);

  const funding = prem ? Number(prem.lastFundingRate) : null;
  const mark = prem ? Number(prem.markPrice) : null;
  const oiContracts = oi ? Number(oi.openInterest) : null;
  const oiUsd = oiContracts != null && mark != null && Number.isFinite(oiContracts) && Number.isFinite(mark) ? oiContracts * mark : null;
  const ls = Array.isArray(lsArr) && lsArr[0] ? Number(lsArr[0].longShortRatio) : null;
  const hist = Array.isArray(fundHist) ? fundHist.map((r) => Number(r.fundingRate)).filter((x) => Number.isFinite(x)) : [];
  const fundingPctl = funding != null && hist.length ? percentileOf(hist, funding) : null;
  const lean = flowLean(candles);

  const reads: string[] = [];
  if (funding != null) {
    const crowd = fundingPctl == null ? "" : fundingPctl >= 0.8 ? " · crowded LONGS (squeeze-down risk)" : fundingPctl <= 0.2 ? " · crowded SHORTS (squeeze-up risk)" : "";
    reads.push(`funding ${(funding * 100).toFixed(3)}%${crowd}`);
  }
  if (oiUsd != null) reads.push(`OI $${(oiUsd / 1e6).toFixed(1)}M`);
  if (ls != null) reads.push(`L/S ${ls.toFixed(2)} (${ls > 1 ? "long-heavy" : "short-heavy"})`);
  reads.push(`flow ${lean >= 0 ? "net BUY" : "net SELL"} ${(Math.abs(lean) * 100).toFixed(0)}%`);

  return { asOf: new Date().toISOString(), funding, fundingPctl, oiUsd, ls, flowLean: lean, reads };
}

// Per-symbol context cache so the poll loop doesn't hit the API every cycle (context moves slowly).
const cache = new Map<string, { at: number; ctx: SymbolContext }>();
/** Cached context: reuses the last fetch if it's younger than `maxAgeMs`. Never throws (returns last/undefined). */
export async function getContext(symbol: string, candles: Candle[], maxAgeMs = 45_000): Promise<SymbolContext | undefined> {
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.ctx;
  try {
    const ctx = await fetchContext(symbol, candles);
    cache.set(symbol, { at: Date.now(), ctx });
    return ctx;
  } catch {
    return hit?.ctx; // fall back to the last good read on a transient failure
  }
}

const LOG_FILE = "data/context-log.jsonl";
const loggedIds = new Set<string>(); // dedup: one forward-log line per unique signal (symbol-source-signalCloseTime)

/**
 * FORWARD-MEASUREMENT LOG: append the context at the moment a signal fires, so we can later measure which context
 * conditions preceded good moves — the honest test for the signals we can't backtest. Append-only JSONL; best-effort
 * (never throws into the trade path). One line per (symbol, source, signalCloseTime).
 */
export async function logContextAtSignal(entry: { symbol: string; source: string; direction: "LONG" | "SHORT"; entry: number; stop: number; target: number; signalCloseTime: number; timeframe: string; ctx: SymbolContext | null }): Promise<void> {
  const key = `${entry.symbol}-${entry.source}-${entry.signalCloseTime}`;
  if (loggedIds.has(key)) return; // already logged this signal (paperOpen is called every cycle while the candle is latest)
  loggedIds.add(key);
  if (loggedIds.size > 5000) loggedIds.clear(); // bound memory over a long run
  try {
    await mkdir(dirname(LOG_FILE), { recursive: true });
    const line = JSON.stringify({
      t: new Date().toISOString(), symbol: entry.symbol, source: entry.source, direction: entry.direction,
      entry: entry.entry, stop: entry.stop, target: entry.target, signalCloseTime: entry.signalCloseTime, timeframe: entry.timeframe,
      funding: entry.ctx?.funding ?? null, fundingPctl: entry.ctx?.fundingPctl ?? null, oiUsd: entry.ctx?.oiUsd ?? null,
      ls: entry.ctx?.ls ?? null, flowLean: entry.ctx?.flowLean ?? null,
    });
    await appendFile(LOG_FILE, line + "\n", "utf8");
  } catch { /* logging must never break the loop */ }
}
