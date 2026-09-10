# cryptbot

A Solana cross-DEX arbitrage bot. **Paper trading first, live later.**

It watches a set of tokens and, for each, quotes `USDC → TOKEN → USDC` across
several DEXs (Raydium / Orca / Meteora) via the free Jupiter API. When it can buy
a token cheap on one venue and sell it dear on another, that's an arbitrage
candidate. It then applies a realistic cost model — fees, priority-fee bidding,
slippage, and the odds you actually **win the race** against faster bots — and
books the result to a virtual portfolio.

The point of paper mode is to answer one question honestly: **would this actually
make money, after costs, at my speed?** Get a reliably positive *expected* PnL
here before you even think about real funds.

## Setup

```bash
npm install
cp .env.example .env   # optional — paper mode needs no secrets
npm run paper          # run the live scanner (paper mode)
npm run analyze        # summarize everything in data/trades.jsonl
```

Requires Node 18+ (uses native `fetch`). No wallet, no RPC, no keys needed for paper mode.
`.env` (if present) is loaded automatically.

## CEX ↔ DEX monitor

DEX-vs-DEX spreads on liquid majors don't clear costs (the bot proves this). So it
also compares the best **on-chain DEX price** against a **centralized-exchange
order book** (Binance spot, free public API) for each token — CEX↔DEX gaps tend to
be larger and more persistent. Each cycle it logs, per token:

- `gross` — best-direction raw edge (buy DEX/sell CEX, or buy CEX/sell DEX)
- `net` — after DEX gas + CEX taker fee (~10bps) + USDC/USDT basis
- `direction` — which way the trade would go

Honest caveat: capturing a CEX↔DEX gap needs inventory on **both** sides, pays
taker fees, and carries latency / withdrawal / rebalancing risk the model only
approximates. Configure it under `config.cex` (set `enabled: false` to skip).

## Analyzing your results

After the scanner has run for a while, `npm run analyze` reads `data/trades.jsonl`
and prints your evidence base: per-token spread distribution (best / median /
worst, in bps), how often a real cross-venue edge cleared the threshold, and —
once trades are taken — realized vs. expected PnL. **Expected PnL is the number
that matters**; realized is noisy race luck.

## What you'll see

Each cycle scans every target token and prints one line per token:

- `no arb` — best buy and sell don't beat the edge threshold (the common case).
- `ARB` — a candidate above threshold. Shows gross edge, net-if-won, expected
  value, and a simulated race outcome (`WON`/`lost`).

At the end of each cycle it prints running totals, including **realized PnL**
(noisy, includes race luck) and **expected PnL** (the long-run number that matters).

Everything is also appended to `data/trades.jsonl` for later analysis.

## The knobs that matter (`src/config.ts`)

| Setting | Why it matters |
|---|---|
| `costs.winProbability` | The single biggest lever. With no infra edge, you lose most races. Start pessimistic (0.15). |
| `costs.priorityFeeSol` | What you bid to win ordering. Raise it and most "profits" evaporate. |
| `costs.executionSlippageFrac` | Price drift between quote and landing. |
| `minGrossEdgeBps` | How big a spread must be before you'd act. |
| `tradeSizeUsd` | Absolute profit scales with this; so does price impact. |
| `dexes` / `targets` | What venues and tokens you hunt across. |

### Adding tokens / DEXs safely

- **Tokens**: never hand-type a mint. Verify against the Jupiter Token API:
  `curl -s "https://lite-api.jup.ag/tokens/v2/search?query=<SYMBOL>"` and copy the
  exact `id` (mint) and `decimals`. A wrong mint = garbage quotes.
- **DEX labels must be exact.** Valid labels come from
  `curl -s https://lite-api.jup.ag/swap/v1/program-id-to-label`. Gotcha: `"Orca"`
  is **not** a valid label — use `"Whirlpool"` or `"Orca V2"`. A bogus label
  silently matches no pool (no error), quietly shrinking your venue set.
- Startup validation (`src/validate.ts`) catches malformed mints, bad decimals,
  duplicate symbols, and out-of-range knobs before the bot hits the network.

Tune these to *your* real assumptions and watch the expected PnL move. That's the
whole exercise.

## Going live (later)

`src/live.ts` is a stub that intentionally throws. When paper EV is consistently
positive, implement real execution there — re-quote, build an atomic swap / Jito
bundle, sign with a **throwaway wallet**, send with a priority fee, and book the
actual PnL. Don't skip the paper step.

## Honest expectations

The obvious arbs are already taken by faster bots. Expect mostly `no arb`, expect
the win-rate haircut to erase most paper "profit," and expect to spend your effort
on speed and routing, not on the strategy itself. This is a measurement tool, not
a money printer.
