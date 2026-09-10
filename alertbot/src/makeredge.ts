import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run makeredge` — HONEST maker/limit-entry vs taker/market-entry comparison.
 *
 * WHY: `npm run bookwalk` showed the 4h book has a thin gross edge (~+0.067R) that taker fees eat ~75% of
 * (net +0.017R), and that dropping fees toward maker (2bps) roughly TRIPLES the net (+0.046R). That makes
 * "enter with resting LIMIT orders (maker) instead of market (taker)" the single highest-leverage lever.
 *
 * THE CATCH this tool measures: a limit order only fills if price trades back to your level. The signals whose
 * price RUNS AWAY (never comes back) are disproportionately the big winners — the book is carried by ~3 outlier
 * winners (bookwalk's minus-top-3 check flips it negative). So a naive `feeBps=2` swap is a LIE: it books the fee
 * saving without the missed-fill cost. This measures whether the fee saving SURVIVES adverse selection.
 *
 * Three models, same signal stream, net of correct fee legs (entry: market=taker / limit=maker; exit: target is a
 * resting limit=maker, stop is a market order=taker):
 *   1. BASELINE  — market entry (taker), every signal fills immediately at `entry`. Mirrors the live paper engine.
 *   2. MAKER-NAIVE — limit entry fee but assume EVERY signal fills (no gating). The optimistic ceiling / the "lie".
 *   3. MAKER-HONEST — rest a limit at `entry`; fill ONLY if a candle within `fillWindow` bars trades back through
 *      it; otherwise DROP the signal (no trade, 0 R). Reports fill rate, the filled book, and — the honest cost —
 *      the would-be-at-market expectancy of the DROPPED signals (adverse selection), plus how many of the biggest
 *      market winners were MISSED. Portfolio expectancy is per-SIGNAL (a dropped signal earns 0), so it is directly
 *      comparable to the baseline (which trades every signal).
 *
 * No lookahead (fill scan and exit scan only ever read candles AFTER the signal bar). Fixed stop/target exit, same
 * as bookwalk, so results reconcile. Small samples are noisy — read the trend and the robustness checks, not the 3rd decimal.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000; // candles/symbol (≈250d @1h, ≈2.7yr @4h)
const HORIZON = 48; // bars to resolve stop/target after entry
const FOLDS = 8;
const FILL_WINDOW = Number(process.env.FILL_WINDOW ?? 4); // bars a resting limit has to get filled before we drop it
const MAKER = Number(process.env.MAKER_BPS ?? 2) / 10000; // maker fee/side (Binance futures ≈ 2bps, less with BNB/VIP)
const TAKER = Number(process.env.TAKER_BPS ?? config.paper.feeBps) / 10000; // taker fee/side (≈5bps)

type Reason = "target" | "stop" | "timeout";

/** First-touch fixed stop/target from `startI` (exclusive) → gross R, exit price, reason. No lookahead. */
function exitFixed(long: boolean, entry: number, stop: number, target: number, c: Candle[], startI: number): { r: number; exit: number; reason: Reason } {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { r: 0, exit: entry, reason: "timeout" };
  const rt = Math.abs(target - entry) / risk;
  const end = Math.min(c.length, startI + 1 + HORIZON);
  for (let j = startI + 1; j < end; j++) {
    const k = c[j]!;
    if (long ? k.low <= stop : k.high >= stop) return { r: -1, exit: stop, reason: "stop" };
    if (long ? k.high >= target : k.low <= target) return { r: rt, exit: target, reason: "target" };
  }
  const last = c[end - 1];
  const r = last ? (long ? last.close - entry : entry - last.close) / risk : 0;
  return { r, exit: last ? last.close : entry, reason: "timeout" };
}

/** Fee in R for one filled trade given which leg is maker vs taker (exit leg depends on how it exited). */
function feeR(entry: number, exit: number, risk: number, entryRate: number, reason: Reason): number {
  const exitRate = reason === "target" ? MAKER : TAKER; // target = resting limit (maker); stop/timeout = market (taker)
  return (entryRate * entry + exitRate * exit) / risk;
}

interface Rec {
  openMs: number; symbol: string; long: boolean; risk: number; source: string;
  // baseline: market entry at signal bar i
  baseNet: number; baseGross: number;
  // maker-honest: did the limit fill within the window, and if so its net
  filled: boolean; fillBar: number; makerNet: number | null;
  // maker-naive: limit fee, assume fill at signal bar (same path as baseline)
  naiveNet: number;
  // maker-realistic: you can only REST a maker limit when providing liquidity (buy at/below price, sell at/above).
  // A momentum/breakout entry set on the WRONG side of the signal-bar close must cross the spread → taker (a chase).
  makerFeasible: boolean;
  realNet: number; // per-signal net under the realistic rule (feasible→limit-or-drop; infeasible→market taker)
}

async function build(): Promise<Rec[]> {
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < WARMUP + 400) { console.error(`  skip ${s}: only ${c?.length ?? 0} candles`); continue; }
    raw[s] = c;
  }
  const syms = Object.keys(raw);
  const bySym = alignByTime(raw, syms);
  const recs: Rec[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!;
    const n = c.length;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {}; // per-source non-overlap, mirrors bookwalk
    for (let i = WARMUP; i < n - 1; i++) {
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const risk = Math.abs(sg.entry - sg.stop);
        if (risk <= 0) continue;
        // BASELINE — market entry at bar i, exit scanned from i.
        const base = exitFixed(sg.long, sg.entry, sg.stop, sg.target, c, i);
        const baseNet = base.r - feeR(sg.entry, base.exit, risk, TAKER, base.reason);
        const naiveNet = base.r - feeR(sg.entry, base.exit, risk, MAKER, base.reason);
        busy[sg.source] = i + 1; // reserve at least the signal bar; extended below if the limit fills
        // MAKER-HONEST — rest a limit at entry; fill only if a bar within the window trades through it.
        let filled = false, fillBar = -1, makerNet: number | null = null;
        const end = Math.min(n, i + 1 + FILL_WINDOW);
        for (let j = i + 1; j < end; j++) {
          const k = c[j]!;
          const hit = sg.long ? k.low <= sg.entry : k.high >= sg.entry;
          if (hit) { filled = true; fillBar = j; break; }
        }
        if (filled) {
          const ex = exitFixed(sg.long, sg.entry, sg.stop, sg.target, c, fillBar);
          makerNet = ex.r - feeR(sg.entry, ex.exit, risk, MAKER, ex.reason);
          busy[sg.source] = fillBar + 1;
        }
        // Realistic maker feasibility: a resting limit only provides liquidity if it sits on the near side of price.
        const closeI = c[i]!.close;
        const makerFeasible = sg.long ? sg.entry <= closeI : sg.entry >= closeI;
        // Under the realistic rule: feasible → the honest limit result (net if filled, 0 if the level was never
        // revisited); infeasible (a chase) → you cross the spread and pay taker at market = the baseline outcome.
        const realNet = makerFeasible ? (filled ? makerNet! : 0) : baseNet;
        recs.push({ openMs: c[i]!.closeTime, symbol: sym, long: sg.long, risk, source: sg.source, baseNet, baseGross: base.r, filled, fillBar, makerNet, naiveNet, makerFeasible, realNet });
      }
    }
  }
  recs.sort((a, b) => a.openMs - b.openMs);
  return recs;
}

const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const winPct = (a: number[]) => (a.length ? (100 * a.filter((r) => r > 0).length) / a.length : 0);
const f3 = (e: number) => `${e >= 0 ? "+" : ""}${e.toFixed(3)}R`;

function foldsPositive(vals: { ms: number; r: number }[], t0: number, span: number): { pos: number; fin: number } {
  const fold: number[][] = Array.from({ length: FOLDS }, () => []);
  for (const v of vals) fold[Math.min(FOLDS - 1, Math.floor(((v.ms - t0) / span) * FOLDS))]!.push(v.r);
  const fin = fold.filter((f) => f.length).length;
  const pos = fold.filter((f) => f.length && mean(f) > 0).length;
  return { pos, fin };
}

async function main() {
  console.log(`MAKER-ENTRY EDGE — does a limit entry's fee saving survive the missed-fill cost? ${SYMBOLS.join("/")} @ ${config.interval}`);
  console.log(`fill window ${FILL_WINDOW} bars · maker ${(MAKER * 1e4).toFixed(1)}bps / taker ${(TAKER * 1e4).toFixed(1)}bps per side · fixed stop/target, no lookahead\n`);
  const recs = await build();
  if (recs.length < 50) { console.error(`only ${recs.length} signals — too few. Aborting.`); process.exit(1); }
  const t0 = recs[0]!.openMs, span = (recs[recs.length - 1]!.openMs - t0) || 1;
  const N = recs.length;

  const base = recs.map((r) => r.baseNet);
  const naive = recs.map((r) => r.naiveNet);
  const real = recs.map((r) => r.realNet);
  const filledRecs = recs.filter((r) => r.filled);
  const droppedRecs = recs.filter((r) => !r.filled);
  const makerFilled = filledRecs.map((r) => r.makerNet!);
  const feasibleRecs = recs.filter((r) => r.makerFeasible);
  // Portfolio per-SIGNAL: a dropped signal earns 0 R (no trade). Comparable to baseline (trades every signal).
  const makerPortfolio = recs.map((r) => (r.filled ? r.makerNet! : 0));

  const bf = foldsPositive(recs.map((r) => ({ ms: r.openMs, r: r.baseNet })), t0, span);
  const mf = foldsPositive(recs.map((r) => ({ ms: r.openMs, r: r.filled ? r.makerNet! : 0 })), t0, span);

  console.log(`${N} signals over ~${Math.round(span / 86_400_000)} days.\n`);
  console.log(`── 1. BASELINE  (market entry, taker) ─────────────────────────────`);
  console.log(`     per-signal net ${f3(mean(base))} · win ${winPct(base).toFixed(0)}% · n=${N} · folds+ ${bf.pos}/${bf.fin}   ← what the live engine does\n`);
  console.log(`── 2. MAKER-NAIVE  (limit fee, assume ALL fill — the optimistic LIE) ─`);
  console.log(`     per-signal net ${f3(mean(naive))} · win ${winPct(naive).toFixed(0)}% · n=${N}`);
  console.log(`     (this is the ceiling maker fees COULD buy if every limit filled — it never does; see model 3)\n`);
  console.log(`── 3. MAKER-HONEST  (limit fills only if price returns within ${FILL_WINDOW} bars, else dropped) ─`);
  console.log(`     fill rate ${(100 * filledRecs.length / N).toFixed(0)}%  (${filledRecs.length} filled / ${droppedRecs.length} dropped)`);
  console.log(`     FILLED book (per trade taken):   ${f3(mean(makerFilled))} · win ${winPct(makerFilled).toFixed(0)}% · n=${filledRecs.length}`);
  console.log(`     PORTFOLIO (per signal, drop=0R): ${f3(mean(makerPortfolio))} · folds+ ${mf.pos}/${mf.fin} · n=${N}   ← compare to baseline`);
  console.log(`     DROPPED signals' would-be-at-market: ${f3(mean(droppedRecs.map((r) => r.baseNet)))} · win ${winPct(droppedRecs.map((r) => r.baseNet)).toFixed(0)}% · n=${droppedRecs.length}`);
  console.log(`        (adverse selection: if the DROPPED bucket is a WINNER, limits are skipping your good trades)\n`);

  const rf = foldsPositive(recs.map((r) => ({ ms: r.openMs, r: r.realNet })), t0, span);
  const nFeas = feasibleRecs.length;
  console.log(`── 4. MAKER-REALISTIC  (maker ONLY where a resting limit provides liquidity; chases pay taker) ─`);
  console.log(`     maker-feasible signals: ${(100 * nFeas / N).toFixed(0)}%  (${nFeas} rest a limit / ${N - nFeas} must cross the spread → taker)`);
  console.log(`     per-signal net ${f3(mean(real))} · folds+ ${rf.pos}/${rf.fin} · n=${N}   ← the HONEST number to judge on`);
  console.log(`     (of feasible signals, this credits maker fees + honest fill-gating; of chases, it charges taker at market)\n`);

  // Per-strategy: which sources can actually be makers, and what each contributes.
  const sources = [...new Set(recs.map((r) => r.source))];
  console.log(`── BY STRATEGY (maker-feasible share + baseline vs realistic per-signal) ──`);
  for (const src of sources) {
    const s = recs.filter((r) => r.source === src);
    const feas = s.filter((r) => r.makerFeasible).length;
    console.log(`     ${src.padEnd(18)} feasible ${(100 * feas / s.length).toFixed(0).padStart(3)}%   baseline ${f3(mean(s.map((r) => r.baseNet))).padStart(9)}   realistic ${f3(mean(s.map((r) => r.realNet))).padStart(9)}   n=${s.length}`);
  }
  console.log("");

  // Did the limit MISS the runaway winners that carry the book? Rank by baseline gross; check fill status of the top.
  const byGross = [...recs].sort((a, b) => b.baseGross - a.baseGross);
  const TOPN = Math.min(10, recs.length);
  const top = byGross.slice(0, TOPN);
  const topFilled = top.filter((r) => r.filled).length;
  console.log(`── OUTLIER-CAPTURE  (bookwalk showed the edge is carried by a few big winners) ──`);
  console.log(`     of the top-${TOPN} biggest market winners, the limit would have FILLED ${topFilled}/${TOPN} and MISSED ${TOPN - topFilled}.`);
  console.log(`     top-${TOPN} avg gross ${f3(mean(top.map((r) => r.baseGross)))}; the missed ones are pure give-up.`);
  const baseMinusTop3 = [...recs].sort((a, b) => b.baseGross - a.baseGross).slice(3).map((r) => r.baseNet);
  const makerMinusTop3 = (() => { const s = [...recs].sort((a, b) => b.baseGross - a.baseGross).slice(3); return s.map((r) => (r.filled ? r.makerNet! : 0)); })();
  console.log(`     robustness — minus top-3 winners:  baseline ${f3(mean(baseMinusTop3))}   maker-portfolio ${f3(mean(makerMinusTop3))}\n`);

  // Per-symbol + 70/30 held-out on the honest portfolio.
  console.log(`── PER-SYMBOL (maker-portfolio per signal) ──`);
  for (const sym of SYMBOLS) {
    const s = recs.filter((r) => r.symbol === sym);
    if (!s.length) continue;
    const bp = mean(s.map((r) => r.baseNet)), mp = mean(s.map((r) => (r.filled ? r.makerNet! : 0)));
    console.log(`     ${sym.padEnd(10)} baseline ${f3(bp).padStart(9)}   maker ${f3(mp).padStart(9)}   fill ${(100 * s.filter((r) => r.filled).length / s.length).toFixed(0)}%  n=${s.length}`);
  }
  const cut = Math.floor(N * 0.7);
  const tr = recs.slice(0, cut), te = recs.slice(cut);
  const port = (a: Rec[]) => mean(a.map((r) => (r.filled ? r.makerNet! : 0)));
  console.log(`── TRAIN/TEST (70/30 by time, maker-portfolio) ──`);
  console.log(`     train ${f3(port(tr))} (n=${tr.length})   test·held-out ${f3(port(te))} (n=${te.length})\n`);

  const bMean = mean(base), mMean = mean(makerPortfolio), rMean = mean(real), lift = rMean - bMean;
  const verdict = rMean <= 0
    ? `maker-realistic is NOT net-positive (${f3(rMean)}) — limit entries don't rescue this book`
    : lift > 0.002
      ? `maker entries HELP realistically: ${f3(bMean)} → ${f3(rMean)}/signal (+${lift.toFixed(3)}R) — worth an opt-in live knob + forward-test`
      : `maker entries are ~NEUTRAL realistically (${f3(bMean)} → ${f3(rMean)}): the fee saving is small once chases pay taker — low priority`;
  console.log(`=== VERDICT @ ${config.interval} (fill window ${FILL_WINDOW}) ===`);
  console.log(`   baseline ${f3(bMean)}  →  maker-optimistic ${f3(mMean)}  →  maker-REALISTIC ${f3(rMean)}  per signal`);
  console.log(`   ${verdict}`);
  console.log(`   HONEST: this is a research measurement, not a live change. Even a positive result is a marginal,`);
  console.log(`   forward-test candidate on a fragile book — NOT a validated edge. Live entry-type is the user's call.\n`);

  await mkdir(dirname("data/makeredge.json"), { recursive: true });
  await writeFile("data/makeredge.json", JSON.stringify({
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, fillWindow: FILL_WINDOW,
    makerBps: MAKER * 1e4, takerBps: TAKER * 1e4, signals: N,
    baseline: { net: bMean, win: winPct(base), foldsPos: bf.pos, foldsFin: bf.fin },
    makerNaive: { net: mean(naive) },
    makerHonest: {
      fillRate: filledRecs.length / N, filledNet: mean(makerFilled), portfolioNet: mMean,
      foldsPos: mf.pos, foldsFin: mf.fin, droppedWouldBe: mean(droppedRecs.map((r) => r.baseNet)),
      topNFilled: topFilled, topN: TOPN, baseMinusTop3: mean(baseMinusTop3), makerMinusTop3: mean(makerMinusTop3),
      trainPort: port(tr), testPort: port(te),
    },
    makerRealistic: {
      net: rMean, foldsPos: rf.pos, foldsFin: rf.fin, feasibleShare: nFeas / N,
      byStrategy: Object.fromEntries(sources.map((src) => {
        const s = recs.filter((r) => r.source === src);
        return [src, { feasibleShare: s.filter((r) => r.makerFeasible).length / s.length, baseline: mean(s.map((r) => r.baseNet)), realistic: mean(s.map((r) => r.realNet)), n: s.length }];
      })),
    },
    lift, verdict,
  }, null, 2), "utf8");
  console.log("Saved → data/makeredge.json");
}

main().catch((e) => { console.error(`makeredge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
