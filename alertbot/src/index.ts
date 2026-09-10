import "./env.js";
import { dispatch } from "./alerts.js";
import { getKlines } from "./binance.js";
import { signalsAt } from "./alphacore.js";
import { getContext } from "./context.js";
import { config } from "./config.js";
import { evaluateAlerts, state, syncSymbol } from "./dashboardState.js";
import { mtfTrends } from "./mtf.js";
import { detectDivergences } from "./divergence.js";
import { fmtPrice, nowStr } from "./format.js";
import { evaluateOpen, logSignal } from "./journal.js";
import { liqSummary, startLiquidationFeed } from "./liquidations.js";
import { checkSweeps } from "./liquiditysweeps.js";
import { getLivePrice, startLivePriceFeed } from "./liveprice.js";
import { feedStatuses } from "./feeds.js";
import { findOrderBlocks } from "./orderblocks.js";
import { assessConfluence } from "./orderflow.js";
import { assessBet, factorsFromConfluence, loadEdge } from "./evidence.js";
import { applyStructureTps, buildConfirmPlan, buildPlan, planFrom } from "./plan.js";
import { checkCircuitBreaker, paperEvaluate, paperInit, paperLine, paperOpen, setMarketEfficiency, setMarketRegime, setSymbolVolSpike, type PaperPosition, type PaperTrade } from "./paper.js";
import { volSpikeBlocks } from "./paperexit.js";
import { atr } from "./indicators.js";
import { reconcileLiveShadow } from "./live.js";
import { computeMarketRegime } from "./marketregime.js";
import { detectRange, manualRange } from "./range.js";
import { checkFailedBreakout } from "./reversal.js";
import { volumeProfile } from "./volumeprofile.js";
import { detectRegime, regimeAllows, regimeClass } from "./regime.js";
import { startServer } from "./server.js";
import { checkSpoof } from "./spoof.js";
import { STRATEGIES } from "./strategies.js";
import { validateConfig } from "./validateConfig.js";
import {
  brokeDown,
  brokeUp,
  confirmsResistance,
  confirmsSupport,
  touchedResistance,
  touchedSupport,
} from "./signals.js";
import { sendTelegram, telegramEnabled } from "./telegram.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-symbol alert state (dedup / re-arm), kept across cycles. */
interface SymState {
  resArmed: boolean;
  supArmed: boolean;
  lastConfirmClose: number;
  seeded: boolean;
  lastDiv: string; // signature of last-reported divergences (dedup)
  lastStratClose: number; // last closed candle we ran strategies on
  lastReversalClose: number; // last closed candle we ran the failed-breakout check on
}
const symStates = new Map<string, SymState>();
function symState(sym: string): SymState {
  let s = symStates.get(sym);
  if (!s) {
    s = { resArmed: true, supArmed: true, lastConfirmClose: 0, seeded: false, lastDiv: "", lastStratClose: 0, lastReversalClose: 0 };
    symStates.set(sym, s);
  }
  return s;
}

/** Standing directional read: trend leads; in a range, position vs the levels. */
function computeBias(
  regime: string,
  price: number,
  range: { high: number; low: number },
): { dir: "LONG" | "SHORT" | "WAIT"; reason: string } {
  if (regime === "uptrend") return { dir: "LONG", reason: "uptrend — buy dips" };
  if (regime === "downtrend") return { dir: "SHORT", reason: "downtrend — sell rips" };
  const span = range.high - range.low;
  const pos = span > 0 ? (price - range.low) / span : 0.5;
  if (pos <= 0.34) return { dir: "LONG", reason: "near support" };
  if (pos >= 0.66) return { dir: "SHORT", reason: "near resistance" };
  return { dir: "WAIT", reason: "mid-range" };
}

