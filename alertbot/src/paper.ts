import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { state } from "./dashboardState.js";
import { atr } from "./indicators.js";
import { getLivePrice } from "./liveprice.js";
import { correlatedCapReached, disciplineBlocks, feeBlocksTrade, inNewsBlackout, leverageCappedSize, limitTouched, liquidationPrice, marketRegimeBlocks, mtfAlignBlocks, partialClosePnl, partialFill, resolveExit } from "./paperexit.js";
import { triggerAudit } from "./auditor.js";
import { logContextAtSignal } from "./context.js";
import type { Candle } from "./types.js";

/**
 * Broad-market regime for the bear-only filter (set once per cycle by index.ts from a causal basket
 * signal). null = unknown → no gating. Measured rationale: the bot's edge is concentrated in DOWNTRENDS
 * (`npm run regimeoverlay`), so the FILTERED account only opens in bear; trading bull/flat regimes bleeds.
 */
export type MarketRegime = "bull" | "bear" | "flat";
let marketRegime: MarketRegime | null = null;
export function setMarketRegime(r: MarketRegime | null): void {
  marketRegime = r;
}

// Current broad-market Efficiency Ratio (0..1), set each cycle from index.ts. Used ONLY for opt-in
// efficiency-scaled sizing (config.plan.riskScaleByEfficiency) — a risk-control lever, not an edge lever.
let marketEfficiency = 1;
export function setMarketEfficiency(er: number): void {
  marketEfficiency = Number.isFinite(er) ? Math.max(0, Math.min(1, er)) : 1;
}
/** Effective risk% for this trade: base riskPct, optionally scaled DOWN toward `riskPctFloor` in low-efficiency
 *  (choppy) regimes. Pure-ish (reads config + the last-set efficiency). Does NOT change R-expectancy — only $ size. */
function effectiveRiskPct(): number {
  const p = config.plan;
  if (!p.riskScaleByEfficiency || config.strategies.regimeMode !== "er") return config.paper.riskPct;
  const floor = p.riskPctFloor;
  const ceil = config.paper.riskPct;
  return floor + (ceil - floor) * marketEfficiency; // linear in ER ∈ [0,1]
}

// Per-symbol volatility-spike flag for the opt-in vol filter, set each cycle from index.ts (where candles+ATR
// live). Read in paperOpen to pause new entries during news-driven convulsions. Default absent = no spike.
const symbolVolSpike = new Map<string, boolean>();
export function setSymbolVolSpike(symbol: string, spike: boolean): void {
  symbolVolSpike.set(symbol, spike);
}

/**
 * PAPER-TRADING ENGINE — TWO fake-money accounts run in parallel off the same signals, so you can
 * compare, live and honestly, whether the bear-only filter actually helps:
 *   • "filtered" — the measured-best config: only opens entries when the market is in a downtrend.
 *   • "strategy" — takes EVERY signal in every regime (long at support, short at resistance, breakouts,
 *     momentum — with the confluence grade attached), no regime pause. This is "your strategy running free."
 * Each account sizes off its OWN compounding balance, persists to its own file, and shows on the dashboard.
 * The live track records settle the debate that a backtest can only argue.
 *
 * Fidelity (both accounts, kept deliberately simple): fills at the plan's entry the moment the signal
 * fires; stop/target exits with a break-even→ATR trail; taker fee + stop slippage modeled; no funding /
 * liquidation / partial fills. One open position per symbol per account.
 */

export interface PaperPosition {
  id: string; // dedup key: symbol + source + signalCloseTime
  account?: string; // which account holds it ("filtered" | "strategy")
  symbol: string;
  source: string; // strategy name, or "support" / "resistance" for S/R confirmations
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  sizeUnits: number;
  notionalUsd: number;
  riskUsd: number;
  leverage?: number; // derived notional/equity at open (risk sizing), after the liquidation-guard cap
  liqPrice?: number; // modelled isolated-margin liquidation price — the guard keeps it beyond the stop
  score?: string;
  openTime: string;
  signalCloseTime: number;
  riskDist?: number;
  peak?: number;
  beDone?: boolean;
  lastEval?: number;
  partialDone?: boolean; // opt-in partial take-profit already banked on this position
  partialPnlUsd?: number; // realized $ from the partial (already added to the account balance)
  origSizeUnits?: number; // size before the partial was skimmed (for display)
  entryFeeBps?: number; // fee paid on the ENTRY leg (undefined = taker config.paper.feeBps; a maker-filled entry sets this to makerEntry.feeBps)
}

