import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, simulateWindow } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run regimeoos` — OUT-OF-SAMPLE validation of the bear-only filter.
 *
 * Everything else is in-sample, so the standing caveat is "could be window-luck." This does the honest
 * test: split the deep history chronologically (first `TRAIN_FRAC` = TRAIN, rest = TEST). On TRAIN it
 * sweeps the regime detector's (lookback, band) and PICKS the best bear-only params — then applies those
 * frozen params to the UNSEEN TEST slice and asks: does bear-only still beat baseline on data it was never
 * tuned on? If yes, the edge is more than in-sample fitting. The regime signal is causal (trailing basket
 * return), so classifying a test bar from data straddling the split leaks no labels — only the (L,band)
 * choice is fit, and only on TRAIN. One split / one path — still not live, but far stronger than in-sample.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const TRAIN_FRAC = 0.6;
const LS = [120, 168, 240, 336];
const BANDS = [0.02, 0.03, 0.05];

type Regime = "bull" | "bear" | "flat";
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cal = (c: number) => (c === Infinity ? "inf" : c.toFixed(2));
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function regimeSeries(idx: number[], L: number, band: number): Regime[] {
  const out: Regime[] = [];
  for (let i = 0; i < idx.length; i++) {
    if (i < L) { out[i] = "flat"; continue; }
    const trail = idx[i]! / idx[i - L]! - 1;
    out[i] = trail > band ? "bull" : trail < -band ? "bear" : "flat";
  }
  return out;
}

async function main() {
  console.log(`REGIME FILTER — OUT-OF-SAMPLE validation. ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < 336 + WARMUP + 500) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) {
    let r = 0;
    for (const s of SYMBOLS) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; }
    idx[i] = idx[i - 1]! * (1 + r / SYMBOLS.length);
  }
  const sigAt = Object.fromEntries(SYMBOLS.map((s) => [s, precomputeSignals(s, bySym[s]!)]));

  // Chronological split: TRAIN = [WARMUP, split), TEST = [split, n-1].
  const split = WARMUP + Math.floor((n - 1 - WARMUP) * TRAIN_FRAC);
  const start: number = config.paper.startBalanceUsd;
  const run = (a: number, b: number, allow?: (i: number, long: boolean, source: string) => boolean) => {
    const sim = simulateWindow(bySym, sigAt, SYMBOLS, a, b, start, allow);
    const ret = sim.equityStart > 0 ? sim.equityEnd / sim.equityStart - 1 : 0;
    return { ret, maxDD: sim.maxDD, calmar: sim.maxDD > 0 ? (ret * 100) / sim.maxDD : ret > 0 ? Infinity : 0, trades: sim.trades };
  };
  console.log(`TRAIN ${day(bySym[SYMBOLS[0]!]![WARMUP]!.openTime)}→${day(bySym[SYMBOLS[0]!]![split - 1]!.openTime)} (${split - WARMUP} bars) · ` +
    `TEST ${day(bySym[SYMBOLS[0]!]![split]!.openTime)}→${day(bySym[SYMBOLS[0]!]![n - 1]!.openTime)} (${n - split} bars).\n`);

  // ---- TRAIN: pick the bear-only params (L,band) with the best risk-adjusted return on TRAIN only ----
  let best: { L: number; band: number; calmar: number; ret: number } | null = null;
  for (const L of LS) for (const band of BANDS) {
    const reg = regimeSeries(idx, L, band);
    const r = run(WARMUP, split - 1, (i) => reg[i] === "bear");
    if (r.ret > 0 && (!best || r.calmar > best.calmar)) best = { L, band, calmar: r.calmar, ret: r.ret };
  }
  const trainBase = run(WARMUP, split - 1);
  if (!best) { console.log("No profitable bear-only params on TRAIN — cannot validate."); process.exit(0); }
  console.log(`TRAIN pick: bear-only params L=${best.L}, band=±${(best.band * 100).toFixed(0)}%  (train ret/DD ${cal(best.calmar)} vs baseline ${cal(trainBase.calmar)}).`);

  // ---- TEST: apply the FROZEN train-picked params to unseen data ----
  const regBest = regimeSeries(idx, best.L, best.band);
  const regDef = regimeSeries(idx, config.strategies.marketRegimeLookback, config.strategies.marketRegimeBandPct / 100);
  const testBase = run(split, n - 1);
  const testBO = run(split, n - 1, (i) => regBest[i] === "bear");
  const testBOdef = run(split, n - 1, (i) => regDef[i] === "bear");

  console.log(`\n  slice   variant                     trades  return    maxDD    ret/DD`);
  const row = (slice: string, name: string, r: ReturnType<typeof run>) =>
    console.log(`  ${slice.padEnd(6)}  ${name.padEnd(26)} ${String(r.trades).padStart(5)}  ${pct(r.ret).padStart(7)}  ${(r.maxDD.toFixed(1) + "%").padStart(6)}  ${cal(r.calmar).padStart(6)}`);
  row("TRAIN", "baseline (all)", trainBase);
  row("TRAIN", `bear-only (picked params)`, run(WARMUP, split - 1, (i) => regBest[i] === "bear"));
  row("TEST", "baseline (all)", testBase);
  row("TEST", "bear-only (train params)", testBO);
  row("TEST", `bear-only (default 168/±3%)`, testBOdef);

  const oosWins = testBO.calmar > testBase.calmar && testBO.ret > 0;
  const oosWinsRet = testBO.ret > testBase.ret;
  console.log(
    `\nVERDICT (out-of-sample): ${oosWins
      ? `bear-only HOLDS OUT-OF-SAMPLE — on data it was never tuned on, ret/DD ${cal(testBO.calmar)} vs baseline ${cal(testBase.calmar)} (return ${pct(testBO.ret)} vs ${pct(testBase.ret)}). ` +
        `The edge is more than in-sample fitting${oosWinsRet ? "" : " (better risk-adjusted, though raw return is close)"}. Still one split/one path — live is the final test.`
      : `bear-only does NOT clearly beat baseline out-of-sample (ret/DD ${cal(testBO.calmar)} vs ${cal(testBase.calmar)}, return ${pct(testBO.ret)} vs ${pct(testBase.ret)}). ` +
        `The in-sample edge may be partly window-luck — treat the filter with more caution and lean on live tracking before trusting it.`}`,
  );
  console.log(`(TEST is only ${n - split} bars ≈ ${((n - split) / 24).toFixed(0)} days — a small out-of-sample sample; directional, not definitive.)`);

  // ---- WALK-FORWARD: several sequential test folds, params RE-PICKED on expanding prior data each time.
  //      Aggregates whether bear-only beats baseline on RETURN vs DRAWDOWN across periods (robuster than 1 split). ----
  const N_FOLDS = 4;
  const wfStart = WARMUP + Math.floor((n - 1 - WARMUP) * 0.4); // reserve first 40% as the initial train
  const foldLen = Math.floor((n - 1 - wfStart) / N_FOLDS);
  interface Fold { fold: number; startDay: string; endDay: string; L: number; band: number; base: ReturnType<typeof run>; bo: ReturnType<typeof run>; retW: boolean; ddW: boolean; calW: boolean }
  const folds: Fold[] = [];
  let retWins = 0, ddWins = 0, calWins = 0;
  console.log(`\nWALK-FORWARD (${N_FOLDS} folds, expanding train → next test window):`);
  console.log(`  fold  test window              baseline r/DD        bear-only r/DD       bear-only better on`);
  for (let f = 0; f < N_FOLDS; f++) {
    const ts = wfStart + f * foldLen;
    const te = f === N_FOLDS - 1 ? n - 1 : ts + foldLen - 1;
    let bp: { L: number; band: number } | null = null;
    let bpCal = -Infinity;
    for (const L of LS) for (const band of BANDS) {
      const reg = regimeSeries(idx, L, band);
      const r = run(WARMUP, ts - 1, (i) => reg[i] === "bear");
      if (r.ret > 0 && r.calmar > bpCal) { bpCal = r.calmar; bp = { L, band }; }
    }
    if (!bp) bp = { L: config.strategies.marketRegimeLookback, band: config.strategies.marketRegimeBandPct / 100 };
    const reg = regimeSeries(idx, bp.L, bp.band);
    const base = run(ts, te);
    const bo = run(ts, te, (i) => reg[i] === "bear");
    const retW = bo.ret > base.ret, ddW = bo.maxDD < base.maxDD, calW = bo.calmar > base.calmar;
    if (retW) retWins++; if (ddW) ddWins++; if (calW) calWins++;
    const startDay = day(bySym[SYMBOLS[0]!]![ts]!.openTime), endDay = day(bySym[SYMBOLS[0]!]![te]!.openTime);
    folds.push({ fold: f + 1, startDay, endDay, L: bp.L, band: bp.band, base, bo, retW, ddW, calW });
    const better = [calW ? "ret/DD" : "", retW ? "return" : "", ddW ? "drawdown" : ""].filter(Boolean).join(", ") || "—";
    console.log(`  ${String(f + 1).padStart(2)}    ${startDay}→${endDay}  ${(pct(base.ret) + " / " + base.maxDD.toFixed(0) + "%").padStart(15)}   ${(pct(bo.ret) + " / " + bo.maxDD.toFixed(0) + "%").padStart(15)}   ${better}`);
  }
  console.log(`\n  Across ${N_FOLDS} folds, bear-only beat baseline on: RETURN ${retWins}/${N_FOLDS} · DRAWDOWN ${ddWins}/${N_FOLDS} · ret/DD ${calWins}/${N_FOLDS}.`);
  console.log(`  → ${ddWins >= N_FOLDS - 1 && retWins <= N_FOLDS / 2
    ? "CONFIRMS risk-reducer — bear-only cuts drawdown consistently but doesn't reliably raise return."
    : retWins >= ddWins && retWins > N_FOLDS / 2
      ? "Return help is as consistent as drawdown help here — stronger than the single split suggested."
      : ddWins > retWins ? "Leans risk-reducer (helps drawdown more than return)." : "Mixed across folds — no consistent edge either way."}`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, split, trainBars: split - WARMUP, testBars: n - split,
    trainPick: best, results: { trainBase, testBase, testBO, testBOdef }, oosWins,
    walkforward: { nFolds: N_FOLDS, retWins, ddWins, calWins, folds } };
  await mkdir(dirname("data/regimeoos.json"), { recursive: true });
  await writeFile("data/regimeoos.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/regimeoos.json");
}

main().catch((e) => {
  console.error(`regimeoos failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
