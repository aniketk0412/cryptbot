import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { fetchDeepHistory } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run oiedge` — Open Interest + Long/Short positioning, the user's "best futures context signal."
 * OI/price interaction: ↑price+↑OI = new money (trust) vs ↑price+↓OI = short-covering (fade); ↓price+↑OI = new shorts.
 *
 * ⚠️ HARD LIMIT — READ THIS: Binance's public `openInterestHist` / `globalLongShortAccountRatio` endpoints only serve
 * the LAST ~30 DAYS. `fundingsent` just proved a short window LIES — a spectacular +0.43R over 166 days dissolved to
 * noise over 3.4yr. So THIS TEST CANNOT VALIDATE ANYTHING: 30 days is one regime, tiny sample. It exists to (a) size
 * the data honestly and (b) justify measuring OI/LS FORWARD via the context HUD's log, not to claim an edge. Any
 * number here is a curiosity, not evidence. Forward-return by OI/price class over the only window Binance gives us.
 */

const SYMBOLS = config.watchlist;
const PERIOD = "4h";
const FWD = Number(process.env.FWD ?? 6); // forward bars to measure (6×4h = 1 day)
const BASE = config.binanceBaseUrl ?? "https://fapi.binance.com";

interface OiRow { sumOpenInterest: string; timestamp: number }
interface LsRow { longShortRatio: string; timestamp: number }

async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(15000) }); if (!r.ok) { console.error(`  HTTP ${r.status} ${path}`); return null; } return (await r.json()) as T; }
  catch (e) { console.error(`  ${(e as Error).name} ${path}`); return null; }
}

/** nearest-value align: for each candle closeTime, the last series point with time ≤ closeTime. */
function alignBy<T extends { timestamp: number }>(candles: Candle[], rows: T[], pick: (r: T) => number): (number | null)[] {
  const out = new Array<number | null>(candles.length).fill(null);
  const sorted = [...rows].sort((a, b) => a.timestamp - b.timestamp);
  let j = 0, cur: number | null = null;
  for (let i = 0; i < candles.length; i++) { const ct = candles[i]!.closeTime; while (j < sorted.length && sorted[j]!.timestamp <= ct) { cur = pick(sorted[j]!); j++; } out[i] = cur; }
  return out;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${(e * 100).toFixed(2)}%` : "  —  ");

async function main() {
  console.log(`OI + LONG/SHORT CONTEXT — ⚠️ Binance serves only ~30 DAYS, so this CANNOT validate an edge (see the funding-window lesson).`);
  console.log(`OI/price interaction + extreme positioning → forward ${FWD}-bar (${FWD * 4}h) return. Curiosity only; forward-test via the HUD.\n`);

  const rows: Record<string, unknown> = {};
  for (const sym of SYMBOLS) {
    const candles = await fetchDeepHistory(sym, PERIOD, 400);
    const oi = await getJson<OiRow[]>(`/futures/data/openInterestHist?symbol=${sym}&period=${PERIOD}&limit=500`);
    const ls = await getJson<LsRow[]>(`/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=${PERIOD}&limit=500`);
    if (!candles || !oi || !oi.length) { console.error(`  ${sym}: missing data (candles ${candles?.length ?? 0}, oi ${oi?.length ?? 0})`); continue; }
    const oiAt = alignBy(candles, oi, (r) => Number(r.sumOpenInterest));
    const lsAt = ls ? alignBy(candles, ls, (r) => Number(r.longShortRatio)) : candles.map(() => null);
    const covDays = Math.round((oi[oi.length - 1]!.timestamp - oi[0]!.timestamp) / 86_400_000);

    // OI/price interaction buckets over the covered window.
    const cls: Record<string, number[]> = { "↑price ↑OI (new longs)": [], "↑price ↓OI (short-cover)": [], "↓price ↑OI (new shorts)": [], "↓price ↓OI (long-liq)": [] };
    let n = 0;
    for (let i = 1; i < candles.length - FWD; i++) {
      const o = oiAt[i], op = oiAt[i - 1]; if (o == null || op == null) continue;
      const dP = candles[i]!.close - candles[i - 1]!.close;
      const dOI = o - op;
      if (dP === 0 || dOI === 0) continue;
      const fwd = candles[i + FWD]!.close / candles[i]!.close - 1; // forward return
      const key = dP > 0 ? (dOI > 0 ? "↑price ↑OI (new longs)" : "↑price ↓OI (short-cover)") : (dOI > 0 ? "↓price ↑OI (new shorts)" : "↓price ↓OI (long-liq)");
      cls[key]!.push(fwd); n++;
    }
    console.log(`  ── ${sym} (~${covDays}d, ${n} bars) — forward ${FWD}-bar return by OI/price class ──`);
    for (const k of Object.keys(cls)) console.log(`     ${k.padEnd(26)} ${pct(mean(cls[k]!)).padStart(9)}  n=${cls[k]!.length}`);

    // Extreme long/short positioning → forward return (contrarian?).
    if (ls && ls.length) {
      const vals = lsAt.filter((x): x is number => x != null).sort((a, b) => a - b);
      const hi = vals[Math.floor(vals.length * 0.8)] ?? Infinity, lo = vals[Math.floor(vals.length * 0.2)] ?? -Infinity;
      const crowdLong: number[] = [], crowdShort: number[] = [];
      for (let i = 1; i < candles.length - FWD; i++) { const l = lsAt[i]; if (l == null) continue; const fwd = candles[i + FWD]!.close / candles[i]!.close - 1; if (l >= hi) crowdLong.push(fwd); else if (l <= lo) crowdShort.push(fwd); }
      console.log(`     L/S extreme-LONG(crowded) fwd ${pct(mean(crowdLong)).padStart(9)} n=${crowdLong.length}   extreme-SHORT fwd ${pct(mean(crowdShort)).padStart(9)} n=${crowdShort.length}`);
    }
    rows[sym] = { covDays, bars: n, classes: Object.fromEntries(Object.entries(cls).map(([k, v]) => [k, { mean: mean(v), n: v.length }])) };
    console.log("");
  }

  console.log(`=== VERDICT ===`);
  console.log(`   ⚠️ 30-day / one-regime sample — NOT evidence. Read as "here's the current OI/positioning texture," not "this predicts."`);
  console.log(`   The honest way to test OI/LS is FORWARD: log them at each entry via the context HUD and measure over months.\n`);
  await mkdir(dirname("data/oiedge.json"), { recursive: true });
  await writeFile("data/oiedge.json", JSON.stringify({ generatedAt: new Date().toISOString(), symbols: SYMBOLS, period: PERIOD, fwdBars: FWD, note: "30-day Binance limit — curiosity only, forward-test via HUD", rows }, null, 2), "utf8");
  console.log("Saved → data/oiedge.json");
}

main().catch((e) => { console.error(`oiedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
