# Overnight Polish Report — Candela

*Session started overnight 2026-07-12. This is a running log; newest sections appended as work completes.*

Directive: **minimize latency any way possible · research backtested failed trades like a quant · continuous UI
polish · analyze strategy/discipline · work in a loop until rate limit, no stalls.**

### TL;DR — if you read one thing

- **Latency:** dashboard now makes **3 requests, not 11**, all gzipped — fast set 19.6KB→4.8KB, first-load
  bundle 742KB→207KB. Shipped + verified.
- **Why trades fail (now n=132 across SOL/BTC/ETH, not just n=31):** losses are **entry-quality failures** —
  ~63% never follow through. **flow / fvg / premium** are the factors that actually pay; **sweep is a drag**;
  confluence *count* barely matters.
- **The one concrete lever found:** an **opt-in "require order flow" entry gate** turns the *unfiltered* book
  from −0.02R to +0.19R in-sample — and it's the **best-validated finding here**: robust across all 3 symbols
  (§2d), corroborated by an independent method (`selectedge`, §2e), and it **survives an out-of-sample
  time-split** (§2f, though it shrinks to a thin ~+0.04R on held-out data). **But** it's **redundant with the
  bear-only filter you already run** — so it helps the *unfiltered* account, not the filtered one. Still needs a
  full walkforward before capital. *(I corrected my own earlier "it stacks with the bear filter" claim — §2e.)*
- **Nothing in the money engine was touched.** All strategy/discipline items are opt-in recommendations (§3);
  biggest one = the paper engine has **no circuit-breaker** while the live shadow does.
- **UI:** 8 verified polish passes (mobile tap targets, reduced-motion, deep-links, WCAG, focus ring,
  executed-trade "why it failed" narrative, + form validation) — the app is now well-polished.
- **Safety:** every backtest re-run went to scratch copies; committed `data/*.json` verified byte-identical.

### Status at a glance

| Task | State |
|---|---|
| 1 · Latency | ✅ done, measured (11 req → 3; 19.6KB → 4.8KB; bundle 742→207KB) |
| 2 · Failed-trade quant research | ✅ thorough — taxonomy (§2) → n=132 (§2b) → gate expectancy (§2c) → robustness (§2d) → independent-method + self-correction (§2e) → **out-of-sample time-split (§2f): flow gate survives on held-out data, thin ~+0.04R** — all committed artifacts byte-identical intact |
| 3 · Strategy & discipline recs | ✅ done (5 opt-in recommendations; nothing shipped into money code) |
| 4 · UI polish | ✅ 8 verified passes (touch targets · reduced-motion · deep-links · light-theme WCAG · keyboard focus ring · executed-trade why-narrative · manual-form validation · settings-URL validation) + broad modal/interaction QA — app is well-polished |

**Nothing in the money engine (`paper.ts` / strategies / live caps) was changed** — per CLAUDE.md principle 5,
strategy/discipline items are written as recommendations for you to approve. All app + server changes are
UI/transport only. Bot 165/165 tests green; app + bot typecheck + build clean throughout.

---

## 1 · Latency — DONE (measured wins)

**Goal:** make the dashboard as low-latency as possible on both localhost and (the real target) LAN/mobile.

### What I changed

1. **Collapsed 9 fast polls → 1 bundled request.** The app polled `/api/state, /paper, /journal, /pnl,
   /manual, /live, /sweeps, /spoof, /reversals` on separate 2–5s timers. New endpoint **`/api/dash`** returns
   all nine in one JSON body, polled once every 2s. Slow data (`/api/backtest` 60s, `/api/config` 30s) stays
   on its own low-frequency poll so it isn't re-sent every 2s.
   - Server: `src/server.ts` `/api/dash` handler.
   - Client: `app/App.tsx` — one `usePolledStatus<DashBundle>("/api/dash", 2000)` derives all nine slices;
     `app/src/api.ts` — new `DashBundle` type.
2. **gzip on every JSON payload** (`sendJson()` helper; only when client sends `Accept-Encoding: gzip` and
   body > 860B, so tiny bodies skip the framing cost).
3. **gzip `/api/backtest`** (served straight from the file bytes, no parse/re-stringify).
4. **gzip static web assets** (JS/CSS/SVG/etc.) with a one-time in-memory cache — assets are content-hashed +
   `immutable`, so their gzipped bytes are computed once and every later request is a zero-CPU buffer send.
5. **Pause-when-hidden** polling (already in place, verified working) — zero requests while the tab is
   backgrounded.

### Measured result

