import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { pivotHighs, pivotLows } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run snipeedge` — tests the user's TP/SL thesis: "your targets are too far — aim at the CLOSEST structural
 * level (nearest high/low / S/R), which has a higher probability of being hit, then TRAIL if price keeps pushing."
 *
 * Method (honest, causal, net of fees): take the SAME entries the live book already makes (`precomputeSignals`),
 * and only swap the EXIT plan. For each entry, build a causal S/R level map from confirmed pivots (clustered;
 * MAJOR = multi-touch, MINOR = single/recent) using ONLY candles up to the signal bar, then compare four exits:
 *   • BASELINE     — the signal's own fixed stop/target (what the engine does today).
 *   • NEAREST      — target = closest opposing level (just inside it); stop = beyond the closest protecting level.
 *   • NEAREST-MAJOR— same, but target only the closest MAJOR level (skip minor noise).
 *   • NEAREST+TRAIL— bank half at the closest level, move to breakeven, TRAIL the rest by kATR to ride continuation.
 *
 * Fee legs are honest (entry taker; a target is a resting limit=maker, a stop is a market=taker). R is defined by
 * each variant's OWN stop distance, so expectancies are per-unit-risk comparable. No lookahead: pivots are only
 * used once confirmed (index ≤ i−right), the level map and ATR are as-of the signal bar, exits scan future only.
 *
 * HONEST FRAME: this hunts for a better exit on a book with NO validated edge. A win here improves the risk/return
 * of the EXIT, it does not by itself create an edge. Closer targets fight fees (smaller reward, same fee) — the net
 * columns are the truth, not the win rate. Order-book-aware TP/SL (the other half of the ask) is NOT here: there is
 * no historical L2 book to backtest — that half is forward-test-only.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 60; // bars to resolve an exit (structure targets can be nearer/farther than fixed ones)
const FOLDS = 8;
const LOOKBACK = Number(process.env.LVL_LOOKBACK ?? 400); // bars of history the level map is built from
const PIV = Number(process.env.PIV ?? 3); // pivot left/right strength
const CLUSTER = Number(process.env.CLUSTER_PCT ?? 0.4) / 100; // merge pivots within this % into one level
const MAJOR_TOUCHES = Number(process.env.MAJOR_TOUCHES ?? 3); // a level with ≥ this many touches is MAJOR
const MAX_TGT_ATR = Number(process.env.MAX_TGT_ATR ?? 8); // skip if no opposing level within this × ATR (no clean structure)
const KATR = config.paper.exit.trailAtrMult || 3; // trail distance for the +TRAIL variant
const MAKER = Number(process.env.MAKER_BPS ?? config.paper.feeBps) / 10000; // default: taker both legs (compare like-for-like with engine)
const TAKER = Number(process.env.TAKER_BPS ?? config.paper.feeBps) / 10000;

interface Lvl { price: number; touches: number; major: boolean }

/** Wilder ATR as-of each bar (atr[i] uses candles 0..i). */
function atrSeries(c: Candle[], lb = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  const trs = new Array<number>(c.length).fill(NaN);
  for (let i = 1; i < c.length; i++) { const h = c[i]!.high, l = c[i]!.low, pc = c[i - 1]!.close; trs[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let a = NaN;
  for (let i = lb; i < c.length; i++) { a = i === lb ? trs.slice(1, lb + 1).reduce((s, x) => s + x, 0) / lb : (a * (lb - 1) + trs[i]!) / lb; out[i] = a; }
  return out;
}

/** Causal S/R levels as of bar `upto`: cluster confirmed pivots (idx ≤ upto−PIV) within CLUSTER%, tag MAJOR by touches. */
function levelsAsOf(c: Candle[], upto: number): Lvl[] {
  const lo = Math.max(0, upto - LOOKBACK);
  const win = c.slice(lo, upto + 1);
  const highs = win.map((k) => k.high), lows = win.map((k) => k.low);
  // pivots confirmed by bar `upto`: pivot at local index p is confirmed when p + PIV ≤ (win.length-1)
  const confirmed = (idxs: number[]) => idxs.filter((p) => p + PIV <= win.length - 1);
  const ph = confirmed(pivotHighs(highs, PIV, PIV)).map((p) => highs[p]!);
  const pl = confirmed(pivotLows(lows, PIV, PIV)).map((p) => lows[p]!);
  const pts = [...ph, ...pl].sort((a, b) => a - b);
  if (!pts.length) return [];
  const levels: Lvl[] = [];
  let bucket: number[] = [pts[0]!];
  const flush = () => {
    const price = bucket.reduce((s, x) => s + x, 0) / bucket.length;
    levels.push({ price, touches: bucket.length, major: bucket.length >= MAJOR_TOUCHES });
  };
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i]! - bucket[bucket.length - 1]!) / bucket[bucket.length - 1]! <= CLUSTER) bucket.push(pts[i]!);
    else { flush(); bucket = [pts[i]!]; }
  }
  flush();
  return levels;
}

type Reason = "target" | "stop" | "timeout";
function feeR(entry: number, exit: number, risk: number, reason: Reason): number {
  const exitRate = reason === "target" ? MAKER : TAKER;
  return (TAKER * entry + exitRate * exit) / risk; // entry taker (market), exit per reason
}

/** First-touch fixed exit; stop checked before target (conservative). Returns net R. */
function fixedNet(long: boolean, entry: number, stop: number, target: number, fut: Candle[]): number | null {
  const risk = Math.abs(entry - stop); if (risk <= 0) return null;
  const rt = Math.abs(target - entry);
  for (const k of fut) {
    if (long ? k.low <= stop : k.high >= stop) return -1 - feeR(entry, stop, risk, "stop");
    if (long ? k.high >= target : k.low <= target) return rt / risk - feeR(entry, target, risk, "target");
  }
  const last = fut[fut.length - 1];
  if (!last) return 0;
  const gross = (long ? last.close - entry : entry - last.close) / risk;
  return gross - feeR(entry, last.close, risk, "timeout");
}

/** Bank half at firstTarget → breakeven → trail remainder by kATR behind peak. Net R (risk = |entry−stop|). */
function trailNet(long: boolean, entry: number, stop: number, firstTarget: number, atr: number, fut: Candle[]): number | null {
  const risk = Math.abs(entry - stop); if (risk <= 0 || !(atr > 0)) return null;
  const half = 0.5;
  let banked = 0, partialed = false, curStop = stop, peak = entry;
  for (const k of fut) {
    // stop first (conservative)
    if (long ? k.low <= curStop : k.high >= curStop) {
      const remR = (long ? curStop - entry : entry - curStop) / risk;
      // if we already banked half, only the remaining half exits here; otherwise the whole position does
      return banked + (partialed ? half : 1) * (remR - feeR(entry, curStop, risk, "stop"));
    }
    if (!partialed && (long ? k.high >= firstTarget : k.low <= firstTarget)) {
      const tR = Math.abs(firstTarget - entry) / risk;
      banked = half * (tR - feeR(entry, firstTarget, risk, "target"));
      partialed = true; curStop = entry; // breakeven on remainder
    }
    peak = long ? Math.max(peak, k.high) : Math.min(peak, k.low);
    if (partialed) { const trail = long ? peak - KATR * atr : peak + KATR * atr; curStop = long ? Math.max(curStop, trail) : Math.min(curStop, trail); }
  }
  const last = fut[fut.length - 1]; if (!last) return banked;
  const remR = (long ? last.close - entry : entry - last.close) / risk;
  return banked + (partialed ? half : 1) * (remR - feeR(entry, last.close, risk, "timeout"));
}

interface Rec { openMs: number; symbol: string; src: string; base: number | null; near: number | null; major: number | null; trail: number | null; hasStruct: boolean }

async function build(): Promise<Rec[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) { const c = await fetchDeepHistory(s, config.interval, TARGET); if (c && c.length >= WARMUP + 400) raw[s] = c; else console.error(`  skip ${s}: ${c?.length ?? 0} candles`); }
  const syms = Object.keys(raw);
  const bySym = alignByTime(raw, syms);
  const recs: Rec[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!; const n = c.length;
    const sigAt = precomputeSignals(sym, c);
    const atr = atrSeries(c, 14);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      const sigs = sigAt[i]!; if (!sigs.length) continue;
      const lvls = levelsAsOf(c, i); const a = atr[i]!;
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const E = sg.entry, long = sg.long;
        const fut = c.slice(i + 1, i + 1 + HORIZON);
        const base = fixedNet(long, E, sg.stop, sg.target, fut);
        busy[sg.source] = i + 1;
        // nearest opposing level (target) and nearest protecting level (stop), from structure
        const above = lvls.filter((l) => l.price > E).sort((x, y) => x.price - y.price);
        const below = lvls.filter((l) => l.price < E).sort((x, y) => y.price - x.price);
        const tgtSide = long ? above : below;   // take profit toward the opposing side
        const stopSide = long ? below : above;  // protection behind the trade
        const nearestTgt = tgtSide[0]?.price;
        const nearestMajor = tgtSide.find((l) => l.major)?.price;
        const structStop = stopSide[0]?.price;
        let near: number | null = null, major: number | null = null, trail: number | null = null, hasStruct = false;
        if (nearestTgt !== undefined && structStop !== undefined && a > 0) {
          const tgtDist = Math.abs(nearestTgt - E);
          if (tgtDist <= MAX_TGT_ATR * a && (long ? structStop < E : structStop > E)) {
            hasStruct = true;
            // pull target/stop just inside the level (0.05% buffer) so we exit before the crowd
            const buf = 0.0005;
            const T = long ? nearestTgt * (1 - buf) : nearestTgt * (1 + buf);
            const S = long ? structStop * (1 - buf) : structStop * (1 + buf);
            near = fixedNet(long, E, S, T, fut);
            trail = trailNet(long, E, S, T, a, fut);
            if (nearestMajor !== undefined) { const TM = long ? nearestMajor * (1 - buf) : nearestMajor * (1 + buf); major = fixedNet(long, E, S, TM, fut); }
          }
        }
        recs.push({ openMs: c[i]!.closeTime, symbol: sym, src: sg.source, base, near, major, trail, hasStruct });
      }
    }
  }
  recs.sort((a, b) => a.openMs - b.openMs);
  return recs;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const win = (a: number[]) => (a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");

function folds(vals: { ms: number; r: number }[], t0: number, span: number): string {
  const fold: number[][] = Array.from({ length: FOLDS }, () => []);
  for (const v of vals) fold[Math.min(FOLDS - 1, Math.floor(((v.ms - t0) / span) * FOLDS))]!.push(v.r);
  const fin = fold.filter((f) => f.length).length, pos = fold.filter((f) => f.length && mean(f) > 0).length;
  return `${pos}/${fin}`;
}

async function main() {
  console.log(`SNIPE-EXIT EDGE — closest structural target/stop (+trail) vs the current fixed exit. ${SYMBOLS.join("/")} @ ${config.interval}`);
  console.log(`levels: ${LOOKBACK}-bar window, pivot±${PIV}, cluster ${(CLUSTER * 1e4 / 100).toFixed(2)}%, MAJOR ≥${MAJOR_TOUCHES} touches · trail ${KATR}×ATR · fees ${(TAKER * 1e4).toFixed(1)}bps/side\n`);
  const recs = await build();
  if (recs.length < 100) { console.error(`only ${recs.length} signals. Aborting.`); process.exit(1); }
  const t0 = recs[0]!.openMs, span = (recs[recs.length - 1]!.openMs - t0) || 1;
  const withStruct = recs.filter((r) => r.hasStruct);
  console.log(`${recs.length} entries; ${withStruct.length} (${(100 * withStruct.length / recs.length).toFixed(0)}%) had a clean structural target within ${MAX_TGT_ATR}×ATR.\n`);

  // Compare ONLY on the subset that has a structural target (apples-to-apples: same entries, four exits).
  const col = (pick: (r: Rec) => number | null, label: string) => {
    const vals = withStruct.map(pick).filter((x): x is number => x !== null);
    const ms = withStruct.filter((r) => pick(r) !== null).map((r) => r.openMs);
    const paired = vals.map((r, k) => ({ ms: ms[k]!, r }));
    console.log(`   ${label.padEnd(16)} ${f3(mean(vals)).padStart(9)}   win ${win(vals).toFixed(0).padStart(3)}%   folds+ ${folds(paired, t0, span).padStart(5)}   n=${vals.length}`);
    return { net: mean(vals), win: win(vals), n: vals.length };
  };
  console.log(`── EXIT COMPARISON (on the ${withStruct.length} structural-target entries; per-signal net R) ──`);
  const cBase = col((r) => r.base, "BASELINE fixed");
  const cNear = col((r) => r.near, "NEAREST level");
  const cMajor = col((r) => r.major, "NEAREST-MAJOR");
  const cTrail = col((r) => r.trail, "NEAREST+TRAIL");

  // Whole-book view: baseline over ALL entries vs a book that uses structure when available, else baseline.
  const hybridNear = recs.map((r) => (r.hasStruct && r.near !== null ? r.near : r.base)).filter((x): x is number => x !== null);
  const hybridTrail = recs.map((r) => (r.hasStruct && r.trail !== null ? r.trail : r.base)).filter((x): x is number => x !== null);
  const baseAll = recs.map((r) => r.base).filter((x): x is number => x !== null);
  console.log(`\n── WHOLE-BOOK (all ${recs.length} entries; structure-when-available, else baseline) ──`);
  console.log(`   baseline-all      ${f3(mean(baseAll)).padStart(9)}   win ${win(baseAll).toFixed(0)}%   n=${baseAll.length}`);
  console.log(`   hybrid NEAREST    ${f3(mean(hybridNear)).padStart(9)}   win ${win(hybridNear).toFixed(0)}%   n=${hybridNear.length}`);
  console.log(`   hybrid +TRAIL     ${f3(mean(hybridTrail)).padStart(9)}   win ${win(hybridTrail).toFixed(0)}%   n=${hybridTrail.length}`);

  // Per-strategy on the structural subset (which entries does closer targeting help?).
  console.log(`\n── BY STRATEGY (structural subset: baseline → nearest → +trail) ──`);
  for (const src of [...new Set(withStruct.map((r) => r.src))]) {
    const s = withStruct.filter((r) => r.src === src);
    const b = s.map((r) => r.base).filter((x): x is number => x !== null);
    const nr = s.map((r) => r.near).filter((x): x is number => x !== null);
    const tr = s.map((r) => r.trail).filter((x): x is number => x !== null);
    console.log(`   ${src.padEnd(18)} ${f3(mean(b)).padStart(9)} → ${f3(mean(nr)).padStart(9)} → ${f3(mean(tr)).padStart(9)}   (win ${win(b).toFixed(0)}%→${win(nr).toFixed(0)}%)  n=${s.length}`);
  }

  const best = [["baseline", cBase.net], ["nearest", cNear.net], ["nearest-major", cMajor.net], ["nearest+trail", cTrail.net]].sort((a, b) => (b[1] as number) - (a[1] as number))[0]!;
  console.log(`\n=== VERDICT @ ${config.interval} ===`);
  console.log(`   Best exit on the structural subset: ${best[0]} (${f3(best[1] as number)}/signal).`);
  const helped = (cNear.net > cBase.net) || (cTrail.net > cBase.net);
  console.log(`   ${helped ? "Closest-level targeting BEATS the fixed exit on these entries" : "Closest-level targeting does NOT beat the fixed exit here"} — baseline ${f3(cBase.net)} vs nearest ${f3(cNear.net)} / +trail ${f3(cTrail.net)}.`);
  console.log(`   HONEST: this is an EXIT improvement measured on entries with no validated edge — it changes risk/return of`);
  console.log(`   the exit, it does not create an edge. Order-book-aware TP/SL is NOT modeled (no historical L2 book). Forward-test before trusting.\n`);

  await mkdir(dirname("data/snipeedge.json"), { recursive: true });
  await writeFile("data/snipeedge.json", JSON.stringify({
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval,
    params: { LOOKBACK, PIV, CLUSTER, MAJOR_TOUCHES, MAX_TGT_ATR, KATR },
    entries: recs.length, structuralSubset: withStruct.length,
    subset: { baseline: cBase, nearest: cNear, nearestMajor: cMajor, nearestTrail: cTrail },
    wholeBook: { baseline: mean(baseAll), hybridNearest: mean(hybridNear), hybridTrail: mean(hybridTrail) },
  }, null, 2), "utf8");
  console.log("Saved → data/snipeedge.json");
}

main().catch((e) => { console.error(`snipeedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
