#!/bin/sh
set -eu

case "${TICKETLIVE_SERVICE:-public-api}" in
  public-api) exec node --import tsx/esm /app/apps/public-api/src/main.ts ;;
  order) exec node --import tsx/esm /app/apps/order-service/src/main.ts ;;
  event) exec node --import tsx/esm /app/apps/event-service/src/main.ts ;;
  email) exec node --import tsx/esm /app/apps/email-service/src/main.ts ;;
  payment) exec node --import tsx/esm /app/apps/payment-service/src/main.ts ;;
  *) echo "Unknown TICKETLIVE_SERVICE: ${TICKETLIVE_SERVICE}" >&2; exit 64 ;;
esac
