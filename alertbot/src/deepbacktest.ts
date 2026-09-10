import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals } from "./alphacore.js";
import { feeBlocksTrade } from "./paperexit.js";
import type { Candle } from "./types.js";

/**
 * `npm run deepbacktest` — MULTI-TIMEFRAME deep backtest of the whole signal book (SOL/BTC/ETH). Sweeps
 * config.backtest.timeframes SEQUENTIALLY (default 1h/4h/12h), runs the full book + a 70/30 OOS split on each, and
 * prints a SIDE-BY-SIDE sweep table; then a detailed per-book breakdown for the primary timeframe (config.interval).
 * Model: enabled strategies + S/R confirmations (precomputeSignals); fee-to-risk filter; first-touch fixed exit;
 * causal, no-lookahead basket regime; NET of taker fees. Honest, no-lookahead, re-runnable.
 *
 * TIMEFRAME SCALING (where the "does higher TF outrun fees?" test actually lives):
 *  • Strategy detectors are BAR-COUNT based (TSMOM lookback 48 bars, ATR14, breakout 25–30-bar windows). Testing on
 *    4h/12h means running the SAME bar-count strategy on the higher-TF candles — that IS the timeframe test. We do
 *    NOT rescale their indicator periods (that would just resample the 1h strategy and defeat the point). Higher TF
 *    ⇒ wider %-stops ⇒ lower fee-per-R, which is exactly the effect under test.
 *  • The one genuinely WALL-CLOCK concept, the broad-market regime lookback (168 bars ≈ 7 days @1h), IS scaled per
 *    TF to stay ~7 days. HORIZON (bars to resolve a trade) stays in bars — generous on higher TF, avoids premature
 *    mark-outs.
 *
 * Gold (XAUT) is excluded: < ~4 months of history and no measured edge (see EDGE-REPORT 2026-07-15).
 */

