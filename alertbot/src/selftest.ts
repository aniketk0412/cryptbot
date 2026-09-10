// Zero-dep unit tests for the core pure logic. Run: `npm test`.
// Pure functions only (no files / no network) so it's safe to run anytime.
import { assessBet, factorsFromConfluence } from "./evidence.js";
import { applyStructureTps, buildConfirmPlan, buildPlan, planFrom, structureLevels } from "./plan.js";
import { volumeProfile } from "./volumeprofile.js";
import { correlatedCapReached, disciplineBlocks, type DisciplineCaps, feeBlocksTrade, inNewsBlackout, limitTouched, type NewsBlackoutCaps, marketRegimeBlocks, mtfAlignBlocks, partialClosePnl, partialFill, resolveExit, volSpikeBlocks } from "./paperexit.js";
import { leverageCappedSize, liquidationPrice } from "./paperexit.js";
import { absorption, bookImbalance, buildFootprint, cvdSeriesOf, findWalls, pressureScore } from "./orderflowxray.js";
import { flowLean, percentileOf } from "./context.js";
import { resolveOutcome } from "./contextreport.js";
import { entryDecision, liveDryRun, roundToStep } from "./live.js";
import { checkFailedBreakout, type ReclaimSignal } from "./reversal.js";
import { config } from "./config.js";
import { validateConfig } from "./validateConfig.js";
import { feedOpen, feedClosed, feedMsg, feedStatuses } from "./feeds.js";
import { keyFor } from "./orderflow.js";
import { emaLast, rsiSeries, atr, vwap, sma, stdev, pivotHighs, pivotLows } from "./indicators.js";
import { STRATEGIES } from "./strategies.js";
import { detectRegime, regimeClass, regimeAllows } from "./regime.js";
import { findFVGs, fvgFactor, sweepFactor, structureFactor } from "./structure.js";
import { findOrderBlocks } from "./orderblocks.js";
import { findSweeps } from "./liquiditysweeps.js";
import { detectRange, manualRange } from "./range.js";
import { state, pushAlert, evaluateAlerts } from "./dashboardState.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { paperApi, type PaperTrade } from "./paper.js";
import { formatAuditPayload } from "./auditor.js";
import { alignByTime, ols, mean } from "./alphacore.js";
import { classifyRegime, efficiencyRatio } from "./marketregime.js";
import type { Candle, Range } from "./types.js";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}
const approx = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const RANGE: Range = { high: 110, low: 100, mid: 105, widthPct: 9.5, consolidating: true, candlesUsed: 24 };

console.log("plan.ts");
{
  const L = planFrom("LONG", 100, 98, 106);
  check("planFrom LONG rr = 3", approx(L.rr, 3), `got ${L.rr}`);
  check("planFrom LONG TP1/2/3 = 102/104/106", approx(L.tp1, 102) && approx(L.tp2, 104) && approx(L.tp3, 106));
  check("planFrom sizeUnits & notional > 0", L.sizeUnits > 0 && L.notionalUsd > 0);
  const S = planFrom("SHORT", 100, 102, 94);
  check("planFrom SHORT rr = 3", approx(S.rr, 3), `got ${S.rr}`);
  check("planFrom SHORT TP1 = 98", approx(S.tp1, 98));
  check("planFrom low rr flagged lowQuality", planFrom("LONG", 100, 99, 100.5).lowQuality === true);
  const supp = buildPlan("support", RANGE);
  check("buildPlan support = LONG, entry@low target@high", supp.direction === "LONG" && approx(supp.entry, 100) && approx(supp.target, 110));
  const res = buildPlan("resistance", RANGE);
  check("buildPlan resistance = SHORT, entry@high target@low", res.direction === "SHORT" && approx(res.entry, 110) && approx(res.target, 100));
  check("buildConfirmPlan atClose=false → entry at the level", approx(buildConfirmPlan("resistance", RANGE, 108, false).entry, 110) && approx(buildConfirmPlan("support", RANGE, 102, false).entry, 100));
  check("buildConfirmPlan atClose=true → entry at the close", approx(buildConfirmPlan("resistance", RANGE, 108, true).entry, 108) && approx(buildConfirmPlan("support", RANGE, 102, true).entry, 102));
  const cp = buildConfirmPlan("support", RANGE, 102, true);
  check("buildConfirmPlan close entry keeps stop below support / target at resistance", cp.direction === "LONG" && cp.stop < 100 && approx(cp.target, 110));

  // ---- structural take-profit levels (nearest resistance / support) ----
  const mkC = (h: number, l: number) => ({ open: h, high: h, low: l, close: (h + l) / 2, volume: 1, takerBuyVolume: 0.5, openTime: 0, closeTime: 0, closed: true });
  const upC = [100, 101, 102, 103, 110, 103, 102, 101, 105, 106, 120, 106, 105, 104, 103].map((h) => mkC(h, h - 5)) as unknown as import("./types.js").Candle[];
  const slL = structureLevels("LONG", 104, upC, 3);
  check("structureLevels LONG = resistances above entry, nearest first", approx(slL[0] ?? 0, 110) && approx(slL[1] ?? 0, 120));
  const spL = applyStructureTps(planFrom("LONG", 104, 102, 108), upC);
  check("applyStructureTps LONG overlays structural TP1/TP2", approx(spL.tp1, 110) && approx(spL.tp2, 120));
  const dnC = [100, 99, 98, 97, 90, 97, 98, 99, 95, 94, 80, 94, 95, 96, 97].map((l) => mkC(l + 5, l)) as unknown as import("./types.js").Candle[];
  const slS = structureLevels("SHORT", 96, dnC, 3);
  check("structureLevels SHORT = supports below entry, nearest first", approx(slS[0] ?? 0, 90) && approx(slS[1] ?? 0, 80));

  // ---- multi-timeframe alignment gate (opt-in) ----
  const dnHtf = [{ tf: "4h", dir: "down" }, { tf: "1d", dir: "down" }];
  const upHtf = [{ tf: "4h", dir: "up" }, { tf: "1d", dir: "up" }];
  check("mtfAlignBlocks off never blocks", mtfAlignBlocks(false, "SHORT", upHtf) === false);
  check("mtfAlignBlocks SHORT allowed when 4h & 1d down", mtfAlignBlocks(true, "SHORT", dnHtf) === false);
  check("mtfAlignBlocks SHORT blocked when 4h up", mtfAlignBlocks(true, "SHORT", [{ tf: "4h", dir: "up" }, { tf: "1d", dir: "down" }]) === true);
  check("mtfAlignBlocks LONG allowed when both up", mtfAlignBlocks(true, "LONG", upHtf) === false);
  check("mtfAlignBlocks missing HTF never blocks", mtfAlignBlocks(true, "SHORT", undefined) === false);
}

console.log("evidence.ts");
{
  const good = assessBet({ source: "breakout-retest", rr: 4.5, factorsPresent: { flow: true, fvg: true } });
  check("assessBet returns 6 workers", good.workers.length === 6);
  check("assessBet strong setup is not AVOID", good.grade !== "AVOID", good.grade);
  check("assessBet known strategy has measured expectancy + sample", good.measuredExpR !== null && good.sampleN !== null);
  check("assessBet good confluence is positive", good.netConfluencePp > 0, `${good.netConfluencePp}`);
  const bad = assessBet({ source: "bollinger-reversion", rr: 1.4, factorsPresent: { sweep: true } });
  check("assessBet losing factor drags confluence negative", bad.netConfluencePp < 0, `${bad.netConfluencePp}`);
  const conf = assessBet({ source: "support", rr: 6, factorsPresent: {} });
  check("assessBet S/R confirmation has null measured expectancy", conf.measuredExpR === null);
  check("assessBet winPct clamped to [8,92]", good.winPct >= 8 && good.winPct <= 92 && conf.winPct >= 8 && conf.winPct <= 92);
  const fp = factorsFromConfluence([{ ok: true, label: "flow net BUY" }, { ok: false, label: "liquidity swept 101" }, { ok: true, label: "HTF up" }]);
  check("factorsFromConfluence maps flow/sweep/HTF labels", fp.flow === true && fp.sweep === false && fp.HTF === true);
}