/** Announce a paper position opening (terminal + Telegram). */
function announcePaperOpen(p: PaperPosition): void {
  const arrow = p.direction === "LONG" ? "🟢" : "🔴";
  console.log(
    `${nowStr()}  ${arrow} PAPER OPEN ${p.symbol} ${p.direction} @ ${fmtPrice(p.entry)}  ` +
      `stop ${fmtPrice(p.stop)}  tgt ${fmtPrice(p.target)}  size ${p.sizeUnits.toFixed(3)} ($${p.notionalUsd.toFixed(0)})  [${p.source}]`,
  );
  if (config.paper.announce) {
    void sendTelegram(
      `${arrow} <b>PAPER OPEN</b> ${p.symbol} ${p.direction}\n` +
        `@ ${fmtPrice(p.entry)} · stop ${fmtPrice(p.stop)} · target ${fmtPrice(p.target)}\n` +
        `size ${p.sizeUnits.toFixed(3)} ($${p.notionalUsd.toFixed(0)}) · risk $${p.riskUsd.toFixed(2)} · ${p.source}`,
    ).catch(() => {});
  }
}

/** Announce a paper position closing with its booked P&L (terminal + Telegram). */
function announcePaperClose(t: PaperTrade): void {
  const emo = t.pnlUsd >= 0 ? "✅" : "❌";
  const sg = t.pnlUsd >= 0 ? "+" : "";
  console.log(
    `${nowStr()}  ${emo} PAPER CLOSE ${t.symbol} ${t.direction} ${t.exitReason} @ ${fmtPrice(t.exit)}  ` +
      `P&L ${sg}$${t.pnlUsd.toFixed(2)} (${sg}${t.rMultiple.toFixed(2)}R)  bal $${t.balanceAfter.toFixed(2)}  [${t.source}]`,
  );
  if (config.paper.announce) {
    void sendTelegram(
      `${emo} <b>PAPER CLOSE</b> ${t.symbol} ${t.direction} — ${t.exitReason}\n` +
        `@ ${fmtPrice(t.exit)} · P&L ${sg}$${t.pnlUsd.toFixed(2)} (${sg}${t.rMultiple.toFixed(2)}R)\n` +
        `balance $${t.balanceAfter.toFixed(2)} · ${t.source}`,
    ).catch(() => {});
  }
}

