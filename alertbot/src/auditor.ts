import type { PaperTrade } from "./paper.js";

/**
 * LLM-AUDITOR. Fires when the circuit breaker trips on an account: extracts the last N closed trades,
 * formats a compact JSON payload, and sends it to an LLM for a structured diagnosis.
 *
 * Default model: NVIDIA Nemotron Ultra (nvidia/llama-3.1-nemotron-ultra-253b-v1) — FREE via NVIDIA NIM.
 * Override via env vars to use any OpenAI-compatible endpoint (OpenAI, Anthropic, local Ollama, etc.).
 * Get a free NVIDIA API key at: https://build.nvidia.com
 *
 * Strictly modular: depends only on the exported `PaperTrade` type, never on the paper engine internals.
 */

/** Pure: build the compact audit payload from an account's closed trades (newest-first). Unit-tested. */
export function formatAuditPayload(accountId: string, closedNewestFirst: PaperTrade[], reason: string, n = 10): string {
  const trades = closedNewestFirst.slice(0, n).map((t) => ({
    symbol: t.symbol,
    dir: t.direction,
    source: t.source,
    entry: t.entry,
    stop: t.stop,
    target: t.target,
    exit: t.exit,
    reason: t.exitReason,
    pnlUsd: Number(t.pnlUsd.toFixed(2)),
    r: Number(t.rMultiple.toFixed(3)),
    closeTime: t.closeTime,
  }));
  return JSON.stringify({ account: accountId, trip: reason, count: trades.length, trades });
}

// Default: NVIDIA Nemotron 3 Ultra (550B, 1M context) — free at https://build.nvidia.com (OpenAI-compatible API).
// Override with env vars to use any compatible provider:
//   LLM_API_URL=https://api.openai.com/v1/chat/completions  LLM_MODEL=gpt-4o-mini
//   LLM_API_URL=https://api.anthropic.com/v1/messages       LLM_MODEL=claude-3-haiku-20240307
//   LLM_API_URL=http://localhost:11434/v1/chat/completions   LLM_MODEL=llama3  (local Ollama)
const LLM_URL = process.env.LLM_API_URL ?? "https://integrate.api.nvidia.com/v1/chat/completions";
const LLM_MODEL = process.env.LLM_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b";
// Nemotron Ultra has a reasoning mode — "detailed thinking off" keeps it in fast JSON-only mode.
// For other models, remove the thinking prefix; the instruction still produces valid JSON.
const NVIDIA_THINKING_OFF = "detailed thinking off\n\n";
const AUDIT_SYSTEM =
  NVIDIA_THINKING_OFF +
  'You are a trading-risk auditor. Given JSON of a paper account\'s recent closed/losing trades, diagnose the likely ' +
  'cause of the losses. Reply with ONLY a pure JSON string (no markdown, no prose) of EXACTLY this shape: ' +
  '{"diagnosis": string, "suggested_action": "widen_stops" | "pause" | "none"}';

/**
 * POST the audit payload to the LLM. FAIL-SAFE by construction: no-ops if LLM_API_KEY is unset, hard 15s timeout,
 * catches everything, NEVER throws. Returns the model's diagnosis text or null. ADVISORY ONLY — the returned
 * suggested_action is logged, NOT auto-applied to the trading/money path (keep a human in the loop before wiring it).
 */
export async function fetchLlmAudit(payload: string): Promise<string | null> {
  const key = process.env.LLM_API_KEY;
  if (!key) return null; // not configured → silent no-op (never blocks, never errors)
  try {
    const res = await fetch(LLM_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: LLM_MODEL, messages: [{ role: "system", content: AUDIT_SYSTEM }, { role: "user", content: payload }] }),
      signal: AbortSignal.timeout(15000), // strict 15s cap — cannot stall the trading loop
    });
    if (!res.ok) { console.warn(`LLM auditor: HTTP ${res.status} (non-fatal)`); return null; }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data?.choices?.[0]?.message?.content ?? null;
    if (content) console.warn(`LLM auditor diagnosis [ADVISORY — not auto-applied]: ${content}`);
    return content;
  } catch (e) {
    console.warn(`LLM auditor call failed (non-fatal): ${(e as Error).name}`);
    return null;
  }
}

/** Fire the auditor: log the payload, then FIRE-AND-FORGET the LLM call (never awaited on the trading path). */
export function triggerAudit(accountId: string, closedNewestFirst: PaperTrade[], reason: string): void {
  const payload = formatAuditPayload(accountId, closedNewestFirst, reason);
  console.warn(`Circuit breaker tripped. Trade history prepared for LLM Auditor: ${payload}`);
  void fetchLlmAudit(payload).catch(() => {}); // fire-and-forget: not awaited, cannot reject into the loop
}