const SYMBOLS = (process.env.DEEP_SYMBOLS ?? "SOLUSDT,BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const DAYS = Number(process.env.DEEP_DAYS ?? 730);
const TIMEFRAMES = (process.env.DEEP_TF ?? config.backtest.timeframes.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
const HORIZON = 48; // bars to resolve a trade (kept in BARS across TFs — see header)
const FOLDS = 8;
const BAND = config.strategies.marketRegimeBandPct / 100;
const FEE = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000;
const FEEFILTER = (process.env.DEEP_FEEFILTER ?? (config.plan.feeFilter ? "on" : "off")) !== "off";
// Walk-forward: set DEEP_WFA=<tf> (e.g. DEEP_WFA=4h) to run a rolling train/test analysis on that TF after the sweep.
const WFA = process.env.DEEP_WFA;
const WFA_TRAIN = Number(process.env.WFA_TRAIN_DAYS ?? 180); // train-window days (informational — see NOTE in report)
const WFA_TEST = Number(process.env.WFA_TEST_DAYS ?? 60); // test-window days; rolled forward by this each fold

/** Hours per bar for a Binance interval string ("1h"→1, "4h"→4, "12h"→12, "1d"→24, "30m"→0.5). */
function tfHours(tf: string): number {
  if (tf.endsWith("h")) return Number(tf.slice(0, -1)) || 1;
  if (tf.endsWith("d")) return 24 * (Number(tf.slice(0, -1)) || 1);
  if (tf.endsWith("m")) return (Number(tf.slice(0, -1)) || 1) / 60;
  return 1;
}
/** Per-timeframe params. Only the wall-clock regime lookback scales; strategy bar-counts run native (see header). */
function tfParams(tf: string): { h: number; target: number; regimeL: number } {
  const h = tfHours(tf);
  const target = Math.ceil(DAYS * (24 / h)) + WARMUP + 100;
  const regimeL = Math.max(8, Math.round(config.strategies.marketRegimeLookback / h)); // ~7 days, in this TF's bars
  return { h, target, regimeL };
}

/** First-touch fixed stop/target → gross R (net computed by caller). */
function exitFixed(long: boolean, entry: number, stop: number, target: number, future: Candle[]): number {
  const risk = Math.abs(entry - stop);
  if (risk <= 0) return 0;
  const rt = Math.abs(target - entry) / risk;
  for (const c of future) {
    if (long ? c.low <= stop : c.high >= stop) return -1;
    if (long ? c.high >= target : c.low <= target) return rt;
  }
  const last = future[future.length - 1];
  return last ? (long ? last.close - entry : entry - last.close) / risk : 0;
}

interface Trade { openMs: number; r: number; gross: number; feeUnit: number; regime: "bull" | "bear" | "flat"; symbol: string; source: string; long: boolean }

/** Replay the whole book at one timeframe. Strategy detectors run on native bars; regime lookback scaled to ~7 days. */
async function buildTrades(tf: string): Promise<{ trades: Trade[]; span: number; candles: number; feeSkipped: number }> {
  const { target, regimeL } = tfParams(tf);
  let feeSkipped = 0;
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, tf, target);
    if (!c || c.length < WARMUP + 100) { console.error(`  skip ${s}@${tf}: only ${c?.length ?? 0} candles`); continue; }
    raw[s] = c;
  }
  const syms = Object.keys(raw);
  if (!syms.length) return { trades: [], span: 0, candles: 0, feeSkipped };
  // Trim every TF to the SAME trailing DAYS-day calendar window so the sweep is apples-to-apples (fetchDeepHistory
  // overshoots by full 1500-candle batches, which on higher TFs would otherwise cover a much longer/older span).
  let maxClose = 0;
  for (const s of syms) { const last = raw[s]![raw[s]!.length - 1]; if (last && last.closeTime > maxClose) maxClose = last.closeTime; }
  const cutoff = maxClose - DAYS * 86_400_000;
  for (const s of syms) raw[s] = raw[s]!.filter((c) => c.closeTime >= cutoff);
  const bySym = alignByTime(raw, syms);
  const n = bySym[syms[0]!]!.length;
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) { let r = 0; for (const s of syms) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; } idx[i] = idx[i - 1]! * (1 + r / syms.length); }
  const regimeAt = (i: number): "bull" | "bear" | "flat" => {
    if (i < regimeL) return "flat";
    const tr = idx[i]! / idx[i - regimeL]! - 1;
    return tr < -BAND ? "bear" : tr > BAND ? "bull" : "flat";
  };

  const trades: Trade[] = [];
  for (const sym of syms) {
    const c = bySym[sym]!;
    const sigAt = precomputeSignals(sym, c);
    const busy: Record<string, number> = {};
    for (let i = WARMUP; i < n - 1; i++) {
      for (const sg of sigAt[i]!) {
        if ((busy[sg.source] ?? -1) >= i) continue;
        const risk = Math.abs(sg.entry - sg.stop);
        if (risk <= 0) continue;
        // Fee-to-risk filter (config.plan.feeFilter) — reject churny tight-stop trades. Env DEEP_FEEFILTER=off to compare.
        if (FEEFILTER && feeBlocksTrade(sg.entry, sg.stop, 2 * FEE, config.plan.maxFeeThresholdPct)) { feeSkipped++; continue; }
        const future = c.slice(i + 1, i + 1 + HORIZON);
        const r = exitFixed(sg.long, sg.entry, sg.stop, sg.target, future);
        let exitBar = future.length;
        for (let j = 0; j < future.length; j++) { const fc = future[j]!; if ((sg.long ? fc.low <= sg.stop || fc.high >= sg.target : fc.high >= sg.stop || fc.low <= sg.target)) { exitBar = j + 1; break; } }
        busy[sg.source] = i + exitBar;
        const exit = sg.long ? sg.entry + r * risk : sg.entry - r * risk;
        const feeUnit = (sg.entry + exit) / risk;
        trades.push({ openMs: c[i]!.closeTime, r: r - FEE * feeUnit, gross: r, feeUnit, regime: regimeAt(i), symbol: sym, source: sg.source, long: sg.long });
      }
    }
  }
  trades.sort((a, b) => a.openMs - b.openMs);
  const span = trades.length ? trades[trades.length - 1]!.openMs - trades[0]!.openMs : 0;
  return { trades, span, candles: n, feeSkipped };
}