/** Scan one symbol for the current cycle: detect range, fire alerts, sync dashboard. */
async function checkSymbol(symbol: string): Promise<void> {
  const candles = await getKlines(config.candleHistory, config.interval, symbol);
  if (!candles || candles.length === 0) {
    console.log(`${nowStr()}  ${symbol}  (no data — retrying)`);
    return;
  }
  const mtf = await mtfTrends(symbol, candles).catch(() => undefined);
  const st = symState(symbol);
  const forming = candles[candles.length - 1]!;
  const price = forming.close;
  const useManual = symbol === config.symbol && config.levelMode === "manual";
  const range = useManual ? manualRange(config.manualResistance, config.manualSupport) : detectRange(candles);
  const levelMode = useManual ? "manual" : "auto";

  const closed = candles.filter((c) => c.closed);
  const lastClosed = closed[closed.length - 1];
  // Market-context HUD read (funding/OI/L-S/flow) — DISCRETIONARY context + forward-log, NOT a trade signal. Cached ~45s.
  const context = await getContext(symbol, closed).catch(() => undefined);
  // Volatility-spike flag for the opt-in vol filter (paperOpen reads it): last closed candle's range vs trailing ATR.
  setSymbolVolSpike(symbol, !!lastClosed && volSpikeBlocks(true, lastClosed.high - lastClosed.low, atr(closed, config.paper.volFilter.atrLookback), config.paper.volFilter.spikeMult));
  if (!st.seeded) {
    // Seed BOTH dedup markers so a restart doesn't re-fire confirmations/setups
    // that were already active on the last-closed candle — only new closes alert.
    st.lastConfirmClose = lastClosed?.closeTime ?? 0;
    st.lastStratClose = lastClosed?.closeTime ?? 0;
    st.lastReversalClose = lastClosed?.closeTime ?? 0;
    st.seeded = true;
  }

  // Judge any open journal trades for this symbol against the latest candles.
  if (config.journal.enabled) await evaluateOpen(symbol, candles).catch(() => {});

  // Paper account: manage open positions, book P&L, announce any that closed.
  if (config.paper.enabled) {
    for (const t of await paperEvaluate(symbol, candles).catch(() => [])) announcePaperClose(t);
  }

  // Resolve the win/loss outcome of recent committed alerts so the feed shows how they played out.
  evaluateAlerts(symbol, candles);

  // Spoofing: watch for large walls that get pulled near price.
  const spoof = config.spoof.enabled ? await checkSpoof(symbol, price).catch(() => undefined) : undefined;

  // Divergence: RSI/CVD vs price. Notify once per new divergence set.
  const divs = config.divergence.enabled ? detectDivergences(candles) : [];
  const divLabels = divs.map((d) => `${d.indicator} ${d.type}`);
  const divSig = divLabels.join(",");
  if (divSig && divSig !== st.lastDiv) {
    console.log(`${nowStr()}  ${symbol}  DIVERGENCE  ${divs.map((d) => `${d.indicator} ${d.type} (${d.note})`).join("  ·  ")}`);
    await sendTelegram(`📉 <b>DIVERGENCE</b> ${symbol}\n${divs.map((d) => `${d.indicator} ${d.type} — ${d.note}`).join("\n")}`);
  }
  st.lastDiv = divSig;

  // ---- Strategy signals (run in ALL market conditions, once per closed candle) ----
  if (lastClosed && lastClosed.closeTime !== st.lastStratClose) {
    const ctx = { symbol, closed, price };
    // Regime-gating (opt-in): only run a strategy in the regime where it has a measured edge.
    const gateReg = config.strategies.regimeGate ? regimeClass(detectRegime(closed).regime) : null;
    for (const strat of STRATEGIES) {
      if (!strat.enabled()) continue;
      if (gateReg && !regimeAllows(strat.regimes, gateReg)) continue;
      const sig = strat.detect(ctx);
      if (!sig) continue;
      const plan = applyStructureTps(planFrom(sig.direction, sig.entry, sig.stop, sig.target), closed);
      if (plan.rr < 1) continue; // skip trades that don't even offer 1:1
      const stratLevel: "support" | "resistance" = sig.direction === "LONG" ? "support" : "resistance";
      // Score the setup with the same order-flow/structure confluence as confirmations.
      const confluence =
        lastClosed && config.orderflow.enabled
          ? await assessConfluence(stratLevel, lastClosed, sig.entry, candles, symbol)
          : undefined;
      // Flag when a strategy fights the range (e.g. LONG right under resistance).
      const span = range.high - range.low;
      const pos = span > 0 ? (sig.entry - range.low) / span : 0.5;
      const conflict =
        sig.direction === "LONG" && pos >= 0.66
          ? " ⚠ against range (near resistance)"
          : sig.direction === "SHORT" && pos <= 0.34
            ? " ⚠ against range (near support)"
            : "";
      const bet = assessBet({ source: sig.strategy, rr: plan.rr, factorsPresent: factorsFromConfluence(confluence?.factors ?? []) });
      await dispatch({
        symbol, kind: "strategy", direction: sig.direction, strategyName: sig.strategy,
        level: stratLevel, price, levelPrice: sig.entry, range, plan, confluence, bet, signalCloseTime: sig.signalCloseTime,
        message: `${sig.strategy} ${sig.direction}: ${sig.reason}${conflict}`,
      });
      if (config.journal.enabled) {
        await logSignal({
          id: `${symbol}-${sig.strategy}-${sig.signalCloseTime}`, time: new Date().toISOString(), symbol,
          direction: sig.direction, level: sig.strategy, entry: sig.entry, stop: sig.stop, target: sig.target,
          rr: plan.rr, signalCloseTime: sig.signalCloseTime,
        });
      }
      if (config.paper.enabled && config.paper.takeStrategies) {
        const paperPos = await paperOpen({
          symbol, source: sig.strategy, direction: sig.direction, entry: sig.entry, stop: sig.stop,
          target: sig.target, signalCloseTime: sig.signalCloseTime,
          score: confluence ? `${confluence.score}/${confluence.max}` : undefined,
        }).catch(() => null);
        if (paperPos) announcePaperOpen(paperPos);
      }
    }
    st.lastStratClose = lastClosed.closeTime;
  }

  // ---- Failed-breakout / reclaim reversal (runs in ALL conditions, once per closed candle) ----
  if (config.reversal.enabled && lastClosed && lastClosed.closeTime !== st.lastReversalClose) {
    const rev = checkFailedBreakout(symbol, lastClosed, closed, range);
    if (rev) {
      const plan = applyStructureTps(planFrom(rev.direction, rev.entry, rev.stop, rev.target), closed);
      if (plan.rr >= config.reversal.minRR) {
        const bet = assessBet({ source: "failed-breakout", rr: plan.rr, factorsPresent: {} });
        await dispatch({
          symbol, kind: "reversal", direction: rev.direction, strategyName: "failed-breakout",
          level: rev.level, price, levelPrice: rev.levelPrice, range, plan, bet, signalCloseTime: rev.time, message: rev.reason,
        });
        if (config.journal.enabled) {
          await logSignal({
            id: `${symbol}-reversal-${rev.time}`, time: new Date().toISOString(), symbol, direction: rev.direction,
            level: "failed-breakout", entry: rev.entry, stop: rev.stop, target: rev.target, rr: plan.rr, signalCloseTime: rev.time,
          });
        }
        if (config.paper.enabled) {
          const pos = await paperOpen({
            symbol, source: "failed-breakout", direction: rev.direction, entry: rev.entry, stop: rev.stop,
            target: rev.target, signalCloseTime: rev.time,
          }).catch(() => null);
          if (pos) announcePaperOpen(pos);
        }
      }
    }
    st.lastReversalClose = lastClosed.closeTime;
  }

  const regime = detectRegime(closed);
  const liq = config.liquidation.enabled ? liqSummary(symbol) : undefined;
  const bias = computeBias(regime.regime, price, range);
  const obz = config.orderblocks.enabled ? findOrderBlocks(closed) : { bull: null, bear: null };
  const ob = {
    bull: obz.bull ? { low: obz.bull.low, high: obz.bull.high, avg: obz.bull.avg } : undefined,
    bear: obz.bear ? { low: obz.bear.low, high: obz.bear.high, avg: obz.bear.avg } : undefined,
  };
  // Liquidity sweeps (LuxAlgo) — notify on a fresh sweep, expose latest for the card.
  const sw = config.sweeps.enabled ? checkSweeps(symbol, candles) : { latest: null, isNew: false };
  if (sw.isNew && sw.latest) {
    const dir = sw.latest.type === "bull" ? "bullish" : "bearish";
    console.log(`${nowStr()}  ${symbol}  LIQUIDITY SWEEP  ${dir} — swept ${fmtPrice(sw.latest.level)}`);
    await sendTelegram(`💧 <b>LIQUIDITY SWEEP</b> ${symbol}\n${dir} sweep — grabbed liquidity at ${fmtPrice(sw.latest.level)}`);
  }
  const sweep = sw.latest ? { type: sw.latest.type, level: sw.latest.level, time: sw.latest.time } : undefined;
  const vpFull = config.volumeProfile.enabled ? volumeProfile(closed.slice(-config.volumeProfile.lookback), config.volumeProfile.bins) : null;
  const vp = vpFull ? { poc: vpFull.poc, vah: vpFull.vah, val: vpFull.val } : undefined;

  if (!range.consolidating) {
    st.resArmed = true;
    st.supArmed = true;
    if (config.printStatus) {
      console.log(`${nowStr()}  ${symbol.padEnd(8)} px=${fmtPrice(price)}  ${range.widthPct.toFixed(1)}% — not consolidating`);
    }
    syncSymbol({ symbol, interval: config.interval, levelMode, price, high: range.high, low: range.low, widthPct: range.widthPct, consolidating: false, resArmed: st.resArmed, supArmed: st.supArmed, spoof, divergences: divLabels, regime, liq, bias, ob, sweep, vp, mtf, context });
    return;
  }

  // ---- Touch alerts (intrabar) ----
  if (config.alertOnTouch) {
    if (st.resArmed && touchedResistance(forming.high, range)) {
      await dispatch({
        symbol, kind: "touch", level: "resistance", price, levelPrice: range.high, range,
        plan: config.plan.enabled ? applyStructureTps(buildPlan("resistance", range), closed) : undefined,
        message: `reached resistance ${fmtPrice(range.high)} — candle high ${fmtPrice(forming.high)}, now ${fmtPrice(price)}`,
      });
      st.resArmed = false;
    }
    if (st.supArmed && touchedSupport(forming.low, range)) {
      await dispatch({
        symbol, kind: "touch", level: "support", price, levelPrice: range.low, range,
        plan: config.plan.enabled ? applyStructureTps(buildPlan("support", range), closed) : undefined,
        message: `reached support ${fmtPrice(range.low)} — candle low ${fmtPrice(forming.low)}, now ${fmtPrice(price)}`,
      });
      st.supArmed = false;
    }
    if (price < range.high * (1 - config.rearmTolerancePct / 100)) st.resArmed = true;
    if (price > range.low * (1 + config.rearmTolerancePct / 100)) st.supArmed = true;
  }

  // ---- Breakout & confirmation (each newly-closed candle once) ----
  if (lastClosed && lastClosed.closeTime !== st.lastConfirmClose) {
    if (config.alertOnBreakout && brokeUp(lastClosed, range)) {
      await dispatch({
        symbol, kind: "breakout", level: "resistance", price: lastClosed.close, levelPrice: range.high, range,
        candleCloseTime: lastClosed.closeTime,
        message: `candle CLOSED ${fmtPrice(lastClosed.close)} above resistance ${fmtPrice(range.high)} — range broke UP`,
      });
    } else if (config.alertOnBreakout && brokeDown(lastClosed, range)) {
      await dispatch({
        symbol, kind: "breakout", level: "support", price: lastClosed.close, levelPrice: range.low, range,
        candleCloseTime: lastClosed.closeTime,
        message: `candle CLOSED ${fmtPrice(lastClosed.close)} below support ${fmtPrice(range.low)} — range broke DOWN`,
      });
    } else if (config.alertOnConfirmation && confirmsResistance(lastClosed, range)) {
      const confluence = config.orderflow.enabled
        ? await assessConfluence("resistance", lastClosed, lastClosed.close, candles, symbol)
        : undefined;
      const plan = config.plan.enabled ? applyStructureTps(buildConfirmPlan("resistance", range, lastClosed.close, config.plan.confirmEntryAtClose), closed) : undefined;
      const bet = plan ? assessBet({ source: "resistance", rr: plan.rr, factorsPresent: factorsFromConfluence(confluence?.factors ?? []) }) : undefined;
      await dispatch({
        symbol, kind: "confirmation", level: "resistance", price: lastClosed.close, levelPrice: range.high, range,
        candleCloseTime: lastClosed.closeTime, signalCloseTime: lastClosed.closeTime, confluence, plan, bet,
        message: `rejection candle closed ${fmtPrice(lastClosed.close)} back below resistance ${fmtPrice(range.high)} (bearish)`,
      });
      if (config.journal.enabled && plan) {
        await logSignal({
          id: `${symbol}-${lastClosed.closeTime}`, time: new Date().toISOString(), symbol, direction: plan.direction,
          level: "resistance", entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr,
          score: confluence ? `${confluence.score}/${confluence.max}` : undefined, signalCloseTime: lastClosed.closeTime,
        });
      }
      if (config.paper.enabled && config.paper.takeConfirmations && plan) {
        const pos = await paperOpen({
          symbol, source: "resistance", direction: plan.direction, entry: plan.entry, stop: plan.stop,
          target: plan.target, signalCloseTime: lastClosed.closeTime,
          score: confluence ? `${confluence.score}/${confluence.max}` : undefined,
        }).catch(() => null);
        if (pos) announcePaperOpen(pos);
      }
    } else if (config.alertOnConfirmation && confirmsSupport(lastClosed, range)) {
      const confluence = config.orderflow.enabled
        ? await assessConfluence("support", lastClosed, lastClosed.close, candles, symbol)
        : undefined;
      const plan = config.plan.enabled ? applyStructureTps(buildConfirmPlan("support", range, lastClosed.close, config.plan.confirmEntryAtClose), closed) : undefined;
      const bet = plan ? assessBet({ source: "support", rr: plan.rr, factorsPresent: factorsFromConfluence(confluence?.factors ?? []) }) : undefined;
      await dispatch({
        symbol, kind: "confirmation", level: "support", price: lastClosed.close, levelPrice: range.low, range,
        candleCloseTime: lastClosed.closeTime, signalCloseTime: lastClosed.closeTime, confluence, plan, bet,
        message: `rejection candle closed ${fmtPrice(lastClosed.close)} back above support ${fmtPrice(range.low)} (bullish)`,
      });
      if (config.journal.enabled && plan) {
        await logSignal({
          id: `${symbol}-${lastClosed.closeTime}`, time: new Date().toISOString(), symbol, direction: plan.direction,
          level: "support", entry: plan.entry, stop: plan.stop, target: plan.target, rr: plan.rr,
          score: confluence ? `${confluence.score}/${confluence.max}` : undefined, signalCloseTime: lastClosed.closeTime,
        });
      }
      if (config.paper.enabled && config.paper.takeConfirmations && plan) {
        const pos = await paperOpen({
          symbol, source: "support", direction: plan.direction, entry: plan.entry, stop: plan.stop,
          target: plan.target, signalCloseTime: lastClosed.closeTime,
          score: confluence ? `${confluence.score}/${confluence.max}` : undefined,
        }).catch(() => null);
        if (pos) announcePaperOpen(pos);
      }
    }
    st.lastConfirmClose = lastClosed.closeTime;
  }

  if (config.printStatus) {
    const toR = ((range.high - price) / price) * 100;
    const toS = ((price - range.low) / price) * 100;
    console.log(
      `${nowStr()}  ${symbol.padEnd(8)} px=${fmtPrice(price)}  ${fmtPrice(range.low)}–${fmtPrice(range.high)} (${range.widthPct.toFixed(1)}%)  ` +
        `→R +${toR.toFixed(2)}%  →S -${toS.toFixed(2)}%  [R:${st.resArmed ? "armed" : "fired"} S:${st.supArmed ? "armed" : "fired"}]`,
    );
  }
  syncSymbol({ symbol, interval: config.interval, levelMode, price, high: range.high, low: range.low, widthPct: range.widthPct, consolidating: true, resArmed: st.resArmed, supArmed: st.supArmed, spoof, divergences: divLabels, regime, liq, bias, ob, sweep, vp, mtf, context });
}

