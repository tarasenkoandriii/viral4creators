#!/bin/sh
# Фильтр исходящего трафика контейнера browser-worker на уровне хоста
# (Э-С Ш3; QA-ТЗ §4.2; тот же приём, что doc/relay-egress-docker-user.sh для
# реле живого входа — реле этот скрипт не трогает). Инструкция, предусловия и
# проверка — doc/DEPLOYMENT.md §6.25.
#
# НЕ запускать, пока не поднята своя сеть воркера bworker-egress с подсетью
# WORKER_SUBNET и мостом br-bworker (browser-worker/docker-compose.yml):
# правила ниже матчат ТОЛЬКО трафик из этой подсети. Остальные контейнеры,
# SSH и правило `-i eth0 --dport 3000 -j DROP` (если есть) не затрагиваются.
# Парольный вход SSH и порт 22 скрипт не трогает (требование владельца).
#
#   sh worker-egress-docker-user.sh            # показать, что будет сделано (ничего не меняет)
#   sh worker-egress-docker-user.sh --apply    # применить (идемпотентно)
#   sh worker-egress-docker-user.sh --remove   # откатить всё, что добавил скрипт
#   sh worker-egress-docker-user.sh --status   # показать текущие правила
set -eu

WORKER_SUBNET="${WORKER_SUBNET:-172.31.251.0/24}"
WORKER_BRIDGE="${WORKER_BRIDGE:-br-bworker}"
EXT_IF="${EXT_IF:-eth0}"
CHAIN="BWORKER-EGRESS"
# Те же порты, что BROWSER_WORKER_EGRESS_ALLOWED_PORTS у воркера (QA §4.2: 80/443).
ALLOWED_TCP_PORTS="${ALLOWED_TCP_PORTS:-80,443}"

MODE="${1:-plan}"

run() {
  if [ "$MODE" = "--apply" ] || [ "$MODE" = "--remove" ]; then
    echo "+ $*"
    "$@"
  else
    echo "[план] $*"
  fi
}

status() {
  echo "== DOCKER-USER"; iptables -S DOCKER-USER || true
  echo "== $CHAIN"; iptables -S "$CHAIN" 2>/dev/null || echo "(цепочки нет)"
  echo "== INPUT (мост $WORKER_BRIDGE)"; iptables -S INPUT | grep -- "-i $WORKER_BRIDGE" || echo "(правил нет)"
}

remove() {
  # ЛЮБОЙ переход в нашу цепочку, а не только с текущей WORKER_SUBNET:
  # если подсеть сменили между --apply и --remove, старый переход иначе
  # остался бы, а `-X` ниже упал бы на «цепочка используется».
  iptables -S DOCKER-USER 2>/dev/null | grep -- "-j $CHAIN\$" | sed 's/^-A //' |
    while read -r spec; do
      # shellcheck disable=SC2086 # spec — готовые аргументы iptables
      run iptables -D $spec
    done
  while iptables -C INPUT -i "$WORKER_BRIDGE" -j DROP 2>/dev/null; do
    run iptables -D INPUT -i "$WORKER_BRIDGE" -j DROP
  done
  while iptables -C INPUT -i "$WORKER_BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null; do
    run iptables -D INPUT -i "$WORKER_BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  done
  if iptables -S "$CHAIN" >/dev/null 2>&1; then
    run iptables -F "$CHAIN"
    run iptables -X "$CHAIN"
  fi
}

case "$MODE" in
  --status)
    status
    exit 0
    ;;
  --remove)
    remove
    status
    exit 0
    ;;
  plan|--apply) ;;
  *)
    echo "неизвестный режим: $MODE (без аргумента | --apply | --remove | --status)" >&2
    exit 2
    ;;
esac

