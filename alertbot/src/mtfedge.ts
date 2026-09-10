import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, fetchDeepHistory, precomputeSignals, mean } from "./alphacore.js";
import { emaSeries } from "./indicators.js";
import type { Candle } from "./types.js";

/**
 * `npm run mtfedge` — does HIGHER-TIMEFRAME alignment actually improve the 1h signals?
 *
 * "Zoom out, trade with the bigger trend" is universal trader advice — but our 4h HTF confluence factor
 * measured NEGATIVE (-12pp) and 1h beat 4h/15m on the timeframe test. So MEASURE it rather than assume:
 * for every 1h signal, compute the CAUSAL 4h and 1d trend (price vs EMA on bars resampled from the SAME
 * 1h history — no extra data, no lookahead) and split fixed-R expectancy by whether the signal AGREES with
 * the higher timeframe. If agreeing lifts expectancy, an MTF-alignment gate is worth building; if not, keep
 * multi-timeframe as on-screen CONTEXT, not a trade filter. In-sample, gross R, 48-bar horizon.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const HORIZON = 48;
const EMA_P = 20;

/** Fixed stop/target, first touch — returns R and the bar it exited (for the per-source busy gate). */
function exitFixed(long: boolean, entry: number, stop: number, target: number, future: Candle[]): { r: number; exitBar: number } {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return { r: 0, exitBar: future.length };
  const rt = Math.abs(target - entry) / risk;
  for (let j = 0; j < future.length; j++) {
    const c = future[j]!;
    if (long ? c.low <= stop : c.high >= stop) return { r: -1, exitBar: j + 1 };
    if (long ? c.high >= target : c.low <= target) return { r: rt, exitBar: j + 1 };
  }
  const last = future[future.length - 1];
  return { r: last ? (long ? last.close - entry : entry - last.close) / risk : 0, exitBar: future.length };
}

/** Causal higher-TF trend: resample 1h closes into `step`-bar HTF bars, EMA on them → up/down/null per 1h index. */
function htfTrendFn(closes: number[], step: number, emaP: number): (i: number) => "up" | "down" | null {
  const samp: number[] = [];
  for (let j = step - 1; j < closes.length; j += step) samp.push(closes[j]!);
  const ema = emaSeries(samp, emaP);
  return (i: number) => {
    const k = Math.floor((i + 1) / step) - 1; // index of the last HTF bar FULLY closed by 1h bar i
    if (k < emaP || k >= samp.length) return null;
    const e = ema[k];
    if (e == null || !Number.isFinite(e)) return null;
    return samp[k]! > e ? "up" : "down";
  };
}

type Bucket = { all: number[]; with4h: number[]; against4h: number[]; with1d: number[]; against1d: number[]; withBoth: number[]; againstBoth: number[] };
const mkBucket = (): Bucket => ({ all: [], with4h: [], against4h: [], with1d: [], against1d: [], withBoth: [], againstBoth: [] });

