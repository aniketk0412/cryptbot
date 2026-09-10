import "./env.js";
import { config } from "./config.js";

/**
 * `npm run fundingedge` — FIRST-LOOK at funding-rate CARRY, the one genuinely-new lever flagged in the
 * famous-strategy survey and never measured. A delta-neutral basis trade (LONG spot + SHORT perp) collects the
 * perp funding when it's positive (longs pay shorts). This fetches recent funding history for the majors and
 * reports the annualized gross yield + how often it's positive — a "is there even anything here" gauge.
 *
 * HONEST SCOPE: this is a DIFFERENT machine than the directional bot — it needs a spot hedge leg (not built), and
 * the real net = funding − (2×taker to set up/unwind) − spot-borrow/basis drift − execution. So a positive gross
 * number here is necessary-but-not-sufficient; it just says whether the raw carry is big enough to bother modeling.
 */

const SYMBOLS = (process.env.FUND_SYMBOLS ?? "SOLUSDT,BTCUSDT,ETHUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const BASE = config.binanceBaseUrl ?? "https://fapi.binance.com";

interface FundingRow { fundingTime: number; fundingRate: string }

async function fundingHistory(symbol: string): Promise<number[]> {
  // Funding pays every 8h (3×/day). limit=1000 ≈ 333 days — enough for a first-look yield gauge.
  const url = `${BASE}/fapi/v1/fundingRate?symbol=${encodeURIComponent(symbol)}&limit=1000`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) { console.error(`  ${symbol}: HTTP ${res.status}`); return []; }
    const rows = (await res.json()) as FundingRow[];
    return Array.isArray(rows) ? rows.map((r) => Number(r.fundingRate)).filter((x) => Number.isFinite(x)) : [];
  } catch (e) {
    console.error(`  ${symbol}: ${(e as Error).name}`);
    return [];
  }
}

const TAKER = Number(process.env.FEE_BPS ?? config.paper.feeBps) / 10000; // per side

async function main() {
  console.log(`FUNDING-CARRY FIRST-LOOK — recent ~333 days (funding every 8h), delta-neutral (long spot + short perp)\n`);
  console.log(`  ${"symbol".padEnd(10)}${"periods".padStart(8)}${"mean/8h".padStart(11)}${"annualized".padStart(12)}${"% positive".padStart(12)}`);
  const out: Record<string, number> = {};
  for (const s of SYMBOLS) {
    const rates = await fundingHistory(s);
    if (!rates.length) continue;
    const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
    const annual = mean * 3 * 365 * 100; // 3 fundings/day × 365 → %/yr (gross, if you're on the receiving side net-positive)
    const posPct = (100 * rates.filter((r) => r > 0).length) / rates.length;
    out[s] = annual;
    console.log(`  ${s.padEnd(10)}${String(rates.length).padStart(8)}${(mean * 100).toFixed(4).padStart(10)}%${(annual >= 0 ? "+" : "") + annual.toFixed(1)}%`.padEnd(0) + `${posPct.toFixed(0)}%`.padStart(12));
  }
  const avg = Object.values(out).length ? Object.values(out).reduce((a, b) => a + b, 0) / Object.values(out).length : 0;
  // Round-trip cost of establishing+unwinding BOTH legs (spot + perp), taker both sides ≈ 4 legs.
  const setupCostPct = TAKER * 4 * 100;
  console.log(`\n  Basket avg gross carry ≈ ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}%/yr.  One-time setup+unwind cost ≈ ${setupCostPct.toFixed(2)}% (4 taker legs).`);
  console.log(`  READ: positive funding ⇒ a LONG-spot/SHORT-perp basis trade EARNS this gross yield (market-neutral). It is`);
  console.log(`  NOT this directional bot (needs a spot leg), and net = gross − spot-borrow/basis drift − execution. A ~${avg >= 5 ? "meaningful" : "thin"}`);
  console.log(`  gross of ${avg.toFixed(1)}%/yr is ${avg >= 5 ? "worth a proper hedged backtest" : "probably too thin to bother after real-world frictions"}. First-look only — honest caveat: recent-window, one exchange, no basis-risk model.`);
}

main().catch((e) => { console.error(`fundingedge failed: ${(e as Error).stack ?? e}`); process.exit(1); });
