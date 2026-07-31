@echo off
chcp 65001 >nul

cd /d "%~dp0"

netstat -ano | findstr ":9222" >nul

if errorlevel 1 (
    echo Запускаю специальный Chrome...

    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
        --remote-debugging-port=9222 ^
        --user-data-dir="%LOCALAPPDATA%\ChromePriceMonitor"

    timeout /t 10 /nobreak >nul
) else (
    echo Специальный Chrome уже запущен.
)

echo Запускаю мониторинг цен...

".venv\Scripts\python.exe" "price_monitor.py"

echo.
echo Работа завершена.
pause