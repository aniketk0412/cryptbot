import "./env.js";
import { config } from "./config.js";

/**
 * Helper: prints the chat id(s) that have messaged your bot, so you can paste it
 * into .env. Usage: set TELEGRAM_BOT_TOKEN in .env, message your bot "hi", then
 * run `npm run tg:chatid`.
 */
async function main() {
  const token = config.telegram.token;
  if (!token) {
    console.log("Set TELEGRAM_BOT_TOKEN in .env first (from @BotFather).");
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const data = (await res.json()) as {
    ok: boolean;
    result?: { message?: { chat?: { id?: number; first_name?: string; type?: string } } }[];
  };
  if (!data.ok) {
    console.log("Telegram rejected the token. Double-check TELEGRAM_BOT_TOKEN.");
    process.exit(1);
  }
  const chats = new Map<number, string>();
  for (const u of data.result ?? []) {
    const chat = u.message?.chat;
    if (chat?.id != null) chats.set(chat.id, `${chat.first_name ?? ""} (${chat.type ?? "?"})`);
  }
  if (chats.size === 0) {
    console.log("No messages found. Open your bot in Telegram, send it any message, then re-run this.");
    return;
  }
  console.log("Found chat id(s) — paste the right one into TELEGRAM_CHAT_ID in .env:");
  for (const [id, who] of chats) console.log(`  ${id}   ${who}`);
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
