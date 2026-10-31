@echo off
rem Adds "PDF Word Reader" to the "Open with" menu for .pdf files (current user only).
setlocal
for /f "usebackq delims=" %%P in (`python -c "import sys, pathlib; print(pathlib.Path(sys.executable).with_name('pythonw.exe'))"`) do set "PYTHONW_PATH=%%P"
if not exist "%PYTHONW_PATH%" (
    echo pythonw.exe not found next to python.exe
    pause
    exit /b 1
)
set "LAUNCHER_PATH=%~dp0launcher.py"
set "PROG_ID=PdfWordReader.Document"

reg add "HKCU\Software\Classes\%PROG_ID%" /ve /d "PDF Document (PDF Word Reader)" /f >nul
reg add "HKCU\Software\Classes\%PROG_ID%\Application" /v ApplicationName /d "PDF Word Reader" /f >nul
reg add "HKCU\Software\Classes\%PROG_ID%\shell\open" /v FriendlyAppName /d "PDF Word Reader" /f >nul
reg add "HKCU\Software\Classes\%PROG_ID%\shell\open\command" /ve /d "\"%PYTHONW_PATH%\" \"%LAUNCHER_PATH%\" \"%%1\"" /f >nul
reg add "HKCU\Software\Classes\.pdf\OpenWithProgids" /v "%PROG_ID%" /t REG_NONE /f >nul

echo Registered. Right-click a PDF - Open with - PDF Word Reader.
echo Command: "%PYTHONW_PATH%" "%LAUNCHER_PATH%" "%%1"
pause
