#!/bin/sh
# Сторож браузерного воркера на VPS (DEPLOYMENT §6.25 п.11): cron раз в 5 минут
# ставит vps-bootstrap.sh. Входящих портов и внешних уведомлений нет — всё
# пишется в журнал и файл состояния, их показывает `vps-bootstrap.sh --check`.
#
#   1. Контейнер не запущен или Docker держит его в unhealthy две проверки
#      подряд → `docker compose up -d` / `restart` (не чаще раза в 30 мин).
#   2. Первое выполненное задание («задание выполнено» в журнале или
#      completed > 0 в файле здоровья) → отметка FIRST_JOB с датой, один раз.
#   3. Файл состояния: время проверки, health, lastClaimAt, completed/failed,
#      lastError, первое задание, последний перезапуск.
#
# Только чтение и перезапуск своего контейнера: .env, правила iptables, sshd
# и данные не трогает. Секретов не печатает (lastError — код, не тело).
set -eu

WD="${WD:-/root/browser-worker}"
STATE_DIR="${STATE_DIR:-/var/lib/bworker}"
LOG="${LOG:-/var/log/bworker-watch.log}"
RESTART_GAP_S="${RESTART_GAP_S:-1800}"

mkdir -p "$STATE_DIR"
now=$(date +%s)
stamp=$(date -u +%FT%TZ)
log() { printf '%s %s\n' "$stamp" "$*" >>"$LOG"; }

cd "$WD" || {
  log "нет $WD — воркер не установлен"
  exit 0
}

cid=$(docker compose ps -q browser-worker 2>/dev/null || true)
health=нет
running=false
if [ -n "$cid" ]; then
  running=$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || echo false)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}нет{{end}}' "$cid" 2>/dev/null || echo нет)
fi

last_restart=$(cat "$STATE_DIR/last-restart" 2>/dev/null || echo 0)
may_restart() { [ $((now - last_restart)) -ge "$RESTART_GAP_S" ]; }
mark_restart() {
  echo "$now" >"$STATE_DIR/last-restart"
  last_restart=$now
}

# --- 1. Самовосстановление ------------------------------------------------
if [ "$running" != true ]; then
  if may_restart; then
    log "контейнер не запущен — docker compose up -d"
    docker compose up -d >>"$LOG" 2>&1 || log "docker compose up -d не удался"
    mark_restart
  else
    log "контейнер не запущен; перезапуск был недавно — жду"
  fi
  rm -f "$STATE_DIR/unhealthy-count"
elif [ "$health" = unhealthy ]; then
  n=$(($(cat "$STATE_DIR/unhealthy-count" 2>/dev/null || echo 0) + 1))
  echo "$n" >"$STATE_DIR/unhealthy-count"
  if [ "$n" -ge 2 ] && may_restart; then
    log "unhealthy $n проверки подряд — docker compose restart browser-worker"
    docker compose restart browser-worker >>"$LOG" 2>&1 || log "restart не удался"
    mark_restart
    rm -f "$STATE_DIR/unhealthy-count"
  else
    log "unhealthy ($n)"
  fi
else
  rm -f "$STATE_DIR/unhealthy-count"
fi

# --- 2–3. Файл здоровья, первое задание, состояние ------------------------
hjson=""
if [ "$running" = true ]; then
  hjson=$(docker compose exec -T browser-worker cat /tmp/browser-worker.health 2>/dev/null || true)
fi
field() { printf '%s' "$hjson" | sed -n "s/.*\"$1\":\([^,}]*\).*/\1/p" | tr -d '"'; }
completed=$(field completed)
failed=$(field failed)
last_claim=$(field lastClaimAt)
last_error=$(field lastError)
[ "$last_error" = null ] && last_error=""
claim_age=нет
case "$last_claim" in
  '' | 0 | null) ;;
  *[!0-9]*) ;;
  *) claim_age="$((now - last_claim / 1000)) с назад" ;;
esac

if [ ! -f "$STATE_DIR/first-job" ]; then
  done_line=""
  if [ "$running" = true ]; then
    done_line=$(docker compose logs --no-color --since 6m browser-worker 2>/dev/null |
      grep -m1 'задание выполнено' | sed -n 's/.*"kind":"\([^"]*\)".*/\1/p' || true)
  fi
  if [ -n "$done_line" ] || { [ -n "$completed" ] && [ "$completed" != 0 ]; }; then
    echo "$stamp ${done_line:-вид неизвестен (completed=$completed)}" >"$STATE_DIR/first-job"
    log "ПЕРВОЕ ЗАДАНИЕ ВЫПОЛНЕНО: $(cat "$STATE_DIR/first-job")"
  fi
fi

{
  echo "проверка: $stamp"
  echo "контейнер: running=$running health=$health"
  echo "последний claim: $claim_age; ошибка: ${last_error:-нет}"
  echo "с запуска контейнера: выполнено ${completed:-?}, не выполнено ${failed:-?}"
  echo "первое задание: $(cat "$STATE_DIR/first-job" 2>/dev/null || echo 'ещё не было')"
  if [ "$last_restart" != 0 ]; then
    echo "последний перезапуск сторожем: $(date -u -d "@$last_restart" +%FT%TZ)"
  else
    echo "последний перезапуск сторожем: не было"
  fi
} >"$STATE_DIR/status.tmp" && mv "$STATE_DIR/status.tmp" "$STATE_DIR/status"

# Журнал не растёт бесконечно: держим последние 2000 строк.
if [ -f "$LOG" ] && [ "$(wc -l <"$LOG")" -gt 4000 ]; then
  tail -n 2000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit 0
