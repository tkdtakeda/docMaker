@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem デスクトップに docMaker のアイコン付きショートカットを作る（Start.bat を開く）
powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=[Environment]::GetFolderPath('Desktop'); $s=(New-Object -ComObject WScript.Shell).CreateShortcut($d+'\docMaker.lnk'); $s.TargetPath='%~dp0Start.bat'; $s.WorkingDirectory='%~dp0'; $s.IconLocation='%~dp0web\img\docmaker.ico'; $s.Description='docMaker 帳票作成ツール'; $s.Save()"
if errorlevel 1 (echo 作れませんでした。) else (echo デスクトップに docMaker のショートカットを作りました。)
pause
