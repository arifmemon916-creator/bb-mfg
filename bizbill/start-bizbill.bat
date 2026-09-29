@echo off
title BizBill - Local Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nahi mila. Pehle https://nodejs.org se Node.js (LTS) install karo, phir is file ko dobara chalao.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Dependencies install ho rahi hain, thoda wait karo...
  call npm install
)

echo.
echo BizBill server start ho raha hai...
echo Browser me automatically khulega: http://127.0.0.1:8080/
echo Is window ko band mat karo jab tak app use kar rahe ho.
echo.

start "" http://127.0.0.1:8080/
node tools\serve.mjs

pause
