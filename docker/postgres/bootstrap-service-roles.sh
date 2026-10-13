#!/bin/sh
set -eu

: "${TICKETLIVE_IDENTITY_DB_PASSWORD:?identity role password is required}"
: "${TICKETLIVE_PUBLIC_API_DB_PASSWORD:?public API role password is required}"
: "${TICKETLIVE_ORDER_DB_PASSWORD:?order role password is required}"
: "${TICKETLIVE_EVENT_DB_PASSWORD:?event role password is required}"
: "${TICKETLIVE_EMAIL_DB_PASSWORD:?email role password is required}"
: "${TICKETLIVE_NOTIFICATION_DB_PASSWORD:?notification role password is required}"

psql -v ON_ERROR_STOP=1 \
  --set=database_name="$PGDATABASE" \
  --set=migration_role="$PGUSER" \
  --set=public_api_password="$TICKETLIVE_PUBLIC_API_DB_PASSWORD" \
  --set=identity_password="$TICKETLIVE_IDENTITY_DB_PASSWORD" \
  --set=order_password="$TICKETLIVE_ORDER_DB_PASSWORD" \
  --set=event_password="$TICKETLIVE_EVENT_DB_PASSWORD" \
  --set=email_password="$TICKETLIVE_EMAIL_DB_PASSWORD" \
  --set=notification_password="$TICKETLIVE_NOTIFICATION_DB_PASSWORD" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_public_api', :'public_api_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_public_api') \gexec
ALTER ROLE ticketlive_public_api LOGIN PASSWORD :'public_api_password' NOINHERIT;
ALTER ROLE ticketlive_public_api IN DATABASE :"database_name" SET search_path = public;
GRANT USAGE ON SCHEMA public TO ticketlive_public_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ticketlive_public_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ticketlive_public_api;
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ticketlive_public_api', :'migration_role') \gexec
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ticketlive_public_api', :'migration_role') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_identity', :'identity_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_identity') \gexec
ALTER ROLE ticketlive_identity LOGIN PASSWORD :'identity_password' NOINHERIT;
CREATE SCHEMA IF NOT EXISTS identity_service AUTHORIZATION ticketlive_identity;
ALTER SCHEMA identity_service OWNER TO ticketlive_identity;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', 'ticketlive_identity', :'database_name', 'identity_service') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_order', :'order_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_order') \gexec
ALTER ROLE ticketlive_order LOGIN PASSWORD :'order_password' NOINHERIT;
CREATE SCHEMA IF NOT EXISTS order_service AUTHORIZATION ticketlive_order;
ALTER SCHEMA order_service OWNER TO ticketlive_order;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', 'ticketlive_order', :'database_name', 'order_service') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_event', :'event_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_event') \gexec
ALTER ROLE ticketlive_event LOGIN PASSWORD :'event_password' NOINHERIT;
CREATE SCHEMA IF NOT EXISTS event_service AUTHORIZATION ticketlive_event;
ALTER SCHEMA event_service OWNER TO ticketlive_event;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', 'ticketlive_event', :'database_name', 'event_service') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_email', :'email_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_email') \gexec
ALTER ROLE ticketlive_email LOGIN PASSWORD :'email_password' NOINHERIT;
CREATE SCHEMA IF NOT EXISTS email_service AUTHORIZATION ticketlive_email;
ALTER SCHEMA email_service OWNER TO ticketlive_email;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', 'ticketlive_email', :'database_name', 'email_service') \gexec

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOINHERIT', 'ticketlive_notification', :'notification_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ticketlive_notification') \gexec
ALTER ROLE ticketlive_notification LOGIN PASSWORD :'notification_password' NOINHERIT;
CREATE SCHEMA IF NOT EXISTS notification_service AUTHORIZATION ticketlive_notification;
ALTER SCHEMA notification_service OWNER TO ticketlive_notification;
SELECT format('ALTER ROLE %I IN DATABASE %I SET search_path = %I', 'ticketlive_notification', :'database_name', 'notification_service') \gexec
SQL
