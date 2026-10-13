#!/usr/bin/env bash
# Установка браузерного воркера на ОТДЕЛЬНЫЙ VPS одной командой
# (doc/DEPLOYMENT.md §6.25, вариант 1, шаги 1–7 и 10). Только чистый
# Debian 12/13, root. Живой вход (`live-login-relay`) и его сервер скрипт не
# трогает и на сервере реле НЕ запускается (там вариант 2, руками).
#
#   sudo SITES_BACKEND_URL=https://<домен sites-backend> bash vps-bootstrap.sh
#   sudo bash vps-bootstrap.sh --check     # только посмотреть состояние
#   sudo bash vps-bootstrap.sh --update    # git pull + пересборка (cron раз в неделю);
#                                          # после pull перезапускается свежей копией
#                                          # (--post-update): fail2ban, сторож, сборка
#
# Что делает (идемпотентно, повторный запуск безопасен):
#   1. Docker Engine + compose из официального репозитория Docker; проверка,
#      что ядро пускает песочницу Chromium (user namespaces).
#   2. Репозиторий — только папка browser-worker/ (sparse clone) в
#      /opt/v4c, ссылка /root/browser-worker.
#   2а. Свежесть Chromium: playwright-core в package.json не старше 31 дня
#      (иначе отказ; ALLOW_OLD_CHROMIUM=1 — осознанно собрать старый).
#   3–4. .env воркера (chmod 600): свой HMAC-секрет (openssl rand -hex 32),
#      публичные адреса сервера в BROWSER_WORKER_EGRESS_DENY, пара ключей
#      конверта учёток (закрытый — только в .env).
#   5. Сборка образа, запуск, проверка песочницы ("sandbox":true в логе).
#   6. Правила исходящего трафика контейнера (worker-egress-docker-user.sh
#      --apply) + unit systemd bworker-egress, чтобы пережили перезагрузку.
#   7. Проверка изоляции: метаданные облака, SSH хоста, частная сеть —
#      закрыто; DNS — работает.
#   10. Еженедельное обновление (cron, воскресенье 04:17 UTC, --update).
#   11. Сторож (cron раз в 5 мин, deploy/worker-watch.sh): перезапуск
#       упавшего/unhealthy контейнера, отметка первого выполненного
#       задания, файл состояния /var/lib/bworker/status (его печатает --check).
#
# Чего НЕ делает (требования владельца): не трогает sshd, парольный вход и
# порт 22, не включает ufw/nftables для INPUT, не открывает портов —
# у воркера нет ни ports:, ни expose:. fail2ban ставится с умолчаниями
# (sshd-jail), отключить — INSTALL_FAIL2BAN=0.
#
# Секреты на экран выводятся ОДИН раз в конце (их нужно перенести в Vercel
# проекта assist-api) и лежат в /root/browser-worker-vercel.txt (600).
# Никуда их не пересылать, в чаты не вставлять.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/tarasenkoandriii/viral4creators.git}"
BRANCH="${BRANCH:-main}"
REPO_DIR="${REPO_DIR:-/opt/v4c}"
LINK_DIR="/root/browser-worker"
VERCEL_FILE="/root/browser-worker-vercel.txt"
MAX_CHROMIUM_AGE_DAYS="${MAX_CHROMIUM_AGE_DAYS:-31}"
INSTALL_FAIL2BAN="${INSTALL_FAIL2BAN:-1}"
MODE="${1:-install}"

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   ok: %s\n' "$*"; }
warn() { printf '   ВНИМАНИЕ: %s\n' "$*" >&2; }
die() {
  printf '\nОТКАЗ: %s\n' "$*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "запускать от root (sudo bash $0)"
case "$MODE" in install | --update | --post-update | --check) ;; *) die "неизвестный режим «$MODE» (нет аргумента | --update | --check)" ;; esac

# --- ОС -------------------------------------------------------------------
. /etc/os-release
if [ "${ID:-}" != debian ] || { [ "${VERSION_ID:-}" != 12 ] && [ "${VERSION_ID:-}" != 13 ]; }; then
  die "нужен Debian 12/13 (сейчас: ${PRETTY_NAME:-неизвестно}); на Ubuntu 24.04 песочницу режет AppArmor — см. DEPLOYMENT §6.25 шаг 1"
