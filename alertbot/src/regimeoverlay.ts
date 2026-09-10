import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, simulateWindow, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run regimeoverlay` — would a BROAD-MARKET regime filter lift the account?
 *
 * `npm run regimealpha` proved the bot is a short-biased trend-follower: it earns in bear markets but
 * BLEEDS in bull (−9.8%) and flat (−9.7%) windows. The obvious fix is to stop (or align) trading when the
 * broad market isn't falling. This tests that HONESTLY — the regime is detected CAUSALLY from trailing
 * basket data only (no lookahead): an equal-weight SOL/BTC/ETH price index, classified bull/bear/flat by
 * its trailing REGIME_L-bar return. Then one shared compounding account is replayed over the full history
 * under each overlay and compared on return / drawdown / risk-adjusted return:
 *   • baseline       — take every signal (today's bot)
 *   • bear-only      — only OPEN trades when the market is in a (trailing) downtrend
 *   • skip-bull      — trade in bear+flat, stand aside only in up-markets
 *   • trend-aligned  — only LONG in bull, only SHORT in bear, nothing in flat (trade WITH the trend)
 * Open positions always ride to their own stop/target; the overlay only gates NEW entries.
 *
 * CAVEATS: the lookback/band are picked (mild in-sample tuning); the signal lags regime turns (realistic);
 * one 311-day path. Directional evidence for whether to build a live regime knob — not proof.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const REGIME_L = 168;      // trailing bars for the market-regime signal (~7 days)
const BAND = 0.03;         // |trailing basket return| below this = "flat"
const BARS_PER_YEAR = 24 * 365;

type Regime = "bull" | "bear" | "flat";
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1));
}

/** Causal market regime at each bar from a basket price index: classify its trailing L-bar return. */
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
  console.log(`REGIME OVERLAY — does a causal broad-market filter lift the account? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < REGIME_L + WARMUP + 200) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;
  const spanDays = (bySym[SYMBOLS[0]!]![n - 1]!.closeTime - bySym[SYMBOLS[0]!]![0]!.openTime) / 8.64e7;
  console.log(`Fetched ${n} aligned candles ≈ ${spanDays.toFixed(0)} days (${day(bySym[SYMBOLS[0]!]![0]!.openTime)} → ${day(bySym[SYMBOLS[0]!]![n - 1]!.openTime)}).`);

  // ---- Causal broad-market regime from a trailing basket index (uses only data up to bar i) ----
  const idx: number[] = [1];
  for (let i = 1; i < n; i++) {
    let r = 0;
    for (const s of SYMBOLS) { const c = bySym[s]!; r += c[i]!.close / c[i - 1]!.close - 1; }
    idx[i] = idx[i - 1]! * (1 + r / SYMBOLS.length);
  }
  const regimeAt = regimeSeries(idx, REGIME_L, BAND);
  const dist = (r: Regime) => regimeAt.slice(WARMUP).filter((x) => x === r).length;
  const tradeable = n - WARMUP;
  console.log(`Market regime (causal, trailing ${REGIME_L}-bar basket return, band ±${(BAND * 100).toFixed(0)}%): ` +
    `bull ${((dist("bull") / tradeable) * 100).toFixed(0)}% · bear ${((dist("bear") / tradeable) * 100).toFixed(0)}% · flat ${((dist("flat") / tradeable) * 100).toFixed(0)}% of bars.\n`);

  const sigAt = Object.fromEntries(SYMBOLS.map((s) => [s, precomputeSignals(s, bySym[s]!)]));

  // ---- Overlays ----
  const overlays: { name: string; allow?: (i: number, long: boolean, source: string) => boolean }[] = [
    { name: "baseline (all)" },
    { name: "bear-only", allow: (i) => regimeAt[i] === "bear" },
    { name: "skip-bull", allow: (i) => regimeAt[i] !== "bull" },
    { name: "trend-aligned", allow: (i, long) => (long ? regimeAt[i] === "bull" : regimeAt[i] === "bear") },
    // Regime-aware combo (from npm run longedge): support-confirmation LONGS in bull/flat (+EV there),
    // trend SHORTS in bear. Two bear treatments — shorts-only, or take-all in the downtrend.
    { name: "combo(sup-long/bear-short)", allow: (i, long, src) => (regimeAt[i] === "bear" ? !long : long && src === "support") },
    { name: "combo(sup-long/bear-all)", allow: (i, long, src) => (regimeAt[i] === "bear" ? true : long && src === "support") },
  ];

  const start: number = config.paper.startBalanceUsd;
  const results = overlays.map((o) => {
    const sim = simulateWindow(bySym, sigAt, SYMBOLS, WARMUP, n - 1, start, o.allow);
    const ret = sim.equityStart > 0 ? sim.equityEnd / sim.equityStart - 1 : 0;
    const sd = std(sim.rBot);
    const sharpe = sd > 0 ? (mean(sim.rBot) / sd) * Math.sqrt(BARS_PER_YEAR) : 0;
    return { name: o.name, trades: sim.trades, ret, maxDD: sim.maxDD, calmar: sim.maxDD > 0 ? (ret * 100) / sim.maxDD : ret > 0 ? Infinity : 0, sharpe, endBal: sim.equityEnd };
  });

  console.log("  overlay                     trades  return    maxDD    ret/DD   Sharpe   endBal");
  for (const r of results) {
    console.log(
      `  ${r.name.padEnd(26)} ${String(r.trades).padStart(5)}  ${pct(r.ret).padStart(7)}  ${(r.maxDD.toFixed(1) + "%").padStart(6)}  ` +
        `${(r.calmar === Infinity ? "inf" : r.calmar.toFixed(2)).padStart(6)}  ${r.sharpe.toFixed(2).padStart(6)}   $${r.endBal.toFixed(0)}`,
    );
  }

  const baseline = results[0]!;
  const bestByCalmar = [...results].sort((a, b) => b.calmar - a.calmar)[0]!;
  const bestBySharpe = [...results].sort((a, b) => b.sharpe - a.sharpe)[0]!;
  const overlayWins = bestByCalmar.name !== "baseline (all)" && bestByCalmar.calmar > baseline.calmar && bestByCalmar.ret > 0;

  console.log(
    `\nVERDICT: ${overlayWins
      ? `The "${bestByCalmar.name}" overlay BEATS baseline on risk-adjusted return (ret/DD ${bestByCalmar.calmar.toFixed(2)} vs ${baseline.calmar.toFixed(2)}, ` +
        `return ${pct(bestByCalmar.ret)} vs ${pct(baseline.ret)}, maxDD ${bestByCalmar.maxDD.toFixed(1)}% vs ${baseline.maxDD.toFixed(1)}%). ` +
        `Worth building as an opt-in live knob (like regimeGate) — then validate forward.`
      : `No overlay clearly beats baseline on this path (best ret/DD "${bestByCalmar.name}" ${bestByCalmar.calmar.toFixed(2)} vs baseline ${baseline.calmar.toFixed(2)}). ` +
        `Filtering out bull/flat entries also removes compounding + the occasional counter-trend winner, roughly a wash here — keep it measured, don't wire it in.`}`,
  );
  console.log(`(Best by Sharpe: "${bestBySharpe.name}" ${bestBySharpe.sharpe.toFixed(2)}.)`);

  // Does the regime-aware combo (support-longs in bull/flat + shorts in bear) beat plain bear-only?
  const bearOnly = results.find((r) => r.name === "bear-only")!;
  const combos = results.filter((r) => r.name.startsWith("combo"));
  const bestCombo = [...combos].sort((a, b) => b.calmar - a.calmar)[0];
  if (bestCombo) {
    console.log(
      `\nCOMBO vs BEAR-ONLY: best combo "${bestCombo.name}" → return ${pct(bestCombo.ret)}, ret/DD ${bestCombo.calmar.toFixed(2)}, Sharpe ${bestCombo.sharpe.toFixed(2)}  ` +
        `vs bear-only ${pct(bearOnly.ret)}, ret/DD ${bearOnly.calmar.toFixed(2)}, Sharpe ${bearOnly.sharpe.toFixed(2)} → ` +
        `${bestCombo.calmar > bearOnly.calmar ? "COMBO WINS — adding selective support-longs beats short-only (regime-aware long+short is the better config)." : "BEAR-ONLY still best — selective support-longs don't lift the whole account here (per-signal +EV ≠ portfolio win; keep short-only)."}`,
    );
  }
  console.log(
    `\n⚠ CAVEATS: causal regime signal but the lookback (${REGIME_L}b) + band (±${(BAND * 100).toFixed(0)}%) are picked on this same data (mild overfit); ` +
      `the filter lags regime turns; one ${spanDays.toFixed(0)}-day path, in-sample. Directional evidence — forward/live is the real test.`,
  );

  // ---- Robustness across a GRID of (lookback, band): (a) bear-only vs baseline, (b) COMBO vs bear-only.
  //      Overfit-check BOTH the filter and the combo's extra support-longs before any live change. ----
  const LS = [120, 168, 240, 336];       // ~5d, 7d, 10d, 14d
  const BANDS = [0.02, 0.03, 0.05];
  const baseCalmar = baseline.calmar;
  const runOverlay = (allow: (i: number, long: boolean, source: string) => boolean) => {
    const sim = simulateWindow(bySym, sigAt, SYMBOLS, WARMUP, n - 1, start, allow);
    const ret = sim.equityStart > 0 ? sim.equityEnd / sim.equityStart - 1 : 0;
    return { ret, calmar: sim.maxDD > 0 ? (ret * 100) / sim.maxDD : ret > 0 ? Infinity : 0 };
  };
  interface Cell { L: number; band: number; boCalmar: number; comboCalmar: number; boBeatsBase: boolean; comboBeatsBo: boolean }
  const grid: Cell[] = [];
  let boWins = 0, comboWins = 0;
  console.log(`\nROBUSTNESS — combo ret/DD across lookback × band (* = combo beats bear-only in that cell):`);
  console.log(`  lookback\\band ` + BANDS.map((b) => `±${(b * 100).toFixed(0)}%`.padStart(9)).join(""));
  for (const L of LS) {
    const row = BANDS.map((band) => {
      const reg = regimeSeries(idx, L, band);
      const bo = runOverlay((i) => reg[i] === "bear");
      const combo = runOverlay((i, long, src) => (reg[i] === "bear" ? !long : long && src === "support"));
      const boBeatsBase = bo.calmar > baseCalmar && bo.ret > 0; if (boBeatsBase) boWins++;
      const comboBeatsBo = combo.calmar > bo.calmar && combo.ret > 0; if (comboBeatsBo) comboWins++;
      grid.push({ L, band, boCalmar: bo.calmar, comboCalmar: combo.calmar, boBeatsBase, comboBeatsBo });
      return `${combo.calmar === Infinity ? "inf" : combo.calmar.toFixed(2)}${comboBeatsBo ? "*" : " "}`;
    });
    console.log(`  ${String(L).padStart(8)}     ` + row.map((c) => c.padStart(9)).join(""));
  }
  const total = LS.length * BANDS.length;
  console.log(`  bear-only beats baseline in ${boWins}/${total} cells; COMBO beats bear-only in ${comboWins}/${total} cells.`);
  const comboRobust = comboWins >= Math.ceil(total * 0.6);
  console.log(`ROBUSTNESS: ${comboRobust
    ? `the combo's edge over bear-only holds in ${comboWins}/${total} cells → reasonably robust, not a single-point artifact. Reasonable to productionize as a filter mode (still validate forward).`
    : `the combo beats bear-only in only ${comboWins}/${total} cells → the extra support-longs are param-sensitive; bear-only is the safer default. Don't productionize the combo on this alone.`}`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, spanDays, regimeL: REGIME_L, band: BAND,
    regimeDist: { bull: dist("bull") / tradeable, bear: dist("bear") / tradeable, flat: dist("flat") / tradeable }, results, overlayWins, robustness: { boWins, comboWins, total, comboRobust, grid } };
  await mkdir(dirname("data/regimeoverlay.json"), { recursive: true });
  await writeFile("data/regimeoverlay.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/regimeoverlay.json");
}

main().catch((e) => {
  console.error(`regimeoverlay failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