# ── Защита от опечатки, которая отрезала бы сервер (аудит Ш0) ─────────
# Правило `INPUT -i <мост> -j DROP` на ВНЕШНЕМ интерфейсе закрыло бы SSH
# (панели Hetzner нет — вернуть доступ было бы нечем), а слишком широкая
# подсеть в DOCKER-USER задела бы Dokploy и Traefik. Поэтому до любых
# изменений: мост — именно мост и не внешний/служебный интерфейс,
# подсеть — узкая.
case "$WORKER_BRIDGE" in
  "" | "$EXT_IF" | lo | eth* | ens* | enp* | eno* | docker0 | docker_gwbridge | wg* | tun* | tap*)
    echo "WORKER_BRIDGE=$WORKER_BRIDGE — это не мост сети воркера; отказ (правило DROP на нём отрезало бы сервер)" >&2
    exit 1
    ;;
esac
SUBNET_BITS="${WORKER_SUBNET##*/}"
case "$WORKER_SUBNET" in
  */*) ;;
  *) SUBNET_BITS="" ;;
esac
if ! [ "$SUBNET_BITS" -ge 16 ] 2>/dev/null || ! [ "$SUBNET_BITS" -le 29 ] 2>/dev/null; then
  echo "WORKER_SUBNET=$WORKER_SUBNET — нужна подсеть IPv4 от /16 до /29 (своя сеть воркера bworker-egress); отказ" >&2
  exit 1
fi
if ip link show "$WORKER_BRIDGE" >/dev/null 2>&1 &&
  ! ip -d link show "$WORKER_BRIDGE" 2>/dev/null | grep -qw bridge; then
  echo "$WORKER_BRIDGE существует, но это не bridge-интерфейс; отказ" >&2
  exit 1
fi

HOST_V4="$(ip -4 -o addr show dev "$EXT_IF" scope global | awk '{print $4}' | cut -d/ -f1 | head -n1)"
if [ -z "$HOST_V4" ]; then
  echo "не нашёл IPv4 на $EXT_IF — задайте EXT_IF=<интерфейс>" >&2
  exit 1
fi

# Служебные и приватные диапазоны — тот же смысл, что isBlockedAddress
# (backend/src/common/external-url-guard.ts), плюс адрес самого хоста.
DENY_V4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 \
198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 \
${HOST_V4}/32"

if ! ip link show "$WORKER_BRIDGE" >/dev/null 2>&1; then
  echo "моста $WORKER_BRIDGE нет — сначала docker compose up (сеть bworker-egress, browser-worker/docker-compose.yml)" >&2
  [ "$MODE" = "--apply" ] && exit 1
fi

# Идемпотентно: снять своё и поставить заново.
if [ "$MODE" = "--apply" ]; then remove; fi

run iptables -N "$CHAIN"
# Ответы на уже разрешённые соединения.
run iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for net in $DENY_V4; do
  run iptables -A "$CHAIN" -d "$net" -p tcp -j REJECT --reject-with tcp-reset
  run iptables -A "$CHAIN" -d "$net" -j DROP
done
# DNS к публичным резолверам (встроенный DNS Docker ходит наружу из сети
# контейнера) и разрешённые TCP-порты; всё прочее — отказ.
run iptables -A "$CHAIN" -p udp --dport 53 -j RETURN
run iptables -A "$CHAIN" -p tcp --dport 53 -j RETURN
run iptables -A "$CHAIN" -p tcp -m multiport --dports "$ALLOWED_TCP_PORTS" -j RETURN
run iptables -A "$CHAIN" -p tcp -j REJECT --reject-with tcp-reset
run iptables -A "$CHAIN" -j DROP

# В DOCKER-USER — первым правилом, но матчит только подсеть воркера.
run iptables -I DOCKER-USER 1 -s "$WORKER_SUBNET" -j "$CHAIN"

# Трафик контейнера на адреса САМОГО хоста идёт не через FORWARD, а
# через INPUT (SSH, панели на хосте) — закрываем его там же.
run iptables -I INPUT 1 -i "$WORKER_BRIDGE" -j DROP
run iptables -I INPUT 1 -i "$WORKER_BRIDGE" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

if [ "$MODE" = "--apply" ]; then
  status
else
  echo
  echo "Это план. Применить: sh $0 --apply ; откатить: sh $0 --remove"
fi