console.log("volumeprofile.ts");
{
  const cs: Candle[] = [];
  let t = 0;
  for (let i = 0; i < 30; i++) {
    const base = 100 + Math.sin(i) * 2;
    cs.push({ openTime: t, open: base, high: base + 1, low: base - 1, close: base, volume: 10 + (i % 5), takerBuyVolume: 5, closeTime: t + 1, closed: true });
    t += 2;
  }
  const vp = volumeProfile(cs, 40);
  check("volumeProfile returns a profile", vp !== null);
  if (vp) {
    const lo = Math.min(...cs.map((c) => c.low));
    const hi = Math.max(...cs.map((c) => c.high));
    check("VAL <= POC <= VAH", vp.val <= vp.poc + 1e-9 && vp.poc <= vp.vah + 1e-9, `${vp.val}/${vp.poc}/${vp.vah}`);
    check("profile within the candle range", vp.val >= lo - 1e-9 && vp.vah <= hi + 1e-9);
  }
  check("volumeProfile null on too-few candles", volumeProfile(cs.slice(0, 3), 40) === null);
}

// The dashboard is a hand-written HTML string, so `tsc` can't catch a dropped
// closing tag — a single missing </style> silently blanks the whole page at every
// viewport (this exact bug shipped once). These structural invariants guard it.
console.log("paperexit.ts (money-path exit resolution)");
{
  // LONG: stop below entry, target above. Stop fills worse by slippage; target is a limit.
  const lStop = resolveExit(true, 98, 106, 97, 99, 0.001);
  check("LONG low pierces stop → stop, filled worse by slip", lStop !== null && lStop.reason === "stop" && approx(lStop.exit, 98 * 0.999));
  const lTgt = resolveExit(true, 98, 106, 99, 107, 0.001);
  check("LONG high reaches target → target at level (no slip)", lTgt !== null && lTgt.reason === "target" && approx(lTgt.exit, 106));
  const lBoth = resolveExit(true, 98, 106, 97, 107, 0);
  check("LONG candle spanning both → stop (conservative)", lBoth !== null && lBoth.reason === "stop");
  check("LONG candle inside range → no exit", resolveExit(true, 98, 106, 99, 105, 0) === null);
  // SHORT: stop above entry, target below.
  const sStop = resolveExit(false, 102, 94, 101, 103, 0.001);
  check("SHORT high pierces stop → stop, filled worse by slip", sStop !== null && sStop.reason === "stop" && approx(sStop.exit, 102 * 1.001));
  const sTgt = resolveExit(false, 102, 94, 93, 101, 0.001);
  check("SHORT low reaches target → target at level (no slip)", sTgt !== null && sTgt.reason === "target" && approx(sTgt.exit, 94));
  const sBoth = resolveExit(false, 102, 94, 93, 103, 0);
  check("SHORT candle spanning both → stop (conservative)", sBoth !== null && sBoth.reason === "stop");
  check("SHORT candle inside range → no exit", resolveExit(false, 102, 94, 95, 101, 0) === null);
  // Correlation cap — N same-direction positions across correlated symbols = one N-sized bet.
  const L = { direction: "LONG" as const };
  const S = { direction: "SHORT" as const };
  check("correlation cap: reached at the cap", correlatedCapReached([S, S], "SHORT", 2) === true);
  check("correlation cap: below the cap is fine", correlatedCapReached([S], "SHORT", 2) === false);
  check("correlation cap: opposite direction doesn't count (partial hedge)", correlatedCapReached([L, L, L], "SHORT", 2) === false);
  check("correlation cap: cap 0 disables the guard", correlatedCapReached([S, S, S], "SHORT", 0) === false);

  // ---- partial take-profit math (opt-in exit management) ----
  const pfL = partialFill(true, 100, 2, 1, 0.5, 10, 0); // LONG, entry 100, risk 2 → +1R level 102, half of 10 units
  check("partialFill LONG level = entry + atR*risk", approx(pfL.level, 102));
  check("partialFill LONG banks half, half remains", approx(pfL.partSize, 5) && approx(pfL.remaining, 5));
  check("partialFill LONG +1R on half = +$10", approx(pfL.partialPnl, 10), `got ${pfL.partialPnl}`);
  check("partialFill LONG BE stop = entry with no fee", approx(pfL.beStop, 100));
  const pfS = partialFill(false, 100, 2, 1, 0.5, 10, 0); // SHORT → +1R level 98
  check("partialFill SHORT level = entry - atR*risk", approx(pfS.level, 98));
  check("partialFill SHORT +1R on half = +$10", approx(pfS.partialPnl, 10), `got ${pfS.partialPnl}`);
  const pfFee = partialFill(true, 100, 2, 1, 0.5, 10, 0.0005); // 5bps fee
  check("partialFill fee reduces banked P&L below gross", pfFee.partialPnl < 10 && pfFee.partialPnl > 9);
  check("partialFill fee-aware BE stop sits just above entry (long)", approx(pfFee.beStop, 100 + 0.0005 * 2 * 100));
  // combined partial + remainder accounting must match exitedge's exitPartial semantics
  { const entry = 100, risk = 2, size = 10, riskUsd = size * risk, pf = partialFill(true, entry, risk, 1, 0.5, size, 0);
    check("partial then BE-stop → total = +0.5R", approx((pf.partialPnl + (100 - entry) * pf.remaining) / riskUsd, 0.5));
    check("partial then +3R target → total = +2R (0.5·1R + 0.5·3R)", approx((pf.partialPnl + (106 - entry) * pf.remaining) / riskUsd, 2)); }
  // ---- manual partial-close math (dashboard "close 25/50/75%" path) ----
  check("partialClosePnl LONG 5u @ +10 (no fee) = +$50", approx(partialClosePnl("LONG", 100, 110, 5, 0), 50));
  check("partialClosePnl SHORT 5u @ -10 (no fee) = +$50", approx(partialClosePnl("SHORT", 100, 90, 5, 0), 50));
  check("partialClosePnl LONG loss 5u @ -8 = -$40", approx(partialClosePnl("LONG", 100, 92, 5, 0), -40));
  check("partialClosePnl fee (5bps) cuts P&L by fee on both legs", approx(partialClosePnl("LONG", 100, 110, 5, 0.0005), 50 - 0.0005 * 5 * 210));
  // The honest invariant: closing frac then the remainder at ONE price = closing whole at that price.
  { const half = partialClosePnl("LONG", 100, 107, 5, 0.0005), rest = partialClosePnl("LONG", 100, 107, 5, 0.0005), whole = partialClosePnl("LONG", 100, 107, 10, 0.0005);
    check("partial + remainder = whole close (linear, no phantom P&L)", approx(half + rest, whole)); }
  { const s70 = partialClosePnl("SHORT", 50, 44, 7, 0.0004), s30 = partialClosePnl("SHORT", 50, 44, 3, 0.0004), s100 = partialClosePnl("SHORT", 50, 44, 10, 0.0004);
    check("partial 70% + 30% = 100% (SHORT, with fee)", approx(s70 + s30, s100)); }
}

