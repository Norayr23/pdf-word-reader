@echo off
rem Starts the reader. Optional argument: path to a PDF file.
for /f "usebackq delims=" %%P in (`python -c "import sys, pathlib; print(pathlib.Path(sys.executable).with_name('pythonw.exe'))"`) do set "PYTHONW_PATH=%%P"
if not exist "%PYTHONW_PATH%" (
    echo pythonw.exe not found next to python.exe
    pause
    exit /b 1
)
start "" "%PYTHONW_PATH%" "%~dp0launcher.py" %*
