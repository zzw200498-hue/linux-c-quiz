@echo off
chcp 65001 >nul
title Linux C 题库 · 桌面端
cd /d "%~dp0.."

echo.
echo   Linux C 题库 · 桌面端
echo   ------------------------------------
echo.

if not exist "desktop\dist\server.cjs" (
  echo   首次运行，正在构建...
  call npm run desktop:build
  echo.
)

node desktop\launch.mjs
pause
