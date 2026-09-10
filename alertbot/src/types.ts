export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyVolume: number; // aggressive-buy volume (rest is aggressive-sell) → order-flow delta
  closeTime: number;
  closed: boolean; // true once the candle is finalized (closeTime is in the past)
}

/** One confirmation factor (order book, order flow, etc.). */
export interface ConfluenceFactor {
  ok: boolean;
  label: string;
}

/** Stacked confirmation: how many independent signals agree with the setup. */
export interface Confluence {
  score: number; // how many factors confirm
  max: number; // out of how many
  weighted: number; // score weighted by factor usefulness (config.confluenceWeights)
  weightedMax: number;
  factors: ConfluenceFactor[];
  context: string[]; // extra context (OI, funding, long/short) — shown, not scored
}

/** The consolidation range measured over the lookback window of closed candles. */
export interface Range {
  high: number; // resistance (top of the range)
  low: number; // support (bottom of the range)
  mid: number;
  widthPct: number; // (high - low) / mid * 100
  consolidating: boolean;
  candlesUsed: number;
}

export type Level = "resistance" | "support";
export type AlertKind = "touch" | "confirmation" | "breakout" | "strategy" | "reversal";

export interface Alert {
  kind: AlertKind;
  symbol: string;
  level: Level;
  direction?: "LONG" | "SHORT"; // for strategy alerts
  strategyName?: string; // for strategy alerts
  price: number; // current price when the alert fired
  levelPrice: number; // the support/resistance price
  range: Range;
  candleCloseTime?: number; // for confirmation alerts, which candle confirmed
  signalCloseTime?: number; // the signal candle's closeTime — from when to track the win/loss outcome (entry kinds only)
  confluence?: Confluence; // order-flow / book confirmation stack
  plan?: TradePlan; // suggested entry/stop/target/size
  bet?: import("./evidence.js").Bet; // evidence-backed read: grade, win%, measured expectancy, reasoning
  message: string;
}

export interface TradePlan {
  direction: "LONG" | "SHORT";
  entry: number;
  stop: number;
  target: number;
  tp1: number; // 1R
  tp2: number; // 2R
  tp3: number; // 3R
  rr: number;
  riskUsd: number;
  sizeUnits: number;
  notionalUsd: number;
  leverage: number;
  lowQuality: boolean;
  feePctOfRisk: number; // round-trip taker fee as a fraction of the 1R stop distance (≈ fee-in-R); high = churny
  feeHeavy: boolean; // true when feePctOfRisk exceeds config.plan.maxFeeThresholdPct (the fee-to-risk filter would skip it)
}
