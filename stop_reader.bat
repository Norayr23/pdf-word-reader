@echo off
rem Stops the background server (needed after updating the code).
python -c "import urllib.request; urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:8765/api/shutdown', method='POST', headers={'X-Pdf-Word-Reader': '1'}), timeout=3); print('Server stopped.')" 2>nul || echo Server was not running.
timeout /t 2 >nul