console.log("live.ts (Stage-1 dry-run shadow — pure rails)");
{
  check("Stage 1 is always dry-run (no real-order branch exists)", liveDryRun() === true);
  // rounding DOWN to the exchange step/tick (never over-order)
  check("roundToStep floors to step (0.7 → 0.5 @ 0.5)", approx(roundToStep(0.7, 0.5), 0.5));
  check("roundToStep exact multiple unchanged (2.0 @ 0.001)", approx(roundToStep(2.0, 0.001), 2));
  check("roundToStep 1.2345 → 1.234 @ 0.001", approx(roundToStep(1.2345, 0.001), 1.234));
  check("roundToStep step<=0 passes value through", roundToStep(5, 0) === 5);
  // rail decisions
  const caps = config.live;
  const ok = { daily: false, drawdown: false, streak: false };
  check("entry passes when within all caps", entryDecision(ok, 0, 10, caps) === null);
  check("entry blocked on daily-loss halt", entryDecision({ ...ok, daily: true }, 0, 10, caps) !== null);
  check("entry blocked on drawdown halt", entryDecision({ ...ok, drawdown: true }, 0, 10, caps) !== null);
  check("entry blocked on loss-streak halt", entryDecision({ ...ok, streak: true }, 0, 10, caps) !== null);
  check("entry blocked at max concurrent", entryDecision(ok, caps.maxConcurrent, 10, caps) !== null);
  check("entry blocked over position-notional cap", entryDecision(ok, 0, caps.maxPositionUsd + 1, caps) !== null);
  check("entry under notional cap allowed", entryDecision(ok, 0, caps.maxPositionUsd, caps) === null);
}

console.log("paperexit.ts (opt-in paper circuit-breaker — disciplineBlocks)");
{
  const NOW = Date.parse("2026-07-13T12:00:00.000Z");
  const H = 3_600_000;
  const iso = (ms: number) => new Date(ms).toISOString();
  const L = (pnl: number, ms: number) => ({ pnlUsd: pnl, closeTime: iso(ms) }); // a closed trade
  const dc: DisciplineCaps = { enabled: true, applyTo: ["filtered"], maxDailyLossUsd: 25, maxConsecutiveLosses: 4, maxDrawdownPct: 10, cooldownHours: 12 };
  const onlyDaily = { ...dc, maxConsecutiveLosses: 0, maxDrawdownPct: 0 };
  const onlyStreak = { ...dc, maxDailyLossUsd: 0, maxDrawdownPct: 0 };
  const onlyDd = { ...dc, maxDailyLossUsd: 0, maxConsecutiveLosses: 0 };

  // master switch off ⇒ never blocks (default config keeps behaviour unchanged)
  check("discipline OFF never blocks", disciplineBlocks([L(-100, NOW - H)], 800, 1000, { ...dc, enabled: false }, NOW) === null);

  // daily-loss: today's (UTC) realized ≤ -cap ⇒ block; resets at UTC midnight
  check("daily-loss trips when today ≤ -cap", (disciplineBlocks([L(-10, NOW - H), L(-20, NOW - 2 * H)], 970, 1000, onlyDaily, NOW) ?? "").startsWith("daily"));
  check("daily-loss just above cap doesn't block", disciplineBlocks([L(-10, NOW - H), L(-14, NOW - 2 * H)], 976, 1000, onlyDaily, NOW) === null); // -24 > -25
  check("daily-loss resets across UTC midnight (yesterday's losses don't count)", disciplineBlocks([L(-20, NOW - 26 * H), L(-20, NOW - 27 * H)], 960, 1000, onlyDaily, NOW) === null);

  // consecutive-loss streak: ≥N recent losses ⇒ block; clears after cooldown; a win resets the count
  const streak4 = [L(-5, NOW - H), L(-5, NOW - 2 * H), L(-5, NOW - 3 * H), L(-5, NOW - 4 * H)];
  check("streak trips at N consecutive losses (recent)", (disciplineBlocks(streak4, 980, 1000, onlyStreak, NOW) ?? "").includes("streak"));
  check("streak of N-1 doesn't block", disciplineBlocks(streak4.slice(0, 3), 985, 1000, onlyStreak, NOW) === null);
  check("streak clears after cooldown (probe allowed)", disciplineBlocks(streak4.map((_, i) => L(-5, NOW - (13 + i) * H)), 980, 1000, onlyStreak, NOW) === null);
  check("a win breaks the streak (2 trailing < N)", disciplineBlocks([L(-5, NOW - H), L(-5, NOW - 2 * H), L(5, NOW - 3 * H), L(-5, NOW - 4 * H)], 990, 1000, onlyStreak, NOW) === null);

  // drawdown from equity high-water mark
  check("drawdown trips at ≥cap% below peak (recent)", (disciplineBlocks([L(-5, NOW - H)], 895, 1000, onlyDd, NOW) ?? "").includes("drawdown")); // 10.5%
  check("drawdown below cap doesn't block (9% < 10%)", disciplineBlocks([L(-5, NOW - H)], 910, 1000, onlyDd, NOW) === null);
  check("drawdown clears after cooldown", disciplineBlocks([L(-5, NOW - 13 * H)], 895, 1000, onlyDd, NOW) === null);

  // every rail independently disable-able with 0
  check("all caps 0 ⇒ never blocks even after a losing streak", disciplineBlocks(streak4, 500, 1000, { ...dc, maxDailyLossUsd: 0, maxConsecutiveLosses: 0, maxDrawdownPct: 0 }, NOW) === null);
}

console.log("auditor.ts (LLM-audit payload — fired when the core_4h breaker trips)");
{
  const mkT = (pnl: number, i: number): PaperTrade => ({
    id: `T${i}`, symbol: "SOLUSDT", source: "momentum-TSMOM", direction: "LONG", entry: 100, stop: 99, target: 102,
    sizeUnits: 1, notionalUsd: 100, riskUsd: 1, openTime: "o", signalCloseTime: i, exit: 100 + pnl, exitReason: pnl >= 0 ? "target" : "stop",
    closeTime: `2026-07-15T0${i}:00:00Z`, pnlUsd: pnl, rMultiple: pnl, balanceAfter: 1000 + pnl,
  });
  const closed = Array.from({ length: 14 }, (_, i) => mkT(i % 2 ? -1 : 2, i)); // newest-first, 14 trades
  const payload = JSON.parse(formatAuditPayload("core_4h", closed, "4-loss streak halt (cooldown 24h)"));
  check("audit payload caps at last 10 trades", payload.count === 10 && payload.trades.length === 10);
  check("audit payload carries account + trip reason", payload.account === "core_4h" && payload.trip.includes("streak"));
  check("audit payload trade shape (entry/stop/target/reason/pnl/r)", (() => { const t = payload.trades[0]; return t.entry === 100 && t.stop === 99 && t.target === 102 && typeof t.reason === "string" && typeof t.pnlUsd === "number" && typeof t.r === "number"; })());
  check("audit payload takes the NEWEST trades (slice from front)", payload.trades[0].closeTime === closed[0]!.closeTime);
  check("audit payload is valid JSON round-trip", typeof JSON.stringify(payload) === "string");
}