fi

WD="$LINK_DIR"

health_report() {
  say "Состояние"
  if [ -d "$WD" ] && docker compose -f "$WD/docker-compose.yml" ps >/dev/null 2>&1; then
    (cd "$WD" && docker compose ps)
    st=$(docker inspect -f '{{.State.Health.Status}}' "$(cd "$WD" && docker compose ps -q browser-worker)" 2>/dev/null || echo нет)
    echo "   health: $st"
    (cd "$WD" && docker compose logs --tail=200 browser-worker 2>/dev/null | grep -E 'воркер запущен|браузер запущен|песочниц|sandbox|claim|HMAC|401|403|503' | tail -8) || true
  else
    echo "   воркер не установлен"
  fi
  if [ -x "$WD/deploy/worker-egress-docker-user.sh" ] || [ -f "$WD/deploy/worker-egress-docker-user.sh" ]; then
    sh "$WD/deploy/worker-egress-docker-user.sh" --status 2>/dev/null | tail -5 || true
  fi
  systemctl is-enabled bworker-egress 2>/dev/null | sed 's/^/   bworker-egress: /' || true
  if fail2ban-client status sshd >/dev/null 2>&1; then
    echo "   fail2ban: работает ($(fail2ban-client status sshd | sed -n 's/.*Currently banned:[[:space:]]*/забанено сейчас: /p'))"
  else
    echo "   fail2ban: НЕ работает"
  fi
  if [ -f /var/lib/bworker/status ]; then
    say "Сторож (/var/lib/bworker/status, журнал /var/log/bworker-watch.log)"
    sed 's/^/   /' /var/lib/bworker/status
  else
    echo "   сторож: ещё не запускался"
  fi
}

# --- fail2ban и сторож (установка и --post-update) ---------------------------
ensure_fail2ban() {
  [ "$INSTALL_FAIL2BAN" = 1 ] || return 0
  command -v fail2ban-server >/dev/null 2>&1 || apt-get install -y -q fail2ban >/dev/null || warn "fail2ban не поставился"
  command -v fail2ban-server >/dev/null 2>&1 || return 0
  # Debian 12/13 без rsyslog: /var/log/auth.log нет, и sshd-jail с умолчаниями
  # не стартует («Have not found any log file») — читать журнал systemd.
  apt-get install -y -q python3-systemd >/dev/null 2>&1 || true
  if [ ! -f /etc/fail2ban/jail.d/v4c-sshd-systemd.local ]; then
    printf '[sshd]\nbackend = systemd\n' >/etc/fail2ban/jail.d/v4c-sshd-systemd.local
  fi
  systemctl enable fail2ban >/dev/null 2>&1 || true
  if ! fail2ban-client status sshd >/dev/null 2>&1; then
    systemctl restart fail2ban >/dev/null 2>&1 || true
    sleep 2
  fi
  if fail2ban-client status sshd >/dev/null 2>&1; then
    ok "fail2ban работает (sshd-jail, журнал systemd; sshd не менялся)"
  else
    warn "fail2ban не запустился — journalctl -u fail2ban -n 30"
  fi
}

ensure_watch() {
  cat >/etc/cron.d/bworker-watch <<EOF
# browser-worker: сторож раз в 5 минут (DEPLOYMENT §6.25 п.11)
*/5 * * * * root /bin/sh $LINK_DIR/deploy/worker-watch.sh >/dev/null 2>&1
EOF
  /bin/sh "$LINK_DIR/deploy/worker-watch.sh" || true
  ok "cron /etc/cron.d/bworker-watch (раз в 5 мин; состояние /var/lib/bworker/status)"
}

if [ "$MODE" = --check ]; then
  health_report
  exit 0
fi

