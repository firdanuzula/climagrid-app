@echo off
setlocal
title ClimaGrid
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js belum terpasang di komputer ini.
  echo  Unduh dan pasang dulu dari: https://nodejs.org
  echo  Setelah itu jalankan file ini lagi.
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   ClimaGrid - Dashboard Cuaca Jawa Timur
echo  ============================================
echo.
echo  Browser akan terbuka otomatis.
echo  Alamat: http://localhost:4173
echo.
echo  Tutup jendela ini atau tekan Ctrl+C
echo  untuk menghentikan server.
echo.

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://localhost:4173'"
node server.js

echo.
echo  Server berhenti.
pause