// ---- stats helpers ----
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const expc = (t: Trade[]) => (t.length ? sum(t.map((x) => x.r)) / t.length : NaN);
const grossc = (t: Trade[]) => (t.length ? sum(t.map((x) => x.gross)) / t.length : NaN);
const winc = (t: Trade[]) => (t.length ? (100 * t.filter((x) => x.r > 0).length) / t.length : 0);
const f3 = (e: number) => (Number.isFinite(e) ? `${e >= 0 ? "+" : ""}${e.toFixed(3)}R` : "  —  ");
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** Compounded fixed-fractional equity sim (sequential by open time; ignores concurrency — an approximation). */
function equity(trades: Trade[], riskPct: number, start: number): { end: number; maxDDpct: number; cagr: number; spanDays: number } {
  let bal = start, peak = start, maxDD = 0;
  for (const t of trades) { bal += t.r * (bal * riskPct / 100); if (bal > peak) peak = bal; const dd = (peak - bal) / peak * 100; if (dd > maxDD) maxDD = dd; if (bal <= 0) { bal = 0; break; } }
  const spanDays = trades.length ? (trades[trades.length - 1]!.openMs - trades[0]!.openMs) / 86_400_000 : 0;
  const cagr = spanDays > 0 && bal > 0 ? (Math.pow(bal / start, 365 / spanDays) - 1) * 100 : NaN;
  return { end: bal, maxDDpct: maxDD, cagr, spanDays };
}

function bookRow(label: string, t: Trade[]) {
  const g = grossc(t), e = expc(t);
  console.log(`  ${label.padEnd(34)} n=${pad(t.length, 5)}  gross ${f3(g)}  fee ${(g - e).toFixed(3)}R  NET ${f3(e)}  win ${winc(t).toFixed(0)}%  totalR ${sum(t.map((x) => x.r)).toFixed(1)}`);
}

