#!/bin/bash
# Double-click this file to start Girl Math and open it in your browser.
# Close the Terminal window that appears to stop it.

cd "$(dirname "$0")" || exit 1

# Homebrew's node isn't always on the PATH that Finder hands to a double-click.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node > /dev/null 2>&1; then
  echo "Node isn't installed. Install it with:  brew install node"
  echo
  read -r -p "Press return to close."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "First run — installing dependencies..."
  npm install || exit 1
fi

PORT="${PORT:-3000}"

# Open the browser once the server is actually answering, rather than
# racing it and landing on a connection error.
(
  for _ in $(seq 1 40); do
    if curl -s -o /dev/null "http://localhost:${PORT}/"; then
      open "http://localhost:${PORT}/"
      exit 0
    fi
    sleep 0.25
  done
) &

echo "Starting Girl Math — close this window to stop it."
echo
exec npm start