console.log("paperexit.ts (opt-in news-proxy guards — volSpikeBlocks + inNewsBlackout)");
{
  // volSpikeBlocks: last candle's range vs trailing ATR × mult. Blocks only when the market convulses.
  check("vol OFF never blocks even on a huge candle", volSpikeBlocks(false, 100, 10, 2) === false);
  check("vol blocks when range > mult×ATR (news convulsion)", volSpikeBlocks(true, 21, 10, 2) === true);
  check("vol doesn't block a normal candle (range ≤ mult×ATR)", volSpikeBlocks(true, 19, 10, 2) === false);
  check("vol exactly at the threshold doesn't block (strict >)", volSpikeBlocks(true, 20, 10, 2) === false);
  check("vol with non-positive ATR never blocks (no baseline yet)", volSpikeBlocks(true, 50, 0, 2) === false);
  check("vol with non-positive mult never blocks (guard mis-set)", volSpikeBlocks(true, 50, 10, 0) === false);

  // inNewsBlackout: schedule-driven (no live feed). Deterministic UTC windows + one-off events.
  const nb = (nowIso: string, caps: Partial<NewsBlackoutCaps> = {}): boolean =>
    inNewsBlackout(Date.parse(nowIso), { enabled: true, dailyWindowsUtc: [{ start: "12:00", end: "13:30" }], weekdaysOnly: true, events: [], ...caps });
  check("blackout OFF never blocks", inNewsBlackout(Date.parse("2026-07-14T12:30:00Z"), { enabled: false, dailyWindowsUtc: [{ start: "12:00", end: "13:30" }], weekdaysOnly: true, events: [] }) === false);
  check("blackout blocks inside a weekday daily window", nb("2026-07-14T12:30:00Z") === true); // Tue 12:30 UTC
  check("blackout window start is inclusive", nb("2026-07-14T12:00:00Z") === true);
  check("blackout window end is exclusive", nb("2026-07-14T13:30:00Z") === false);
  check("blackout doesn't block outside the window", nb("2026-07-14T09:00:00Z") === false);
  check("blackout skips weekends when weekdaysOnly", nb("2026-07-18T12:30:00Z") === false); // Sat, same clock time
  check("blackout applies weekend when weekdaysOnly is off", nb("2026-07-18T12:30:00Z", { weekdaysOnly: false }) === true);
  check("blackout blocks inside a one-off event window", nb("2026-07-15T18:15:00Z", { dailyWindowsUtc: [], events: [{ from: "2026-07-15T18:00:00Z", to: "2026-07-15T19:00:00Z" }] }) === true);
  check("blackout event window end is exclusive", nb("2026-07-15T19:00:00Z", { dailyWindowsUtc: [], events: [{ from: "2026-07-15T18:00:00Z", to: "2026-07-15T19:00:00Z" }] }) === false);
  check("blackout ignores malformed event dates", nb("2026-07-15T18:15:00Z", { dailyWindowsUtc: [], events: [{ from: "not-a-date", to: "also-bad" }] }) === false);
}

console.log("reversal.ts (failed-breakout reclaim)");
{
  const RNG: Range = { high: 110, low: 100, mid: 105, widthPct: 9.5, consolidating: true, candlesUsed: 24 };
  const mk = (close: number, high: number, low: number, ct: number): Candle => ({ openTime: ct - 1, open: close, high, low, close, volume: 10, takerBuyVolume: 5, closeTime: ct, closed: true });
  // Unique symbols so the module-level memo Map doesn't collide between cases.
  const A = "TEST-RECLAIM-A";
  const armed = checkFailedBreakout(A, mk(111, 112, 110.2, 1000), [mk(111, 112, 110.2, 1000)], RNG);
  check("reversal: breakout candle only arms (no signal yet)", armed === null);
  const hist = [mk(111, 112, 110.2, 1000), mk(109, 110.5, 108.5, 2000)];
  const sig = checkFailedBreakout(A, mk(109, 110.5, 108.5, 2000), hist, RNG);
  check("reversal: reclaim within window fires a SHORT off resistance", sig !== null && sig.direction === "SHORT" && sig.level === "resistance");
  check("reversal: SHORT targets the opposite side, stop beyond the trap", sig !== null && approx(sig.target, 100) && sig.stop > sig.entry && sig.target < sig.entry);

  // Off-by-one guard: a reclaim on the candle PAST reclaimWindow must be ignored.
  const B = "TEST-RECLAIM-B";
  checkFailedBreakout(B, mk(111, 112, 110.2, 1000), [], RNG); // arm (bars=0)
  const W = config.reversal.reclaimWindow;
  let late: ReclaimSignal | null = null;
  for (let i = 1; i <= W; i++) checkFailedBreakout(B, mk(111, 112, 110.5, 1000 + i * 1000), [], RNG); // stays broken through the whole window
  late = checkFailedBreakout(B, mk(109, 110.5, 108.5, 1000 + (W + 1) * 1000), [], RNG); // bars = W+1 → over the window
  check("reversal: reclaim past the window is ignored", late === null);
}

console.log("validateConfig.ts");
{
  const v = validateConfig();
  check("validateConfig: shipped config has zero fatal errors", v.errors.length === 0, v.errors.join("; "));
}

console.log("feeds.ts (feed health state machine)");
{
  const F = "test-price-feed";
  const stateOf = (): string => { const s = feedStatuses().find((x) => x.name === F); return s ? s.state : "absent"; };
  feedClosed(F);
  check("feeds: registered but disconnected → off", stateOf() === "off");
  feedOpen(F);
  check("feeds: connected, no data yet → idle", stateOf() === "idle");
  feedMsg(F);
  check("feeds: connected + fresh message → live", stateOf() === "live");
  feedClosed(F);
  check("feeds: disconnect overrides recent data → off", stateOf() === "off");
}

console.log("orderflow.ts (confluence weight-key mapping)");
{
  // Every label a factor can emit — including the n/a fallbacks — must map to a real
  // weight key, else that factor silently defaults to weight 1 and skews the score.
  const cases: [string, string][] = [
    ["rejection candle", "rejection"],
    ["bid wall 62%", "wall"], ["ask wall 55%", "wall"], ["book n/a", "wall"],
    ["flow net BUY", "flow"], ["flow net SELL", "flow"],
    ["bull FVG", "fvg"], ["IFVG resistance", "fvg"], ["no FVG", "fvg"],
    ["swept sell-side", "sweep"], ["no sweep", "sweep"], ["sweep n/a", "sweep"],
    ["45% discount", "pd"], ["70% premium", "pd"], ["P/D n/a", "pd"],
    ["structure up", "structure"], ["structure n/a", "structure"],
    ["HTF 4h up", "htf"], ["HTF 4h n/a", "htf"],
  ];
  let allOk = true;
  for (const [label, want] of cases) {
    const got = keyFor(label);
    if (got !== want) { allOk = false; console.error(`    keyFor("${label}") = "${got}", want "${want}"`); }
    if (!(got in config.confluenceWeights)) { allOk = false; console.error(`    key "${got}" missing from confluenceWeights`); }
  }
  check("orderflow: every factor label maps to a real weight key (none fall through to 'other')", allOk);
}