/** Full per-book breakdown for ONE timeframe (sections 1–10). Writes summary fields into `out`. */
function detailedReport(tf: string, trades: Trade[], span: number, candles: number, feeSkipped: number, out: Record<string, unknown>): void {
  const days = Math.round(span / 86_400_000);
  const t0 = trades[0]!.openMs;
  const foldOf = (ms: number) => Math.min(FOLDS - 1, Math.floor(((ms - t0) / (span || 1)) * FOLDS));
  const all = trades;
  // "FILTERED" book = trades whose regime is in config.market.allowedRegimes (what the `filtered` account opens).
  const gated = trades.filter((t) => config.market.allowedRegimes.includes(t.regime));

  console.log(`\n${"═".repeat(78)}`);
  console.log(`SPAN @ ${tf}: ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(trades[trades.length - 1]!.openMs).toISOString().slice(0, 10)}  (${days}d, ${candles} candles/symbol)  ·  ${trades.length} trades`);
  console.log(`CONFIG: bollinger=${config.strategies.bollinger ? "on" : "OFF"}  feeFilter=${FEEFILTER ? `ON (>${(config.plan.maxFeeThresholdPct * 100).toFixed(0)}% of 1R → skipped ${feeSkipped})` : "off"}  regimeMode=${config.strategies.regimeMode}`);
  console.log(`${"═".repeat(78)}`);

  console.log(`\n▐ 1. HEADLINE — expectancy per book (avg R/trade, net of fees)`);
  bookRow("STRATEGY (unfiltered, all regimes)", all);
  bookRow(`FILTERED (allowedRegimes: ${config.market.allowedRegimes.join("/")})`, gated);

  console.log(`\n▐ 2. COMPOUNDED ACCOUNT — $${config.paper.startBalanceUsd} start, ${config.paper.riskPct}% risk/trade, sequential (approx.)`);
  for (const [lbl, t] of [["STRATEGY", all], ["FILTERED", gated]] as [string, Trade[]][]) {
    const eq = equity(t, config.paper.riskPct, config.paper.startBalanceUsd);
    console.log(`  ${lbl.padEnd(10)} end $${eq.end.toFixed(0).padStart(8)}  (${eq.end >= config.paper.startBalanceUsd ? "+" : ""}${((eq.end / config.paper.startBalanceUsd - 1) * 100).toFixed(0)}%)  CAGR ${Number.isFinite(eq.cagr) ? eq.cagr.toFixed(0) + "%" : "—"}  maxDD ${eq.maxDDpct.toFixed(0)}%`);
    out[`equity_${lbl.toLowerCase()}`] = eq;
  }

  console.log(`\n▐ 3. PER-SYMBOL (unfiltered book)`);
  for (const s of SYMBOLS) { const t = all.filter((x) => x.symbol === s); if (t.length) bookRow(s, t); }

  console.log(`\n▐ 4. LONG vs SHORT (unfiltered book)`);
  bookRow("LONG", all.filter((t) => t.long));
  bookRow("SHORT", all.filter((t) => !t.long));

  console.log(`\n▐ 5. PER-STRATEGY / SIGNAL SOURCE (unfiltered book)`);
  for (const src of [...new Set(all.map((t) => t.source))].sort()) bookRow(src, all.filter((x) => x.source === src));

  console.log(`\n▐ 6. PER-REGIME (unfiltered book — where does the edge live?)`);
  for (const rg of ["bull", "flat", "bear"] as const) { const t = all.filter((x) => x.regime === rg); if (t.length) bookRow(rg.toUpperCase(), t); }

  console.log(`\n▐ 7. TIME FOLDS (${FOLDS} chronological, ~${Math.round(days / FOLDS)}d each) — is the edge STABLE across time?`);
  const foldStat = (t: Trade[]) => { const f: Trade[][] = Array.from({ length: FOLDS }, () => []); for (const x of t) f[foldOf(x.openMs)]!.push(x); return f.map(expc); };
  const drawFolds = (label: string, cells: number[]) => {
    const finite = cells.filter(Number.isFinite);
    console.log(`  ${label.padEnd(10)} ${cells.map((c) => (Number.isFinite(c) ? (c >= 0 ? "+" : "") + c.toFixed(2) : "  —").padStart(7)).join("")}   pos ${finite.filter((c) => c > 0).length}/${finite.length}`);
  };
  console.log(`  ${" ".repeat(10)} ${Array.from({ length: FOLDS }, (_, i) => `f${i + 1}`.padStart(7)).join("")}`);
  drawFolds("STRATEGY", foldStat(all));
  drawFolds("FILTERED", foldStat(gated));

  console.log(`\n▐ 8. OUT-OF-SAMPLE (70/30 by time) — does it hold on unseen data?`);
  const sorted = [...all].sort((a, b) => a.openMs - b.openMs);
  const cut = Math.floor(sorted.length * 0.7);
  console.log(`  STRATEGY  train ${f3(expc(sorted.slice(0, cut)))} (n=${cut})   test·held-out ${f3(expc(sorted.slice(cut)))} (n=${sorted.length - cut})`);
  const gS = [...gated].sort((a, b) => a.openMs - b.openMs); const gc = Math.floor(gS.length * 0.7);
  console.log(`  FILTERED  train ${f3(expc(gS.slice(0, gc)))} (n=${gc})   test·held-out ${f3(expc(gS.slice(gc)))} (n=${gS.length - gc})`);

  console.log(`\n▐ 9. FEE SWEEP (net R/trade at each taker tier)`);
  console.log(`  ${"book".padEnd(10)}${[5, 2, 0].map((b) => `${b}bps`.padStart(11)).join("")}`);
  for (const [lbl, t] of [["STRATEGY", all], ["FILTERED", gated]] as [string, Trade[]][]) {
    console.log(`  ${lbl.padEnd(10)}${[5, 2, 0].map((bps) => { const f = bps / 10000; return f3(t.length ? sum(t.map((x) => x.gross - f * x.feeUnit)) / t.length : NaN).padStart(11); }).join("")}`);
  }
  out.headline = { tf, strategyNet: expc(all), filteredNet: expc(gated), strategyWin: winc(all), filteredWin: winc(gated) };
  out.interval = tf;
  out.days = days;
}

