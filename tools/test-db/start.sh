#!/usr/bin/env bash
# Starts a throwaway local PostgreSQL cluster for tests when no TEST_DATABASE_URL is provided.
# Prints the admin connection URL on the last line. Safe to call repeatedly (reuses a running cluster).
# Needs Postgres server binaries (Debian/Ubuntu: /usr/lib/postgresql/<ver>/bin). No Docker required.
set -euo pipefail

PORT="${KHALTA_TEST_PG_PORT:-55432}"
DIR="${KHALTA_TEST_PG_DIR:-/tmp/khalta-test-pg}"
BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$BIN" ] || { echo "no PostgreSQL server binaries found" >&2; exit 1; }

as_pg() { # run as the postgres OS user when we are root (initdb/postgres refuse root)
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

if [ ! -d "$DIR/data" ]; then
  mkdir -p "$DIR"
  [ "$(id -u)" = 0 ] && chown postgres "$DIR"
  as_pg "$BIN/initdb" -D "$DIR/data" -U postgres --auth=trust >/dev/null
fi
if ! as_pg "$BIN/pg_ctl" -D "$DIR/data" status >/dev/null 2>&1; then
  as_pg "$BIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c fsync=off" \
    -l "$DIR/log" -w start >/dev/null
fi
echo "postgres://postgres@127.0.0.1:$PORT/postgres"
