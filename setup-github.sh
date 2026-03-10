#!/bin/bash
# DapperDriver — GitHub Push Setup Script
# Run this from your Mac Terminal once to push the project to GitHub.
# Usage: bash setup-github.sh YOUR_GITHUB_USERNAME

set -e

USERNAME=$1
if [ -z "$USERNAME" ]; then
  echo "❌  Please provide your GitHub username."
  echo "    Usage: bash setup-github.sh YOUR_GITHUB_USERNAME"
  exit 1
fi

REPO="dapperdriver-api"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📁  Project folder: $SCRIPT_DIR"
cd "$SCRIPT_DIR"

echo ""
echo "🔧  Initializing git..."
git init
git add .
git commit -m "Initial commit: DapperDriver API"

echo ""
echo "📡  Creating GitHub repo (you'll be prompted to log in if needed)..."
gh repo create "$USERNAME/$REPO" --public --source=. --remote=origin --push

echo ""
echo "✅  Done! Your repo is live at:"
echo "    https://github.com/$USERNAME/$REPO"
