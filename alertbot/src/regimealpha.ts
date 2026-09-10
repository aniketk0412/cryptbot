import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { WARMUP, alignByTime, fetchDeepHistory, precomputeSignals, simulateWindow, ols, mean } from "./alphacore.js";
import type { Candle } from "./types.js";

/**
 * `npm run regimealpha` — does the edge survive a BULL market, or only a bear one?
 *
 * `npm run alpha` measured ONE recent window and found the bot net-SHORT with a big residual — but that
 * window happened to be a downtrend, so it couldn't tell "trend-luck" (short a falling market) from
 * durable skill. This fetches DEEP history (many months) and slides the SAME alpha/beta analysis across
 * overlapping windows, classifying each by its OWN market return (bull / bear / flat) and reporting the
 * bot's return + residual-alpha in each bucket. The question it answers:
 *   • if the bot only profits in BEAR windows → it's a directional short (trend-follower), not skill;
 *   • if it profits in BULL windows too → the edge is real beyond the market call.
 *
 * Each window is an INDEPENDENT fresh-$1000 backtest with proper lookback (signals precomputed on the
 * full series). No lookahead. CAVEAT: overlapping windows share candles → the buckets are NOT independent
 * samples; still in-sample. Directional evidence, not proof.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;       // ~250 days of 1h candles (paged back from now)
const WIN = 1000;          // window length in bars (~42 days)
const STEP = 200;          // slide step (~8 days)
const BAND = 0.03;         // |market return| below this = "flat" window (avoid noise)

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Regime = "bull" | "bear" | "flat";
interface Win { start: string; end: string; mktRet: number; botRet: number; beta: number; tAlpha: number; residual: number; avgNet: number; trades: number; regime: Regime }

async function main() {
  console.log(`REGIME ALPHA — does the edge survive bull markets, or only bear? ${SYMBOLS.join("/")} @ ${config.interval}\n`);
  const raw: Record<string, Candle[]> = {};
  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < WIN + WARMUP + 50) { console.error(`failed to fetch enough history for ${s} (got ${c?.length ?? 0})`); process.exit(1); }
    raw[s] = c;
  }
  const bySym = alignByTime(raw, SYMBOLS);
  const n = bySym[SYMBOLS[0]!]!.length;
  const spanDays = (bySym[SYMBOLS[0]!]![n - 1]!.closeTime - bySym[SYMBOLS[0]!]![0]!.openTime) / 8.64e7;
  console.log(`Fetched ${n} aligned candles ≈ ${spanDays.toFixed(0)} days (${day(bySym[SYMBOLS[0]!]![0]!.openTime)} → ${day(bySym[SYMBOLS[0]!]![n - 1]!.openTime)}).`);
  console.log(`Sliding a ${WIN}-bar (~${(WIN / 24).toFixed(0)}d) window every ${STEP} bars; each = a fresh $${config.paper.startBalanceUsd} backtest.\n`);

  const sigAt = Object.fromEntries(SYMBOLS.map((s) => [s, precomputeSignals(s, bySym[s]!)]));

  const wins: Win[] = [];
  for (let a = WARMUP; a + WIN - 1 <= n - 1; a += STEP) {
    const b = a + WIN - 1;
    const sim = simulateWindow(bySym, sigAt, SYMBOLS, a, b);
    let mktRet = 1;
    for (const r of sim.rMkt) mktRet *= 1 + r;
    mktRet -= 1;
    const botRet = sim.equityStart > 0 ? sim.equityEnd / sim.equityStart - 1 : 0;
    const reg = ols(sim.rBot, sim.rMkt);
    const regime: Regime = mktRet > BAND ? "bull" : mktRet < -BAND ? "bear" : "flat";
    wins.push({
      start: day(bySym[SYMBOLS[0]!]![a]!.openTime), end: day(bySym[SYMBOLS[0]!]![b]!.openTime),
      mktRet, botRet, beta: reg.beta, tAlpha: reg.tAlpha, residual: botRet - reg.beta * mktRet,
      avgNet: mean(sim.netExp), trades: sim.trades, regime,
    });
  }

  // ---- Per-window table ----
  console.log("  window (start→end)     regime   market    bot     β      resid(α)  netExp  trades");
  for (const w of wins) {
    console.log(
      `  ${w.start}→${w.end}  ${w.regime.padEnd(6)} ${pct(w.mktRet).padStart(7)}  ${pct(w.botRet).padStart(7)}  ` +
        `${w.beta.toFixed(2).padStart(5)}  ${pct(w.residual).padStart(7)}  ${w.avgNet.toFixed(2).padStart(5)}×  ${String(w.trades).padStart(4)}`,
    );
  }

  // ---- Buckets ----
  const bucket = (r: Regime) => wins.filter((w) => w.regime === r);
  const summarize = (r: Regime) => {
    const ws = bucket(r);
    if (!ws.length) return null;
    return {
      regime: r, n: ws.length,
      avgMkt: mean(ws.map((w) => w.mktRet)), avgBot: mean(ws.map((w) => w.botRet)),
      avgResid: mean(ws.map((w) => w.residual)), pctBotProfit: ws.filter((w) => w.botRet > 0).length / ws.length,
      pctResidPos: ws.filter((w) => w.residual > 0).length / ws.length, avgBeta: mean(ws.map((w) => w.beta)),
      avgNet: mean(ws.map((w) => w.avgNet)),
    };
  };
  const buckets = (["bull", "bear", "flat"] as Regime[]).map(summarize).filter(Boolean) as NonNullable<ReturnType<typeof summarize>>[];

  console.log(`\nBY REGIME (windows bucketed by their own market move; bull/bear = |market| > ${(BAND * 100).toFixed(0)}%):`);
  console.log("  regime  windows  avgMarket  avgBot   avgResid(α)  bot>0    resid>0   avgβ    avgNet");
  for (const s of buckets) {
    console.log(
      `  ${s.regime.padEnd(6)}  ${String(s.n).padStart(6)}  ${pct(s.avgMkt).padStart(8)}  ${pct(s.avgBot).padStart(7)}  ` +
        `${pct(s.avgResid).padStart(9)}  ${((s.pctBotProfit * 100).toFixed(0) + "%").padStart(5)}  ${((s.pctResidPos * 100).toFixed(0) + "%").padStart(6)}  ` +
        `${s.avgBeta.toFixed(2).padStart(5)}  ${s.avgNet.toFixed(2).padStart(5)}×`,
    );
  }

  // ---- Window-level relationship: does bot return depend on market direction? ----
  const cross = ols(wins.map((w) => w.botRet), wins.map((w) => w.mktRet));

  // ---- Verdict ----
  const bull = buckets.find((s) => s.regime === "bull");
  const bear = buckets.find((s) => s.regime === "bear");
  console.log(`\nWindow-level: bot return vs market return across ${wins.length} windows → slope ${cross.beta.toFixed(2)}, corr ${cross.corr.toFixed(2)}.`);
  let verdict: string;
  if (!bull || !bear) {
    verdict = `History covered mostly ${bull ? "bull" : bear ? "bear" : "flat"} conditions — need a wider span to compare regimes. Re-run when more history is available.`;
  } else {
    const survivesBull = bull.avgBot > 0 && bull.pctBotProfit >= 0.5;
    const bullResidPos = bull.avgResid > 0;
    verdict = survivesBull && bullResidPos
      ? `EDGE SURVIVES UP-MARKETS: in bull windows the bot still averaged ${pct(bull.avgBot)} (resid ${pct(bull.avgResid)}, profitable ${(bull.pctBotProfit * 100).toFixed(0)}% of the time). ` +
        `That's evidence of a real edge beyond a directional short — not just trend-luck.`
      : bull.avgBot <= 0
        ? `LIKELY A DIRECTIONAL SHORT: in bull windows the bot averaged ${pct(bull.avgBot)} (loses when crypto rises), vs ${pct(bear.avgBot)} in bear windows. ` +
          `The +29% headline is largely "short a falling market," which won't repeat in a rally. Trend-following, regime-dependent — not market-neutral skill.`
        : `MIXED: the bot stays positive in bull windows (${pct(bull.avgBot)}) but the residual alpha there is ${pct(bull.avgResid)} — weaker than in bear windows (${pct(bear.avgResid)}). ` +
          `There's some regime-independent edge, but a meaningful part of the return still depends on catching down-moves.`;
  }
  console.log(`\nVERDICT: ${verdict}`);
  console.log(
    `\n⚠ CAVEATS: overlapping windows share candles (buckets are NOT independent samples); all in-sample; ` +
      `~${spanDays.toFixed(0)} days may still under-sample regimes. Directional evidence — LIVE / longer out-of-sample tracking is the real test.`,
  );

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, spanDays, windows: wins, buckets, crossSectional: cross, verdict };
  await mkdir(dirname("data/regimealpha.json"), { recursive: true });
  await writeFile("data/regimealpha.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/regimealpha.json");
}

main().catch((e) => {
  console.error(`regimealpha failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