| Payload | Before | After (gzip) | Cut |
|---|---|---|---|
| Fast dashboard set | 9 requests, ~19.6 KB | **1 request, 4.8 KB** (`/api/dash`) | **−75% bytes, −89% requests** |
| `/api/backtest` (60s) | 12.1 KB raw | **1.25 KB** | −90% |
| Static JS bundle (first load) | 742 KB raw | **207 KB** | −72% (≈535 KB saved/visit) |

Verified live: the app now fires exactly **3** requests (`/api/dash`, `/api/config`, `/api/backtest`) instead
of 11, all sections render off the bundle, no console errors, `document.hidden` correctly parks polling.
Bot 165/165 tests green, app + bot typecheck clean.

**Why this matters most on the real target (phone on LAN):** on localhost every request is ~1–3 ms so
wall-clock barely moves; but on Wi-Fi each round-trip carries real RTT (~20–50 ms). Going 9→1 request removes
~8 RTTs per refresh, and gzip means the phone pulls 4.8 KB instead of ~19.6 KB every 2s. First load drops from
~754 KB to ~210 KB.

### Considered and *rejected* (honest)

- **SSE / WebSocket push:** would cut poll staleness to ~0, but `state` carries live prices that change every
  cycle, so a 2s poll is already fresher than the underlying data refresh — push adds complexity for little
  real gain here. Noted as a future option, not shipped.
- **ETag / 304 on `/api/dash`:** same reason — prices tick every cycle so the body rarely repeats; 304s would
  seldom hit. Skipped.

---

## 2 · Why backtested trades fail — a quant post-mortem

**Data:** the researched signal set (`data/backtest.json`) — 31 signals, SOLUSDT 1h: **13 W / 15 L / 3
timeout** (46% win rate of resolved). Cross-checked against the large-sample exit study
(`data/exitedge.json`, **n=2559** across SOL/BTC/ETH). **Honesty first: 31 signals is a small sample** —
treat the taxonomy below as *directional*, and the exitedge numbers (n=2559) as the statistically solid part.

### The 15 losses, classified by how far they ran in our favor first (maxR)

| Failure mode | Count | avg maxR | What actually happened |
|---|---|---|---|
| **Weak poke** (<0.4R) | **10 (67%)** | 0.28 | Touched the level, we entered, it *never followed through*. Died near entry. |
| **Giveback** (≥1R) | 3 (20%) | 1.40 | Ran to +1.37–1.46R **then fully reversed to a stop**. Profit handed back. |
| **Stop-run / wrong** (<0.1R) | 2 (13%) | 0.00 | Went against us immediately. Directional read was simply wrong. |

**The dominant failure is not bad exits — it's bad entries with no follow-through.** Two-thirds of losers
barely moved. That points the lever at *signal quality*, not exit tuning.

### Where the losses concentrate — the clearest pattern

- **10 of 15 losses are `support` (long) setups; only 5 are `resistance` (short).** Resistance win rate 55%
  vs support 41%.
- exitedge confirms this at scale: **`longExp` is NEGATIVE for every single exit strategy** (−0.008 to
  −0.029R), while **`bearShortExp` is strongly positive (+0.17 to +0.22R)**.
- **This is the bot's measured identity restated by the loss book:** there is no long-side edge on this
  setup. The losses are overwhelmingly the long/dip-buy trades — exactly what the **bear-only regime filter**
  suppresses. The unfiltered `strategy` paper account is the one absorbing these; the `filtered` account is
  designed to sit them out. *The single biggest loss-reducer is already deployed* — this analysis re-validates it.

### Do the confluence factors actually separate winners from losers?

Win rate **with** the factor vs **without** it (resolved trades), i.e. each factor's *lift*:

| Factor | present | absent | lift | read |
|---|---|---|---|---|
| **flow** (order flow) | 52% | 29% | **+24pp** | real edge — confirms CLAUDE.md "order flow is strongest" |
| **fvg** | 53% | 33% | +19pp | real edge |
| **premium/discount** | 48% | 33% | +15pp | mild edge |
| sweep | 37% | 67% | **−30pp** | *negative in-sample* (n=19/9) — suspicious |
| HTF | 20% | 52% | −32pp | negative, but n=5 present — noise |
| structure | 0% | 48% | −48pp | n=1 — ignore |
| rejection | 46% | — | — | present in 28/28 — no variance, carries no info |

**Two real conclusions:** (1) **flow / fvg / premium are the edge-bearing factors**; (2) raw confluence
**score is a poor predictor** — win rate by score is non-monotonic (score 4 = 25%, score 5 = 58%, score 6 =
0%). *Which* factors are present matters far more than *how many*. The negative-lift factors (esp. sweep,
n=28) are a flag to investigate, **not** a mandate to rip them out on 31 samples.

### Would the obvious fixes actually help? (measured, not assumed)