/**
 * core_4h forward-test path (2026-07-15). Same signal engine as the 1h book (`signalsAt` = enabled strategies +
 * S/R confirmations, the exact function `deepbacktest` validated the 4h book with), but on 4h candles, routed ONLY
 * to the unfiltered `core_4h` paper account (paperOpen/paperEvaluate with timeframe="4h"). Crypto majors only — the
 * 4h edge was measured on SOL/BTC/ETH; gold has none. Runs each cycle; paperOpen dedups by the 4h signalCloseTime,
 * so a signal opens once per 4h close. Wholly additive: it never touches the two legacy 1h accounts or their files.
 */
async function checkSymbol4h(symbol: string): Promise<void> {
  const candles = await getKlines(config.candleHistory, "4h", symbol);
  if (!candles) return;
  const closed = candles.filter((c) => c.closed);
  if (closed.length < 60) return; // need enough 4h bars for the strategy detectors
  for (const t of await paperEvaluate(symbol, candles, "4h").catch(() => [])) announcePaperClose(t);
  // Only OPEN new 4h trades on the focused list (BTC/SOL) — ETH still gets EVALUATED above so any open ETH position
  // manages out normally; it just won't take new ETH entries (per rrsweep: ETH is the 4h drag). See config.core4hSymbols.
  if (!config.paper.core4hSymbols.includes(symbol)) return;
  const last = closed[closed.length - 1]!;
  for (const s of signalsAt(symbol, closed)) {
    const pos = await paperOpen(
      { symbol, source: s.source, direction: s.long ? "LONG" : "SHORT", entry: s.entry, stop: s.stop, target: s.target, signalCloseTime: last.closeTime },
      "4h",
    ).catch(() => null);
    if (pos) console.log(`${nowStr()}  core_4h OPEN ${pos.direction} ${symbol} @ ${pos.entry} · ${s.source} (4h)`);
  }
}

