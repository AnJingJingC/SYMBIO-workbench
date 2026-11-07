@echo off
title SYMBIO 工作台初始化
cd /d "%~dp0"

echo ==========================================================
echo   SYMBIO 工作台初始化
echo.
echo   第一步：体检（只读，一个字节都不写）
echo   看清楚缺什么，再决定补不补
echo ==========================================================
echo.
pause >nul

echo.
echo 正在检查 ...
echo.
chcp 65001 >nul & node tools\setup.mjs & chcp 936 >nul

echo.
echo ----------------------------------------------------------
echo   如果上面有 FAIL：
echo     node tools\setup.mjs --fix
echo   它只补不存在的目录与文件，不会覆盖你已经写好的记忆
echo ----------------------------------------------------------
echo.
pause
exit /b 0