/**
 * A resting LIMIT order for the opt-in maker-entry account (config.paper.makerEntry). It has NOT opened a position
 * yet — it opens only when a later candle trades through `entry` (honest maker fill), or is cancelled if untouched
 * within `makerEntry.fillWindowBars`. Kept separate from PaperPosition so an unfilled limit never counts as a trade.
 */
export interface PendingLimit {
  id: string;
  symbol: string;
  source: string;
  direction: "LONG" | "SHORT";
  entry: number; // the limit price
  stop: number;
  target: number;
  score?: string;
  signalCloseTime: number;
  placedAt: string;
  barsWaited: number; // candles elapsed without a fill
  lastCheck?: number; // closeTime of the last candle already examined (so we don't re-count)
}

export interface PaperTrade extends PaperPosition {
  exit: number;
  exitReason: "target" | "stop" | "manual";
  closeTime: string;
  pnlUsd: number;
  rMultiple: number;
  balanceAfter: number;
}

interface PaperAccount {
  id: string;
  label: string;
  applyFilter: boolean; // does the bear-only regime filter gate this account's entries?
  timeframe: string; // which candle timeframe feeds THIS account's signals — legacy accounts "1h", core_4h "4h"
  makerEntry: boolean; // opt-in: this account enters via a resting maker LIMIT (honest fill-gating), not a market order
  file: string;
  legacyFile?: string; // one-time migration source (the old single-account file)
  loaded: boolean;
  startBalanceUsd: number;
  balance: number;
  open: PaperPosition[];
  pending: PendingLimit[]; // resting maker limits not yet filled (empty unless makerEntry)
  closed: PaperTrade[];
  equity: { time: string; balance: number }[];
}

/** File path for an account, derived from the configured base (data/paper.json → data/paper-<id>.json). */
function accFile(id: string): string {
  return config.paper.file.replace(/\.json$/i, `-${id}.json`);
}

const ACCOUNT_DEFS = [
  // LEGACY 1h experiment — DO NOT rename/remove (their live records answer the filter-vs-unfiltered question).
  { id: "filtered", label: "Filtered · regime-gated · 1h", applyFilter: true, timeframe: "1h", makerEntry: false },
  { id: "strategy", label: "Strategy · all signals · 1h", applyFilter: false, timeframe: "1h", makerEntry: false },
  // NEW (2026-07-15) — forward-test of the marginal 4h momentum book. Unfiltered (no regime gate), 4h candles, its
  // OWN file (data/paper-core_4h.json). Additive: does not touch the two 1h accounts or their data.
  { id: "core_4h", label: "Core · unfiltered · 4h", applyFilter: false, timeframe: "4h", makerEntry: false },
  // NEW (2026-07-18, OPT-IN via config.paper.makerEntry.enabled) — the maker-vs-market forward-test. Same 4h signals
  // as core_4h, but enters via a resting maker LIMIT (honest fill-gating). Only present when the flag is on.
  { id: "core_4h_maker", label: "Core · maker-entry · 4h", applyFilter: false, timeframe: "4h", makerEntry: true },
] as const;

const ACCOUNTS: PaperAccount[] = ACCOUNT_DEFS
  // The maker-entry account only exists when opted in (default OFF = it never appears and nothing changes).
  .filter((d) => !d.makerEntry || config.paper.makerEntry.enabled)
  .map((d) => ({
    id: d.id,
    label: d.label,
    applyFilter: d.applyFilter,
    timeframe: d.timeframe,
    makerEntry: d.makerEntry,
    file: accFile(d.id),
    legacyFile: d.id === "filtered" ? config.paper.file : undefined, // filtered inherits the old single account
    loaded: false,
    startBalanceUsd: config.paper.startBalanceUsd,
    balance: config.paper.startBalanceUsd,
    open: [],
    pending: [],
    closed: [],
    equity: [],
  }));

function adopt(acc: PaperAccount, raw: string): boolean {
  const p = JSON.parse(raw);
  if (!(p && typeof p.balance === "number" && Array.isArray(p.open) && Array.isArray(p.closed))) return false;
  acc.startBalanceUsd = typeof p.startBalanceUsd === "number" ? p.startBalanceUsd : config.paper.startBalanceUsd;
  acc.balance = p.balance;
  acc.open = (p.open as PaperPosition[]).map((o) => ({
    ...o,
    account: acc.id,
    riskDist: typeof o.riskDist === "number" ? o.riskDist : Math.abs(o.entry - o.stop),
    peak: typeof o.peak === "number" ? o.peak : o.entry,
    beDone: !!o.beDone,
    lastEval: typeof o.lastEval === "number" ? o.lastEval : o.signalCloseTime,
  }));
  acc.pending = Array.isArray(p.pending) ? (p.pending as PendingLimit[]).map((pl) => ({ ...pl, barsWaited: pl.barsWaited ?? 0 })) : [];
  acc.closed = p.closed;
  acc.equity = Array.isArray(p.equity) ? p.equity : [];
  return true;
}