# --- 2а. Свежесть Chromium -------------------------------------------------
check_chromium_age() {
  local ver released age
  ver=$(sed -n 's/.*"playwright-core": *"\([0-9.]*\)".*/\1/p' "$WD/package.json" | head -1)
  [ -n "$ver" ] || die "не нашёл точную версию playwright-core в package.json"
  released=$(curl -fsS --max-time 20 https://registry.npmjs.org/playwright-core |
    tr ',' '\n' | sed -n "s/^ *\"$ver\": *\"\\([0-9T:.-]*Z\\)\".*/\\1/p" | head -1)
  if [ -z "$released" ]; then
    warn "не удалось узнать дату релиза playwright-core $ver — проверьте вручную (DEPLOYMENT §6.25 п.2а)"
    return 0
  fi
  age=$((($(date +%s) - $(date -d "$released" +%s)) / 86400))
  if [ "$age" -gt "$MAX_CHROMIUM_AGE_DAYS" ]; then
    if [ "${ALLOW_OLD_CHROMIUM:-0}" = 1 ]; then
      warn "playwright-core $ver — $age дн. (> $MAX_CHROMIUM_AGE_DAYS); собираю по ALLOW_OLD_CHROMIUM=1"
    else
      die "playwright-core $ver вышел $age дн. назад (> $MAX_CHROMIUM_AGE_DAYS): сначала обновить пакет в репозитории (DEPLOYMENT §6.25 п.2а)"
    fi
  else
    ok "playwright-core $ver — $age дн."
  fi
}

# --- --update (cron) ---------------------------------------------------------
if [ "$MODE" = --update ]; then
  [ -d "$REPO_DIR/.git" ] || die "нет $REPO_DIR — сначала установка без аргументов"
  say "Обновление $(date -u +%FT%TZ)"
  git -C "$REPO_DIR" pull --ff-only -q
  # Дальше — свежей копией скрипта: этот блок bash прочитал до pull.
  exec /bin/bash "$LINK_DIR/deploy/vps-bootstrap.sh" --post-update
fi

if [ "$MODE" = --post-update ]; then
  say "После обновления: fail2ban, сторож, сборка"
  ensure_fail2ban
  check_chromium_age
  (cd "$WD" && docker compose build --pull -q && docker compose up -d)
  upd_if=$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  EXT_IF="${upd_if:-eth0}" sh "$WD/deploy/worker-egress-docker-user.sh" --apply >/dev/null
  ensure_watch
  health_report
  exit 0
fi

# --- 1. Docker и песочница ядра ---------------------------------------------
say "1. Docker"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg git openssl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
fi
apt-get install -y -q git openssl iptables curl >/dev/null
ok "$(docker --version)"
ok "$(docker compose version)"

userns=$(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo нет)
maxns=$(sysctl -n user.max_user_namespaces 2>/dev/null || echo 0)
if [ "$userns" = 0 ] || [ "$maxns" = 0 ]; then
  die "ядро не пускает user namespaces (unprivileged_userns_clone=$userns, max_user_namespaces=$maxns) — песочница Chromium не стартует"
fi
ok "user namespaces: unprivileged_userns_clone=$userns, max_user_namespaces=$maxns"

ensure_fail2ban

# --- 2. Код -------------------------------------------------------------------
say "2. Код ($REPO_URL, $BRANCH → $REPO_DIR, только browser-worker/)"
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone -q --filter=blob:none --no-checkout --depth 1 --branch "$BRANCH" "$REPO_URL" "$REPO_DIR"
  git -C "$REPO_DIR" sparse-checkout set browser-worker
  git -C "$REPO_DIR" checkout -q "$BRANCH"
else
  git -C "$REPO_DIR" pull --ff-only -q
fi
ln -sfn "$REPO_DIR/browser-worker" "$LINK_DIR"
ok "коммит $(git -C "$REPO_DIR" rev-parse --short HEAD)"
check_chromium_age

# --- 3–4. .env ---------------------------------------------------------------
say "3–4. .env воркера"
cd "$WD"
umask 077
env_get() { sed -n "s/^$1=//p" .env | tail -1; }
env_set() {
  if grep -q "^$1=" .env; then
    # значение через файл, без sed-подстановки (в ключах есть / и +)
    awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' .env >.env.tmp && mv .env.tmp .env
  else
    printf '%s=%s\n' "$1" "$2" >>.env
  fi
}
[ -f .env ] || cp .env.example .env
chmod 600 .env

