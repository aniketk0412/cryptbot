import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run fundingsent` — funding as a CONTRARIAN SENTIMENT gauge (NOT carry — carry is dead, see `fundingedge`).
 * Thesis: extreme +funding = crowded longs paying to hold = squeeze-DOWN risk (and vice versa). So entering WITH the
 * crowd (long into extreme-high funding) should underperform; fading it (short into extreme-high funding) should do
 * better. This tags our SAME entries with the causal funding percentile at entry and buckets net-of-fee expectancy:
 *
 *   • WITH-CROWD  — long into extreme-HIGH funding, or short into extreme-LOW funding (the squeeze-risk side).
 *   • AGAINST-CROWD — the contrarian side (short into high funding / long into low funding).
 *   • NEUTRAL — funding not extreme.
 *
 * If AGAINST-CROWD clearly beats WITH-CROWD, funding-sentiment earns a place as a risk FILTER (don't pile into the
 * crowded side) — measure BEFORE wiring/displaying it as a signal. Window is funding-limited (~333 days, 8h funding),
 * shorter than the 4h candle history — a decent but single-ish-regime sample; read the gap + folds, not the decimal.
 * No lookahead: funding is forward-filled (last funding whose time ≤ the candle) and percentiles use trailing values.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const FOLDS = 8;
const PCTL_WIN = Number(process.env.PCTL_WIN ?? 90); // trailing funding values for the percentile (90×8h ≈ 30d)
const EXTREME = Number(process.env.EXTREME_PCTL ?? 0.2); // top/bottom 20% = "extreme"
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;
const BASE = config.binanceBaseUrl ?? "https://fapi.binance.com";

interface FundingRow { fundingTime: number; fundingRate: string }
/** Paginate funding history backwards by endTime (Binance returns ~500 rows/page ≈ 166d) to cover MULTIPLE regimes. */
async function fundingHistory(symbol: string): Promise<{ t: number; r: number }[]> {
  const MAX_PAGES = Number(process.env.FUND_PAGES ?? 12); // walk back until candles run out (~1250d ≈ 8 pages)
  const all: { t: number; r: number }[] = [];
  let endTime: number | undefined;
  let prevEarliest = Infinity;
  for (let page = 0; page < MAX_PAGES; page++) {
    let url = `${BASE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1000`;
    if (endTime !== undefined) url += `&endTime=${endTime}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) { console.error(`  ${symbol}: HTTP ${res.status}`); break; }
      const rows = (await res.json()) as FundingRow[];
      if (!Array.isArray(rows) || !rows.length) break;
      const mapped = rows.map((x) => ({ t: x.fundingTime, r: Number(x.fundingRate) })).filter((x) => Number.isFinite(x.r));
      all.push(...mapped);
      const earliest = Math.min(...rows.map((x) => x.fundingTime));
      if (earliest >= prevEarliest) break; // no progress backwards → we've hit the start of history
      prevEarliest = earliest;
      endTime = earliest - 1; // next page ends just before the earliest row we have (regardless of page size)
    } catch (e) { console.error(`  ${symbol}: ${(e as Error).name}`); break; }
  }
  // dedup by time + sort ascending
  const seen = new Set<number>();
  return all.filter((x) => (seen.has(x.t) ? false : (seen.add(x.t), true))).sort((a, b) => a.t - b.t);
}

function exitFixedNet(long: boolean, entry: number, stop: number, target: number, fut: Candle[]): number | null {
  const risk = Math.abs(entry - stop); if (risk <= 0) return null;
  const rt = Math.abs(target - entry) / risk;
  for (const k of fut) {
    if (long ? k.low <= stop : k.high >= stop) return -1 - (FEE * (entry + stop)) / risk;
    if (long ? k.high >= target : k.low <= target) return rt - (FEE * (entry + target)) / risk;
  }
  const last = fut[fut.length - 1]; if (!last) return 0;
  return (long ? last.close - entry : entry - last.close) / risk - (FEE * (entry + last.close)) / risk;
}

/** Forward-fill funding onto candle close times: fundAt[i] = rate of the last funding with time ≤ candle[i].closeTime. */
function alignFunding(candles: Candle[], fund: { t: number; r: number }[]): (number | null)[] {
  const out = new Array<number | null>(candles.length).fill(null);
  if (!fund.length) return out;
  const sorted = [...fund].sort((a, b) => a.t - b.t);
  let j = 0, cur: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const ct = candles[i]!.closeTime;
    while (j < sorted.length && sorted[j]!.t <= ct) { cur = sorted[j]!.r; j++; }
    out[i] = cur;
  }
  return out;
}