async function loadAccount(acc: PaperAccount): Promise<void> {
  if (acc.loaded) return;
  const candidates = [acc.file, `${acc.file}.bak`, acc.legacyFile, acc.legacyFile ? `${acc.legacyFile}.bak` : undefined].filter(Boolean) as string[];
  for (const f of candidates) {
    try {
      if (adopt(acc, await readFile(f, "utf8"))) {
        if (f !== acc.file) console.log(`paper[${acc.id}]: loaded from ${f}`);
        acc.loaded = true;
        return;
      }
    } catch {
      /* try next */
    }
  }
  acc.loaded = true; // nothing found → fresh
}

async function load(): Promise<void> {
  for (const a of ACCOUNTS) await loadAccount(a);
}

async function saveAccount(acc: PaperAccount): Promise<void> {
  await mkdir(dirname(acc.file), { recursive: true });
  const tmp = `${acc.file}.tmp`;
  const data = { id: acc.id, startBalanceUsd: acc.startBalanceUsd, balance: acc.balance, open: acc.open, pending: acc.pending, closed: acc.closed, equity: acc.equity };
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, acc.file);
  await copyFile(acc.file, `${acc.file}.bak`).catch(() => {});
}

export async function paperInit(): Promise<void> {
  await load();
}

export interface SignalInput {
  symbol: string;
  source: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  signalCloseTime: number;
  score?: string;
}

/**
 * Offer a fresh signal to BOTH accounts. The filtered account takes it only in a bear regime; the strategy
 * account takes it always. Each opens its own position sized off its own balance. Returns a representative
 * opened position (for the terminal announce) or null if neither account took it.
 */
