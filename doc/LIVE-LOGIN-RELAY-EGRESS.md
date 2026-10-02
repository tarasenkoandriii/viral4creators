# Изоляция браузера `live-login-relay`: фильтр исходящего трафика

Шаг **Ш0.2** этапа «Э-С» —
`docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md`, риск **К-1**
(SSRF с картинкой через живой вход). Здесь: что уже сделано в коде, что
остаётся сделать на сервере руками и как проверить. Установка площадки
с нуля — `doc/HETZNER-DOKPLOY-SETUP.md`.

**Чего здесь нет и не будет:** открытия портов, отключения входа по
паролю, сужения порта 22 и всего, что требует панели Hetzner (её у
владельца нет). Порт `8088` реле наружу не публикуется, порт `2377`
(Swarm) — тоже; правило
`iptables -I DOCKER-USER -i eth0 -p tcp --dport 3000 -j DROP` для
панели Dokploy остаётся как есть — скрипт ниже его не трогает.

## Содержание

- [Угроза в двух строках](#угроза-в-двух-строках)
- [Что сделано в коде](#что-сделано-в-коде)
- [Шаг 1. Адреса сервера в переменные реле](#шаг-1-адреса-сервера-в-переменные-реле)
- [Шаг 2. Передеплой и проверка фильтра](#шаг-2-передеплой-и-проверка-фильтра)
- [Шаг 3. Своя сеть для исходящего трафика](#шаг-3-своя-сеть-для-исходящего-трафика)
- [Шаг 4. Правила DOCKER-USER](#шаг-4-правила-docker-user)
- [Шаг 5. Правила после перезагрузки](#шаг-5-правила-после-перезагрузки)
- [Откат](#откат)
- [Что остаётся открытым](#что-остаётся-открытым)

## Угроза в двух строках

Реле открывает в Chromium сайт, который задал пользователь, и показывает
экран вживую. Без фильтра страница делает
`location = "http://169.254.169.254/…"` или `<iframe src="http://10.0.x.x:3000">`
— и атакующий видит ответ внутреннего адреса на экране и кликает дальше.

## Что сделано в коде

| Мера | Где | Что закрывает |
|---|---|---|
| Фильтрующий forward-прокси в процессе реле, Chromium ходит только через него (`--proxy-server`, `--proxy-bypass-list=<-loopback>`, WebRTC только через прокси) | `live-login-relay/src/browser-network.ts`, `src/shared/egress-filter-proxy.ts` (копия `backend/src/common/`) | переходы, подресурсы, XHR/fetch, iframe, WebSocket, попапы: один резолв DNS, отказ служебным адресам (`isBlockedAddress` — тот же список, что у sites-backend), подключение к уже проверенному IP — это и защита от DNS-rebinding |
| Отказ публичным адресам самого сервера (`LIVE_LOGIN_EGRESS_DENY`) и портам вне `80,443,8080,8443`; пустой список в production — предупреждение в логе при старте | там же, `src/config.ts` (`egressStartupWarnings`) | доступ страницы к SSH и панелям через публичный IP хоста |
| `--disable-quic`; `Host` из URI, а не от клиента; потолок соединений прокси (512) и закрытие брошенных и молчащих соединений | `egress-filter-proxy.ts` | UDP-выход HTTP/3 мимо прокси; подмена виртуального хоста; исчерпание сокетов и памяти реле враждебной страницей |
| Фильтр нельзя выключить в production | `src/config.ts` | «временно выключили и забыли» |
| `USER node` в образе | `live-login-relay/Dockerfile` | эксплойт рендерера не получает root в контейнере |
| `cap_drop: [ALL]`, `no-new-privileges` | `live-login-relay/docker-compose.yml` | повышение привилегий из контейнера |
| Тот же прокси у обучалки (браузер в функции бэкенда) | `backend/src/modules/client-site-tutorial/chromium-page-explorer.ts` | К-3 |

**Почему реле осталось в `dokploy-network`.** Аудит предлагал вынести
его в отдельную сеть. Но Traefik площадки доходит до контейнера только
через эту сеть, а другой маршрут без проверки на сервере не собрать.
Поэтому сеть Traefik остаётся, а исходящий трафик закрывается двумя
независимыми слоями: прокси в процессе (сделано) и правила хоста
(шаги 3–4 ниже).

**Чего прокси не закрывает.** Эксплойт самого Chromium (RCE при
`--no-sandbox`) откроет сокет мимо прокси. От этого — правила хоста
ниже и свежий Chromium: Debian-пакет `chromium` берётся при каждой
сборке образа, поэтому образ стоит пересобирать хотя бы раз в неделю
(передеплой в Dokploy без изменений кода).

## Шаг 1. Адреса сервера в переменные реле

На сервере (`ssh relay`):

```bash
ip -4 -o addr show dev eth0 scope global | awk '{print $4}'
ip -6 -o addr show dev eth0 scope global | awk '{print $4}'
```

Hetzner выдаёт IPv4 (`/32`) и IPv6-подсеть `/64`; адрес IPv6 вида
`2a01:4f8:…::1/64` записывается подсетью: `2a01:4f8:…::/64`.

В Dokploy → сервис реле → **Environment** добавить:

```
LIVE_LOGIN_EGRESS_DENY=<IPv4>,<IPv6-подсеть>/64
```

`LIVE_LOGIN_EGRESS_FILTER` и `LIVE_LOGIN_EGRESS_ALLOWED_PORTS` не
задавать — умолчания правильные.

## Шаг 2. Передеплой и проверка фильтра

1. **Deploy** в Dokploy.
2. В логах сервиса первая строка:
   `"msg":"live-login-relay listening", … "egressFilter":true,"egressDenyCidrs":2`.
   Если реле не стартовало — в логе причина (`отказ стартовать: …`):
   опечатка в адресе или `LIVE_LOGIN_EGRESS_FILTER=off` при
   `NODE_ENV=production`.
3. Пользователь процесса:
   ```bash
   docker ps --filter name=live-login-relay --format '{{.ID}} {{.Names}}'
   docker exec <ID> id    # uid=1000(node) gid=1000(node)
   ```
4. Живой вход из мини-аппа: экран стримится, вход проходит.
5. Отрицательная проверка — страница, которая лезет внутрь, не видит
   ответа: в живой сессии открыть адрес `http://169.254.169.254/` (поле
   адреса не нужно — достаточно сайта, который делает такой переход;
   для проверки годится любой свой тестовый HTML с
   `<iframe src="http://169.254.169.254/">`). Ожидаемо — страница ошибки
   Chromium (`ERR_TUNNEL_CONNECTION_FAILED`), в логе реле
   `"egress: соединение браузера отклонено","verdict":"blocked-address"`.

## Шаг 3. Своя сеть для исходящего трафика

Нужна, чтобы у трафика реле был **постоянный** адрес-источник: иначе
правило хоста не за что зацепить (адрес в общей сети меняется при
каждом деплое). Сеть Traefik (`dokploy-network`) остаётся — по ней
приходят запросы; новая сеть — только для выхода наружу.

Проверить версии (нужны Docker Engine ≥ 28 и Compose ≥ 2.33 — для
`gw_priority`):

```bash
docker version --format '{{.Server.Version}}'
docker compose version
```

В `live-login-relay/docker-compose.yml` (в репозитории — через коммит,
Dokploy подхватит) заменить блок `networks` сервиса и нижний блок
`networks` на:

```yaml
    networks:
      dokploy-network: {}
      relay-egress:
        gw_priority: 100

networks:
  dokploy-network:
    external: true
  relay-egress:
    driver: bridge
    driver_opts:
      com.docker.network.bridge.name: br-relay
    ipam:
      config:
        - subnet: 172.31.250.0/24
```

Подсеть `172.31.250.0/24` проверить на занятость до деплоя:
`docker network ls -q | xargs docker network inspect --format '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}'`.

После деплоя — проверить, что маршрут по умолчанию ушёл в новую сеть, а
домен работает:

```bash
PID=$(docker inspect -f '{{.State.Pid}}' <ID>)
nsenter -t "$PID" -n ip route        # default via 172.31.250.1 dev …
curl -s https://relay.<домен>/health # {"ok":true,…}
```

Если `default` остался через другую сеть или `/health` не отвечает —
вернуть прежний блок `networks` (откат — передеплой прошлого коммита) и
на шаг 4 не переходить: правило без своей сети не матчит ничего.

## Шаг 4. Правила DOCKER-USER

Скрипт — [`doc/relay-egress-docker-user.sh`](relay-egress-docker-user.sh).
Он трогает только трафик из подсети `172.31.250.0/24` (моста `br-relay`):
SSH, Dokploy, Traefik и правило для порта 3000 не задеваются.

```bash
scp doc/relay-egress-docker-user.sh relay:/root/
ssh relay
sh /root/relay-egress-docker-user.sh            # план: что будет добавлено
sh /root/relay-egress-docker-user.sh --apply
sh /root/relay-egress-docker-user.sh --status
```

Защита от опечаток (скрипт откажется что-либо менять и выйдет с
ошибкой): `RELAY_BRIDGE` — внешний или служебный интерфейс (`eth*`,
`ens*`, `lo`, `docker0`, `docker_gwbridge`, `wg*`…) или не bridge;
`RELAY_SUBNET` — не IPv4-подсеть от `/16` до `/29`. Правило `DROP` на
внешнем интерфейсе закрыло бы SSH, а вернуть доступ без панели Hetzner
нечем. Режимы `--status` и `--remove` работают всегда, даже если на
`eth0` не нашёлся адрес; `--remove` снимает переход в цепочку
`RELAY-EGRESS` при любой подсети (если её меняли между запусками).
Поведение скрипта проверяет `live-login-relay/test/egress-script.spec.ts`
(заглушки `ip`/`iptables`, на настоящий фильтр не влияет).

Что делают правила:

- `DOCKER-USER`: из подсети реле — запрет RFC1918, `100.64/10`,
  `169.254/16`, `127/8`, `0/8`, `224/4`, `240/4`, TEST-NET, сети Docker
  (входят в `172.16/12`) и публичный IPv4 хоста; наружу — только TCP
  `80,443,8080,8443` и DNS `53`; остальное — отказ;
- `INPUT`: с моста `br-relay` на сам хост — запрет (адреса хоста
  принимаются через `INPUT`, а не `FORWARD`).

IPv6 скрипт не трогает: Docker по умолчанию не выдаёт контейнерам
IPv6, выйти по нему реле не может. Если IPv6 для Docker когда-нибудь
включат — правила нужно повторить через `ip6tables`
(`fc00::/7`, `fe80::/10`, `::1/128`, `64:ff9b::/96`, `2002::/16` и
подсеть хоста).

Проверка после `--apply`:

```bash
# изнутри контейнера реле (у образа есть node):
docker exec <ID> node -e "fetch('http://169.254.169.254/').then(()=>console.log('ОТКРЫТО — плохо')).catch(()=>console.log('закрыто'))"
docker exec <ID> node -e "require('net').connect(22,'<IPv4 хоста>').on('connect',()=>console.log('ОТКРЫТО — плохо')).on('error',()=>console.log('закрыто'))"
docker exec <ID> node -e "fetch('https://example.com').then(r=>console.log('наружу', r.status))"
curl -s https://relay.<домен>/health
```

Ожидаемо: два «закрыто», `наружу 200`, `/health` отвечает. Затем —
живой вход из мини-аппа.

## Шаг 5. Правила после перезагрузки

`iptables` без сохранения живёт до перезагрузки. Docker цепочку
`DOCKER-USER` не очищает, но и не восстанавливает. Unit для systemd:

```bash
cp /root/relay-egress-docker-user.sh /usr/local/sbin/
cat > /etc/systemd/system/relay-egress.service <<'EOF'
[Unit]
Description=live-login-relay: фильтр исходящего трафика (DOCKER-USER)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
# Мост br-relay появляется вместе с контейнером — ждём до минуты.
ExecStartPre=/bin/sh -c 'for i in $(seq 1 60); do ip link show br-relay >/dev/null 2>&1 && exit 0; sleep 1; done; exit 1'
ExecStart=/bin/sh /usr/local/sbin/relay-egress-docker-user.sh --apply
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now relay-egress.service
```

Правило для порта 3000 (`-i eth0 --dport 3000 -j DROP`) поддерживается
так же, как сейчас, — этот unit его не трогает.

## Откат

```bash
sh /root/relay-egress-docker-user.sh --remove
systemctl disable --now relay-egress.service   # если ставили шаг 5
```

Сеть `relay-egress` откатывается передеплоем прошлого коммита
`docker-compose.yml`. Фильтр в процессе реле не откатывается
переменной — только откатом образа.

## Что остаётся открытым

- **Трафик внутри `dokploy-network`** (реле ↔ Traefik ↔ контейнеры
  Dokploy) идёт внутри overlay-сети и мимо `DOCKER-USER`. Страница его
  не достанет — прокси режет `10/8` и `172.16/12`, — но эксплойт самого
  Chromium достал бы. Полностью закрывает только вынос браузера на
  отдельный VPS (Ш3 аудита, вариант C), где сети Dokploy нет вовсе.
- **`--no-sandbox`** остаётся: песочница Chromium в контейнере без
  user namespaces не поднимается. Смягчение — non-root, `cap_drop`,
  свежий Chromium.
- **Подтверждения владения сайтом нет** (К-4) — это Ш1, не Ш0.
