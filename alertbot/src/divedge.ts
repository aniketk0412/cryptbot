import "./env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { config } from "./config.js";
import { fetchDeepHistory, mean } from "./alphacore.js";
import { detectDivergences } from "./divergence.js";

/**
 * `npm run divedge` — do the bot's RSI/CVD DIVERGENCE alerts actually predict anything, or are they noise?
 *
 * The bot detects & alerts regular divergences (price HH / indicator LH = bearish; price LL / indicator HL =
 * bullish) but their edge was never measured. This replays deep history, fires each divergence the moment it
 * newly appears (bounded window, no lookahead), and measures the H-bar forward return IN THE PREDICTED
 * DIRECTION vs the market's unconditional drift. If a bearish divergence's forward short-return beats the
 * baseline short-return (and bullish beats baseline long), the signal has edge; if not, it's noise the user
 * should stop trusting. Split by indicator (RSI / CVD) and direction. In-sample, gross % over a fixed horizon.
 */

const SYMBOLS = config.watchlist;
const TARGET = 6000;
const START = 60;
const H = 24;             // forward horizon (bars) to judge the signal
const WIN = 250;          // bounded window fed to the detector

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const hit = (a: number[]) => (a.length ? (a.filter((r) => r > 0).length / a.length) * 100 : NaN);

async function main() {
  console.log(`DIVERGENCE EDGE — do RSI/CVD divergence alerts predict? ${SYMBOLS.join("/")} @ ${config.interval} (${H}-bar forward)\n`);
  const buckets: Record<string, number[]> = { "RSI-bullish": [], "RSI-bearish": [], "CVD-bullish": [], "CVD-bearish": [] };
  const baseFwdLong: number[] = [];

  for (const s of SYMBOLS) {
    const c = await fetchDeepHistory(s, config.interval, TARGET);
    if (!c || c.length < START + H + 100) { console.error(`not enough history for ${s} (${c?.length ?? 0})`); process.exit(1); }
    const n = c.length;
    let prev = new Set<string>();
    for (let i = START; i < n - H; i++) {
      baseFwdLong.push(c[i + H]!.close / c[i]!.close - 1);
      const window = c.slice(Math.max(0, i - WIN + 1), i + 1);
      const divs = detectDivergences(window);
      const cur = new Set(divs.map((d) => `${d.indicator}-${d.type}`));
      const fwdLong = c[i + H]!.close / c[i]!.close - 1;
      for (const d of divs) {
        const sig = `${d.indicator}-${d.type}`;
        if (prev.has(sig)) continue; // only when it NEWLY appears
        const predicted = d.type === "bullish" ? fwdLong : -fwdLong; // return in the signal's direction
        buckets[sig]!.push(predicted);
      }
      prev = cur;
    }
  }

  const baseLong = mean(baseFwdLong);        // market drift over H bars (long)
  const baseFor = (type: string) => (type.endsWith("bullish") ? baseLong : -baseLong); // baseline in the predicted direction
  console.log(`Baseline ${H}-bar drift: long ${pct(baseLong)} · short ${pct(-baseLong)}  (the market's unconditional move — what a signal must beat)\n`);
  console.log(`  signal          predicted-dir return   hit%    n     edge vs baseline`);
  let anyEdge = false;
  for (const sig of Object.keys(buckets)) {
    const a = buckets[sig]!;
    if (!a.length) { console.log(`  ${sig.padEnd(14)}  ${"—".padStart(18)}`); continue; }
    const m = mean(a), edge = m - baseFor(sig);
    if (a.length >= 25 && edge >= 0.004) anyEdge = true;
    console.log(`  ${sig.padEnd(14)}  ${pct(m).padStart(18)}   ${hit(a).toFixed(0)}%   ${String(a.length).padStart(4)}   ${(edge >= 0 ? "+" : "") + (edge * 100).toFixed(2)}pp${a.length >= 25 && edge >= 0.004 ? "  ✓" : ""}`);
  }
  console.log(
    `\nVERDICT: ${anyEdge
      ? `at least one divergence type beats its baseline by ≥0.4pp over ${H} bars (marked ✓) — a weak but real predictive tilt; could be worth a small confluence weight (validate OOS).`
      : `NO divergence type meaningfully beats the market's own drift over ${H} bars — the RSI/CVD divergence alerts are essentially NOISE as a standalone predictor. Keep them as context/curiosity, don't trade or weight them; the honest move is to stop treating them as signal.`}`,
  );
  console.log(`(In-sample, gross %, ${H}-bar horizon, ${SYMBOLS.length} symbols pooled. "Edge" = mean predicted-direction return minus the baseline drift in that direction.)`);

  const out = { generatedAt: new Date().toISOString(), symbols: SYMBOLS, interval: config.interval, horizon: H, baseLong,
    buckets: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, { mean: mean(v), hit: hit(v), n: v.length, edge: mean(v) - baseFor(k) }])), anyEdge };
  await mkdir(dirname("data/divedge.json"), { recursive: true });
  await writeFile("data/divedge.json", JSON.stringify(out, null, 2), "utf8");
  console.log("\nSaved → data/divedge.json");
}

main().catch((e) => {
  console.error(`divedge failed: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
