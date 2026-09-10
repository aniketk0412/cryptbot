import { config } from "./config.js";
import { atr, emaLast, sma, stdev, vwap } from "./indicators.js";
import { findOrderBlocks } from "./orderblocks.js";
import type { RegimeClass } from "./regime.js";
import type { Candle } from "./types.js";

export interface StrategySignal {
  strategy: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  reason: string;
  signalCloseTime: number;
}

export interface StratCtx {
  symbol: string;
  closed: Candle[]; // closed candles only
  price: number;
}

export interface Strategy {
  name: string;
  enabled(): boolean;
  regimes?: RegimeClass[]; // when config.strategies.regimeGate is on, only fire in these regimes (from npm run regimeedge)
  detect(ctx: StratCtx): StrategySignal | null;
}

function swing(closed: Candle[], n: number): { hi: number; lo: number } {
  const w = closed.slice(-n);
  return { hi: Math.max(...w.map((c) => c.high)), lo: Math.min(...w.map((c) => c.low)) };
}

// ---- Trend pullback: buy dips to the EMA in an uptrend / sell rips in a downtrend ----
const trendPullback: Strategy = {
  name: "trend-pullback",
  enabled: () => config.strategies.trendPullback,
  detect({ closed }) {
    if (closed.length < 60) return null;
    const closes = closed.map((c) => c.close);
    const fast = emaLast(closes, config.strategies.emaFast);
    const slow = emaLast(closes, config.strategies.emaSlow);
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const tol = a * config.strategies.pullbackAtrMult;
    const last = closed[closed.length - 1]!;
    const { hi, lo } = swing(closed, config.strategies.swingLookback);

    if (fast > slow && last.low <= fast + tol && last.close > fast && last.close > last.open) {
      const entry = last.close;
      const stop = Math.min(last.low, slow) - a * 0.2;
      if (hi > entry && entry > stop) {
        return { strategy: "trend-pullback", direction: "LONG", entry, stop, target: hi, reason: `uptrend pullback to EMA${config.strategies.emaFast}, bullish resumption`, signalCloseTime: last.closeTime };
      }
    }
    if (fast < slow && last.high >= fast - tol && last.close < fast && last.close < last.open) {
      const entry = last.close;
      const stop = Math.max(last.high, slow) + a * 0.2;
      if (lo < entry && entry < stop) {
        return { strategy: "trend-pullback", direction: "SHORT", entry, stop, target: lo, reason: `downtrend pullback to EMA${config.strategies.emaFast}, bearish resumption`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Breakout + retest: enter when a broken range level is retested and holds ----
const breakoutRetest: Strategy = {
  name: "breakout-retest",
  enabled: () => config.strategies.breakoutRetest,
  regimes: ["trend"], // measured +0.53R in trends, −0.28R in ranges
  detect({ closed }) {
    if (closed.length < 40) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const tol = a * config.strategies.pullbackAtrMult;
    const last = closed[closed.length - 1]!;
    const prior = closed.slice(-30, -5);
    if (prior.length < 10) return null;
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const priorLow = Math.min(...prior.map((c) => c.low));
    const height = priorHigh - priorLow;
    const between = closed.slice(-5, -1);

    if (between.some((c) => c.close > priorHigh) && last.low <= priorHigh + tol && last.close > priorHigh && last.close > last.open) {
      const entry = last.close;
      const stop = priorHigh - a * 0.3;
      if (entry > stop) {
        return { strategy: "breakout-retest", direction: "LONG", entry, stop, target: priorHigh + height, reason: `broke ${priorHigh.toFixed(2)}, retested as support`, signalCloseTime: last.closeTime };
      }
    }
    if (between.some((c) => c.close < priorLow) && last.high >= priorLow - tol && last.close < priorLow && last.close < last.open) {
      const entry = last.close;
      const stop = priorLow + a * 0.3;
      if (entry < stop) {
        return { strategy: "breakout-retest", direction: "SHORT", entry, stop, target: priorLow - height, reason: `broke ${priorLow.toFixed(2)}, retested as resistance`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Liquidity sweep reversal: wick beyond a recent swing then snap back ----
const sweepReversal: Strategy = {
  name: "sweep-reversal",
  enabled: () => config.strategies.sweepReversal,
  detect({ closed }) {
    if (closed.length < 30) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const last = closed[closed.length - 1]!;
    const prior = closed.slice(-11, -1);
    const priorHigh = Math.max(...prior.map((c) => c.high));
    const priorLow = Math.min(...prior.map((c) => c.low));
    const { hi, lo } = swing(closed, config.strategies.swingLookback);

    if (last.low < priorLow && last.close > priorLow && last.close > last.open) {
      const entry = last.close;
      const stop = last.low - a * 0.2;
      if (hi > entry && entry > stop) {
        return { strategy: "sweep-reversal", direction: "LONG", entry, stop, target: hi, reason: `swept sell-side below ${priorLow.toFixed(2)}, reclaimed`, signalCloseTime: last.closeTime };
      }
    }
    if (last.high > priorHigh && last.close < priorHigh && last.close < last.open) {
      const entry = last.close;
      const stop = last.high + a * 0.2;
      if (lo < entry && entry < stop) {
        return { strategy: "sweep-reversal", direction: "SHORT", entry, stop, target: lo, reason: `swept buy-side above ${priorHigh.toFixed(2)}, rejected`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- VWAP reversion: fade an over-extension back toward VWAP ----
const vwapReversion: Strategy = {
  name: "vwap-reversion",
  enabled: () => config.strategies.vwapReversion,
  detect({ closed }) {
    if (closed.length < 30) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const v = vwap(closed.slice(-48));
    if (!Number.isFinite(v)) return null;
    const last = closed[closed.length - 1]!;
    const dist = last.close - v;
    const ext = a * 1.5;
    const { hi, lo } = swing(closed, config.strategies.swingLookback);

    if (dist < -ext && last.close > last.open) {
      const entry = last.close;
      const stop = Math.min(last.low, lo) - a * 0.2;
      if (v > entry && entry > stop) {
        return { strategy: "vwap-reversion", direction: "LONG", entry, stop, target: v, reason: `${Math.abs(dist).toFixed(2)} below VWAP, reverting up`, signalCloseTime: last.closeTime };
      }
    }
    if (dist > ext && last.close < last.open) {
      const entry = last.close;
      const stop = Math.max(last.high, hi) + a * 0.2;
      if (v < entry && entry < stop) {
        return { strategy: "vwap-reversion", direction: "SHORT", entry, stop, target: v, reason: `${dist.toFixed(2)} above VWAP, reverting down`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Time-series momentum (TSMOM — Moskowitz, Ooi & Pedersen 2012) ----
// An asset's own past N-bar return predicts its near-term direction.
const tsmom: Strategy = {
  name: "momentum-TSMOM",
  enabled: () => config.strategies.tsmom,
  regimes: ["trend"], // measured +0.22R in trends, −0.30R in ranges
  detect({ closed }) {
    const lb = config.strategies.tsmomLookback;
    if (closed.length < lb + 5) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const last = closed[closed.length - 1]!;
    const past = closed[closed.length - 1 - lb]!;
    const ret = ((last.close - past.close) / past.close) * 100;
    const th = config.strategies.tsmomThresholdPct;
    const { hi, lo } = swing(closed, config.strategies.swingLookback);

    if (ret >= th && last.close > last.open) {
      const entry = last.close;
      const stop = Math.min(last.low, lo) - a * 0.3;
      if (entry > stop) {
        return { strategy: "momentum-TSMOM", direction: "LONG", entry, stop, target: entry + (entry - stop) * 2, reason: `+${ret.toFixed(1)}% ${lb}-bar momentum (TSMOM)`, signalCloseTime: last.closeTime };
      }
    }
    if (ret <= -th && last.close < last.open) {
      const entry = last.close;
      const stop = Math.max(last.high, hi) + a * 0.3;
      if (entry < stop) {
        return { strategy: "momentum-TSMOM", direction: "SHORT", entry, stop, target: entry - (stop - entry) * 2, reason: `${ret.toFixed(1)}% ${lb}-bar momentum (TSMOM)`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Order-flow imbalance (Cont, Kukanov & Stoikov) ----
// Net aggressive buying/selling pressure over recent bars leads short-term price.
const orderFlow: Strategy = {
  name: "order-flow-imbalance",
  enabled: () => config.strategies.orderFlow,
  detect({ closed }) {
    const k = config.strategies.ofiLookback;
    if (closed.length < k + 20) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const recent = closed.slice(-k);
    let delta = 0;
    let vol = 0;
    for (const c of recent) {
      delta += 2 * c.takerBuyVolume - c.volume;
      vol += c.volume;
    }
    const imb = vol > 0 ? delta / vol : 0; // -1..1
    const last = closed[closed.length - 1]!;
    const { hi, lo } = swing(closed, config.strategies.swingLookback);
    const th = config.strategies.ofiThreshold;

    if (imb >= th && last.close > last.open) {
      const entry = last.close;
      const stop = Math.min(last.low, lo) - a * 0.3;
      if (entry > stop) {
        return { strategy: "order-flow-imbalance", direction: "LONG", entry, stop, target: entry + (entry - stop) * 2, reason: `+${(imb * 100).toFixed(0)}% aggressive-buy imbalance`, signalCloseTime: last.closeTime };
      }
    }
    if (imb <= -th && last.close < last.open) {
      const entry = last.close;
      const stop = Math.max(last.high, hi) + a * 0.3;
      if (entry < stop) {
        return { strategy: "order-flow-imbalance", direction: "SHORT", entry, stop, target: entry - (stop - entry) * 2, reason: `${(imb * 100).toFixed(0)}% aggressive-sell imbalance`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Bollinger-band mean reversion (John Bollinger) ----
// A close back inside after piercing a 2σ band reverts toward the mean (SMA).
const bollinger: Strategy = {
  name: "bollinger-reversion",
  enabled: () => config.strategies.bollinger,
  regimes: ["range"], // measured +0.18R in ranges, ~flat in trends
  detect({ closed }) {
    const p = config.strategies.bbPeriod;
    if (closed.length < p + 5) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const closes = closed.map((c) => c.close);
    const mid = sma(closes, p);
    const sd = stdev(closes, p);
    const upper = mid + config.strategies.bbMult * sd;
    const lower = mid - config.strategies.bbMult * sd;
    const last = closed[closed.length - 1]!;

    if (last.low < lower && last.close > lower && last.close > last.open) {
      const entry = last.close;
      const stop = last.low - a * 0.3;
      if (mid > entry && entry > stop) {
        return { strategy: "bollinger-reversion", direction: "LONG", entry, stop, target: mid, reason: `closed back above lower band, revert to mean`, signalCloseTime: last.closeTime };
      }
    }
    if (last.high > upper && last.close < upper && last.close < last.open) {
      const entry = last.close;
      const stop = last.high + a * 0.3;
      if (mid < entry && entry < stop) {
        return { strategy: "bollinger-reversion", direction: "SHORT", entry, stop, target: mid, reason: `closed back below upper band, revert to mean`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

// ---- Order-block revisit (wugamlo Order Block Finder) ----
// Price returning into a bullish OB (buy zone) / bearish OB (sell zone) — the
// institutional level where limit orders sit — and reacting off it.
const orderBlock: Strategy = {
  name: "order-block",
  enabled: () => config.orderblocks.enabled && config.orderblocks.tradeRevisit,
  detect({ closed }) {
    if (closed.length < config.orderblocks.periods + 20) return null;
    const a = atr(closed);
    if (!Number.isFinite(a) || a <= 0) return null;
    const { bull, bear } = findOrderBlocks(closed);
    const last = closed[closed.length - 1]!;

    // Bullish OB revisit: dipped into the zone, closed back above its equilibrium.
    if (bull && last.low <= bull.high && last.low >= bull.low * 0.995 && last.close > bull.avg && last.close > last.open) {
      const entry = last.close;
      const stop = bull.low - a * 0.3;
      if (entry > stop) {
        return { strategy: "order-block", direction: "LONG", entry, stop, target: entry + (entry - stop) * 2, reason: `revisit of bullish order block ${bull.low.toFixed(2)}–${bull.high.toFixed(2)}`, signalCloseTime: last.closeTime };
      }
    }
    // Bearish OB revisit: rallied into the zone, closed back below its equilibrium.
    if (bear && last.high >= bear.low && last.high <= bear.high * 1.005 && last.close < bear.avg && last.close < last.open) {
      const entry = last.close;
      const stop = bear.high + a * 0.3;
      if (entry < stop) {
        return { strategy: "order-block", direction: "SHORT", entry, stop, target: entry - (stop - entry) * 2, reason: `revisit of bearish order block ${bear.low.toFixed(2)}–${bear.high.toFixed(2)}`, signalCloseTime: last.closeTime };
      }
    }
    return null;
  },
};

export const STRATEGIES: Strategy[] = [
  trendPullback,
  breakoutRetest,
  sweepReversal,
  vwapReversion,
  tsmom,
  orderFlow,
  bollinger,
  orderBlock,
];