url="${SITES_BACKEND_URL:-$(env_get SITES_BACKEND_URL)}"
case "$url" in
  https://*'<'* | '' | http://*) die "задайте SITES_BACKEND_URL=https://<домен sites-backend> (сейчас: «${url:-пусто}»)" ;;
  https://*) ;;
  *) die "SITES_BACKEND_URL должен начинаться с https:// (сейчас: «$url»)" ;;
esac
env_set SITES_BACKEND_URL "${url%/}"
ok "SITES_BACKEND_URL=${url%/}"

if [ -z "$(env_get SITES_WORKER_HMAC_SECRET)" ]; then
  env_set SITES_WORKER_HMAC_SECRET "$(openssl rand -hex 32)"
  ok "SITES_WORKER_HMAC_SECRET — сгенерирован"
else
  ok "SITES_WORKER_HMAC_SECRET — уже задан, не меняю"
fi

ext_if=$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
[ -n "$ext_if" ] || die "не нашёл интерфейс маршрута по умолчанию"
ip4s=$(ip -4 -o addr show dev "$ext_if" scope global | awk '{print $4}' | cut -d/ -f1)
# IPv6 — подсетью /64 из маршрута ядра на интерфейсе (у Hetzner — ровно /64)
ip6s=$(ip -6 -o route show dev "$ext_if" proto kernel 2>/dev/null | awk '$1 ~ /\// && $1 !~ /^fe80/ {print $1}')
deny=$(printf '%s\n%s\n' "$ip4s" "$ip6s" | grep -v '^$' | paste -sd, -)
[ -n "$deny" ] || die "не нашёл публичных адресов на $ext_if"
env_set BROWSER_WORKER_EGRESS_DENY "$deny"
ok "BROWSER_WORKER_EGRESS_DENY=$deny"
[ -n "$(env_get BROWSER_WORKER_ID)" ] || env_set BROWSER_WORKER_ID "bw-$(hostname -s | tr 'A-Z_' 'a-z-' | tr -cd 'a-z0-9-' | cut -c1-40)"

# --- 5. Сборка, ключи, запуск --------------------------------------------------
say "5. Сборка образа (несколько минут)"
docker compose build -q
ok "образ v4c-browser-worker:local"

if [ -z "$(env_get BROWSER_WORKER_SEAL_PRIVATE_KEY)" ]; then
  keys=$(docker compose run --rm --no-deps -T browser-worker node dist/seal-keygen.js)
  priv=$(printf '%s\n' "$keys" | sed -n 's/^BROWSER_WORKER_SEAL_PRIVATE_KEY=//p')
  pub=$(printf '%s\n' "$keys" | sed -n 's/^SITES_WORKER_SEAL_PUBLIC_KEY=//p')
  [ -n "$priv" ] && [ -n "$pub" ] || die "seal-keygen не выдал пару ключей"
  env_set BROWSER_WORKER_SEAL_PRIVATE_KEY "$priv"
  printf 'SITES_WORKER_SEAL_PUBLIC_KEY=%s\n' "$pub" >"$VERCEL_FILE.pub"
  ok "пара ключей конверта: закрытый — в .env, открытый — для Vercel"
else
  ok "BROWSER_WORKER_SEAL_PRIVATE_KEY — уже задан, не меняю"
fi
{
  echo "# Vercel → проект assist-api (sites-backend) → Settings → Environment Variables → Production"
  echo "SITES_WORKER_HMAC_SECRET=$(env_get SITES_WORKER_HMAC_SECRET)"
  [ -f "$VERCEL_FILE.pub" ] && cat "$VERCEL_FILE.pub"
  echo "BROWSER_WORKER_ENABLED=true"
} >"$VERCEL_FILE"
chmod 600 "$VERCEL_FILE" "$VERCEL_FILE.pub" 2>/dev/null || true