export async function paperOpen(sig: SignalInput, timeframe = "1h"): Promise<PaperPosition | null> {
  if (!config.paper.enabled) return null;
  await load();
  const risk = Math.abs(sig.entry - sig.stop);
  const reward = Math.abs(sig.target - sig.entry);
  if (risk <= 0 || reward / risk < config.paper.minRR) return null;

  // Fee-to-risk filter (config.plan.feeFilter, default ON): reject when the round-trip taker fee eats more than
  // maxFeeThresholdPct of the 1R distance — the fee-drag fix. Global (both accounts). See paperexit.feeBlocksTrade.
  if (config.plan.feeFilter && feeBlocksTrade(sig.entry, sig.stop, (2 * config.paper.feeBps) / 10000, config.plan.maxFeeThresholdPct)) {
    console.log(`${sig.symbol} PAPER SKIP — fee-to-risk guard (fee > ${(config.plan.maxFeeThresholdPct * 100).toFixed(0)}% of 1R; stop too tight for ${config.paper.feeBps}bps)`);
    return null;
  }

  // Opt-in news/volatility guards (default OFF) — global (both accounts): skip the whole signal during a
  // volatility spike (news proxy) or a scheduled macro-event window. Damage control for the bot's news-blindness.
  if (config.paper.volFilter.enabled && symbolVolSpike.get(sig.symbol)) {
    console.log(`${sig.symbol} PAPER SKIP — volatility-spike guard (news proxy)`);
    return null;
  }
  if (inNewsBlackout(Date.now(), config.paper.newsBlackout)) {
    console.log(`${sig.symbol} PAPER SKIP — news-blackout window`);
    return null;
  }

  const id = `${sig.symbol}-${sig.source}-${sig.signalCloseTime}`;

  // Forward-measurement log: record the market context at this signal (deduped by id), so we can later measure which
  // context conditions precede good moves — the honest test for the signals we can't backtest. Never gates the trade.
  void logContextAtSignal({
    symbol: sig.symbol, source: sig.source, direction: sig.direction, entry: sig.entry, stop: sig.stop, target: sig.target,
    signalCloseTime: sig.signalCloseTime, timeframe, ctx: state.symbols.find((s) => s.symbol === sig.symbol)?.context ?? null,
  });

  let opened: PaperPosition | null = null;

  for (const acc of ACCOUNTS) {
    if (acc.timeframe !== timeframe) continue; // ROUTE by timeframe: 1h signals → filtered/strategy; 4h signals → core_4h
    if (acc.open.some((p) => p.id === id) || acc.pending.some((p) => p.id === id) || acc.closed.some((t) => t.id === id)) continue; // already taken
    // A resting maker limit counts as exposure, so pending + open together respect the per-symbol / correlation caps.
    const exposure = acc.makerEntry ? [...acc.open, ...acc.pending] : acc.open;
    if (exposure.filter((p) => p.symbol === sig.symbol).length >= config.paper.maxOpenPerSymbol) continue; // don't stack
    if (correlatedCapReached(exposure, sig.direction, config.paper.maxSameDirection)) continue;
    // Filtered account: only open when the current regime is in config.market.allowedRegimes (default bull/flat).
    // Strategy account: always. The `filtered` account always applies the gate — that's what makes it "filtered".
    if (acc.applyFilter && marketRegimeBlocks(true, marketRegime, config.market.allowedRegimes)) continue;
    // Opt-in multi-timeframe alignment gate (filtered account only; default off) — OOS-validated to lift the short edge.
    if (acc.applyFilter && mtfAlignBlocks(config.strategies.mtfAlignFilter, sig.direction, state.symbols.find((s) => s.symbol === sig.symbol)?.mtf)) continue;
    // Opt-in circuit-breaker (default OFF): pause NEW entries while a risk rail is tripped (daily-loss / streak /
    // drawdown). Open positions still manage & close normally — this only gates opening. Default off = no-op.
    const disc = config.paper.discipline;
    if (disc.enabled && disc.applyTo.includes(acc.id)) {
      let peak = acc.startBalanceUsd;
      for (const e of acc.equity) if (e.balance > peak) peak = e.balance;
      if (acc.balance > peak) peak = acc.balance;
      const halt = disciplineBlocks(acc.closed, acc.balance, peak, disc, Date.now());
      if (halt) {
        console.log(`${sig.symbol} PAPER SKIP [${acc.id}] discipline — ${halt}`);
        continue;
      }
    }

    // Maker-entry account: don't open now — rest a LIMIT at the entry. It becomes a position only when a later
    // candle trades through it (paperEvaluate), or is cancelled if untouched within makerEntry.fillWindowBars.
    // Sizing is deferred to fill time (off the balance then). No announce here — nothing has filled yet.
    if (acc.makerEntry) {
      acc.pending.push({
        id, symbol: sig.symbol, source: sig.source, direction: sig.direction,
        entry: sig.entry, stop: sig.stop, target: sig.target, score: sig.score,
        signalCloseTime: sig.signalCloseTime, placedAt: new Date().toISOString(), barsWaited: 0, lastCheck: sig.signalCloseTime,
      });
      await saveAccount(acc);
      console.log(`${sig.symbol} PAPER MAKER LIMIT [${acc.id}] resting @ ${sig.entry} (${sig.direction}) — fills only if price returns`);
      continue;
    }

    const riskUsd = (acc.balance * effectiveRiskPct()) / 100;
    // Liquidation-aware sizing: cap leverage so liquidation stays ≥ liqSafetyMult × the stop distance away.
    // If the requested risk implies more leverage than that, the size is cut (risking less than riskPct) rather
    // than opening a position that could be margin-called before its stop fills.
    const lc = leverageCappedSize(sig.entry, risk, acc.balance, riskUsd / risk, config.paper.leverage);
    const sizeUnits = lc.units;
    if (lc.capped) {
      console.log(`${sig.symbol} PAPER [${acc.id}] size capped by liquidation guard — leverage ${lc.leverage.toFixed(1)}× (max ${lc.maxLeverage.toFixed(1)}×); risking $${(sizeUnits * risk).toFixed(2)} instead of $${riskUsd.toFixed(2)}`);
    }
    const liqPrice = liquidationPrice(sig.direction === "LONG", sig.entry, lc.leverage, config.paper.leverage.maintenanceMarginRate);
    const pos: PaperPosition = {
      id,
      account: acc.id,
      symbol: sig.symbol,
      source: sig.source,
      direction: sig.direction,
      entry: sig.entry,
      stop: sig.stop,
      target: sig.target,
      sizeUnits,
      notionalUsd: sizeUnits * sig.entry,
      riskUsd: sizeUnits * risk, // ACTUAL risk after any liquidation-guard size cap (not the requested riskPct)
      leverage: lc.leverage,
      liqPrice,
      score: sig.score,
      openTime: new Date().toISOString(),
      signalCloseTime: sig.signalCloseTime,
      riskDist: risk,
      peak: sig.entry,
      beDone: false,
      lastEval: sig.signalCloseTime,
    };
    acc.open.push(pos);
    await saveAccount(acc);
    opened = opened ?? pos;
  }
  return opened;
}

