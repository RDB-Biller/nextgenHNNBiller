#!/usr/bin/env bash
# Commit everything in this folder and push to GitHub.
#   ./sync.sh "what changed"
set -e

MSG="${1:-Update HNN Biller}"

# Never commit dependencies or real secrets.
if [ ! -f .gitignore ] || ! grep -q "node_modules" .gitignore; then
  printf "node_modules/\n.env\n" >> .gitignore
  echo "→ added node_modules/ and .env to .gitignore"
fi

# If node_modules was ever committed, untrack it (keeps it on disk).
if git ls-files --error-unmatch node_modules >/dev/null 2>&1; then
  git rm -r --cached node_modules >/dev/null
  echo "→ untracked node_modules"
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing to commit — repo already matches this folder."
  exit 0
fi

git commit -m "$MSG"
git push
echo
echo "✓ Pushed. Railway will redeploy automatically."
echo "  Check: /app/platform.html  /app/admin.html  /app/apis.html"