docker compose up -d
say "Песочница Chromium (до 90 с)"
sandbox=""
for _ in $(seq 1 30); do
  logs=$(docker compose logs --no-color browser-worker 2>/dev/null || true)
  if grep -q '"sandbox":true' <<<"$logs"; then sandbox=ok; break; fi
  if grep -q 'Chromium не запустился' <<<"$logs"; then sandbox=fail; break; fi
  sleep 3
done
case "$sandbox" in
  ok) ok 'браузер запущен с "sandbox":true' ;;
  fail)
    docker compose logs --tail=30 browser-worker
    docker compose down
    die "Chromium не запустился с песочницей (journalctl -k | grep -i seccomp; DEPLOYMENT §6.25 шаг 5)"
    ;;
  *) warn "строки о запуске браузера нет за 90 с — смотрите docker compose logs browser-worker" ;;
esac

# --- 6. Egress ----------------------------------------------------------------
say "6. Правила исходящего трафика контейнера"
EXT_IF="$ext_if" sh deploy/worker-egress-docker-user.sh | sed 's/^/   /'
EXT_IF="$ext_if" sh deploy/worker-egress-docker-user.sh --apply | tail -3 | sed 's/^/   /'
cat >/etc/systemd/system/bworker-egress.service <<EOF
[Unit]
Description=browser-worker egress rules
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/bin/sh $LINK_DIR/deploy/worker-egress-docker-user.sh --apply
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now bworker-egress >/dev/null
ok "unit bworker-egress включён"

# --- 7. Изоляция ----------------------------------------------------------------
say "7. Проверка изоляции изнутри контейнера"
probe() {
  docker compose exec -T browser-worker node -e \
    "fetch('$1',{signal:AbortSignal.timeout(3000)}).then(()=>console.log('ОТКРЫТО'),()=>console.log('закрыто'))" 2>/dev/null || echo 'нет ответа'
}
fail=0
host4=$(printf '%s\n' "$ip4s" | head -1)
for u in http://169.254.169.254/ "http://$host4:22/" http://10.0.0.1/ http://192.168.0.1/; do
  r=$(probe "$u")
  if [ "$r" = закрыто ]; then ok "$u — закрыто"; else
    warn "$u — $r"
    fail=1
  fi
done
if docker compose exec -T browser-worker getent hosts example.com >/dev/null 2>&1; then ok "DNS работает"; else
  warn "DNS из контейнера не работает (WORKER_DNS_RESOLVERS, шаг 6)"
  fail=1
fi
[ "$fail" = 0 ] || die "изоляция не подтверждена — воркер оставлен запущенным для разбора; откат: docker compose down && sh deploy/worker-egress-docker-user.sh --remove"

# --- 10. Еженедельное обновление ---------------------------------------------
cat >/etc/cron.d/bworker-update <<EOF
# browser-worker: свежий Chromium раз в неделю (DEPLOYMENT §6.25 п.10)
17 4 * * 0 root /bin/bash $LINK_DIR/deploy/vps-bootstrap.sh --update >>/var/log/bworker-update.log 2>&1
EOF
ok "cron /etc/cron.d/bworker-update (вс 04:17 UTC, журнал /var/log/bworker-update.log)"
ensure_watch

health_report

say "ГОТОВО. Дальше — Vercel, проект assist-api (Production):"
cat "$VERCEL_FILE"
cat <<'EOF'

1) Внести эти три переменные (значения — только отсюда, в чат не вставлять).
2) Выпуск без изменения кода: временно VERCEL_FORCE_BUILD=1 → Redeploy →
   Ready → удалить VERCEL_FORCE_BUILD (DEPLOYMENT «Изменения env без
   изменения кода»).
3) Через 1–2 мин: sudo bash /root/browser-worker/deploy/vps-bootstrap.sh --check
   — health: healthy (до настройки Vercel claim отклоняется, и это ожидаемо).
4) Снаружи (с другой машины): nmap -Pn <IP сервера> — открыт только 22.
Копия значений: /root/browser-worker-vercel.txt (600). Секрет HMAC ротируется
по DEPLOYMENT §6.25 «Ротация».
EOF
