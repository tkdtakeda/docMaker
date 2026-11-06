@echo off
chcp 65001 >nul
title docMaker
cd /d "%~dp0"
python run.py
pause
