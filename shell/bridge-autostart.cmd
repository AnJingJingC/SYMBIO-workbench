@echo off
rem SYMBIO web AI bridge autostart: wait for DSH Desktop, then launch bridge-only mode (127.0.0.1:31239)
set ELECTRON_RUN_AS_NODE=
set ELECTRON=E:\SYMBIO\shell\node_modules\electron\dist\electron.exe

rem skip if bridge is already healthy
powershell -NoProfile -Command "try{Invoke-WebRequest -Uri 'http://127.0.0.1:31239/health' -UseBasicParsing -TimeoutSec 2|Out-Null;exit 0}catch{exit 1}" && exit /b 0

rem wait up to 10 minutes for DSH Desktop to start
set /a n=0
:wait
tasklist /FI "IMAGENAME eq DSH Desktop.exe" | find /I "DSH Desktop.exe" >nul && goto run
tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" | find /I "DeepSeek Harness.exe" >nul && goto run
set /a n+=1
if %n% geq 120 exit /b 1
timeout /t 5 /nobreak >nul
goto wait

:run
start "" /b "%ELECTRON%" "E:\SYMBIO\shell" --bridge-only
exit /b 0