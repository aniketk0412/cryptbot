import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getKlines } from "./binance.js";
import { config } from "./config.js";
import { WARMUP, precomputeSignals, simulateWindow, ols, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run alpha` — is the bot's return ALPHA (skill) or BETA (it was net-long while crypto rallied)?
 *
 * Prompted by the classic quant critique ("remove market beta exposure / is this alpha?"): a bot that
 * just holds a net-long book will make money in a bull window without any skill. This decomposes the
 * portfolio backtest's return into the part explained by MARKET EXPOSURE (beta × the crypto market) and
 * the RESIDUAL (alpha). It replays the SAME lockstep portfolio sim as `npm run portfolio` (cap off, so
 * the total return reconciles to that tool), records a per-candle MARK-TO-MARKET equity + net exposure,
 * then runs a plain-OLS regression of the bot's per-bar returns against an equal-weight SOL/BTC/ETH
 * basket:  bot_ret = alpha + beta·market_ret + ε  (Jensen's alpha, rf≈0).
 *
 * HONESTY GUARDS (tiny in-sample window — built to NOT overclaim): reports full-sample beta (diluted by
 * flat bars) AND active-bar beta; runs self-check CONTROLS with known answers (basket-on-basket → β≈1,
 * all-cash → β≈0, 2×→β≈2) and prints PASS/FAIL; prints a MANDATORY small-sample caveat. See the
 * many-window robustness view in `npm run regimealpha`. No lookahead. Standard math only.
 */

const SYMBOLS = config.watchlist;
const HISTORY = 1500;
const BARS_PER_YEAR = 24 * 365; // 1h bars

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const sig = (t: number) => (Math.abs(t) >= 2.58 ? "**" : Math.abs(t) >= 1.96 ? "*" : "");

async function main() {
  console.log(`ALPHA vs BETA — is the edge SKILL or riding the market? ${SYMBOLS.join("/")} @ ${config.interval}, ${HISTORY} candles\n`);
  const bySym: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await getKlines(HISTORY, config.interval, s);
    if (c) bySym[s] = c.filter((x) => x.closed);
  }
  if (SYMBOLS.some((s) => !bySym[s])) { console.error("failed to fetch history for some symbols"); process.exit(1); }

  const sigAt = Object.fromEntries(SYMBOLS.map((s) => [s, precomputeSignals(s, bySym[s]!)]));
  const n = Math.min(...SYMBOLS.map((s) => bySym[s]!.length));
  const sim = simulateWindow(bySym, sigAt, SYMBOLS, WARMUP, n - 1);
  const botTotalRet = sim.equityStart > 0 ? sim.equityEnd / sim.equityStart - 1 : 0;

  // Market benchmarks over the SAME bar window (returns run from bar WARMUP; buy-hold anchored at WARMUP-1).
  const base = WARMUP - 1;
  const buyHold: Record<string, number> = {};
  for (const s of SYMBOLS) buyHold[s] = bySym[s]![n - 1]!.close / bySym[s]![base]!.close - 1;
  const basketBuyHold = mean(SYMBOLS.map((s) => buyHold[s]!)); // 1/3 each, no rebalance
  let basketRebal = 1;
  for (const r of sim.rMkt) basketRebal *= 1 + r;
  basketRebal -= 1;
  const windowHours = (bySym[SYMBOLS[0]!]![n - 1]!.closeTime - bySym[SYMBOLS[0]!]![base]!.closeTime) / 3.6e6;
  const windowDays = windowHours / 24;

  // ---- Regressions vs the equal-weight basket ----
  const full = ols(sim.rBot, sim.rMkt);
  const activeIdx = sim.active.map((a, i) => (a ? i : -1)).filter((i) => i >= 0);
  const act = ols(activeIdx.map((i) => sim.rBot[i]!), activeIdx.map((i) => sim.rMkt[i]!));
  const btc = bySym["BTCUSDT"];
  const btcRet = btc ? btc.map((c, i) => (i > base ? c.close / btc[i - 1]!.close - 1 : 0)).slice(WARMUP) : [];
  const vsBtc = btcRet.length === sim.rBot.length ? ols(sim.rBot, btcRet) : null;

  // ---- Return decomposition:  bot ≈ beta·market + residual(alpha) ----
  const betaImplied = full.beta * basketRebal;
  const alphaResidual = botTotalRet - betaImplied;
  const alphaAnnNaive = Math.pow(1 + full.alpha, BARS_PER_YEAR) - 1;

  // ---- Exposure profile ----
  const longBars = sim.netExp.filter((e) => e > 1e-9).length;
  const shortBars = sim.netExp.filter((e) => e < -1e-9).length;
  const flatBars = sim.bars - longBars - shortBars;
  const avgNet = mean(sim.netExp);
  const avgNetActive = activeIdx.length ? mean(activeIdx.map((i) => sim.netExp[i]!)) : 0;
  const avgGross = mean(sim.grossExp);

  // ---- Self-check CONTROLS (known answers) — prove the OLS isn't lying ----
  const cBasket = ols(sim.rMkt, sim.rMkt);
  const cCash = ols(sim.rMkt.map(() => 0), sim.rMkt);
  const c2x = ols(sim.rMkt.map((r) => 2 * r), sim.rMkt);
  const checks = [
    { name: "basket-on-basket → β≈1, α≈0, R²≈1", ok: Math.abs(cBasket.beta - 1) < 1e-9 && Math.abs(cBasket.alpha) < 1e-9 && Math.abs(cBasket.r2 - 1) < 1e-9 },
    { name: "all-cash → β≈0, α≈0", ok: Math.abs(cCash.beta) < 1e-12 && Math.abs(cCash.alpha) < 1e-12 },
    { name: "2×-basket → β≈2", ok: Math.abs(c2x.beta - 2) < 1e-9 },
    { name: "market variance > 0", ok: sim.rMkt.some((r) => r !== 0) },
    { name: "R²∈[0,1], corr∈[-1,1]", ok: full.r2 >= 0 && full.r2 <= 1 && Math.abs(full.corr) <= 1 + 1e-9 },
    { name: "bar counts aligned (bot=market=active-mask)", ok: sim.rBot.length === sim.rMkt.length && sim.active.length === sim.rBot.length },
  ];

  // ================= OUTPUT =================
  console.log(`Window: ${sim.bars} bars ≈ ${windowDays.toFixed(0)} days.  Sim trades: ${sim.trades}.  (Reconcile total return with 'npm run portfolio' cap-off row.)\n`);

  console.log("MARKET (what you'd get with zero skill, just holding):");
  console.log(`  buy & hold ⅓ each SOL/BTC/ETH : ${pct(basketBuyHold)}   (rebalanced-basket ${pct(basketRebal)})`);
  for (const s of SYMBOLS) console.log(`    ${s.padEnd(9)} buy&hold      : ${pct(buyHold[s]!)}`);

  console.log(`\nBOT (portfolio sim, mark-to-market):`);
  console.log(`  total return                  : ${pct(botTotalRet)}   maxDD ${sim.maxDD.toFixed(1)}%`);
  console.log(`  vs buy & hold basket          : ${pct(botTotalRet - basketBuyHold)}  (beat the market? ${botTotalRet > basketBuyHold ? "YES" : "NO"})`);

  console.log(`\nEXPOSURE (was it structurally long?):`);
  console.log(`  bars net-long / short / flat  : ${((longBars / sim.bars) * 100).toFixed(0)}% / ${((shortBars / sim.bars) * 100).toFixed(0)}% / ${((flatBars / sim.bars) * 100).toFixed(0)}%`);
  console.log(`  avg net exposure (net/equity) : ${avgNet.toFixed(3)}× overall, ${avgNetActive.toFixed(3)}× while in a trade`);
  console.log(`  avg gross exposure            : ${avgGross.toFixed(3)}×`);

  console.log(`\nREGRESSION  bot_ret = α + β·market_ret  (Jensen's alpha, rf=0, OLS):`);
  console.log(`  full sample (${full.n} bars)      : β=${full.beta.toFixed(3)} (t=${full.tBeta.toFixed(1)})  α=${(full.alpha * 1e4).toFixed(2)}bps/bar (t=${full.tAlpha.toFixed(2)}${sig(full.tAlpha)})  R²=${full.r2.toFixed(3)}  corr=${full.corr.toFixed(2)}`);
  console.log(`  active bars only (${act.n} bars)   : β=${act.beta.toFixed(3)} (t=${act.tBeta.toFixed(1)})  α=${(act.alpha * 1e4).toFixed(2)}bps/bar (t=${act.tAlpha.toFixed(2)}${sig(act.tAlpha)})  R²=${act.r2.toFixed(3)}`);
  if (vsBtc) console.log(`  vs BTC alone (full)           : β=${vsBtc.beta.toFixed(3)}  α=${(vsBtc.alpha * 1e4).toFixed(2)}bps/bar  R²=${vsBtc.r2.toFixed(3)}`);

  console.log(`\nDECOMPOSITION of the bot's ${pct(botTotalRet)}:`);
  console.log(`  market beta component (β·mkt) : ${pct(betaImplied)}   ← return you'd get just from exposure`);
  console.log(`  residual / ALPHA component    : ${pct(alphaResidual)}   ← the part not explained by the market`);
  console.log(`  per-bar α ${(full.alpha * 1e4).toFixed(2)}bps → naive-annualized ${pct(alphaAnnNaive)} (compounds a tiny noisy estimate — do NOT quote as a forecast)`);

  console.log(`\nSELF-CHECKS (controls with known answers):`);
  for (const c of checks) console.log(`  [${c.ok ? "PASS" : "FAIL"}] ${c.name}`);
  const allPass = checks.every((c) => c.ok);

  // ---- Verdict (DIRECTION-AWARE: the naive critique assumes hidden LONG beta; measure what's actually there.
  //      Statistical honesty first — a significant β proves exposure; α needs its own t-stat to claim SKILL.) ----
  const marketUp = basketRebal > 0;
  const netLong = avgNet > 0;
  const alphaSignificant = Math.abs(full.tAlpha) >= 1.96 && full.alpha > 0;
  const directional = marketUp === netLong; // book leaned WITH the market's move → the move was a tailwind
  let verdict: string;
  if (!allPass) {
    verdict = "A self-check FAILED — the OLS math is suspect; fix before trusting anything above.";
  } else {
    const l1 = `Bot ${pct(botTotalRet)} vs market ${pct(basketBuyHold)} (spread ${pct(botTotalRet - basketBuyHold)}). ` +
      `β=${full.beta.toFixed(2)} (t=${full.tBeta.toFixed(1)}), net-${netLong ? "long" : "short"} ${avgNet.toFixed(2)}× → ` +
      `${netLong && marketUp ? "this return is partly LONG-BETA (riding crypto up)" : "this is NOT long-beta (the naive critique doesn't apply)"}.`;
    const l2 = directional
      ? `Most P&L = being ${netLong ? "long a rising" : "short a falling"} market — a DIRECTIONAL trend bet. ` +
        (alphaSignificant
          ? `Residual α is significant (t=${full.tAlpha.toFixed(2)}) → real skill on TOP of the directional bet.`
          : `Residual α is NOT significant (t=${full.tAlpha.toFixed(2)}) → skill BEYOND the directional bet is UNPROVEN on this window.`)
      : `Return is largely residual, not explained by market direction. ` +
        (alphaSignificant
          ? `α is significant (t=${full.tAlpha.toFixed(2)}) → evidence of genuine market-neutral skill.`
          : `but α is NOT significant (t=${full.tAlpha.toFixed(2)}) → promising, not proven.`);
    const l3 = `Regime risk: a flip to a ${marketUp ? "falling" : "rising"} market would ${directional ? "remove this tailwind (the book leans the wrong way then)" : "test whether the edge truly holds"} — one window can't separate trend-luck from durable skill.`;
    verdict = `${l1}\n         ${l2}\n         ${l3}`;
  }
  console.log(`\nVERDICT: ${verdict}`);
  console.log(
    `\n⚠ SMALL-SAMPLE CAVEAT (mandatory): ${sim.trades} trades over ~${windowDays.toFixed(0)} days, ONE in-sample window. ` +
      `The α t-stat (${full.tAlpha.toFixed(2)}) is INDICATIVE, not proof — hourly returns autocorrelate (real significance is lower), ` +
      `and one favorable window (here the market ${marketUp ? "rose" : "fell"}, which suited this ${netLong ? "long" : "short"}-leaning book) can masquerade as skill. ` +
      `Only LIVE / out-of-sample tracking settles skill-vs-beta.`,
  );

  const out = {
    generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, bars: sim.bars, days: windowDays,
    trades: sim.trades, botTotalRet, basketBuyHold, basketRebal, buyHold, maxDD: sim.maxDD,
    exposure: { longPct: longBars / sim.bars, shortPct: shortBars / sim.bars, flatPct: flatBars / sim.bars, avgNet, avgNetActive, avgGross },
    regression: { full, active: act, vsBtc }, decomposition: { betaImplied, alphaResidual, alphaAnnNaive },
    selfChecks: checks, allPass, verdict,
  };
  await mkdir(dirname("data/alpha.json"), { recursive: true });
  await writeFile("data/alpha.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/alpha.json");
}

main().catch((e) => {
  console.error(`alpha failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