/**
 * Rolling WALK-FORWARD on one timeframe: split history into sequential ~WFA_TEST-day test windows (each preceded by
 * a WFA_TRAIN-day train window) and report net R per test window + the pooled aggregate. NOTE: the strategies are
 * FIXED (never fitted on the train window), so every window is already out-of-sample — this measures whether net
 * expectancy is STABLE across shifting macro windows, which is the real question behind the single-split +0.032R.
 * Returns the pooled OOS expectancy + fold counts (also written to the JSON).
 */
function walkForwardReport(tf: string, trades: Trade[], out: Record<string, unknown>): void {
  console.log(`\n${"═".repeat(82)}`);
  console.log(`WALK-FORWARD @ ${tf} — train ${WFA_TRAIN}d / test ${WFA_TEST}d, rolling by ${WFA_TEST}d  ·  unfiltered book, net ${FEE * 1e4}bps`);
  console.log(`NOTE: strategies are FIXED (not fitted on train) → every window is already OOS; this tests STABILITY of net R across rolling test windows.`);
  console.log(`${"═".repeat(82)}`);
  if (trades.length < 30) { console.log(`  too few trades (${trades.length}) to walk forward.`); return; }
  const day = 86_400_000;
  const t0 = trades[0]!.openMs, tN = trades[trades.length - 1]!.openMs;
  console.log(`  ${"fold".padEnd(6)}${"test window".padEnd(25)}${"n".padStart(6)}${"win%".padStart(7)}${"netR".padStart(11)}`);
  const pool: Trade[] = [];
  let k = 0, posFolds = 0, totalFolds = 0;
  for (let testStart = t0 + WFA_TRAIN * day; testStart < tN; testStart += WFA_TEST * day, k++) {
    const testEnd = testStart + WFA_TEST * day;
    const seg = trades.filter((t) => t.openMs >= testStart && t.openMs < testEnd);
    if (!seg.length) continue;
    totalFolds++;
    const e = expc(seg);
    if (e > 0) posFolds++;
    pool.push(...seg);
    const label = `${new Date(testStart).toISOString().slice(0, 10)}→${new Date(testEnd).toISOString().slice(0, 10)}`;
    console.log(`  ${("f" + (k + 1)).padEnd(6)}${label.padEnd(25)}${String(seg.length).padStart(6)}${winc(seg).toFixed(0).padStart(7)}${f3(e).padStart(11)}`);
  }
  const pooled = expc(pool);
  console.log(`  ${"─".repeat(55)}`);
  console.log(`  AGGREGATE OOS (pooled test trades): net ${f3(pooled)}  win ${winc(pool).toFixed(0)}%  n=${pool.length}  ·  positive folds ${posFolds}/${totalFolds}`);
  const verdict = pooled > 0.02 && posFolds >= Math.ceil(totalFolds * 0.6)
    ? "SURVIVES walk-forward — net edge is stable across rolling windows. Strongest evidence yet; forward-paper to confirm before sizing."
    : pooled > 0
      ? "MARGINAL — pooled OOS positive but fold stability weak (< ~60% of folds). Real-ish but fragile; do NOT size up on this."
      : "FAILS walk-forward — the single-split +0.032R does NOT generalise across shifting windows. Not a validated edge.";
  console.log(`  → ${verdict}`);
  out.walkForward = { tf, trainDays: WFA_TRAIN, testDays: WFA_TEST, pooledNetR: pooled, poolWinPct: winc(pool), poolN: pool.length, posFolds, totalFolds };
}

