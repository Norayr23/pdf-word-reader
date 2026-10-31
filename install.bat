@echo off
rem Installs the Python packages the reader needs (run once).
cd /d "%~dp0"
python -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo Installation failed. Check that Python 3.10+ is installed and on PATH.
) else (
    echo.
    echo Done. Run start_reader.bat or register_open_with.bat next.
)
pause
