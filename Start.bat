@echo off
chcp 65001 >nul
title docMaker
cd /d "%~dp0"
rem 同じフォルダの docmaker.exe があればそれを開く（配る形）。無ければ cargo でビルドして開く（開発中の形）
if exist "%~dp0docmaker.exe" (
  "%~dp0docmaker.exe" %*
) else (
  cargo run --release --quiet --bin docmaker -- %*
)
pause