async function main() {
  console.log("┌──────────────────────────────────────────────┐");
  console.log("│  futures alert bot — S/R touch + confirmation │");
  console.log("└──────────────────────────────────────────────┘");
  console.log(`watchlist: [${config.watchlist.join(", ")}]  ${config.interval}  (Binance futures)`);
  console.log(
    `range=${config.lookback} candles ≤ ${config.maxRangeWidthPct}% wide · touch=${config.touchTolerancePct}% · poll=${config.pollIntervalSec}s`,
  );
  console.log(`alerts: terminal ${telegramEnabled() ? "+ Telegram ✓" : "(Telegram off — add creds in .env)"}`);
  console.log(
    `regime gate: ${config.strategies.marketRegimeFilter ? `filtered opens only in [${config.market.allowedRegimes.join("/")}]` : "off (all regimes)"}` +
    ` · strategies: TSMOM=${config.strategies.tsmom ? "on" : "off"} bollinger=${config.strategies.bollinger ? "on" : "off"} feeFilter=${config.plan.feeFilter ? "on" : "off"}`,
  );
  console.log(
    `paper accounts: filtered + strategy on ${config.interval} (legacy 1h experiment) · ` +
    `core_4h on 4h ${config.paper.core4hSymbols.join("/")} · trail=${config.paper.exit.trailAtrMult}×ATR (unfiltered momentum forward-test — MARGINAL edge, not validated) → data/paper-core_4h.json` +
    (config.paper.makerEntry.enabled ? ` · core_4h_maker ON (maker ${config.paper.makerEntry.feeBps}bps limit entries, honest fill-gate — A/B vs core_4h) → data/paper-core_4h_maker.json` : ""),
  );
  const cfgCheck = validateConfig();
  for (const w of cfgCheck.warnings) console.warn(`⚠ config: ${w}`);
  if (cfgCheck.errors.length) {
    console.error("\nConfig errors — fix these before starting:");
    for (const e of cfgCheck.errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  if (config.levelMode === "manual") {
    if (!(config.manualResistance > config.manualSupport && config.manualSupport > 0)) {
      console.error(`\nInvalid manual levels: RESISTANCE (${config.manualResistance}) must be > SUPPORT (${config.manualSupport}) > 0.`);
      process.exit(1);
    }
    console.log(`${config.symbol} levels: MANUAL  resistance=${config.manualResistance}  support=${config.manualSupport}  (others: auto)\n`);
  } else {
    console.log(`levels: AUTO (range from last ${config.lookback} candles)\n`);
  }

  state.telegram = telegramEnabled();
  if (config.paper.enabled) await paperInit();
  await loadEdge(); // load the measured edge model (refreshes from `npm run audit`)
  if (config.dashboard.enabled) startServer();
  startLiquidationFeed(config.watchlist);
  startLivePriceFeed(config.watchlist);

  // Fast live-price patch: refresh displayed price/distances every second between
  // the heavier full scans, so the dashboard feels like a live ticker.
  setInterval(() => {
    for (const s of state.symbols) {
      const lp = getLivePrice(s.symbol);
      if (lp && lp > 0) {
        s.price = lp;
        s.toR = ((s.high - lp) / lp) * 100;
        s.toS = ((lp - s.low) / lp) * 100;
      }
    }
    state.feeds = feedStatuses();
    if (state.symbols.length) state.updatedAt = new Date().toISOString();
  }, 1000);

  let running = true;
  const shutdown = () => {
    running = false;
    console.log("\n── stopping ──");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    // Broad-market regime — shown on the dashboard as the market "weather", and (when the opt-in
    // config.strategies.marketRegimeFilter is on) it pauses NEW paper entries outside downtrends,
    // since the bot's edge is measured only in bear markets (npm run regimeoverlay / regimealpha).
    if (config.strategies.marketRegimeFilter || config.dashboard.enabled) {
      const mkReg = await computeMarketRegime().catch(() => null);
      setMarketRegime(mkReg?.regime ?? null);
      setMarketEfficiency(mkReg?.efficiency ?? 1);
      if (mkReg) state.market = {
        regime: mkReg.regime,
        filterActive: config.strategies.marketRegimeFilter,
        trendPct: mkReg.trendPct,
        lookbackBars: config.strategies.marketRegimeLookback,
        bandPct: config.strategies.marketRegimeBandPct,
        allowedRegimes: config.market.allowedRegimes,
      };
      // Only log a pause when the current regime is actually BLOCKED (not in allowedRegimes) — so bull/flat no
      // longer falsely report a pause now that the filtered account trades them.
      if (config.strategies.marketRegimeFilter && mkReg && !config.market.allowedRegimes.includes(mkReg.regime)) {
        console.log(`${nowStr()}  market regime: ${mkReg.regime} (basket ${mkReg.trendPct.toFixed(1)}%) — filtered account paused (regime not in allowed [${config.market.allowedRegimes.join("/")}])`);
      }
    }
    for (const symbol of config.watchlist) {
      await checkSymbol(symbol).catch((e) => console.error(`${symbol} scan failed: ${(e as Error).message}`));
    }
    // core_4h forward-test: same signals on 4h candles → the unfiltered 4h account only (crypto majors).
    for (const symbol of config.strategies.regimeSymbols) {
      await checkSymbol4h(symbol).catch((e) => console.error(`${symbol} 4h scan failed: ${(e as Error).message}`));
    }
    // Circuit-breaker watchdog for core_4h (once/cycle): the ENTRY gate is already enforced inside paperOpen; this
    // detects a fresh trip and fires the LLM auditor. No-op for the 1h accounts (not in discipline.applyTo).
    if (config.paper.enabled) checkCircuitBreaker("core_4h");
    if (config.paper.enabled) console.log(`${nowStr()}  ${paperLine()}`);
    // Live DRY-RUN shadow (default OFF; needs config.live.enabled AND env LIVE_TRADING=on).
    // Mirrors the filtered account and logs the orders it WOULD place — it submits nothing.
    await reconcileLiveShadow().catch((e) => console.error(`${nowStr()}  live-shadow: ${(e as Error).message}`));
    await sleep(config.pollIntervalSec * 1000);
  }
}

// Resilient 24/7 bot: log stray errors and keep scanning instead of crashing the
// whole process. Each scan cycle is independent, so a one-off error shouldn't take
// the watcher down until the user notices and restarts it.
process.on("unhandledRejection", (reason) => {
  console.error(`${nowStr()}  ⚠ unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});
process.on("uncaughtException", (err) => {
  console.error(`${nowStr()}  ⚠ uncaught exception (staying up): ${err.stack ?? err.message}`);
});

main().catch((e) => {
  console.error(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
