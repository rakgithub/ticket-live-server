#!/bin/sh
set -eu

case "${TICKETLIVE_SERVICE:-public-api}" in
  public-api) exec /app/node_modules/.bin/tsx /app/src/server.ts ;;
  order) exec /app/node_modules/.bin/tsx /app/apps/order-service/src/main.ts ;;
  event) exec /app/node_modules/.bin/tsx /app/apps/event-service/src/main.ts ;;
  email) exec /app/node_modules/.bin/tsx /app/apps/email-service/src/main.ts ;;
  *) echo "Unknown TICKETLIVE_SERVICE: ${TICKETLIVE_SERVICE}" >&2; exit 64 ;;
esac