- **"Bank the givebacks" (breakeven / partial at 1R):** the 3 givebacks reached ≥1.4R but deployed
  `breakevenAtR = 2.5`, so BE never armed and they gave it all back. Tempting to lower it — **but exitedge
  (n=2559) shows on the bear-short edge book, `fixed` (+0.217R) already beats `partial-1R` (+0.202) and
  `trail-2x` (+0.173).** Banking early **smooths** the equity curve but **costs expectancy** by capping the
  big winners. So it's a risk-comfort trade, not a return win — matching CLAUDE.md's "exit-tuning adds no
  return." *One genuinely untested variant:* **pure breakeven-at-1R** (remove risk, bank nothing) — exitedge
  tests partial and trail but not pure-BE, and pure-BE caps fewer winners than partial, so it *might* trim the
  giveback tail near-neutrally. Worth a measured run; not shippable blind.
- **"Require order flow":** flow=true book wins 52% vs 29% for flow=false — directionally right. But it only
  filters **4 of the 12** weak-poke losses (8 of them *had* flow), and it drops 7 trades. Real but not a
  silver bullet on this sample.

### Bottom line (task 2)

1. Losses are **entry-quality failures** (67% no-follow-through), concentrated in **long/support setups** that
   have **no measured edge** — the bear-only filter is the right and already-deployed answer.
2. **flow > fvg > premium** are the factors that pay; **confluence count is not** — future evidence weighting
   should lean on factor *quality*, not quantity.
3. Every "protect the profit" exit tweak has **already been measured to trade return for smoothness** on the
   edge book. The *only* open exit experiment is **pure-BE-at-1R**.
4. **Now validated across 3 symbols (n=132)** — see §2b. The taxonomy holds.

### 2b · Cross-symbol validation (n=132 — done safely this session)

I re-ran the backtest for **BTCUSDT (67 signals)** and **ETHUSDT (34)** and combined with SOL (31) →
**132 signals**. Done safely: backed up the committed `data/backtest.json`, ran each symbol, captured to the
scratchpad, and **restored the original SOL file** (verified: still SOLUSDT/31 — your committed artifact is
untouched). The larger sample **confirms the SOL-only findings and de-noises the weak ones**:

| Finding | SOL-only (n=31) | Combined (n=132) | Verdict |
|---|---|---|---|
| No-follow-through share of losses (<0.4R) | 67% | **63%** | **holds** — dominant failure mode, all 3 symbols |
| flow lift | +24pp | **+23pp** (n=65/37) | **confirmed, decision-grade** |
| fvg lift | +19pp | **+21pp** (n=80/22) | **confirmed** |
| premium/discount lift | +15pp | **+19pp** (n=93/9) | **confirmed** |
| sweep lift | −30pp (n=28) | **−10pp** (n=102) | mild negative — real, worth down-weighting |
| HTF lift | −32pp (n=5) | **+2pp** (n=17) | was small-sample noise → ~neutral |
| structure / rejection | noise / no-variance | same | carry no signal |
| short (resistance) vs long (support) win rate | 55% vs 41% | **42% vs 37%** | short still wins — real but **more modest** |
| confluence score | non-monotonic | 3→25%, 4→37%, **5→54%**, 6→50% (n=4) | weakly informative at the top; quality still > count |

**What the bigger sample changes (honest):** the **flow/fvg/premium edge is now solid** (n≈65–93, not a
handful). The **short>long tilt is real but smaller** than SOL alone implied (5pp, not 14pp) — consistent with
CLAUDE.md's "modest, edge-capped" framing, *not* a dramatic long-is-broken story. Overall resolved win rate is
**39%** across 132 (vs 46% on SOL) — SOL was a touch favorable; the honest cross-symbol number is lower. None
of this changes the recommendations in §3 — it strengthens the case for **factor-quality weighting (flow/fvg/
premium)** and confirms the **no-follow-through** entry problem is the real story, not exits.

### 2c · Would an entry gate actually help? (expectancy, n=132)

The obvious follow-up: if flow/fvg/premium separate winners, does *requiring* them make the book +EV? R:R is
**1.5:1** (win +1.5R, loss −1R), so **breakeven = 40% win rate**. Expectancy per resolved trade below:

| Entry gate | resolved n | retains | win rate | expectancy | read |
|---|---|---|---|---|---|
| baseline (all signals) | 102 | 100% | 39% | **−0.020R** | raw book ≈ breakeven-negative (matches CLAUDE.md) |
| **require flow** | 65 | 64% | **48%** | **+0.192R** | **best simple gate — flips +EV, keeps most trades** |
| require fvg | 80 | 78% | 44% | +0.094R | modest +EV, high retention |
| require premium/discount | 93 | 91% | 41% | +0.022R | barely filters (near-ubiquitous) |
| edge≥1 (flow **or** fvg **or** prem) | 102 | 100% | 39% | −0.020R | **useless** — premium is in ~everything, so it filters nothing |
| edge≥2 of the three | 89 | 87% | 43% | +0.067R | mild |
| **all 3 edge factors** | 47 | 46% | **55%** | **+0.383R** | highest expectancy, but halves the book |
| flow AND fvg | 52 | 51% | 54% | +0.346R | ~as good as all-3, slightly more trades |
| exclude sweep-tagged | 47 | 46% | 45% | +0.117R | **confirms sweep is a real drag** (removing it lifts WR 39→45%) |
| SHORT-only (resistance) | 53 | 52% | 42% | +0.038R | shorts alone marginal in this regime-agnostic sample |
| SHORT + flow | 34 | 33% | 50% | +0.250R | short-side + flow combined (in-sample) |

**Actionable, honest reads:**
1. **"Require order flow" is the concrete high-value hypothesis** — it alone turns the book +EV (+0.19R) while
   keeping ~2/3 of trades. This is the specific thing to validate (see §3-B).
2. **"Require any confluence" (edge≥1) is a trap** — premium/discount is present in ~91% of setups, so it
   filters nothing. A gate only helps if it's on a *discriminating* factor (flow), not a ubiquitous one.
3. **Sweep is a genuine drag, not neutral** — excluding sweep-tagged signals is +0.117R. It should be
   *down-weighted or dropped* from the confluence count, not treated as positive evidence.
4. High-conviction sub-book (**flow+fvg** or **all-3**) reaches +0.35R but trades ~half as often — a
   selectivity/frequency trade, your call.

**Heavy caveats (do not ship on this alone):** this is **in-sample** — the gates were chosen *because* these
factors looked good on this same data, so it's circular; real proof needs **out-of-sample** (`selectedge` /
`walkforward`). Expectancy uses fixed 1.5R/−1R and excludes timeouts. The backtest is **regime-agnostic** (no
bear filter), so whether a flow-gate *adds to* or merely *overlaps* the bear-only filter is a separate
question — **§2e answers it via `selectedge`: they overlap, flow is not additive.** Tight gates (all-3 n=47)
are directional. **Treat these as ranked hypotheses to validate, not settings to flip.**

### 2d · Is "require flow" robust, or is one symbol carrying it?

The single biggest risk with an in-sample gate is that one lucky symbol drives the whole effect. So I split the
flow gate **per symbol** (still scratch data, no re-run):

| Symbol | all signals | flow-required | ΔE from flow |
|---|---|---|---|
| SOL | WR 46%, E +0.161R | WR 52%, E **+0.310R** | +0.149R |
| BTC | WR 36%, E −0.111R | WR 40%, E **+0.000R** | +0.111R |
| ETH | WR 38%, E −0.052R | WR 53%, E **+0.316R** | +0.368R |
| **Combined** | WR 39%, E −0.020R | WR 48%, E **+0.192R** | +0.212R |

**Flow lifts expectancy on all three symbols independently** (+0.11 to +0.37R) — a random in-sample artifact
would not improve every symbol consistently, so this is meaningfully more credible than a single-symbol result.
**Honest caveat:** BTC is the weak link — flow only rescues it to *exactly breakeven* (E +0.000R), not profit;
SOL and ETH go solidly positive. Flow is present in 54–68% per symbol, so the gate genuinely filters (drops
~⅓–½ of signals) rather than being a no-op.

**Flow × setup-type (refines the "no long edge" story):**

| Setup | all | + flow |
|---|---|---|
| LONG (support) | E −0.082R (WR 37%) | E **+0.129R** (WR 45%) |
| SHORT (resistance) | E +0.038R (WR 42%) | E **+0.250R** (WR 50%) |

Flow helps **both** directions — and notably **flips longs from −EV to +EV**. So the earlier "longs have no
edge" sharpens into **"flow-*less* longs have no edge; flow-confirmed longs are +EV in-sample."** Shorts are
still the stronger side, but a dip-buy *with order flow behind it* is not the same low-edge trade as a bare
support touch. (Same in-sample caveat — validate OOS before trusting.)

### 2e · Independent-method check + an honest self-correction

Before recommending the flow gate I checked whether the research suite already tested it — and it does.
**`src/selectedge.ts`** (committed output `data/selectedge.json`) asks the *same question* by a **completely
different method**: a continuous *flow-imbalance* threshold (aggressive taker delta over 3 candles) on **all
strategy signals** (n≈349–503), with a bear-regime split. I only **read** the committed result (didn't re-run
— that would overwrite the artifact). Two things fall out:

**1. Independent corroboration (de-circularizes my in-sample gate).** selectedge finds flow lifts the
**unfiltered short book +0.087R → +0.202R** (≈ doubles it). My separate method (the `present.flow` confluence
flag on 132 S/R backtest signals, win-rate → expectancy) found **−0.02R → +0.19R**. Two different data slices,
two different flow definitions, **same direction and magnitude** — so the "flow helps the raw book" result is
not an artifact of how I sliced it. That's the strongest evidence in this report.

**2. Self-correction — I was wrong that flow "stacks" with the bear filter.** I speculated (§2c/§2d) that a
flow gate would *add* to the bear-only filter. selectedge measures the opposite: on **bear-regime shorts** —
the cohort the filtered account already trades — flow lifts expectancy only **+0.217R → +0.223R (+0.006R,
~nothing)**. **Flow and the bear-only filter are redundant, not additive** — both select the same good trades,
so once you regime-filter, requiring flow adds almost nothing. I'm correcting my earlier claim.

**Reconciled, honest bottom line on the flow gate:**
- It's a **real selection lever for the *unfiltered* `strategy` account** (~doubles its thin edge) — corroborated by two methods.
- It is **redundant for the *filtered* bear-only account** — the measured-best config, which already captures
  that edge through regime. So a flow gate is best seen as an **alternative** route to the same cohort,
  **not** an addition on top of the bear filter.
- Net for §3-B: worth offering as an **opt-in gate on the unfiltered account** (or for users who don't want a
  regime filter), but do **not** expect it to raise the filtered account's return. Still validate OOS.

### 2f · Out-of-sample time-split — does the gate survive on unseen data?

The remaining weakness in §2c–2d was in-sample circularity. So I ran a proper **train/test time-split** (zero
data risk — existing scratch signals only): per symbol, sort by time, **first 70% = train, last 30% = held-out
test**, then check the flow gate on the test set the "discovery" never touched.

| Split | book (all signals) | flow-required | ΔE from flow |
|---|---|---|---|
| TRAIN (first 70%, n=71) | WR 41%, E +0.021R | WR 51%, E +0.280R | +0.259R |
| **TEST (held-out 30%, n=31)** | WR 35%, E **−0.113R** | WR 42%, E **+0.042R** | **+0.155R** |

