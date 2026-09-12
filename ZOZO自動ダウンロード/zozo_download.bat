@echo off
rem ZOZO BACK OFFICE goods_cs auto download
rem Task Scheduler runs this every morning at 8:00.
rem This file is ASCII only on purpose: the folder path contains Japanese,
rem so paths are taken from %~dp0 instead of being written out here.
chcp 932 > nul
cd /d "%~dp0"
"C:\Users\poyo\AppData\Local\Programs\Python\Python313\python.exe" "%~dp0zozo_download.py" %*
exit /b %ERRORLEVEL%
