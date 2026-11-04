@echo off
setlocal
title SYMBIO 发布仓 - 推送到 GitHub
cd /d "%~dp0"

echo ==========================================================
echo   SYMBIO 工作台 - 把发布仓推送到 GitHub
echo   目标：https://github.com/AnJingJingC/SYMBIO-workbench
echo   整个动作只需要成功跑一次
echo ==========================================================
echo.

where git >nul 2>&1
if errorlevel 1 goto NOGIT

echo [1/3] 启用 GitHub 登录弹窗 ...
git config --global credential.helper manager
git config --global credential.https://github.com.provider github
echo       完成
echo.

echo [2/3] 检查能不能连上 GitHub ...
set GIT_TERMINAL_PROMPT=0
set GCM_INTERACTIVE=Never
git ls-remote origin >nul 2>&1
if errorlevel 1 goto NONET
set GIT_TERMINAL_PROMPT=
set GCM_INTERACTIVE=
echo       连接正常
echo.

echo [3/3] 开始推送。第一次会弹出 GitHub 登录窗口，
echo       点 Sign in with your browser，浏览器里授权后会自动继续 ...
echo.
git push -u origin main
if errorlevel 1 goto RETRY
goto DONE

:RETRY
echo.
echo [!] 直推没成功，可能是远端已有一份 README。先合并再推 ...
git pull --no-rebase --allow-unrelated-histories origin main
git push -u origin main
if errorlevel 1 goto PUSHFAIL
goto DONE

:DONE
echo.
echo ==========================================================
echo   [成功] 已经推送到 GitHub
echo.
echo   打开这个地址确认能看到文件：
echo   https://github.com/AnJingJingC/SYMBIO-workbench
echo.
echo   应该看到：package.json  dsh  src  lib  tools  shell  docs  icon.svg
echo   不应该看到：memory 目录 —— 看不到是对的，那是你的私人记忆
echo ==========================================================
echo.
pause
exit /b 0

:NOGIT
echo.
echo [X] 这台电脑找不到 git 命令。
echo     先装 Git for Windows：https://git-scm.com/download/win
echo     一路点下一步装完，关掉本窗口，再双击一次本文件。
echo.
pause
exit /b 1

:NONET
set GIT_TERMINAL_PROMPT=
set GCM_INTERACTIVE=
echo.
echo [X] 连不上 GitHub，或者仓库不存在 / 没权限。三种常见情况：
echo.
echo     情况1  仓库还没建
echo            浏览器打开 https://github.com/new
echo            Repository name 填 SYMBIO-workbench
echo            选 Public，不要勾 Add a README file，点 Create repository
echo            建好后再双击本文件
echo.
echo     情况2  需要走代理
echo            你浏览器如果能上 GitHub 是靠梯子，那 git 也要设同一个代理。
echo            双击打开 CMD 后粘这一行并回车（端口按你梯子的实际端口改）：
echo            git config --global http.proxy http://127.0.0.1:7890
echo            然后重新双击本文件
echo.
echo     情况3  账号或仓库名拼错了
echo            必须正好是 AnJingJingC/SYMBIO-workbench
echo.
pause
exit /b 1

:PUSHFAIL
echo.
echo [X] 推送失败。把上面最后 8 行报错复制发给我，我帮你定位。
echo.
pause
exit /b 1
