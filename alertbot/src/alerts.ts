import { config } from "./config.js";
import { pushAlert } from "./dashboardState.js";
import { fmtPrice, nowStr } from "./format.js";
import { nativeNotify } from "./notify.js";
import { sendTelegram } from "./telegram.js";
import type { Alert } from "./types.js";

const BELL = "\x07"; // terminal beep
const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
};

/** Qualitative label for a (weighted) confluence score. */
function grade(score: number, max: number): string {
  const r = max > 0 ? score / max : 0;
  return r >= 0.75 ? "STRONG" : r >= 0.5 ? "OK" : "WEAK";
}
const gradeRank = (g: string): number => (g === "STRONG" ? 2 : g === "OK" ? 1 : 0);

/** Deliver an alert to the terminal (with a beep) and to Telegram if configured. */
export async function dispatch(alert: Alert): Promise<void> {
  const directional = alert.kind === "strategy" || alert.kind === "reversal";
  const bullish = directional ? alert.direction === "LONG" : alert.level === "support";
  const color = bullish ? C.green : C.red;
  const arrow = bullish ? "▲" : "▼";
  const kindTag =
    alert.kind === "strategy"
      ? `SETUP 🎯 ${alert.strategyName ?? ""}`
      : alert.kind === "reversal"
        ? "REVERSAL 🔄"
        : alert.kind === "breakout"
          ? "BREAKOUT 💥"
          : alert.kind === "confirmation"
            ? "CONFIRMED ✅"
            : "TOUCH ⚠️";
  const label = directional ? (alert.direction ?? "") : alert.level.toUpperCase();

  // Terminal
  console.log(
    `${BELL}${color}${C.bold}${nowStr()}  ${alert.symbol}  ${kindTag}  ${arrow} ${label} ` +
      `@ ${fmtPrice(alert.levelPrice)}${C.reset}  ${color}${alert.message}${C.reset}`,
  );
  if (alert.confluence) {
    const cf = alert.confluence;
    const marks = cf.factors.map((f) => `${f.ok ? "✓" : "✗"} ${f.label}`).join("   ");
    const ctx = cf.context.length ? `   |   ${cf.context.join("  ")}` : "";
    const wpct = cf.weightedMax > 0 ? Math.round((cf.weighted / cf.weightedMax) * 100) : 0;
    console.log(
      `${color}          confirmation ${cf.score}/${cf.max} ${grade(cf.weighted, cf.weightedMax)} (wtd ${wpct}%):  ${marks}${ctx}${C.reset}`,
    );
  }
  if (alert.plan) {
    const p = alert.plan;
    console.log(
      `${color}          plan ${p.direction}  entry ${fmtPrice(p.entry)}  stop ${fmtPrice(p.stop)}  target ${fmtPrice(p.target)}  ` +
        `R:R ${p.rr.toFixed(2)}${p.lowQuality ? " (low)" : ""}  size ${p.sizeUnits.toFixed(3)} (~$${p.notionalUsd.toFixed(0)}, ${p.leverage.toFixed(1)}x)${C.reset}`,
    );
  }
  if (alert.bet) {
    const b = alert.bet;
    const on = b.workers.filter((w) => w.present).map((w) => `${w.name}${w.liftPp >= 0 ? "+" : ""}${w.liftPp.toFixed(0)}`).join(" ");
    console.log(
      `${color}          evidence ${b.grade} · ~${b.winPct.toFixed(0)}% win` +
        `${b.measuredExpR != null ? ` · ${b.measuredExpR >= 0 ? "+" : ""}${b.measuredExpR.toFixed(2)}R (${b.sampleN}n)` : ""}${on ? ` · ${on}` : ""}${C.reset}`,
    );
  }

  // Telegram
  const head =
    alert.kind === "strategy"
      ? `🎯 <b>SETUP</b> ${alert.strategyName ?? ""}`
      : alert.kind === "reversal"
        ? "🔄 <b>REVERSAL</b>"
        : alert.kind === "breakout"
          ? "💥 <b>BREAKOUT</b>"
          : alert.kind === "confirmation"
            ? "✅ <b>CONFIRMED</b>"
            : "⚠️ <b>TOUCH</b>";
  let cfText = "";
  if (alert.confluence) {
    const cf = alert.confluence;
    const marks = cf.factors.map((f) => `${f.ok ? "✓" : "✗"} ${f.label}`).join("\n");
    cfText =
      `\n<b>confirmation ${cf.score}/${cf.max} ${grade(cf.weighted, cf.weightedMax)}</b>\n${marks}` +
      (cf.context.length ? `\n${cf.context.join("  ·  ")}` : "");
  }
  let planText = "";
  if (alert.plan) {
    const p = alert.plan;
    planText =
      `\n\n<b>${p.direction} plan</b>  R:R ${p.rr.toFixed(2)}${p.lowQuality ? " ⚠️low" : ""}\n` +
      `entry ${fmtPrice(p.entry)} · stop ${fmtPrice(p.stop)} · target ${fmtPrice(p.target)}\n` +
      `size ${p.sizeUnits.toFixed(3)} (~$${p.notionalUsd.toFixed(0)}, ${p.leverage.toFixed(1)}x, risk $${p.riskUsd.toFixed(0)})`;
  }
  let betText = "";
  if (alert.bet) {
    const b = alert.bet;
    const on = b.workers.filter((w) => w.present).map((w) => `${w.name} ${w.liftPp >= 0 ? "+" : ""}${w.liftPp.toFixed(0)}pp`).join(", ");
    betText =
      `\n\n📊 <b>Evidence: ${b.grade}</b> · ~${b.winPct.toFixed(0)}% win` +
      `${b.measuredExpR != null ? ` · ${b.measuredExpR >= 0 ? "+" : ""}${b.measuredExpR.toFixed(2)}R over ${b.sampleN} trades` : ""}` +
      `${on ? `\nbacked by: ${on}` : ""}`;
  }
  await sendTelegram(
    `${head} ${arrow} ${label}\n` +
      `<b>${alert.symbol}</b> ${config.interval}  @ ${fmtPrice(alert.levelPrice)}\n` +
      `${alert.message}${cfText}${planText}${betText}`,
  );

  // Dashboard
  pushAlert({
    time: new Date().toISOString(),
    symbol: alert.symbol,
    kind: alert.kind,
    level: alert.level,
    direction: alert.direction,
    strategyName: alert.strategyName,
    levelPrice: alert.levelPrice,
    score: alert.confluence
      ? `${alert.confluence.score}/${alert.confluence.max} ${grade(alert.confluence.weighted, alert.confluence.weightedMax)}`
      : undefined,
    factors: alert.confluence?.factors,
    context: alert.confluence?.context,
    plan: alert.plan,
    bet: alert.bet,
    signalCloseTime: alert.signalCloseTime,
    message: alert.message,
  });

  // Native desktop notification — priority-filtered (actionable kinds, grade gate).
  const actionable =
    alert.kind === "confirmation" || alert.kind === "strategy" || alert.kind === "breakout" || alert.kind === "reversal";
  const gradeOk =
    !alert.confluence ||
    gradeRank(grade(alert.confluence.weighted, alert.confluence.weightedMax)) >= gradeRank(config.notify.minGrade);
  if (actionable && gradeOk) {
    const p = alert.plan;
    const scoreStr = alert.confluence
      ? ` · ${alert.confluence.score}/${alert.confluence.max} ${grade(alert.confluence.weighted, alert.confluence.weightedMax)}`
      : "";
    const body = p
      ? `Entry ${fmtPrice(p.entry)} · Stop ${fmtPrice(p.stop)} · Target ${fmtPrice(p.target)} · R:R ${p.rr.toFixed(1)}${scoreStr}`
      : `${alert.message}${scoreStr}`;
    nativeNotify(`${alert.symbol}  ${label} @ ${fmtPrice(alert.levelPrice)}`, body);
  }
}