console.log("indicators.ts (foundational math)");
{
  check("sma of [1..5] = 3", approx(sma([1, 2, 3, 4, 5], 5), 3));
  check("sma uses only the last `period` values", approx(sma([1, 2, 3, 4], 2), 3.5));
  check("population stdev of the textbook set = 2", approx(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8), 2));
  check("emaLast of a constant series = that constant", approx(emaLast([5, 5, 5, 5, 5], 3), 5));
  check("emaLast period 1 tracks the latest value", approx(emaLast([2, 4], 1), 4));
  const up = Array.from({ length: 20 }, (_, i) => i + 1);
  const rUp = rsiSeries(up, 14);
  check("RSI of a strictly rising series = 100", approx(rUp[rUp.length - 1]!, 100));
  const down = Array.from({ length: 20 }, (_, i) => 20 - i);
  const rDn = rsiSeries(down, 14);
  check("RSI of a strictly falling series = 0", approx(rDn[rDn.length - 1]!, 0));
  const flat: Candle[] = Array.from({ length: 16 }, (_, i) => ({ openTime: i, open: 100, high: 101, low: 99, close: 100, volume: 10, takerBuyVolume: 5, closeTime: i + 1, closed: true }));
  check("ATR of constant 2-wide candles = 2", approx(atr(flat, 14), 2));
  check("ATR returns NaN with too few candles", Number.isNaN(atr(flat.slice(0, 5), 14)));
  check("VWAP of constant typical-price candles = that price", approx(vwap(flat), 100));
  const v = [1, 3, 2, 5, 1];
  check("pivotHighs finds local maxima", JSON.stringify(pivotHighs(v, 1, 1)) === JSON.stringify([1, 3]));
  check("pivotLows finds local minima", JSON.stringify(pivotLows(v, 1, 1)) === JSON.stringify([2]));
}

console.log("strategies.ts (entry geometry)");
{
  const mkC = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 10, takerBuyVolume: 6, closeTime: i + 1, closed: true });
  const tsmomStrat = STRATEGIES.find((s) => s.name === "momentum-TSMOM")!;
  // A clean uptrend: last close well above the close `tsmomLookback` bars ago, last candle green.
  const upTrend: Candle[] = [];
  for (let i = 0; i < 60; i++) { const b = 100 + i * 0.25; upTrend.push(mkC(i, b - 0.05, b + 0.15, b - 0.15, b)); }
  const sig = tsmomStrat.detect({ symbol: "T", closed: upTrend, price: upTrend[upTrend.length - 1]!.close });
  check("tsmom fires LONG on a strong uptrend", sig !== null && sig.direction === "LONG");
  check("tsmom signal geometry is valid (stop < entry < target)", sig !== null && sig.stop < sig.entry && sig.entry < sig.target);
  check("tsmom target sits ~2R above entry", sig !== null && approx(sig.target - sig.entry, 2 * (sig.entry - sig.stop)));
}

console.log("regime.ts (market classification)");
{
  const mkC = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 10, takerBuyVolume: 5, closeTime: i + 1, closed: true });
  const up: Candle[] = [];
  for (let i = 0; i < 60; i++) { const b = 100 + i * 0.4; up.push(mkC(i, b, b + 0.2, b - 0.2, b)); }
  check("regime: strong steady uptrend → uptrend", detectRegime(up).regime === "uptrend");
  const flat: Candle[] = [];
  for (let i = 0; i < 60; i++) flat.push(mkC(i, 100, 100.2, 99.8, 100));
  check("regime: flat market → ranging", detectRegime(flat).regime === "ranging");
  const wild: Candle[] = [];
  for (let i = 0; i < 60; i++) { const b = 100 + (i % 2 === 0 ? 4 : -4); wild.push(mkC(i, 100, b + 6, b - 6, b)); }
  check("regime: huge ATR → volatile", detectRegime(wild).regime === "volatile");
  check("regime: too few candles → warming up", detectRegime(up.slice(0, 10)).note === "warming up");
  check("regimeClass: up/downtrend → trend", regimeClass("uptrend") === "trend" && regimeClass("downtrend") === "trend");
  check("regimeClass: ranging → range, volatile → volatile", regimeClass("ranging") === "range" && regimeClass("volatile") === "volatile");
  check("regimeAllows: fires in its declared regime", regimeAllows(["trend"], "trend") === true);
  check("regimeAllows: blocked outside its regime", regimeAllows(["trend"], "range") === false);
  check("regimeAllows: no declared regimes → never gated", regimeAllows(undefined, "range") === true && regimeAllows([], "trend") === true);
}

console.log("structure.ts (SMC factors)");
{
  const mkC = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 10, takerBuyVolume: 5, closeTime: i + 1, closed: true });
  // Bull FVG: candle[0].high (100) < candle[2].low (103) → unfilled gap [100, 103].
  const bullFvg: Candle[] = [mkC(0, 99, 100, 98, 99), mkC(1, 101, 105, 101, 104), mkC(2, 104, 106, 103, 105)];
  const fvgs = findFVGs(bullFvg);
  check("findFVGs detects a bull FVG with the right zone", fvgs.length === 1 && fvgs[0]!.type === "bull" && approx(fvgs[0]!.bottom, 100) && approx(fvgs[0]!.top, 103));
  check("fvgFactor: price inside an unfilled bull FVG confirms support", fvgFactor("support", 101.5, bullFvg).ok === true);
  check("fvgFactor: the same bull FVG does NOT confirm resistance", fvgFactor("resistance", 101.5, bullFvg).ok === false);
  // Sweep: last candle wicks below the prior-window low, then closes back above it.
  const sweepC: Candle[] = [];
  for (let i = 0; i < 11; i++) sweepC.push(mkC(i, 100, 101, 99, 100)); // prior lows all 99
  sweepC.push(mkC(11, 100, 100.5, 97, 100)); // last: low 97 < 99, close 100 > 99
  check("sweepFactor: wick below prior low + reclaim = swept sell-side", sweepFactor("support", sweepC).ok === true);
  // Structure: a clean uptrend over the window → bullish structure supports the long side.
  const upW: Candle[] = [];
  for (let i = 0; i < 20; i++) { const b = 100 + i; upW.push(mkC(i, b, b + 0.5, b - 0.5, b)); }
  check("structureFactor: uptrend → bullish structure (confirms support side)", structureFactor("support", upW).ok === true);
}

console.log("orderblocks.ts + liquiditysweeps.ts (LuxAlgo ports)");
{
  const mkC = (i: number, o: number, h: number, l: number, cl: number): Candle => ({ openTime: i, open: o, high: h, low: l, close: cl, volume: 10, takerBuyVolume: 5, closeTime: i + 1, closed: true });
  // Bullish order block: a down candle, then `periods`(5) up candles, + a detection bar.
  const ob: Candle[] = [mkC(0, 102, 102.5, 99, 100)];
  for (let i = 1; i <= 5; i++) { const b = 100 + i; ob.push(mkC(i, b - 0.5, b + 0.5, b - 1, b)); }
  ob.push(mkC(6, 105, 105.5, 104.5, 105));
  const obs = findOrderBlocks(ob);
  check("findOrderBlocks: down candle before 5 up candles = bullish OB", obs.bull !== null && obs.bull.type === "bull" && approx(obs.bull.high, 102) && approx(obs.bull.low, 99));
  check("findOrderBlocks: no bearish OB in a clean up-run", obs.bear === null);
  // Bearish liquidity sweep: an isolated pivot high, later wicked above then closed back below.
  const sw: Candle[] = [];
  for (let i = 0; i < 20; i++) { let h = 100.5, l = 99.5, cl = 100; const o = 100; if (i === 7) { h = 110; l = 99; } if (i === 15) { h = 111; l = 99; cl = 108; } sw.push(mkC(i, o, h, l, cl)); }
  const sweeps = findSweeps(sw);
  check("findSweeps: wick above a pivot high + close below = bearish sweep", sweeps.length === 1 && sweeps[0]!.type === "bear" && approx(sweeps[0]!.level, 110));
}