function closePosition(acc: PaperAccount, p: PaperPosition, exit: number, reason: "target" | "stop" | "manual"): PaperTrade {
  // Per-leg fees: the ENTRY leg uses whatever was actually paid (taker by default; a maker-filled entry set
  // entryFeeBps). The EXIT leg is kept at taker (conservative — a target is really a limit/maker, but charging
  // taker on exit UNDER-states the maker benefit rather than over-stating it). For any non-maker position
  // entryFeeBps is undefined → both legs taker → identical to the original single-rate model (no behaviour change).
  const takerRate = config.paper.feeBps / 10000;
  const entryRate = (p.entryFeeBps ?? config.paper.feeBps) / 10000;
  const fees = p.sizeUnits * (entryRate * p.entry + takerRate * exit);
  const sign = p.direction === "LONG" ? 1 : -1;
  const remainderPnl = sign * (exit - p.entry) * p.sizeUnits - fees;
  acc.balance += remainderPnl; // any earlier partial was already booked to the balance
  const pnlUsd = remainderPnl + (p.partialPnlUsd ?? 0); // trade total = partial + remainder
  const trade: PaperTrade = {
    ...p,
    account: acc.id,
    exit,
    exitReason: reason,
    closeTime: new Date().toISOString(),
    pnlUsd,
    rMultiple: p.riskUsd > 0 ? pnlUsd / p.riskUsd : 0,
    balanceAfter: acc.balance,
  };
  acc.open = acc.open.filter((o) => o.id !== p.id);
  acc.closed.unshift(trade);
  acc.equity.push({ time: trade.closeTime, balance: acc.balance });
  return trade;
}

/** Manage open positions for `symbol` on the accounts feeding off `timeframe` candles (1h legacy / 4h core_4h).
 *  Returns trades closed this cycle (tagged by account). Candles MUST be of the given timeframe. */