async function main() {
  console.log(`DEEP BACKTEST SWEEP — ${SYMBOLS.join("/")} @ [${TIMEFRAMES.join(", ")}]  ~${DAYS}d  NET of ${FEE * 1e4}bps/side\n`);
  const swept: { tf: string; res: Awaited<ReturnType<typeof buildTrades>> }[] = [];
  for (const tf of TIMEFRAMES) {
    console.log(`▶ fetching + replaying ${tf} …`);
    swept.push({ tf, res: await buildTrades(tf) });
  }

  // ---- SIDE-BY-SIDE SWEEP TABLE (the multi-TF validation view) ----
  const widths = [7, 6, 8, 10, 6, 10, 10, 12, 14];
  const head = ["TF", "Days", "Trades", "feeSkip", "Win%", "GrossR", "NetR", "Train70%", "Test·OOS30%"];
  console.log(`\n${"═".repeat(90)}`);
  console.log(`MULTI-TIMEFRAME SWEEP  ·  unfiltered book  ·  net ${FEE * 1e4}bps/side  ·  bollinger=${config.strategies.bollinger ? "on" : "OFF"} feeFilter=${FEEFILTER ? "ON" : "off"}`);
  console.log(`${"═".repeat(90)}`);
  console.log(head.map((h, i) => h.padStart(widths[i]!)).join(""));
  const summary: Record<string, unknown>[] = [];
  for (const { tf, res } of swept) {
    const all = res.trades;
    const sorted = [...all].sort((a, b) => a.openMs - b.openMs);
    const cut = Math.floor(sorted.length * 0.7);
    const g = grossc(all), net = expc(all), train = expc(sorted.slice(0, cut)), test = expc(sorted.slice(cut));
    const cells = [tf, String(Math.round(res.span / 86_400_000)), String(all.length), String(res.feeSkipped), all.length ? winc(all).toFixed(0) : "—", f3(g), f3(net), f3(train), f3(test)];
    console.log(cells.map((v, i) => v.padStart(widths[i]!)).join(""));
    summary.push({ tf, days: Math.round(res.span / 86_400_000), trades: all.length, feeSkipped: res.feeSkipped, winPct: winc(all), grossR: g, netR: net, trainR: train, testR: test });
  }
  console.log(`\nRead: NetR>0 AND Test·OOS>0 = candidate edge worth forward-testing. NetR>0 but Test<0 = in-sample overfit (the recurring pattern — higher TF has repeatedly looked good in-sample and failed OOS).`);

  // ---- DETAILED per-book breakdown for the PRIMARY timeframe ----
  const primaryTf = TIMEFRAMES.includes(config.interval) ? config.interval : TIMEFRAMES[0]!;
  const primary = swept.find((s) => s.tf === primaryTf);
  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, timeframes: TIMEFRAMES, sweep: summary };
  if (primary && primary.res.trades.length >= 50) {
    console.log(`\n\n${"█".repeat(26)}  DETAILED BREAKDOWN @ ${primaryTf}  ${"█".repeat(26)}`);
    detailedReport(primaryTf, primary.res.trades, primary.res.span, primary.res.candles, primary.res.feeSkipped, out);
  }

  // WALK-FORWARD (DEEP_WFA=<tf>) — the rolling-window validation of the candidate 4h edge.
  if (WFA) {
    const wfaTf = WFA === "on" || WFA === "1" || WFA === "true" ? "4h" : WFA;
    const cached = swept.find((s) => s.tf === wfaTf);
    const trades = cached ? cached.res.trades : (await buildTrades(wfaTf)).trades;
    walkForwardReport(wfaTf, trades, out);
  }

  await mkdir(dirname("data/deepbacktest.json"), { recursive: true });
  await writeFile("data/deepbacktest.json", JSON.stringify(out, null, 2), "utf8");
  console.log(`\nSaved → data/deepbacktest.json`);
}

main().catch((e) => { console.error(`deepbacktest failed: ${(e as Error).stack ?? e}`); process.exit(1); });
