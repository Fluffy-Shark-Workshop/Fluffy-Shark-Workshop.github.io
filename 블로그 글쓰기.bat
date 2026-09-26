@echo off
rem Blog writer: double-click, or drop files/folders onto this file.
setlocal
cd /d "%~dp0"
title Blog writer

set "PY=.venv\Scripts\python.exe"
if exist "%PY%" goto check
echo [setup] Creating a Python environment for the blog tools...
where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
if not exist "%PY%" goto nopython

:check
"%PY%" -c "import markdown_it, mdit_py_plugins, yaml, jinja2, pygments" >nul 2>nul
if not errorlevel 1 goto run
echo [setup] Installing packages (first run only)...
"%PY%" -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 goto failed

:run
"%PY%" tools\writer.py %*
if errorlevel 1 pause
goto :eof

:nopython
echo.
echo Python 3 was not found. Install it from https://www.python.org/downloads/
echo (check "Add python.exe to PATH"), then run this file again.
pause
goto :eof

:failed
echo.
echo Package installation failed. Check the internet connection and try again.
pause
