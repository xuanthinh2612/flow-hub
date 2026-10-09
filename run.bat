@echo off
cd /d "%~dp0"
if not exist frontend\dist\index.html (
  if exist frontend\package.json (
    echo Building React frontend...
    cd frontend
    call npm.cmd run build
    cd /d "%~dp0"
  )
)
if not exist .venv\Scripts\python.exe (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
.venv\Scripts\python -m flowhub
