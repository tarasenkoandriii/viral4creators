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
#
# Переменные (все необязательны): WORKER_SUBNET, WORKER_BRIDGE, EXT_IF,
# ALLOWED_TCP_PORTS; WORKER_DNS_RESOLVERS — IPv4-адреса резолверов через
# запятую/пробел (по умолчанию — nameserver'ы /etc/resolv.conf хоста без
# loopback, как их берёт Docker; если там только 127.0.0.53 —
# /run/systemd/resolve/resolv.conf; если и там пусто — 8.8.8.8 8.8.4.4,
# запасные адреса самого Docker); WORKER_NETWORK — имя сети Docker для
# сверки (по умолчанию bworker-egress или <проект>_bworker-egress).
set -eu

WORKER_SUBNET="${WORKER_SUBNET:-172.31.251.0/24}"
WORKER_BRIDGE="${WORKER_BRIDGE:-br-bworker}"
EXT_IF="${EXT_IF:-eth0}"
CHAIN="BWORKER-EGRESS"
# Те же порты, что BROWSER_WORKER_EGRESS_ALLOWED_PORTS у воркера (QA §4.2: 80/443).
ALLOWED_TCP_PORTS="${ALLOWED_TCP_PORTS:-80,443}"

WORKER_RESOLV_CONF="${WORKER_RESOLV_CONF:-/etc/resolv.conf}"
WORKER_SYSTEMD_RESOLV_CONF="${WORKER_SYSTEMD_RESOLV_CONF:-/run/systemd/resolve/resolv.conf}"

MODE="${1:-plan}"

die() {
  echo "$*; отказ" >&2
  exit 1
}