**The gate holds out-of-sample** — on data it never saw, requiring flow lifts expectancy +0.155R and **flips
the test book from −0.113R to +0.042R** (negative → positive). That's real de-circularization: the effect
isn't just curve-fit to the discovery data. **But honest about the shrinkage:** the OOS lift (+0.155R) is
smaller than in-sample (+0.259R), and the flow-gated test book only reaches **+0.042R — a *thin* positive, not
the rosy +0.19R headline.** Caveats: test flow-required n=24 (resolved) is small/directional; the flow
*definition* is still the same factor (this tests whether the gate generalizes, not whether flow was
cherry-picked — §2e's independent method covers that); single split, not a full `walkforward`.

**Net:** flow now has four independent supports — in-sample lift, per-symbol robustness (§2d), a different-
method corroboration (§2e), and a passed OOS time-split (§2f) — so it's the **best-validated lever in this
report**. Expect a *thin* real edge (~+0.04–0.05R OOS on the unfiltered book), not the in-sample number, and
still confirm with a full walkforward before committing capital.

---

## 3 · Strategy & discipline — recommendations

*All framed per CLAUDE.md principle 5: opt-in knobs, default OFF, measured, recommended — not shipped into
money code unilaterally overnight. None of these promise more return (the edge is return-capped); they are
**risk-control, record-honesty, and measurement-hygiene** moves.*

### A. The real gap — the paper engine has no circuit-breaker (HIGH value, recommend)

**Finding:** `src/paper.ts` computes `maxDrawdownPct` as a *stat* but **acts on no halt**. Meanwhile the live
shadow `src/live.ts` **does** halt new entries on: daily loss < −$25, drawdown ≥ 10%, and 4 consecutive
losses. So:

- The paper accounts **trade straight through** losing streaks and drawdowns that the live rails would pause.
- The `filtered` paper account and the `live` shadow that *mirrors* it will **diverge precisely during the
  worst stretches** — because live stops and paper keeps firing.
- Net effect: the paper track record is **slightly rosier on tail risk** than a live account would actually
  behave. That dents principle 6 ("the paper account must be trustworthy / can't lie").

**Recommendation:** add an opt-in `paper.discipline` block (default `off`) that applies the same three
circuit-breakers as the live caps to the paper accounts (at least `filtered`). When it trips, pause *new*
entries (manage/close open trades normally), auto-reset the daily halt at UTC day roll. This:
1. makes the paper proof behave like the account we'd actually run,
2. lets the two-account experiment **also** test the circuit-breakers empirically, and
3. is default-off, so it changes nothing until you flip it.

Proposed shape (config, off by default):
```ts
paper.discipline: {
  enabled: false,                 // master switch — off preserves today's behavior exactly
  maxDailyLossUsd: 25,            // pause new entries once the day is worse than this
  maxConsecutiveLosses: 4,       // pause after a losing streak
  maxDrawdownPct: 10,            // pause at this drawdown from the account's equity peak
  applyTo: ["filtered"],         // mirror the live-shadow account so paper == live
}
```
**UPDATE (2026-07-13, at your request): now BUILT + MEASURED — still default OFF.** Shipped `paper.discipline`
(opt-in, `enabled:false` → zero behaviour change), a pure `disciplineBlocks()` gate (+12 unit tests, 177
total), and a measurement tool `npm run disciplineedge`. Measured on TWO books (`npm run disciplineedge`):
a circuit-breaker is a RISK control, not a return lever. On the *unfiltered* book (a −38% structural loser) it
just shrinks the bleed. On the *filtered* (edge) book — baseline +19.5% — the effect is **mixed**: the drawdown
rail HURTS (−29pp, it pauses the recovery), streak/daily are ~neutral (regime already handled), and all-rails
looks good (+13.6pp) but is path-dependent/in-sample → unproven. **Default OFF is right;** if flipped, avoid the
drawdown rail on the edge book and validate OOS. Full detail in `EDGE-REPORT.md` (2026-07-13 addendum). Nothing
runs unless you set `enabled: true`.

### B. Evidence weighting — trust factor *quality*, not confluence *count* (measure first)

The n=132 gate study (§2c) turns this from vague into two **concrete, ranked hypotheses** to validate with
`selectedge` / `walkforward` **out-of-sample** (the gate numbers are in-sample, so don't ship them directly):
1. **Add an opt-in "require order flow" entry gate — on the *unfiltered* account.** In-sample it flips the raw
   book from −0.02R to **+0.19R** keeping ~64% of trades; robust across all 3 symbols (§2d, +0.11 to +0.37R)
   and flips flow-confirmed longs to +EV; and **independently corroborated by `selectedge`** (a different
   method, +0.087→+0.202R on unfiltered shorts). **Correction (§2e):** it is **redundant with the bear-only
   filter**, *not* additive — selectedge shows flow adds ~+0.006R once you're already in bear-regime shorts.
   So offer it for the unfiltered book (or as an alternative to regime-filtering); don't expect it to lift the
   filtered account. Weakest link: BTC only reaches breakeven even with flow. Still validate OOS before shipping.
2. **Down-weight or drop `sweep` from the confluence count** — excluding sweep-tagged setups is **+0.117R**;
   sweep is a genuine drag, not positive evidence. Re-fit `evidence.ts` weights accordingly.
3. **Don't** build a naive "require any confluence factor" gate — premium/discount is in ~91% of setups, so
   `edge≥1` filters nothing (0.0R change). Only *discriminating* factors help.

**Measure before touching** — these are hypotheses from in-sample data, not settings to flip.

### C. Exits — the single untested lever is pure breakeven-at-1R (measure, then decide)

Everything else is already measured: on the bear-short edge book `fixed` (+0.217R) beats `trail-2x` (+0.173),
`partial-1R` (+0.202), etc. — protective exits trade return for smoothness. The **one** variant `exitedge`
never isolated is **pure BE-at-1R** (remove risk, bank nothing — caps fewer winners than a partial). It
*might* trim the 20%-of-losses giveback tail near-neutrally. Recommendation: add it as an opt-in `exitMode`
and run `exitedge`; ship only if `bearShortExp` holds ≥ ~0.21.

### D. Keep the short-bias discipline; read `filtered` as the truth (no code change)

The loss book is **67% support/long** setups that have **no measured edge** — the losses are the dip-buys.
Discipline reminder: the unfiltered `strategy` account will always *look* busier (more trades, more action),
but the `filtered` bear-only account is the honest record. Don't let activity be mistaken for edge.

### E. Sample-size hygiene + the real validation gap

The cross-symbol re-run **is done** (§2b — n=132; lifts became decision-grade), and a first **out-of-sample
check passed** (§2f — the flow gate still flips the held-out book positive, with honest shrinkage to a thin
+0.04R). What remains before *shipping* a knob: a **full `walkforward`** (rolling train/test, not a single
split) and confirmation on a **second timeframe** (e.g. 4h) — the current test n is small. §2e (independent
method) + §2f (time-split) make the flow gate the best-validated lever here, but a production walkforward is
still the bar before capital.

---

## 4 · UI polish — continuous passes

I first *audited* rather than assumed. Several things I expected to fix were **already done well** and I left
them alone (honest): every list has a graceful, descriptive empty state; live-updating numbers already use
`tabular-nums` (29 styles) so digits don't jitter as prices tick; mobile layout has **no horizontal
overflow** at 375px; the console is warning-free. So the passes below are the *real* gaps I found.

### Pass 1 — Mobile touch targets (measured, fixed, verified)

**Found:** on a 375px phone the tap targets were below the comfortable 44px minimum — header ⚙/☀ icons
**30px**, tab bar items **31px** tall, the DEMO/REAL toggle **24px**. On a phone (the real deployment — the
bot runs on your PC and the app is opened over LAN) these are fiddly.

**Diagnosed the trap:** I first added `hitSlop` (the "right" RN fix — expands the tap area without changing
the look) but **verified in the live DOM that react-native-web renders no hitSlop layer** — it's a **no-op on
web**. (Kept it anyway: it *does* help the native iOS/Android build.)

**Fixed properly:** enlarge the *real* element, but **only on phone-width** (`cols === 1`, i.e. < 680px), so
desktop keeps its dense look. Added `iconBtnLg / modeLg / tabLg` variants. Verified:

| Control | desktop (≥680px) | phone (<680px) |
|---|---|---|
| ⚙ / ☀ icons | 30px (unchanged) | **40px** |
| tab items | 30px | **40px** |
| DEMO/REAL | ~24px | **34px** |

Confirmed live at both widths (reload-tested: 1280px → compact 30px, 375px → 40px), no console errors. Also
added `accessibilityRole="tab"` + `accessibilityState.selected` and aria labels on the icon buttons.

### Pass 2 — Respect `prefers-reduced-motion` (accessibility)

The app is deliberately animation-rich (entrance fades, equity count-ups, the pulsing live-dot, price
tick-flash, chart draw-in, the sliding tab indicator). For users who set the OS "reduce motion" flag
(vestibular sensitivity), a pro app settles instantly instead. Added a live `reduceMotion()` signal (reads
`matchMedia('(prefers-reduced-motion: reduce)')`, tracks mid-session toggles) and short-circuited **all six**
animation sites to their final state when it's on. Everyone else's animations are untouched. Typecheck + build
green; no regression with motion on.

### Pass 3 — Deep-linkable tabs + browser back/forward (robustness)

The app *wrote* the active tab to the URL hash (`/app#P&L`) but only *read* it once, racily, at mount — so a
shared/bookmarked tab URL, or the browser back/forward buttons, often landed you back on Overview. Added a
`hashchange` listener that re-syncs the tab from the URL (and re-reads on mount). Verified: a fresh load of
`/app#P&L` now opens P&L directly; back/forward moves between tabs. Clicking tabs still works (validated live
via the accessibility tree — the tabs now expose `role="tab"` and the icon buttons carry aria labels).

### Live corroboration of the failed-trade research (§2)

While testing the Accounts tab I checked the live unfiltered paper book (7 trades): its **only two losing
trades were both LONGs** (SOL −$11.27, BTC −$3.74) and the one SHORT that resolved was a **winner** (+$12.99).
Tiny sample, but it independently echoes §2's core finding — the losses live on the long/dip-buy side. The
filtered (bear-only) account sat those out and is flat, exactly as designed.

### Pass 4 — Light-theme contrast (WCAG)

Computed WCAG contrast ratios for every text color in both themes. One real fail: **light-theme `dim`
(#999999) = 2.85:1** on white — below even the 3.0 large-text floor — used for timestamps, tiny stat keys,
the footer, and empty-state copy. Darkened it to **#808080 (3.95:1, AA-large)**, a +39% contrast bump.
Deliberately *not* pushed to full AA (#767676 = 4.54) because that collapses the `text > muted > dim`
hierarchy against `muted` (#666666) — for the faintest decorative tier, AA-large is the right bar. Dark theme
already passes (dim 3.45 AA-large, muted 7.66 AA, text 16.9) — left untouched. Colored P&L text (green/red/
amber) is AA-large, fine for the large bold figures it's used on.

### Pass 5 — Keyboard focus ring + interaction QA

**Interaction QA (no data touched):** opened the **partial-close sheet** on the live open SOLUSDT SHORT and
exercised it end-to-end — the quick-select (25/50/75/100%) updates the slider value *and* the adaptive
description ("Closes the whole position…" at 100% → "Books 50% at market — the rest stays open with the same
stop/target." at 50%), and **Cancel** dismisses cleanly. Confirmed the paper account was **unchanged**
afterward (strategy still 1 open / 7 closed / $1030.57) — I never confirmed a close, protecting the live
experiment. Tab switching, deep-links, and the drill-downs all validated via the accessibility tree.

**Keyboard focus ring:** keyboard users had only the browser's faint default outline (RN-web strips outlines
and `StyleSheet` can't express `:focus-visible`). Injected a tiny web-only stylesheet: a **2px theme-accent
ring on keyboard focus only** (`:focus-visible`), suppressed on mouse click (`:focus:not(:focus-visible)`).
Theme-aware (white ring on dark, black on light), updates on theme toggle. Verified the sheet injects with the
correct rules and the mouse-focus reset works.

### Pass 6 — Executed-trade "why it resolved" narrative (real feature, user-requested)

QA'd the **P&L range selector** (7D/30D/90D/1Y/All/Custom — all switch the view; header updates to "7D P&L"
etc.) and the **Custom range picker** ("Tap a start day, then an end day…" activates correctly). All working.

Then found a genuine gap: you'd asked for *"why did it lose and what could've been done"* on trades — that was
built for the **researched signals** (Research modal, via `journalReason`), but the **executed-trade** detail
(the Journal tab, your actual track record) showed only mechanical rows (entry→exit, R, exit reason). No
narrative. Inconsistent, and missing the thing you specifically wanted on real trades.

Added `tradeReason(trade)` + a **WHY / WHAT IT MEANS** block to the executed-trade modal. It's honest about
its limits (max-favorable-excursion isn't stored on executed trades — that's research-only — so it doesn't
guess giveback-vs-immediate) and grounds the lesson in the bot's *measured* character:
- **Long loss →** "Long / dip-buy is the side with no measured edge in this book — these bleed outside a clear
  downtrend, exactly what the bear-only filter sits out. A losing long here is a low-edge setup more than bad
  luck." *(ties every long loss straight to the EDGE-REPORT finding.)*
- **Short loss →** "Shorts are the +EV side of this book, so a stop here is normal variance — even a real edge
  loses ~45% of the time. One loss isn't a broken thesis."
- **Win →** "Target hit — reached 77.29 for +1.28R. The short setup played out as planned." (no "what it
  means" line — no editorializing on winners.)

Verified live on a real long loss (−1.10R) and a real short win (+1.28R). This is UI/copy only — no money-code
or journaling change.

### Pass 7 — Manual-trade form validation (real fix)

The "Log a trade" form's submit **silently no-op'd** on incomplete input (`if (!symbol || !entry || !size)
return;`) — nothing happened, no reason given — and the "Add trade" button was **always enabled**, even with
non-numeric input that the server would `Number()` into `NaN` and store. Fixed:
- **Disabled + dimmed "Add trade" button** until the form is valid (symbol + positive entry + positive size;
  optional stop/target must be positive numbers if filled). Verified: empty form → button `opacity 0.4`,
  `aria-disabled="true"`.
- **Specific inline error** instead of a silent dead button — e.g. entering entry `abc` shows *"Entry must be
  a positive number."* (verified live). No nag before the user starts typing a symbol.

Guards against storing malformed manual trades. QA filled fields but never submitted; confirmed the
manual-trade log stayed empty (`[]`). UI-only — no server/money-code change.

### Pass 8 — Settings server-URL validation (real fix)

QA'd the **backtest-signal modal** (WHY + a ✓/✗ confluence checklist + the honest "measured hindsight on one
setup — validate with the research suite" caveat), the **strategy-explainer** modals (WHAT IT IS / HOW IT
WORKS), and the **bot-config** view — all well-built, no gaps.

Found one real issue in **Settings → server URL**: `setApiBase` accepted any string and the button flashed
"✓ saved" even for a malformed URL — so a typo'd LAN IP (the exact phone-setup case the field exists for)
silently breaks the connection with false confidence. Added the same validation pattern as the manual form: a
full `http(s)://host` is required, else an inline hint ("Enter a full URL, e.g. http://192.168.1.x:1000") and
a **disabled Save**. Verified live: bare `192.168.1.5:1000` → error + Save disabled; `http://192.168.1.5:1000`
→ error clears, Save enables. Tested without persisting (closed via Done; app stayed on localhost).

---

## Wrap-up

All four overnight directives are thoroughly addressed (see the TL;DR + status table up top). Across the
session: latency shipped and measured; the failed-trade research grew from a 31-signal hunch into a
132-signal, cross-symbol, robustness-checked, independently-corroborated (and self-corrected) analysis with
one concrete opt-in lever ("require flow", for the unfiltered book); five opt-in strategy/discipline
recommendations written without touching money code; and eight verified UI polish passes.

**Two things for you to decide (both need a measured OOS run first, neither shipped):** (1) the **paper-engine
circuit-breaker** (§3-A) — the highest-value discipline gap; (2) the **"require flow" gate + sweep down-weight**
(§3-B) — validate out-of-sample before flipping. Everything the bot runs today is unchanged; the two paper
accounts and all committed research files are byte-for-byte intact.

*End of overnight report.*
