#!/usr/bin/env bash
# ============================================================
#  Quarc Notes — Full System Diagnostic
#  Run from the project root: bash check.sh
# ============================================================

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'

PASS=0; WARN=0; FAIL=0; FAILURES=()

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$1"; PASS=$((PASS+1)); }
warn() { printf "  ${YELLOW}⚠${NC} %s\n" "$1"; WARN=$((WARN+1)); }
fail() { printf "  ${RED}✗${NC} %s\n" "$1"; FAIL=$((FAIL+1)); FAILURES+=("$1"); }
info() { printf "  ${DIM}·${NC} %s\n" "$1"; }
hdr()  { printf "\n${BOLD}${CYAN}── %s ${NC}\n" "$*"; }

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env 2>/dev/null || true
  set +a
else
  warn "No .env file found in current directory"
fi

HTTPS_PORT=${HTTPS_PORT:-4001}
BASE="https://localhost:${HTTPS_PORT}"
COOKIE=$(mktemp)
trap 'rm -f "$COOKIE"' EXIT

PROJECT=$(basename "$(pwd)" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/_/g')
cid() { docker ps -q \
  --filter "label=com.docker.compose.project=${PROJECT}" \
  --filter "label=com.docker.compose.service=$1" | head -1; }
dexec() { local c; c=$(cid "$1"); shift; [ -n "$c" ] && docker exec -i "$c" "$@" || echo ""; }

printf "\n${BOLD}Quarc Notes — System Diagnostic${NC}  $(date '+%Y-%m-%d %H:%M:%S')\n"
if ! docker info &>/dev/null 2>&1; then
  printf "  ${RED}✗ Docker not accessible — re-run as root: sudo bash check.sh${NC}\n\n"
  exit 1
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Docker Containers"
# ════════════════════════════════════════════════════════════════════════

for svc in backend frontend; do
  CID=$(docker ps -q --filter "label=com.docker.compose.service=${svc}" | head -1)
  if [ -z "$CID" ]; then
    CID_ANY=$(docker ps -aq --filter "label=com.docker.compose.service=${svc}" | head -1)
    [ -n "$CID_ANY" ] && fail "$svc: exists but is stopped/exited" \
                      || fail "$svc: container not found (never started?)"
    continue
  fi
  STATE=$(docker inspect --format '{{.State.Status}}' "$CID" 2>/dev/null || echo "unknown")
  if [ "$STATE" = "running" ]; then ok "$svc: running"; else fail "$svc: state=${STATE}"; fi
done

QA_CID=$(docker ps -q --filter "name=quarc-auth" | head -1)
if [ -n "$QA_CID" ]; then
  ok "quarc-auth: running (shared login service)"
else
  fail "quarc-auth: not running — logins will fail. See auth/README.md"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Network & HTTPS"
# ════════════════════════════════════════════════════════════════════════

HTTPS_CODE=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/" 2>/dev/null || echo 0)
if [ "$HTTPS_CODE" = "200" ]; then
  ok "HTTPS:${HTTPS_PORT} serving frontend (200)"
else
  fail "HTTPS:${HTTPS_PORT} not responding (got: ${HTTPS_CODE})"
fi

CERT_EXP=$(echo | openssl s_client -connect "localhost:${HTTPS_PORT}" \
  -servername localhost 2>/dev/null \
  | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || echo "")
if [ -n "$CERT_EXP" ]; then
  EXP_EPOCH=$(date -d "$CERT_EXP" +%s 2>/dev/null || echo 0)
  DAYS=$(( (EXP_EPOCH - $(date +%s)) / 86400 ))
  if   [ "$DAYS" -lt 7  ]; then fail "SSL cert expires in ${DAYS} days! Renew now."
  elif [ "$DAYS" -lt 30 ]; then warn "SSL cert expires in ${DAYS} days"
  else ok "SSL cert valid for ${DAYS} more days"; fi
else
  warn "Could not read SSL certificate (self-signed or nginx not up)"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Shared Login (Quarc Auth, via this app's nginx proxy)"
# ════════════════════════════════════════════════════════════════════════

AUTH_ME=$(curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "${BASE}/api/auth/me" 2>/dev/null || echo 0)
if [ "$AUTH_ME" = "401" ]; then
  ok "GET /api/auth/me → 401 (nginx is reaching quarc-auth; just not logged in — expected)"
elif [ "$AUTH_ME" = "000" ]; then
  fail "GET /api/auth/me → no response (quarc-auth unreachable — check quarcnet-shared network)"
else
  warn "GET /api/auth/me → unexpected ${AUTH_ME}"
fi

if [ -n "${ADMIN_TEST_USERNAME:-}" ] && [ -n "${ADMIN_TEST_PASSWORD:-}" ]; then
  LOGIN_RESP=$(curl -sk --max-time 10 -X POST "${BASE}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"${ADMIN_TEST_USERNAME}\",\"password\":\"${ADMIN_TEST_PASSWORD}\"}" \
    -c "$COOKIE" 2>/dev/null || echo "")
  if echo "$LOGIN_RESP" | grep -q '"username"'; then
    ok "POST /api/auth/login → authenticated as '${ADMIN_TEST_USERNAME}'"
  else
    warn "Login test failed — set ADMIN_TEST_USERNAME/ADMIN_TEST_PASSWORD in .env to test this"
  fi
else
  info "Set ADMIN_TEST_USERNAME/ADMIN_TEST_PASSWORD in .env to test a real login here"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Backend API"
# ════════════════════════════════════════════════════════════════════════

HEALTH_RESP=$(curl -sk --max-time 5 "${BASE}/api/health" 2>/dev/null || echo "")
if echo "$HEALTH_RESP" | grep -q '"ok"'; then
  ok "GET /api/health → ok"
else
  fail "GET /api/health → ${HEALTH_RESP:-no response}"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Database"
# ════════════════════════════════════════════════════════════════════════

DB_RESULT=$(dexec backend node -e "
  try {
    const { getDb } = require('/app/src/db');
    const db = getDb();
    const pages       = db.prepare('SELECT COUNT(*) as c FROM pages WHERE is_deleted = 0').get().c;
    const trashed     = db.prepare('SELECT COUNT(*) as c FROM pages WHERE is_deleted = 1').get().c;
    const links       = db.prepare('SELECT COUNT(*) as c FROM links').get().c;
    const attachments = db.prepare('SELECT COUNT(*) as c FROM attachments').get().c;
    const wal         = Object.values(db.prepare('PRAGMA journal_mode').get())[0];
    console.log(JSON.stringify({ pages, trashed, links, attachments, wal }));
  } catch(e) {
    console.log(JSON.stringify({ error: e.message }));
  }
" 2>/dev/null || echo '{"error":"exec failed"}')

if echo "$DB_RESULT" | grep -q '"error"'; then
  ERR=$(echo "$DB_RESULT" | grep -oP '"error":"\K[^"]+' || echo "unknown")
  fail "Database check failed: ${ERR}"
else
  DB_PAGES=$(echo "$DB_RESULT" | grep -oP '"pages":\K\d+'       || echo "?")
  DB_TRASH=$(echo "$DB_RESULT" | grep -oP '"trashed":\K\d+'     || echo "?")
  DB_LINKS=$(echo "$DB_RESULT" | grep -oP '"links":\K\d+'       || echo "?")
  DB_ATT=$(echo "$DB_RESULT"   | grep -oP '"attachments":\K\d+' || echo "?")
  DB_WAL=$(echo "$DB_RESULT"   | grep -oP '"wal":"\K[^"]+'      || echo "?")
  ok "DB accessible — ${DB_PAGES} pages, ${DB_TRASH} in trash, ${DB_LINKS} links, ${DB_ATT} attachments"
  [ "$DB_WAL" = "wal" ] && ok "SQLite WAL mode enabled" || warn "SQLite journal mode: ${DB_WAL} (expected wal)"
fi

# ════════════════════════════════════════════════════════════════════════
hdr "Recent Errors in Logs (last 1h)"
# ════════════════════════════════════════════════════════════════════════

for svc in backend frontend; do
  C=$(cid "$svc")
  ERR_N=0
  if [ -n "$C" ]; then
    ERR_N=$(docker logs "$C" --since 1h 2>&1 | grep -iE '\b(error|fatal|exception|crash|panic)\b' | wc -l)
    ERR_N=${ERR_N:-0}
  fi
  if   [ "$ERR_N" -gt 20 ]; then fail  "$svc: ${ERR_N} error lines in last hour"
  elif [ "$ERR_N" -gt 5  ]; then warn  "$svc: ${ERR_N} error lines in last hour"
  else ok "$svc: ${ERR_N} error lines in last hour"; fi
done

# ════════════════════════════════════════════════════════════════════════
hdr "Summary"
# ════════════════════════════════════════════════════════════════════════

TOTAL=$((PASS + WARN + FAIL))
printf "\n  ${GREEN}✓ %d passed${NC}  ${YELLOW}⚠ %d warnings${NC}  ${RED}✗ %d failed${NC}  (%d total checks)\n\n" \
  "$PASS" "$WARN" "$FAIL" "$TOTAL"

if [ "${#FAILURES[@]}" -gt 0 ]; then
  printf "${RED}${BOLD}Failed checks:${NC}\n"
  for f in "${FAILURES[@]}"; do
    printf "  ${RED}✗${NC} %s\n" "$f"
  done
  printf "\n"
  exit 1
fi

if   [ "$FAIL" -eq 0 ] && [ "$WARN" -eq 0 ]; then
  printf "${GREEN}${BOLD}All systems healthy.${NC}\n\n"
elif [ "$FAIL" -eq 0 ]; then
  printf "${YELLOW}${BOLD}System OK with ${WARN} warning(s).${NC}\n\n"
fi