# IPv4 без ведущих нулей (иначе арифметика sh читает «010» как восьмеричное).
OCTET='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
is_ip4() {
  printf '%s\n' "$1" | grep -Eq "^$OCTET\\.$OCTET\\.$OCTET\\.$OCTET\$"
}
ip4_int() {
  old_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 # разбиение по точкам — намеренно
  set -- $1
  IFS=$old_ifs
  echo $((($1 << 24) + ($2 << 16) + ($3 << 8) + $4))
}
mask_of() {
  if [ "$1" -eq 0 ]; then echo 0; else echo $(((0xFFFFFFFF << (32 - $1)) & 0xFFFFFFFF)); fi
}
# in_cidr <адрес> <сеть/биты>
in_cidr() {
  m=$(mask_of "${2#*/}")
  [ $(($(ip4_int "$1") & m)) -eq $(($(ip4_int "${2%/*}") & m)) ]
}

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
SUBNET_NET="${WORKER_SUBNET%/*}"
case "$WORKER_SUBNET" in
  */*) ;;
  *) SUBNET_BITS="" ;;
esac
if ! is_ip4 "$SUBNET_NET" ||
  ! [ "$SUBNET_BITS" -ge 16 ] 2>/dev/null || ! [ "$SUBNET_BITS" -le 29 ] 2>/dev/null; then
  die "WORKER_SUBNET=$WORKER_SUBNET — нужна подсеть IPv4 от /16 до /29 (своя сеть воркера bworker-egress)"
fi
if [ $(($(ip4_int "$SUBNET_NET") & ~$(mask_of "$SUBNET_BITS") & 0xFFFFFFFF)) -ne 0 ]; then
  die "WORKER_SUBNET=$WORKER_SUBNET — адрес не начало подсети (Docker такую не создаст: опечатка?)"
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
if in_cidr "$HOST_V4" "$WORKER_SUBNET"; then
  die "адрес сервера $HOST_V4 внутри WORKER_SUBNET=$WORKER_SUBNET"
fi

# ── Самозащиты (аудит P3, 06.10.2026) ─────────────────────────────────
# Имя моста прошло проверку выше, но «мостом» по ошибке может оказаться
# интерфейс, через который живёт сам сервер (переименованный, со своим
# адресом): тогда `INPUT -i <мост> -j DROP` отрезал бы SSH. Поэтому по
# фактам, а не по имени: на мосту нет адреса сервера, маршрут по
# умолчанию идёт не через него, а адрес моста лежит в WORKER_SUBNET.
if ip link show "$WORKER_BRIDGE" >/dev/null 2>&1; then
  BRIDGE_V4="$(ip -4 -o addr show dev "$WORKER_BRIDGE" | awk '{print $4}' | cut -d/ -f1)"
  for a in $BRIDGE_V4; do
    if [ "$a" = "$HOST_V4" ]; then
      die "на $WORKER_BRIDGE висит адрес сервера $HOST_V4 — это не мост воркера (DROP на нём отрезал бы SSH)"
    fi
  done
  if ip route get 1.1.1.1 2>/dev/null | grep -Eq " dev $WORKER_BRIDGE( |\$)"; then
    die "маршрут по умолчанию (ip route get 1.1.1.1) идёт через $WORKER_BRIDGE — это не мост воркера"
  fi
  if [ -z "$BRIDGE_V4" ]; then
    die "у $WORKER_BRIDGE нет IPv4 — не могу убедиться, что это мост сети $WORKER_SUBNET"
  fi
  for a in $BRIDGE_V4; do
    if ! in_cidr "$a" "$WORKER_SUBNET"; then
      die "адрес моста $WORKER_BRIDGE ($a) вне WORKER_SUBNET=$WORKER_SUBNET — подсеть или мост указаны неверно"
    fi
  done
fi

# Сверка с самой сетью Docker: подсеть из её IPAM и мост из её опций
# должны совпасть с WORKER_SUBNET/WORKER_BRIDGE — иначе правила матчили
# бы чужую подсеть, а трафик воркера шёл бы мимо. IPv6 у сети — отказ:
# правила ниже только IPv4, и v6-трафик воркера ушёл бы без фильтра.
if command -v docker >/dev/null 2>&1; then
  if ! NETS="$(docker network ls --format '{{.Name}}' 2>/dev/null)"; then
    die "docker есть, но не отвечает (docker network ls) — не могу сверить сеть воркера"
  fi
  if [ -n "${WORKER_NETWORK:-}" ]; then
    NETS="$(printf '%s\n' "$NETS" | grep -Fx -- "$WORKER_NETWORK" || true)"
    if [ -z "$NETS" ]; then echo "сети $WORKER_NETWORK нет — сверка подсети пропущена"; fi
  else
    NETS="$(printf '%s\n' "$NETS" | grep -E '^(.+_)?bworker-egress$' || true)"
  fi
  for net in $NETS; do
    NET_SUBNETS="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$net")"
    NET_SUBNETS="$(echo $NET_SUBNETS)" # без хвостового пробела шаблона
    NET_V6="$(docker network inspect -f '{{.EnableIPv6}}' "$net")"
    NET_BR="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$net" 2>/dev/null || true)"
    if [ "$NET_V6" = "true" ]; then
      die "у сети Docker $net включён IPv6 (EnableIPv6=true): фильтр только IPv4, трафик воркера по IPv6 ушёл бы мимо него — уберите enable_ipv6 у сети и пересоздайте её"
    fi
    for sn in $NET_SUBNETS; do
      case "$sn" in
        *:*) die "у сети Docker $net есть IPv6-подсеть $sn: фильтр только IPv4" ;;
      esac
      if [ "$sn" != "$WORKER_SUBNET" ]; then
        die "подсеть сети Docker $net ($sn) не совпадает с WORKER_SUBNET=$WORKER_SUBNET"
      fi
    done
    if [ -z "$NET_SUBNETS" ]; then die "у сети Docker $net нет IPv4-подсети в IPAM"; fi
    case "$NET_BR" in
      "" | "<no value>") ;;
      "$WORKER_BRIDGE") ;;
      *) die "мост сети Docker $net — $NET_BR, а WORKER_BRIDGE=$WORKER_BRIDGE" ;;
    esac
    echo "сеть Docker $net: подсеть $NET_SUBNETS, IPv6 выключен — совпадает"
  done
else
  echo "docker не найден — сверка подсети с сетью bworker-egress пропущена"
fi

# Служебные и приватные диапазоны — тот же смысл, что isBlockedAddress
# (backend/src/common/external-url-guard.ts), плюс адрес самого хоста.
DENY_V4="0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 \
172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.88.99.0/24 192.168.0.0/16 \
198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4 \
${HOST_V4}/32"

# Резолверы для DNS 53 (аудит Ш3, хвост (14)): раньше 53 был открыт на
# ЛЮБОЙ адрес — канал наружу мимо прокси (DNS-туннель к своему серверу).
# Теперь — только к резолверам, которыми пользуется встроенный DNS Docker.
resolvers_from() {
  [ -r "$1" ] || return 0
  awk '$1 == "nameserver" { print $2 }' "$1" | grep -v '^127\.' | grep -v ':' || true
}
if [ -n "${WORKER_DNS_RESOLVERS:-}" ]; then
  DNS_V4="$(printf '%s' "$WORKER_DNS_RESOLVERS" | tr ',' ' ')"
  DNS_FROM="WORKER_DNS_RESOLVERS"
else
  DNS_V4="$(resolvers_from "$WORKER_RESOLV_CONF")"
  DNS_FROM="$WORKER_RESOLV_CONF"
  if [ -z "$DNS_V4" ]; then
    DNS_V4="$(resolvers_from "$WORKER_SYSTEMD_RESOLV_CONF")"
    DNS_FROM="$WORKER_SYSTEMD_RESOLV_CONF"
  fi
  if [ -z "$DNS_V4" ]; then
    DNS_V4="8.8.8.8 8.8.4.4"
    DNS_FROM="запасные адреса Docker (в resolv.conf нет внешних IPv4)"
  fi
fi
DNS_V4="$(echo $DNS_V4)" # одной строкой через пробел
if [ -z "$DNS_V4" ]; then die "WORKER_DNS_RESOLVERS пуст"; fi
for r in $DNS_V4; do
  is_ip4 "$r" || die "резолвер «$r» ($DNS_FROM) — не IPv4-адрес"
  case "$r" in
    0.* | 127.*) die "резолвер $r ($DNS_FROM) — loopback/0.0.0.0, контейнеру недоступен" ;;
  esac
  for net in $DENY_V4; do
    if in_cidr "$r" "$net"; then
      echo "ВНИМАНИЕ: резолвер $r в закрытом диапазоне $net — правила ниже закроют и DNS к нему; задайте WORKER_DNS_RESOLVERS" >&2
      break
    fi
  done
done
echo "DNS 53 — только к: $DNS_V4 ($DNS_FROM)"

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
# DNS — только к резолверам хоста (встроенный DNS Docker ходит наружу из
# сети контейнера) и разрешённые TCP-порты; всё прочее — отказ.
for r in $DNS_V4; do
  run iptables -A "$CHAIN" -d "$r/32" -p udp --dport 53 -j RETURN
  run iptables -A "$CHAIN" -d "$r/32" -p tcp --dport 53 -j RETURN
done
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