async function main() {
  console.log(`MULTI-TIMEFRAME EDGE — does 4h / 1d alignment improve the 1h signals? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const shorts = mkBucket(), longs = mkBucket();
  const sEarlyAll: number[] = [], sEarlyBoth: number[] = [], sLateAll: number[] = [], sLateBoth: number[] = [];
  const shortTrades: { t: number; r: number; aligned: boolean }[] = []; // for the compounding portfolio test

  for (const sym of SYMBOLS) {
    const candles = await fetchDeepHistory(sym, config.interval, TARGET);
    if (!candles || candles.length < 600) { console.error(`not enough history for ${sym} (${candles?.length ?? 0})`); continue; }
    const splitAt = Math.floor(candles.length * 0.6); // chronological OOS split: early 60% vs late 40% (recent)
    const closes = candles.map((c) => c.close);
    const t4 = htfTrendFn(closes, 4, EMA_P); // 4h from 1h
    const t1d = htfTrendFn(closes, 24, EMA_P); // 1d from 1h
    const sigAt = precomputeSignals(sym, candles);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < candles.length - 1; i++) {
      const sigs = sigAt[i]!;
      if (!sigs.length) continue;
      const future = candles.slice(i + 1, i + 1 + HORIZON);
      const tr4 = t4(i), tr1 = t1d(i);
      for (const sg of sigs) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const fx = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        busy[sg.source] = i + fx.exitBar;
        const want: "up" | "down" = sg.long ? "up" : "down";
        const b = sg.long ? longs : shorts;
        b.all.push(fx.r);
        if (tr4) (tr4 === want ? b.with4h : b.against4h).push(fx.r);
        if (tr1) (tr1 === want ? b.with1d : b.against1d).push(fx.r);
        if (tr4 && tr1) (tr4 === want && tr1 === want ? b.withBoth : b.againstBoth).push(fx.r);
        if (!sg.long) {
          const late = i >= splitAt;
          const aligned = !!(tr4 && tr1 && tr4 === want && tr1 === want);
          (late ? sLateAll : sEarlyAll).push(fx.r);
          if (aligned) (late ? sLateBoth : sEarlyBoth).push(fx.r);
          shortTrades.push({ t: candles[i]!.closeTime, r: fx.r, aligned });
        }
      }
    }
  }

  const exp = (a: number[]) => (a.length ? mean(a) : NaN);
  const win = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);
  const cell = (a: number[]) => (Number.isFinite(exp(a)) ? `${exp(a) >= 0 ? "+" : ""}${exp(a).toFixed(3)}R/${win(a).toFixed(0)}%/n${a.length}` : "—");
  const report = (name: string, b: Bucket) => {
    console.log(`  ${name}`);
    console.log(`    all signals         ${cell(b.all)}`);
    console.log(`    WITH 4h trend       ${cell(b.with4h).padEnd(22)} AGAINST 4h    ${cell(b.against4h)}`);
    console.log(`    WITH 1d trend       ${cell(b.with1d).padEnd(22)} AGAINST 1d    ${cell(b.against1d)}`);
    console.log(`    WITH both (4h&1d)   ${cell(b.withBoth).padEnd(22)} AGAINST both  ${cell(b.againstBoth)}\n`);
  };
  report("SHORT signals (the earner cohort):", shorts);
  report("LONG signals:", longs);

  const d4 = exp(shorts.with4h) - exp(shorts.against4h);
  const d1 = exp(shorts.with1d) - exp(shorts.against1d);
  const dB = exp(shorts.withBoth) - exp(shorts.againstBoth);
  const fmt = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(3)}R` : "n/a");
  console.log(`VERDICT (shorts, with-trend minus against-trend): 4h ${fmt(d4)} · 1d ${fmt(d1)} · both ${fmt(dB)}`);
  const helps = (Number.isFinite(d4) && d4 > 0.03) || (Number.isFinite(dB) && dB > 0.05);
  console.log(
    helps
      ? "→ higher-timeframe alignment LIFTS the short edge — an opt-in MTF-alignment gate is worth prototyping (validate out-of-sample first)."
      : "→ higher-timeframe alignment does NOT meaningfully improve the edge — keep multi-timeframe as on-screen CONTEXT, not a trade gate (consistent with the -12pp HTF factor + 1h-best timeframe findings).",
  );
  console.log(`(In-sample, gross R, ${HORIZON}-bar horizon; 4h/1d resampled from 1h, EMA${EMA_P}, causal.)`);

  const gEarly = exp(sEarlyBoth) - exp(sEarlyAll);
  const gLate = exp(sLateBoth) - exp(sLateAll);
  console.log(`\nOOS (shorts, chronological split — does the '4h&1d-aligned' gate hold?):`);
  console.log(`  EARLY 60%: all ${cell(sEarlyAll)} · aligned ${cell(sEarlyBoth)}  → gate ${fmt(gEarly)}`);
  console.log(`  LATE 40%:  all ${cell(sLateAll)} · aligned ${cell(sLateBoth)}  → gate ${fmt(gLate)}`);
  console.log(
    Number.isFinite(gLate) && gLate > 0.02
      ? "  → MTF-alignment gate HOLDS out-of-sample (aligned shorts still beat all shorts in the recent half) — worth wiring as an opt-in short filter."
      : "  → MTF gate does NOT hold out-of-sample — keep multi-timeframe as context only, no gate.",
  );

  // PORTFOLIO test — per-trade edge != portfolio benefit. Compound the short book chronologically at 1% fixed
  // risk/trade and compare taking ALL shorts vs only ALIGNED shorts, on return AND drawdown (ret/DD).
  const port = (trades: { r: number }[]) => {
    let eq = 1, peak = 1, maxDD = 0;
    for (const t of trades) { eq *= 1 + 0.01 * t.r; if (eq > peak) peak = eq; const dd = (peak - eq) / peak; if (dd > maxDD) maxDD = dd; }
    return { ret: (eq - 1) * 100, dd: maxDD * 100, n: trades.length };
  };
  const chron = [...shortTrades].sort((a, b) => a.t - b.t);
  const pAll = port(chron), pAln = port(chron.filter((t) => t.aligned));
  const rdd = (p: { ret: number; dd: number }) => (p.dd > 0 ? p.ret / p.dd : p.ret);
  console.log(`\nPORTFOLIO (short book, chronological, 1% fixed risk/trade, compounding):`);
  console.log(`  ALL shorts:      ${pAll.ret >= 0 ? "+" : ""}${pAll.ret.toFixed(1)}%  maxDD ${pAll.dd.toFixed(1)}%  ret/DD ${rdd(pAll).toFixed(2)}  (n ${pAll.n})`);
  console.log(`  ALIGNED shorts:  ${pAln.ret >= 0 ? "+" : ""}${pAln.ret.toFixed(1)}%  maxDD ${pAln.dd.toFixed(1)}%  ret/DD ${rdd(pAln).toFixed(2)}  (n ${pAln.n})`);
  console.log(
    rdd(pAln) > rdd(pAll) * 1.05
      ? "  → the MTF gate improves the short book's RISK-ADJUSTED return (higher ret/DD) — the per-trade edge DOES translate to the portfolio. RECOMMEND enabling mtfAlignFilter."
      : "  → the MTF gate does NOT clearly improve risk-adjusted return at the portfolio level (fewer/clustered trades offset the per-trade lift) — keep it OFF; the per-trade edge didn't translate.",
  );
  console.log(`(Sequential 1% risk compounding — approximates the book; not concurrent-position sizing.)`);

  const out = {
    generatedAt: new Date().toISOString(),
    symbols: SYMBOLS,
    horizon: HORIZON,
    shorts: Object.fromEntries(Object.entries(shorts).map(([k, v]) => [k, { exp: exp(v), win: win(v), n: v.length }])),
    longs: Object.fromEntries(Object.entries(longs).map(([k, v]) => [k, { exp: exp(v), win: win(v), n: v.length }])),
    verdict: { d4h: d4, d1d: d1, dBoth: dB, helps },
  };
  await mkdir(dirname("data/mtfedge.json"), { recursive: true });
  await writeFile("data/mtfedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/mtfedge.json");
}

main().catch((e) => {
  console.error(`mtfedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