export async function paperEvaluate(symbol: string, candles: Candle[], timeframe = "1h"): Promise<PaperTrade[]> {
  if (!config.paper.enabled) return [];
  await load();
  const closedCandles = candles.filter((c) => c.closed);
  const a = atr(closedCandles);
  const ex = config.paper.exit;
  const slip = config.paper.slippageBps / 10000;
  const done: PaperTrade[] = [];

  for (const acc of ACCOUNTS) {
    if (acc.timeframe !== timeframe) continue; // manage each account only with ITS timeframe's candles
    let changed = false;

    // MAKER pending-limit fills (opt-in accounts only): a resting limit becomes a real position when a later candle
    // trades through it (honest fill), or is cancelled if untouched within fillWindowBars. Runs BEFORE management so
    // a fill this cycle is managed from the NEXT candle on (its lastEval = fill candle → the fill bar can't also exit).
    if (acc.makerEntry && acc.pending.length) {
      const win = config.paper.makerEntry.fillWindowBars;
      for (const pl of [...acc.pending].filter((x) => x.symbol === symbol)) {
        const since = pl.lastCheck ?? pl.signalCloseTime;
        let outcome: "fill" | "cancel" | null = null;
        let fillTime = 0;
        for (const c of closedCandles) {
          if (c.closeTime <= since) continue;
          pl.lastCheck = c.closeTime;
          if (limitTouched(pl.direction, pl.entry, c.low, c.high)) { outcome = "fill"; fillTime = c.closeTime; break; }
          pl.barsWaited += 1;
          if (pl.barsWaited >= win) { outcome = "cancel"; break; }
        }
        if (outcome === "fill") {
          const risk = Math.abs(pl.entry - pl.stop);
          const riskUsd = (acc.balance * effectiveRiskPct()) / 100;
          const sizeUnits = risk > 0 ? riskUsd / risk : 0;
          acc.open.push({
            id: pl.id, account: acc.id, symbol: pl.symbol, source: pl.source, direction: pl.direction,
            entry: pl.entry, stop: pl.stop, target: pl.target, sizeUnits, notionalUsd: sizeUnits * pl.entry,
            riskUsd, score: pl.score, openTime: new Date().toISOString(), signalCloseTime: pl.signalCloseTime,
            riskDist: risk, peak: pl.entry, beDone: false, lastEval: fillTime, entryFeeBps: config.paper.makerEntry.feeBps,
          });
          acc.pending = acc.pending.filter((x) => x.id !== pl.id);
          changed = true;
          console.log(`${pl.symbol} PAPER MAKER FILL [${acc.id}] @ ${pl.entry} (${pl.direction}, maker ${config.paper.makerEntry.feeBps}bps)`);
        } else if (outcome === "cancel") {
          acc.pending = acc.pending.filter((x) => x.id !== pl.id);
          changed = true;
          console.log(`${pl.symbol} PAPER MAKER CANCEL [${acc.id}] limit @ ${pl.entry} unfilled in ${win} bars`);
        }
      }
    }

    for (const p of [...acc.open]) {
      if (p.symbol !== symbol) continue;
      const long = p.direction === "LONG";
      const riskDist = p.riskDist ?? Math.abs(p.entry - p.stop);
      let peak = p.peak ?? p.entry;
      let beDone = p.beDone ?? false;
      const startLast = p.lastEval ?? p.signalCloseTime;
      const since = Math.max(p.signalCloseTime, startLast);
      let resolved = false;

      for (const c of closedCandles) {
        if (c.closeTime <= since) continue;
        const hit = resolveExit(long, p.stop, p.target, c.low, c.high, slip);
        if (hit) {
          p.peak = peak;
          p.beDone = beDone;
          // LIQUIDATION backstop (honest high-leverage modelling). The sizing guard keeps liqPrice BEYOND the stop,
          // so this can only fire when a candle blows through BOTH in one bar (a gap) — i.e. price reached the
          // liquidation level before a stop order could realistically fill. Then the fill is the liquidation price,
          // not the stop: the margin is gone. Without this a leveraged paper account could never blow up = a lie.
          const liq = p.liqPrice;
          const blewThroughLiq = hit.reason === "stop" && liq != null && liq > 0 && Number.isFinite(liq) && (long ? c.low <= liq : c.high >= liq);
          if (blewThroughLiq) {
            console.log(`${p.symbol} PAPER [${acc.id}] LIQUIDATED @ ${liq} (${p.leverage?.toFixed(1) ?? "?"}× lev) — candle gapped through the stop AND the liquidation level`);
            done.push(closePosition(acc, p, liq, "stop"));
            changed = true;
            resolved = true;
            break;
          }
          done.push(closePosition(acc, p, hit.exit, hit.reason));
          changed = true;
          resolved = true;
          break;
        }
        if (riskDist > 0) {
          peak = long ? Math.max(peak, c.high) : Math.min(peak, c.low);
          const favR = (long ? peak - p.entry : p.entry - peak) / riskDist;
          // Partial take-profit (opt-in): bank a fraction at +atR, move the remainder to break-even.
          const tp = ex.partialTp;
          if (tp.enabled && !p.partialDone && favR >= tp.atR && !tp.exclude.includes(p.source)) {
            const f = partialFill(long, p.entry, riskDist, tp.atR, tp.fraction, p.sizeUnits, config.paper.feeBps / 10000);
            acc.balance += f.partialPnl;
            p.partialPnlUsd = (p.partialPnlUsd ?? 0) + f.partialPnl;
            p.origSizeUnits = p.origSizeUnits ?? p.sizeUnits;
            p.sizeUnits = f.remaining;
            p.notionalUsd = p.sizeUnits * p.entry;
            p.partialDone = true;
            p.stop = long ? Math.max(p.stop, f.beStop) : Math.min(p.stop, f.beStop);
            beDone = true;
            changed = true;
            acc.equity.push({ time: new Date().toISOString(), balance: acc.balance });
            console.log(
              `${p.symbol} PAPER PARTIAL [${acc.id}] ${(tp.fraction * 100).toFixed(0)}% @ ${f.level.toFixed(4)} (+${tp.atR}R)  ` +
                `banked ${f.partialPnl >= 0 ? "+" : ""}$${f.partialPnl.toFixed(2)} — remainder to break-even`,
            );
          }
          if (ex.breakevenAtR > 0 && !beDone && favR >= ex.breakevenAtR && !ex.breakevenExclude.includes(p.source)) {
            const feeBuf = (config.paper.feeBps / 10000) * 2 * p.entry;
            const be = long ? p.entry + feeBuf : p.entry - feeBuf;
            p.stop = long ? Math.max(p.stop, be) : Math.min(p.stop, be);
            beDone = true;
          }
          if (beDone && ex.trailAtrMult > 0 && Number.isFinite(a) && a > 0) {
            const trail = long ? peak - ex.trailAtrMult * a : peak + ex.trailAtrMult * a;
            p.stop = long ? Math.max(p.stop, trail) : Math.min(p.stop, trail);
          }
        }
        p.lastEval = c.closeTime;
      }

      if (!resolved) {
        p.peak = peak;
        p.beDone = beDone;
        p.riskDist = riskDist;
        p.lastEval = p.lastEval ?? p.signalCloseTime;
        if (p.lastEval !== startLast) changed = true;
      }
    }
    if (changed) await saveAccount(acc);
  }
  return done;
}

/** Manually close an open position on a specific account (dashboard button).
 *  `fraction` in (0,1) books a PARTIAL close: that share of the position is sold
 *  at the live price (fees on both sides of the closed units, same model as
 *  closePosition/partialFill), P&L is banked to the balance, and the remainder
 *  stays open with its stop/target untouched. fraction 1 (default) = full close. */
