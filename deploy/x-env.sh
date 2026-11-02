#!/bin/bash
# Copies the X API settings from app/.env to the site's production settings on Vercel, then
# publishes the site again so /api/xfeed uses them. Values are sent to Vercel, never printed.
#   deploy/x-env.sh
cd "$(dirname "$0")/../app" || exit 1
[ -f .env ] || { echo "app/.env not found"; exit 1; }
set -a; . ./.env; set +a
if [ -z "$X_BEARER_TOKEN" ] && { [ -z "$X_API_KEY" ] || [ -z "$X_API_SECRET" ]; }; then echo "Fill in X_BEARER_TOKEN, or X_API_KEY and X_API_SECRET, in app/.env first"; exit 1; fi
for name in X_BEARER_TOKEN X_API_KEY X_API_SECRET X_ACCOUNTS X_QUERY X_REFRESH_MINUTES X_MAX_RESULTS X_MIN_FOLLOWERS; do
  value="${!name}"
  [ -z "$value" ] && continue
  npx vercel env rm "$name" production --yes >/dev/null 2>&1
  printf '%s' "$value" | npx vercel env add "$name" production >/dev/null 2>&1 && echo "set $name" || echo "could not set $name"
done
npx vercel --prod --yes 2>&1 | grep -E "Aliased|Error"
