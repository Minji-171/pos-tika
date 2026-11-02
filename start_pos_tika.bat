@echo off
title POS TIKA - Point of Sale ^& Business Management System (Pemilik: TIKA)
cd /d "%~dp0"
echo Menjalankan Server Lokal ^& P2P Signaling Relay POS TIKA...
start "" "http://localhost:8090"
python server.py 8090
pause
