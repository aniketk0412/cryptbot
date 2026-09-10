@echo off
REM ── Cryptbot alertbot launcher ─────────────────────────────────────────────────
REM Auto-start (via a shortcut in the user Startup folder) + auto-restart on crash.
REM No admin / Task Scheduler needed. Launched hidden by start-bot-hidden.vbs at logon.
cd /d "X:\cryptbot\alertbot"

:loop
REM Don't start a second instance if the dashboard is already served on port 1000.
netstat -ano | findstr ":1000 " | findstr /I "LISTENING" >nul 2>&1
if %errorlevel%==0 (
  echo [start-bot] Port 1000 already serving - not starting a duplicate. %date% %time%>> "data\bot-console.log"
  exit /b 0
)
echo [start-bot] Launching bot %date% %time%>> "data\bot-console.log"
"C:\Program Files\nodejs\node.exe" --import tsx src/index.ts >> "data\bot-console.log" 2>&1
echo [start-bot] Bot exited (code %errorlevel%) %date% %time% - restarting in ~15s>> "data\bot-console.log"
REM ping-based sleep: `timeout` fails when stdout is redirected; ping does not.
ping -n 16 127.0.0.1 >nul 2>&1
goto loop
