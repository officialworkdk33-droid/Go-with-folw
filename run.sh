#!/usr/bin/env bash
# Starts the HAWB Document Merger app.
# First run: creates a venv and installs dependencies.
set -e
cd "$(dirname "$0")/backend"

if [ ! -d ".venv" ]; then
  echo "Setting up virtual environment (first run only)…"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip -q
  ./.venv/bin/pip install -r requirements.txt -q
fi

echo ""
echo "Starting server at http://127.0.0.1:8000"
echo "Open that address in your browser. Press Ctrl+C to stop."
echo ""
./.venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000