console.log("range.ts (consolidation detection — the founding feature)");
{
  const mkC = (i: number, h: number, l: number): Candle => ({ openTime: i, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2, volume: 10, takerBuyVolume: 5, closeTime: i + 1, closed: true });
  const tight: Candle[] = [];
  for (let i = 0; i < config.lookback; i++) tight.push(mkC(i, 101, 99)); // ~2% wide, full window
  const r1 = detectRange(tight);
  check("detectRange: tight full-window band is consolidating", r1.consolidating === true && approx(r1.high, 101) && approx(r1.low, 99));
  const wide: Candle[] = [];
  for (let i = 0; i < config.lookback; i++) wide.push(mkC(i, 130, 100)); // ~26% wide
  check("detectRange: band wider than maxRangeWidthPct is NOT consolidating", detectRange(wide).consolidating === false);
  check("detectRange: fewer than lookback candles → not consolidating (warm-up)", detectRange(tight.slice(0, 5)).consolidating === false);
  const m = manualRange(82.23, 79.94);
  check("manualRange: correct high/low/mid + consolidating", approx(m.high, 82.23) && approx(m.low, 79.94) && approx(m.mid, (82.23 + 79.94) / 2) && m.consolidating === true);
  check("manualRange: inverted levels are not consolidating", manualRange(79.94, 82.23).consolidating === false);
}

console.log("dashboardState.ts (alert outcome tracking)");
{
  const mkC = (ct: number, h: number, l: number): Candle => ({ openTime: ct - 1, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2, volume: 10, takerBuyVolume: 5, closeTime: ct, closed: true });
  const plan = { direction: "SHORT" as const, entry: 100, stop: 102, target: 94, tp1: 98, tp2: 96, tp3: 94, rr: 3, riskUsd: 10, sizeUnits: 1, notionalUsd: 100, leverage: 1, lowQuality: false, feePctOfRisk: 0.05, feeHeavy: false };
  const seed = () => { state.alerts.length = 0; pushAlert({ time: "t", symbol: "TESTAO", kind: "confirmation", level: "resistance", levelPrice: 100, plan, signalCloseTime: 1000, message: "m" }); };
  seed(); evaluateAlerts("TESTAO", [mkC(2000, 101, 93)]); // low 93 ≤ target 94 → win
  check("evaluateAlerts: SHORT reaches target → win", state.alerts[0]!.outcome === "win");
  seed(); evaluateAlerts("TESTAO", [mkC(2000, 103, 99)]); // high 103 ≥ stop 102 → loss (stop-first)
  check("evaluateAlerts: SHORT hits stop → loss", state.alerts[0]!.outcome === "loss");
  seed(); evaluateAlerts("TESTAO", [mkC(2000, 101, 99)]); // neither → open
  check("evaluateAlerts: no touch yet → open", state.alerts[0]!.outcome === "open");
  seed(); evaluateAlerts("TESTAO", [mkC(1000, 90, 80)]); // candle at signalCloseTime is ignored → open
  check("evaluateAlerts: candles at/before the signal are ignored", state.alerts[0]!.outcome === "open");
  state.alerts.length = 0;
}

console.log("dashboard.ts (HTML integrity)");
{
  const html = DASHBOARD_HTML;
  const n = (needle: string) => html.split(needle).length - 1;
  check("starts with doctype", html.startsWith("<!doctype html>"));
  check("<style> opened and closed exactly once", n("<style>") === 1 && n("</style>") === 1, `open ${n("<style>")} / close ${n("</style>")}`);
  check("</head> present exactly once", n("</head>") === 1, `${n("</head>")}`);
  check("<body> opened and </body> closed once", n("<body>") === 1 && n("</body>") === 1, `open ${n("<body>")} / close ${n("</body>")}`);
  check("<script> opened and closed exactly once", n("<script>") === 1 && n("</script>") === 1, `open ${n("<script>")} / close ${n("</script>")}`);
  check("</html> present exactly once", n("</html>") === 1, `${n("</html>")}`);
  for (const id of ["cards", "board", "alerts", "paper"] as const) {
    check(`mount point #${id} present`, html.includes(`id="${id}"`));
  }
  check("market-regime badge #mreg present", html.includes('id="mreg"'));
  check("market-regime render reads s.market", html.includes("s.market"));
}

console.log("alphacore.ts (OLS regression — the alpha/beta math)");
{
  check("mean of [1,2,3,4] = 2.5", approx(mean([1, 2, 3, 4]), 2.5));
  check("mean of [] = 0 (no divide-by-zero)", mean([]) === 0);
  const x = [-2, -1, 0, 1, 2];
  const line = ols([-1, 1, 3, 5, 7], x); // y = 2x + 3, perfect fit
  check("ols perfect line → β=2, α=3", approx(line.beta, 2) && approx(line.alpha, 3), `β=${line.beta} α=${line.alpha}`);
  check("ols perfect line → R²=1, corr=1", approx(line.r2, 1) && approx(line.corr, 1));
  // The three self-check CONTROLS the alpha tools assert on real data:
  check("control basket-on-basket → β=1, α=0, R²=1", (() => { const r = ols(x, x); return approx(r.beta, 1) && approx(r.alpha, 0) && approx(r.r2, 1); })());
  check("control all-cash (y=0) → β=0, α=0", (() => { const r = ols([0, 0, 0, 0, 0], x); return approx(r.beta, 0) && approx(r.alpha, 0); })());
  check("control 2×-basket → β=2", approx(ols([-4, -2, 0, 2, 4], x).beta, 2));
  const neg = ols([1, 0.5, 0, -0.5, -1], x); // y = -0.5x
  check("ols negative slope → β=-0.5, corr=-1", approx(neg.beta, -0.5) && approx(neg.corr, -1), `β=${neg.beta}`);
  check("ols zero-variance x → β=0 (guarded)", ols([1, 2, 3], [5, 5, 5]).beta === 0);
  // alignByTime: keep only the openTimes common to ALL symbols, aligned row-for-row
  const mkCd = (t: number): Candle => ({ openTime: t, open: 1, high: 1, low: 1, close: 1, volume: 0, takerBuyVolume: 0, closeTime: t + 1, closed: true });
  const aligned = alignByTime({ A: [mkCd(1), mkCd(2), mkCd(3)], B: [mkCd(2), mkCd(3), mkCd(4)] }, ["A", "B"]);
  check("alignByTime keeps only common openTimes (2 & 3)", aligned.A!.length === 2 && aligned.B!.length === 2 && aligned.A![0]!.openTime === 2 && aligned.A![1]!.openTime === 3);
  check("alignByTime rows line up across symbols", aligned.A![0]!.openTime === aligned.B![0]!.openTime && aligned.A![1]!.openTime === aligned.B![1]!.openTime);
}

