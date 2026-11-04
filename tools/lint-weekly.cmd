@echo off
rem SYMBIO 记忆体检 —— Windows 计划任务入口
rem 注册命令（一次性）：
rem   schtasks /Create /F /TN "SYMBIO 记忆体检" /SC WEEKLY /D SUN /ST 09:00 /TR "cmd /c E:\SYMBIO\tools\lint-weekly.cmd"
cd /d E:\SYMBIO
node tools\lint-weekly.mjs
