@echo off
rem Removes the "Open with" entry created by register_open_with.bat.
set "PROG_ID=PdfWordReader.Document"
reg delete "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "%PROG_ID%" /f >nul 2>&1
reg delete "HKCU\Software\Classes\%PROG_ID%" /f >nul 2>&1
echo Unregistered.
pause