export async function paperClose(id: string, account?: string, fraction = 1): Promise<PaperTrade | { ok: true; partial: true; bankedUsd: number } | null> {
  if (!config.paper.enabled) return null;
  await load();
  for (const acc of ACCOUNTS) {
    if (account && acc.id !== account) continue;
    const p = acc.open.find((o) => o.id === id);
    if (!p) continue;
    const px = priceOf(p.symbol) || p.entry;
    const frac = Number.isFinite(fraction) && fraction > 0 && fraction < 1 ? fraction : 1;
    if (frac < 1) {
      const closedUnits = p.sizeUnits * frac;
      const pnl = partialClosePnl(p.direction, p.entry, px, closedUnits, config.paper.feeBps / 10000);
      acc.balance += pnl;
      p.partialPnlUsd = (p.partialPnlUsd ?? 0) + pnl;
      p.origSizeUnits = p.origSizeUnits ?? p.sizeUnits;
      p.sizeUnits -= closedUnits;
      p.notionalUsd = p.sizeUnits * p.entry;
      p.partialDone = true;
      acc.equity.push({ time: new Date().toISOString(), balance: acc.balance });
      await saveAccount(acc);
      console.log(`${p.symbol} PAPER PARTIAL CLOSE [${acc.id}] (manual ${(frac * 100).toFixed(0)}%) @ ${px}  banked ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`);
      return { ok: true, partial: true, bankedUsd: pnl };
    }
    const trade = closePosition(acc, p, px, "manual");
    await saveAccount(acc);
    console.log(`${trade.symbol} PAPER CLOSE [${acc.id}] (manual) @ ${px}  P&L ${trade.pnlUsd >= 0 ? "+" : ""}$${trade.pnlUsd.toFixed(2)}`);
    return trade;
  }
  return null;
}

function priceOf(sym: string): number {
  const lp = getLivePrice(sym);
  if (lp && lp > 0) return lp;
  return state.symbols.find((s) => s.symbol === sym)?.price ?? 0;
}

