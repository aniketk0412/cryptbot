import { execFile } from "node:child_process";
import { config } from "./config.js";

// Windows toast via the built-in WinRT API (no install). Title/body passed as
// env vars to avoid any quoting/injection issues. Non-fatal on any failure.
const PS = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $x = $t.GetElementsByTagName('text')
  $null = $x.Item(0).AppendChild($t.CreateTextNode($env:NOTIF_TITLE))
  $null = $x.Item(1).AppendChild($t.CreateTextNode($env:NOTIF_BODY))
  $toast = [Windows.UI.Notifications.ToastNotification]::new($t)
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Candela').Show($toast)
} catch {}
`;

/** Fire a native Windows desktop notification. Silent no-op if disabled/unsupported. */
export function nativeNotify(title: string, body: string): void {
  if (!config.notify.enabled) return;
  try {
    execFile(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", PS],
      { env: { ...process.env, NOTIF_TITLE: title, NOTIF_BODY: body }, windowsHide: true },
      () => {},
    );
  } catch {
    // notifications are best-effort
  }
}