console.log("marketregime.ts (opt-in bear-only filter classifier)");
{
  check("classifyRegime: +5% > 3% band → bull", classifyRegime(0.05, 0.03) === "bull");
  check("classifyRegime: -5% < -3% band → bear", classifyRegime(-0.05, 0.03) === "bear");
  check("classifyRegime: +1% within band → flat", classifyRegime(0.01, 0.03) === "flat");
  check("classifyRegime: exactly +band → flat (strict >)", classifyRegime(0.03, 0.03) === "flat");
  check("classifyRegime: exactly -band → flat (strict <)", classifyRegime(-0.03, 0.03) === "flat");

  // efficiencyRatio (Kaufman ER): 1 = straight trend, 0 = pure chop, 0 if too short
  check("ER: straight line up → 1.0", Math.abs(efficiencyRatio([1, 2, 3, 4, 5], 4) - 1) < 1e-9);
  check("ER: straight line down → 1.0", Math.abs(efficiencyRatio([5, 4, 3, 2, 1], 4) - 1) < 1e-9);
  check("ER: pure chop (no net move) → 0", efficiencyRatio([1, 2, 1, 2, 1], 4) === 0);
  check("ER: partial efficiency → 0.6", Math.abs(efficiencyRatio([0, 2, 1, 3], 3) - 0.6) < 1e-9); // net |3−0|=3, path 2+1+2=5 → 0.6
  check("ER: too few values → 0", efficiencyRatio([1, 2], 5) === 0);

  // feeBlocksTrade: round-trip fee as a fraction of the 1R stop distance; reject if > maxPct
  const RT = 0.001; // 2 × 5bps round trip
  check("fee gate: tight stop (fee 100% of 1R) → block", feeBlocksTrade(100, 99.9, RT, 0.05) === true); // 0.001·100/0.1 = 1.0
  check("fee gate: wide stop (fee 3.3% of 1R) → allow", feeBlocksTrade(100, 97, RT, 0.05) === false); // 0.001·100/3 = 0.033
  check("fee gate: exactly at threshold → allow (strict >)", feeBlocksTrade(100, 98, RT, 0.05) === false); // 0.001·100/2 = 0.05
  check("fee gate: zero risk never blocks", feeBlocksTrade(100, 100, RT, 0.05) === false);
  check("fee gate: threshold 0 disables the gate", feeBlocksTrade(100, 99.9, RT, 0) === false);
  // marketRegimeBlocks: the paper-engine gate — blocks any regime NOT in allowedRegimes (default bull/flat)
  const allow = ["bull", "flat"] as ("bull" | "bear" | "flat")[];
  check("gate off never blocks", marketRegimeBlocks(false, "bull", allow) === false && marketRegimeBlocks(false, "bear", allow) === false);
  check("gate on allows bull & flat (the edge regimes)", marketRegimeBlocks(true, "bull", allow) === false && marketRegimeBlocks(true, "flat", allow) === false);
  check("gate on blocks bear (not in allowed)", marketRegimeBlocks(true, "bear", allow) === true);
  check("gate on with unknown regime (null) never blocks", marketRegimeBlocks(true, null, allow) === false);
  check("allowedRegimes = all three ⇒ passes every regime (gate effectively off)", marketRegimeBlocks(true, "bear", ["bull", "flat", "bear"]) === false);
  check("allowedRegimes = [bear] ⇒ restores old bear-only rule", marketRegimeBlocks(true, "bull", ["bear"]) === true && marketRegimeBlocks(true, "bear", ["bear"]) === false);

  // limitTouched: honest maker-fill test — a resting limit fills only when price trades to it (LONG bid ≤ low, SHORT ask ≥ high)
  check("maker fill: LONG limit filled when a bar low dips to it", limitTouched("LONG", 100, 99.5, 101) === true);
  check("maker fill: LONG limit NOT filled when price stays above (low > limit)", limitTouched("LONG", 100, 100.2, 101) === false);
  check("maker fill: SHORT limit filled when a bar high reaches it", limitTouched("SHORT", 100, 99, 100.4) === true);
  check("maker fill: SHORT limit NOT filled when price stays below (high < limit)", limitTouched("SHORT", 100, 99, 99.8) === false);
  check("maker fill: exact touch fills (LONG low == limit)", limitTouched("LONG", 100, 100, 101) === true);
}

console.log("orderflowxray.ts (footprint / delta / CVD / DOM / absorption)");
{
  // m=true → buyer is maker ⇒ aggressive SELL; m=false ⇒ aggressive BUY
  const T = (p: number, q: number, m: boolean) => ({ p: String(p), q: String(q), T: 0, m });
  const trades = [T(100, 1, false), T(100, 2, true), T(110, 3, false), T(90, 1, true)];
  const fp = buildFootprint(trades, 2);
  check("footprint: returns buckets sorted high→low", fp.length > 0 && fp[0]!.price >= fp[fp.length - 1]!.price);
  check("footprint: delta = buy - sell per level", fp.every((l) => Math.abs(l.deltaUsd - (l.buyUsd - l.sellUsd)) < 1e-9));
  const totalBuy = fp.reduce((s, l) => s + l.buyUsd, 0), totalSell = fp.reduce((s, l) => s + l.sellUsd, 0);
  check("footprint: conserves total buy/sell notional", Math.abs(totalBuy - (100 * 1 + 110 * 3)) < 1e-6 && Math.abs(totalSell - (100 * 2 + 90 * 1)) < 1e-6);
  check("footprint: single-price window collapses to one level", buildFootprint([T(50, 1, false), T(50, 2, true)], 5).length === 1);
  check("footprint: empty input safe", buildFootprint([], 5).length === 0);

  const cvd = cvdSeriesOf([T(100, 1, false), T(100, 1, false), T(100, 1, true)]);
  check("cvd: ends at net delta (buy - sell)", Math.abs(cvd[cvd.length - 1]! - 100) < 1e-6);
  check("cvd: all-sell window ends negative", cvdSeriesOf([T(10, 1, true), T(10, 1, true)]).slice(-1)[0]! < 0);

  const bids: [string, string][] = [["99", "10"], ["98", "5"]];
  const asks: [string, string][] = [["101", "1"], ["102", "1"]];
  check("bookImbalance: bid-heavy → positive", bookImbalance(bids, asks, 100, 5) > 0);
  check("bookImbalance: ask-heavy → negative", bookImbalance(asks.map(([p, q]) => [String(200 - +p), q]) as [string, string][], bids.map(([p, q]) => [String(200 - +p), q]) as [string, string][], 100, 5) < 0);
  check("bookImbalance: zero price safe", bookImbalance(bids, asks, 0, 5) === 0);

  const walls = findWalls([["99", "1000"], ["98", "1"], ["97", "1"]], [["101", "1"], ["102", "1"]], 100, 5, 5);
  check("findWalls: flags the outsized resting order", walls.length === 1 && walls[0]!.side === "BID" && walls[0]!.price === 99);
  check("findWalls: no walls in a flat book", findWalls([["99", "1"], ["98", "1"]], [["101", "1"], ["102", "1"]], 100, 5, 5).length === 0);

  check("absorption: perfectly two-sided → 100", Math.abs(absorption(50, 50) - 100) < 1e-9);
  check("absorption: one-sided → 0", Math.abs(absorption(100, 0) - 0) < 1e-9);
  check("absorption: no flow → 0", absorption(0, 0) === 0);

  check("pressureScore: buy-dominant + bid-heavy → positive", pressureScore(100, 0, 50, [0, 10]) > 0);
  check("pressureScore: sell-dominant + ask-heavy → negative", pressureScore(0, 100, -50, [0, -10]) < 0);
  check("pressureScore: balanced → ~0", Math.abs(pressureScore(50, 50, 0, [0, 0])) < 1e-6);
  check("pressureScore: stays within -100..100", Math.abs(pressureScore(1e9, 0, 100, [0, 1e9])) <= 100 + 1e-9);
}