/** Snapshot one account (open PnL marked to live price) for the dashboard/API. */
function snapshotAccount(acc: PaperAccount) {
  const open = acc.open.map((p) => {
    const px = priceOf(p.symbol) || p.entry;
    const sign = p.direction === "LONG" ? 1 : -1;
    const uPnlUsd = sign * (px - p.entry) * p.sizeUnits;
    return { ...p, price: px, uPnlUsd, uR: p.riskUsd > 0 ? uPnlUsd / p.riskUsd : 0 };
  });
  const unrealized = open.reduce((s, p) => s + p.uPnlUsd, 0);
  const equity = acc.balance + unrealized;
  const wins = acc.closed.filter((t) => t.pnlUsd > 0);
  const losses = acc.closed.filter((t) => t.pnlUsd <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  let peak = acc.startBalanceUsd;
  let maxDD = 0;
  for (const pt of acc.equity) {
    if (pt.balance > peak) peak = pt.balance;
    const dd = peak > 0 ? ((peak - pt.balance) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;
  }
  const denom = acc.startBalanceUsd || 1;
  // Opt-in circuit-breaker state for the dashboard: is it on for this account, and is a rail currently tripped?
  const disc = config.paper.discipline;
  const discOn = disc.enabled && disc.applyTo.includes(acc.id);
  const discHalted = discOn ? disciplineBlocks(acc.closed, acc.balance, peak, disc, Date.now()) : null;
  return {
    id: acc.id,
    label: acc.label,
    applyFilter: acc.applyFilter,
    timeframe: acc.timeframe,
    discipline: { enabled: discOn, halted: discHalted },
    startBalance: acc.startBalanceUsd,
    balance: acc.balance,
    equity,
    unrealized,
    returnPct: ((equity - acc.startBalanceUsd) / denom) * 100,
    realizedReturnPct: ((acc.balance - acc.startBalanceUsd) / denom) * 100,
    stats: {
      trades: acc.closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: acc.closed.length ? (wins.length / acc.closed.length) * 100 : 0,
      avgWinUsd: wins.length ? grossWin / wins.length : 0,
      avgLossUsd: losses.length ? grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      // Expectancy = average R booked per closed trade. THE metric that predicts staying profitable
      // (positive = the edge compounds), far more than win rate. Null until there's a trade to average.
      expectancyR: acc.closed.length ? acc.closed.reduce((s, t) => s + t.rMultiple, 0) / acc.closed.length : null,
      maxDrawdownPct: maxDD,
      openCount: acc.open.length,
      pendingCount: acc.pending.length, // resting maker limits not yet filled (0 unless this is the maker-entry account)
    },
    open,
    closed: acc.closed.slice(0, config.paper.maxDashboard),
    curve: acc.equity.slice(-120),
  };
}

/** Both accounts' snapshots for the dashboard / API. */
export function paperApi() {
  return { enabled: config.paper.enabled, accounts: ACCOUNTS.map(snapshotAccount) };
}

// Account ids whose CURRENT breaker trip has already fired an LLM audit — so we audit ONCE per trip, not every cycle.
const breakerAudited = new Set<string>();

/**
 * Circuit-breaker WATCHDOG for one account. Reuses the tested `disciplineBlocks` rails (config.paper.discipline) —
 * NO duplicate breaker logic — and returns whether the account is currently halted + why. Side effect: on a FRESH
 * trip it fires the LLM auditor once (cleared when the cooldown lifts, so the next trip re-fires). The ENTRY gate
 * itself already lives in `paperOpen` (same rails, scoped by `applyTo`); this is the monitor + audit trigger.
 * Returns {tripped:false} for any account the breaker isn't enabled for (so the 1h accounts are never touched).
 */
export function checkCircuitBreaker(accountId: string): { tripped: boolean; reason: string | null } {
  const acc = ACCOUNTS.find((a) => a.id === accountId);
  const disc = config.paper.discipline;
  if (!acc || !disc.enabled || !disc.applyTo.includes(accountId)) return { tripped: false, reason: null };
  let peak = acc.startBalanceUsd;
  for (const e of acc.equity) if (e.balance > peak) peak = e.balance;
  if (acc.balance > peak) peak = acc.balance;
  const reason = disciplineBlocks(acc.closed, acc.balance, peak, disc, Date.now());
  if (reason) {
    if (!breakerAudited.has(accountId)) { breakerAudited.add(accountId); triggerAudit(accountId, acc.closed, reason); }
  } else {
    breakerAudited.delete(accountId); // cooldown cleared → allow the next trip to trigger a fresh audit
  }
  return { tripped: !!reason, reason };
}

function istDay(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD in IST
}

/** Binance-style realized-P&L analysis per account: windowed totals, a daily map, per-asset, and a cumulative curve. */
export function paperPnl() {
  const now = Date.now();
  const DAY = 86_400_000;
  const todayIst = istDay(new Date(now).toISOString());
  const accounts = ACCOUNTS.map((acc) => {
    const daily: Record<string, number> = {};
    const byAsset: Record<string, { pnl: number; trades: number; wins: number }> = {};
    const curve: { t: string; cum: number }[] = [];
    let cum = 0;
    for (const t of [...acc.closed].reverse()) {
      // oldest → newest for the cumulative curve
      cum += t.pnlUsd;
      curve.push({ t: t.closeTime, cum });
      const d = istDay(t.closeTime);
      daily[d] = (daily[d] ?? 0) + t.pnlUsd;
      const a = (byAsset[t.symbol] ??= { pnl: 0, trades: 0, wins: 0 });
      a.pnl += t.pnlUsd;
      a.trades += 1;
      if (t.pnlUsd > 0) a.wins += 1;
    }
    const snap = snapshotAccount(acc);
    const within = (ms: number) => acc.closed.filter((t) => now - Date.parse(t.closeTime) <= ms).reduce((s, t) => s + t.pnlUsd, 0);
    const today = acc.closed.filter((t) => istDay(t.closeTime) === todayIst).reduce((s, t) => s + t.pnlUsd, 0);
    return {
      id: acc.id,
      label: acc.label,
      applyFilter: acc.applyFilter,
      startBalance: acc.startBalanceUsd,
      balance: acc.balance,
      equity: snap.equity,
      unrealized: snap.unrealized,
      realizedPct: ((acc.balance - acc.startBalanceUsd) / (acc.startBalanceUsd || 1)) * 100,
      today,
      pnl7d: within(7 * DAY),
      pnl30d: within(30 * DAY),
      trades: acc.closed.length,
      wins: acc.closed.filter((t) => t.pnlUsd > 0).length,
      daily,
      byAsset,
      curve,
    };
  });
  return { generatedAt: new Date(now).toISOString(), accounts };
}

/** Compact one-line status for the terminal, printed once per full scan cycle (both accounts). */
export function paperLine(): string {
  return (
    "paper — " +
    ACCOUNTS.map((acc) => {
      const s = snapshotAccount(acc);
      const sg = s.returnPct >= 0 ? "+" : "";
      return `${acc.id}: $${s.equity.toFixed(2)} (${sg}${s.returnPct.toFixed(1)}%) ${s.stats.trades}t/${s.stats.openCount}o`;
    }).join("  |  ")
  );
}
