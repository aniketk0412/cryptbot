import { fapiJson } from "./binance.js";
import { config } from "./config.js";
import { htfFactor } from "./htf.js";
import { fvgFactor, premiumDiscountFactor, structureFactor, sweepFactor } from "./structure.js";
import type { Candle, Confluence, ConfluenceFactor, Level } from "./types.js";

interface Depth {
  bids: [string, string][];
  asks: [string, string][];
}

/**
 * Stack extra confirmation onto a level rejection using free Binance futures data:
 *   1. rejection candle (already established by the caller)
 *   2. order-book wall — is resting liquidity defending the level?
 *   3. order flow — did aggressive traders push the right way this candle?
 * Plus context (open interest, funding, long/short) that's shown but not scored.
 *
 * Every fetch is independent and failure-tolerant: a missing feed just becomes an
 * unmet factor rather than blocking the alert.
 */
export async function assessConfluence(
  level: Level,
  candle: Candle,
  price: number,
  candles: Candle[],
  symbol: string = config.symbol,
): Promise<Confluence> {
  const s = symbol;
  // Fetch order-flow feeds and the higher-timeframe bias concurrently.
  const [depth, oi, prem, ls, htf] = await Promise.all([
    fapiJson<Depth>(`/fapi/v1/depth?symbol=${s}&limit=${config.orderflow.depthLimit}`),
    fapiJson<{ openInterest: string }>(`/fapi/v1/openInterest?symbol=${s}`),
    fapiJson<{ lastFundingRate: string }>(`/fapi/v1/premiumIndex?symbol=${s}`),
    fapiJson<{ longShortRatio: string }[]>(`/futures/data/globalLongShortAccountRatio?symbol=${s}&period=5m&limit=1`),
    htfFactor(level, symbol),
  ]);

  const supportSide = level === "support";
  const factors: ConfluenceFactor[] = [{ ok: true, label: "rejection candle" }];

  // 2) Order-book wall near the level.
  if (depth?.bids && depth?.asks) {
    const band = price * (config.orderflow.depthBandPct / 100);
    const bidLiq = depth.bids.filter((b) => +b[0] >= price - band).reduce((sum, b) => sum + +b[1], 0);
    const askLiq = depth.asks.filter((a) => +a[0] <= price + band).reduce((sum, a) => sum + +a[1], 0);
    const total = bidLiq + askLiq;
    const bidShare = total > 0 ? bidLiq / total : 0.5;
    const share = supportSide ? bidShare : 1 - bidShare; // share on the defending side
    factors.push({
      ok: share >= config.orderflow.imbalanceThreshold,
      label: `${supportSide ? "bid" : "ask"} wall ${(share * 100).toFixed(0)}%`,
    });
  } else {
    factors.push({ ok: false, label: "book n/a" });
  }

  // 3) Order flow — taker volume delta on the candle.
  const delta = 2 * candle.takerBuyVolume - candle.volume;
  const flowOk = supportSide ? delta > 0 : delta < 0;
  factors.push({ ok: flowOk, label: `flow ${delta >= 0 ? "net BUY" : "net SELL"}` });

  // 4) Price-structure / SMC factors (computed from candle history).
  factors.push(fvgFactor(level, price, candles));
  factors.push(sweepFactor(level, candles));
  factors.push(premiumDiscountFactor(level, price, candles));
  factors.push(structureFactor(level, candles));

  // 5) Higher-timeframe alignment.
  factors.push(htf);

  // Context (shown, not scored).
  const context: string[] = [];
  if (oi) context.push(`OI ${(+oi.openInterest / 1e6).toFixed(2)}M`);
  if (prem) context.push(`funding ${(+prem.lastFundingRate * 100).toFixed(3)}%`);
  if (Array.isArray(ls) && ls[0]) context.push(`L/S ${(+ls[0].longShortRatio).toFixed(2)}`);

  const score = factors.filter((f) => f.ok).length;
  let weighted = 0;
  let weightedMax = 0;
  for (const f of factors) {
    const w = config.confluenceWeights[keyFor(f.label)] ?? 1;
    weightedMax += w;
    if (f.ok) weighted += w;
  }
  return { score, max: factors.length, weighted, weightedMax, factors, context };
}

/**
 * Map a factor label to its weight key (config.confluenceWeights). Must cover EVERY
 * label a factor can emit — including the "n/a" fallbacks ("book n/a" for the wall,
 * "P/D n/a" for premium/discount) — or that factor silently defaults to weight 1
 * and corrupts the weighted score. Exported so a test can assert full coverage.
 */
export function keyFor(label: string): string {
  const l = label.toLowerCase();
  if (l.includes("rejection")) return "rejection";
  if (l.includes("wall") || l.includes("book")) return "wall";
  if (l.includes("flow")) return "flow";
  if (l.includes("fvg")) return "fvg";
  if (l.includes("sweep") || l.includes("swept")) return "sweep";
  if (l.includes("discount") || l.includes("premium") || l.includes("p/d")) return "pd";
  if (l.includes("structure")) return "structure";
  if (l.includes("htf")) return "htf";
  return "other";
}
