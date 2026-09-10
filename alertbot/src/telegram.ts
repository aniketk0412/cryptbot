import { config } from "./config.js";

/**
 * Send a message to your Telegram chat. Silent no-op if Telegram isn't
 * configured, and never throws — alert delivery must not crash the watcher.
 */
export async function sendTelegram(text: string): Promise<void> {
  const { token, chatId } = config.telegram;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // swallow — a failed ping shouldn't stop the loop
  }
}

export function telegramEnabled(): boolean {
  return Boolean(config.telegram.token && config.telegram.chatId);
}