/** Causal percentile of x within the trailing window `hist` (fraction of values ≤ x). */
function pctlOf(hist: number[], x: number): number {
  if (!hist.length) return 0.5;
  let le = 0; for (const v of hist) if (v <= x) le++;
  return le / hist.length;
}

interface Rec { openMs: number; symbol: string; src: string; long: boolean; net: number; bucket: "with" | "against" | "neutral"; extreme: boolean }

async function build(): Promise<Rec[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) { const c = await fetchDeepHistory(s, config.interval, TARGET); if (c && c.length >= WARMUP + 400) raw[s] = c; else console.error(`  skip ${s}: ${c?.length ?? 0}`); }
  const syms = Object.keys(raw); const bySym = alignByTime(raw, syms);
  const recs: Rec[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!; const n = c.length;
    const fund = await fundingHistory(sym);
    if (fund.length < 50) { console.error(`  ${sym}: only ${fund.length} funding rows — skip`); continue; }
    const fundAt = alignFunding(c, fund);
    const firstFundMs = Math.min(...fund.map((x) => x.t));
    const fundDays = Math.round((Math.max(...fund.map((x) => x.t)) - firstFundMs) / 86_400_000);
    const candleDays = Math.round((c[c.length - 1]!.closeTime - c[0]!.closeTime) / 86_400_000);
    console.log(`  ${sym}: ${fund.length} funding rows (~${fundDays}d), ${c.length} candles (~${candleDays}d) → entries limited by the shorter`);
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!; if (!sigs.length) continue;
      if (c[i]!.closeTime < firstFundMs) continue; // no funding coverage this early
      const f = fundAt[i]; if (f == null) continue;
      // trailing funding values (causal) for the percentile
      const hist: number[] = [];
      for (let k = i; k >= 0 && hist.length < PCTL_WIN; k--) { const fv = fundAt[k]; if (fv != null) hist.push(fv); }
      const p = pctlOf(hist, f);
      const extremeHigh = p >= 1 - EXTREME, extremeLow = p <= EXTREME;
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const fut = c.slice(i + 1, i + 1 + HORIZON);
        const net = exitFixedNet(sg.long, sg.entry, sg.stop, sg.target, fut);
        if (net === null) continue;
        busy[sg.source] = i + 1;
        const withCrowd = (sg.long && extremeHigh) || (!sg.long && extremeLow);
        const againstCrowd = (sg.long && extremeLow) || (!sg.long && extremeHigh);
        const bucket = withCrowd ? "with" : againstCrowd ? "against" : "neutral";
        recs.push({ openMs: c[i]!.closeTime, symbol: sym, src: sg.source, long: sg.long, net, bucket, extreme: extremeHigh || extremeLow });
      }
    }
  }
  recs.sort((a, b) => a.openMs - b.openMs);
  return recs;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const win = (a: number[]) => (a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

async function main() {
  console.log(`FUNDING-SENTIMENT — is extreme funding a contrarian gauge on our entries? ${SYMBOLS.join("/")} @ ${config.interval}`);
  console.log(`percentile window ${PCTL_WIN}×8h (~${Math.round(PCTL_WIN / 3)}d) · extreme = top/bottom ${(EXTREME * 100).toFixed(0)}% · net ${(FEE * 1e4).toFixed(1)}bps · fixed exit\n`);
  const recs = await build();
  if (recs.length < 80) { console.error(`only ${recs.length} entries in the funding window. Aborting.`); process.exit(1); }
  const t0 = recs[0]!.openMs, span = (recs[recs.length - 1]!.openMs - t0) || 1;
  const folds = (subset: Rec[]) => {
    const fold: number[][] = Array.from({ length: FOLDS }, () => []);
    for (const r of subset) fold[Math.min(FOLDS - 1, Math.floor(((r.openMs - t0) / span) * FOLDS))]!.push(r.net);
    const fin = fold.filter((f) => f.length).length, pos = fold.filter((f) => f.length && mean(f) > 0).length;
    return `${pos}/${fin}`;
  };
  const bucket = (label: string, sub: Rec[]) => {
    const v = sub.map((r) => r.net);
    console.log(`   ${label.padEnd(24)} ${f3(mean(v)).padStart(9)}   win ${win(v).toFixed(0).padStart(3)}%   folds+ ${folds(sub).padStart(4)}   n=${sub.length}`);
    return { net: mean(v), win: win(v), n: sub.length };
  };
  console.log(`${recs.length} entries within the funding window (~${Math.round(span / 86_400_000)} days).\n`);
  console.log(`── FUNDING-SENTIMENT BUCKETS (net R/trade) ──`);
  const all = bucket("ALL (baseline)", recs);
  const wc = bucket("WITH the crowd", recs.filter((r) => r.bucket === "with"));
  const ac = bucket("AGAINST the crowd", recs.filter((r) => r.bucket === "against"));
  const nu = bucket("neutral (not extreme)", recs.filter((r) => r.bucket === "neutral"));

  // ROBUSTNESS of the AGAINST-crowd bucket (the promising one) — is it real, or one coin / a few outliers / one regime?
  const against = recs.filter((r) => r.bucket === "against");
  console.log(`\n── AGAINST-CROWD ROBUSTNESS (the promising bucket, n=${against.length}) ──`);
  console.log(`   per-symbol:`);
  for (const sym of SYMBOLS) { const s = against.filter((r) => r.symbol === sym); if (s.length) console.log(`     ${sym.padEnd(10)} ${f3(mean(s.map((r) => r.net))).padStart(9)}  win ${win(s.map((r) => r.net)).toFixed(0)}%  n=${s.length}`); }
  const dirS = against.filter((r) => !r.long), dirL = against.filter((r) => r.long);
  console.log(`   by direction:  SHORT-into-high-funding ${f3(mean(dirS.map((r) => r.net)))} (n=${dirS.length})   LONG-into-low-funding ${f3(mean(dirL.map((r) => r.net)))} (n=${dirL.length})`);
  const sortedByNet = [...against].sort((a, b) => b.net - a.net);
  const minus3 = sortedByNet.slice(3);
  console.log(`   outlier check:  full ${f3(mean(against.map((r) => r.net)))} → minus top-3 winners ${f3(mean(minus3.map((r) => r.net)))} (n=${minus3.length})`);
  const cut = Math.floor(against.length * 0.6);
  const tr = against.slice(0, cut), te = against.slice(cut);
  console.log(`   train/test 60/40 by time:  train ${f3(mean(tr.map((r) => r.net)))} (n=${tr.length})   test·held-out ${f3(mean(te.map((r) => r.net)))} (n=${te.length})`);

  const edge = ac.net - wc.net;
  console.log(`\n=== VERDICT @ ${config.interval} ===`);
  const verdict = !Number.isFinite(edge) ? "insufficient extreme-funding entries"
    : Math.abs(edge) < 0.03 ? `funding-sentiment is ~NOISE here (against ${f3(ac.net)} vs with ${f3(wc.net)}, gap ${f3(edge)}) — no usable contrarian filter`
    : edge > 0 ? `AGAINST-crowd beat WITH-crowd by ${f3(edge)}/trade (${f3(wc.net)}→${f3(ac.net)}) — extreme funding is a candidate contrarian/risk FILTER, forward-test it`
    : `WITH-crowd beat AGAINST by ${f3(-edge)} — momentum-in-funding, not contrarian; treat as noise unless it holds OOS`;
  console.log(`   ${verdict}.`);
  console.log(`   HONEST: full ~3.4yr multi-regime funding history (paginated). LESSON: on a short ~166d window this bucket showed a`);
  console.log(`   spectacular +0.43R — a REGIME ARTIFACT that dissolved to noise over multiple regimes. OI/long-short are only ~30-day`);
  console.log(`   backtestable (same short-window trap), so they're forward-test-only — do NOT trust a 30-day OI "edge".\n`);

  await mkdir(dirname("data/fundingsent.json"), { recursive: true });
  await writeFile("data/fundingsent.json", JSON.stringify({ generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, entries: recs.length, all, withCrowd: wc, againstCrowd: ac, neutral: nu, edge }, null, 2), "utf8");
  console.log("Saved → data/fundingsent.json");
}

main().catch((e) => { console.error(`fundingsent failed: ${(e as Error).stack ?? e}`); process.exit(1); });