console.log("paperexit.ts (liquidation guard — 'liquidation shouldn't be closer than the stop')");
{
  const caps = { maxLeverage: 20, maintenanceMarginRate: 0.005, liqSafetyMult: 2 };
  // entry 100, stop 2 away (2%), equity 1000. Requested 5% risk → 50/2 = 25 units → notional 2500 → 2.5x lev.
  const a = leverageCappedSize(100, 2, 1000, 25, caps);
  check("levCap: modest leverage passes uncapped", !a.capped && Math.abs(a.leverage - 2.5) < 1e-9 && a.units === 25);
  // Tight stop 0.1 (0.1%) with big requested size → would be huge leverage → must be capped
  const b = leverageCappedSize(100, 0.1, 1000, 5000, caps);
  check("levCap: tight stop + big size gets capped", b.capped && b.leverage <= 20 + 1e-9 && b.units < 5000);
  check("levCap: capped leverage respects maxLeverage ceiling", b.leverage <= caps.maxLeverage + 1e-9);
  // The cap must keep liquidation at least liqSafetyMult × stopFrac away
  const stopFrac = 0.1 / 100;
  const liqDist = 1 / b.leverage - caps.maintenanceMarginRate;
  check("levCap: liquidation sits >= 2x the stop distance away", liqDist >= caps.liqSafetyMult * stopFrac - 1e-9);
  check("levCap: zero/invalid inputs are safe", leverageCappedSize(0, 1, 1000, 10, caps).units === 0 && leverageCappedSize(100, 0, 1000, 10, caps).units === 0);
  // liquidationPrice: at 10x with 0.5% mmr, liq distance = 1/10 - 0.005 = 9.5%
  check("liqPrice: LONG 10x ≈ -9.5%", Math.abs(liquidationPrice(true, 100, 10, 0.005) - 90.5) < 1e-9);
  check("liqPrice: SHORT 10x ≈ +9.5%", Math.abs(liquidationPrice(false, 100, 10, 0.005) - 109.5) < 1e-9);
  check("liqPrice: higher leverage pulls liquidation CLOSER", liquidationPrice(true, 100, 20, 0.005) > liquidationPrice(true, 100, 5, 0.005));
  // The whole point: with the guard, liquidation is always beyond the stop
  const c2 = leverageCappedSize(100, 2, 1000, 100000, caps); // absurd request → capped
  const liqP = liquidationPrice(true, 100, c2.leverage, caps.maintenanceMarginRate);
  check("guard invariant: liq price is BEYOND the stop (long)", liqP < 100 - 2);
}

console.log("context.ts (market-context HUD helpers)");
{
  const c = (tb: number, v: number) => ({ openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: v, takerBuyVolume: tb, closeTime: 1, closed: true });
  // flowLean: net aggressive lean = Σ(2·takerBuy − vol)/Σvol, clamped [-1,1]
  check("flowLean: all aggressive buys → +1", flowLean([c(10, 10), c(10, 10)]) === 1);
  check("flowLean: all aggressive sells → -1", flowLean([c(0, 10), c(0, 10)]) === -1);
  check("flowLean: balanced → 0", Math.abs(flowLean([c(5, 10), c(5, 10)])) < 1e-9);
  check("flowLean: no volume → 0", flowLean([c(0, 0)]) === 0);
  check("flowLean: ignores unclosed candles", flowLean([{ ...c(10, 10), closed: false }]) === 0);
  // percentileOf: fraction of history ≤ x
  check("percentileOf: median", percentileOf([1, 2, 3, 4], 2) === 0.5);
  check("percentileOf: max → 1", percentileOf([1, 2, 3], 3) === 1);
  check("percentileOf: below all → 0", percentileOf([1, 2, 3], 0) === 0);
  check("percentileOf: empty → 0.5 (neutral)", percentileOf([], 5) === 0.5);
}

console.log("contextreport.ts (forward-log outcome resolver)");
{
  const bar = (ct: number, low: number, high: number) => ({ openTime: ct - 1, open: (low + high) / 2, high, low, close: (low + high) / 2, volume: 1, takerBuyVolume: 0.5, closeTime: ct, closed: true });
  const sig = { direction: "LONG" as const, entry: 100, stop: 95, target: 110, signalCloseTime: 1000 };
  // signal bar at ct=1000; next bars decide. Target 110 (rt=2), stop 95. fee 0 for exact R.
  const winBars = [bar(1000, 99, 101), bar(2000, 100, 111)]; // 2nd bar hits target
  const lossBars = [bar(1000, 99, 101), bar(2000, 94, 101)]; // 2nd bar hits stop first
  const openBars = [bar(1000, 99, 101), bar(2000, 99, 102)]; // neither hit
  const w = resolveOutcome(sig, winBars, 0);
  const l = resolveOutcome(sig, lossBars, 0);
  const p = resolveOutcome(sig, openBars, 0);
  check("resolveOutcome: target hit → win, r=+2 (rt)", w.outcome === "win" && "r" in w && Math.abs(w.r - 2) < 1e-9);
  check("resolveOutcome: stop hit → loss, r=-1", l.outcome === "loss" && "r" in l && Math.abs(l.r - -1) < 1e-9);
  check("resolveOutcome: neither → pending", p.outcome === "pending");
  check("resolveOutcome: fee reduces win R below rt", (() => { const r = resolveOutcome(sig, winBars, 0.0005); return "r" in r && r.r < 2; })());
  check("resolveOutcome: signal bar absent → pending", resolveOutcome({ ...sig, signalCloseTime: 500 }, winBars, 0).outcome === "pending");
}

console.log("paper.ts (dual-account contract — the filter-vs-strategy experiment)");
{
  // Reads only the in-memory ACCOUNTS (no paperInit ⇒ no disk/network), so it stays a pure test.
  const api = paperApi();
  check("exposes three accounts (2 legacy 1h + core_4h)", api.accounts.length === 3, `${api.accounts.length}`);
  const filtered = api.accounts.find((a) => a.id === "filtered");
  const strategy = api.accounts.find((a) => a.id === "strategy");
  const core4h = api.accounts.find((a) => a.id === "core_4h");
  check("has 'filtered', 'strategy' and 'core_4h' accounts", !!filtered && !!strategy && !!core4h);
  // The whole point of the split: one gates on the bear-only filter, the others never do.
  check("'filtered' applies the bear-only filter", filtered?.applyFilter === true);
  check("'strategy' takes every signal (no filter)", strategy?.applyFilter === false);
  // core_4h is the additive 4h forward-test: unfiltered, on 4h candles; legacy accounts stay on 1h.
  check("'core_4h' is unfiltered", core4h?.applyFilter === false);
  check("legacy accounts feed off 1h, core_4h off 4h", filtered?.timeframe === "1h" && strategy?.timeframe === "1h" && core4h?.timeframe === "4h");
  check("all three start at the configured balance", [filtered, strategy, core4h].every((a) => a?.startBalance === config.paper.startBalanceUsd));
  // Fresh accounts must be flat and honest — no phantom equity/trades before anything happens.
  for (const a of api.accounts) {
    check(`${a.id}: fresh equity == startBalance`, a.equity === a.startBalance);
    check(`${a.id}: fresh account has 0 trades & 0 open`, a.stats.trades === 0 && a.stats.openCount === 0);
    check(`${a.id}: snapshot shape complete`, typeof a.returnPct === "number" && Array.isArray(a.open) && Array.isArray(a.closed) && Array.isArray(a.curve) && typeof a.stats.maxDrawdownPct === "number");
  }
}

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
