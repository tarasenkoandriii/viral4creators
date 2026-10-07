# seccomp-профиль браузерного воркера

`seccomp-chromium.json` подключается в `../docker-compose.yml`
(`security_opt: seccomp=./docker/seccomp-chromium.json`). Руками не правится —
собирается скриптом:

```sh
node docker/seccomp-build.cjs          # записать профиль
node docker/seccomp-build.cjs --check  # сверить (то же делает unit-тест test/unit/seccomp.spec.ts)
```

## Источник основы

- Файл: `moby-seccomp-default-v0.2.4.json` — копия без правок.
- Откуда:
  `https://raw.githubusercontent.com/moby/profiles/refs/tags/seccomp/v0.2.4/seccomp/default.json`.
- Почему эта версия: с 2025 года умолчание Docker живёт в модуле
  `github.com/moby/profiles/seccomp`; `go.mod` ветки `master` moby/moby
  (проверено 07.10.2026) — `github.com/moby/profiles/seccomp v0.2.4`
  (последний тег модуля).
- sha256: `785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334`
  (сверяется скриптом).
- Лицензия: Apache-2.0 (The Moby Authors).

В `main` moby/profiles после v0.2.4 есть невыпущенная правка — список
разрешённых семейств `socket` вместо «всё, кроме AF_ALG/AF_VSOCK». Наш
профиль строже и её покрывает (см. п. 3 ниже).

Прежний профиль был профилем Playwright на старом умолчании Docker: в нём не
было `close_range`, `faccessat2`, `openat2`, `epoll_pwait2`, `pidfd_*`,
`pkey_*`, `landlock_*`, `futex_waitv`, `map_shadow_stack`, `mseal` и др.
(новые вызовы — ENOSYS заглушкой runc, `pkey_*` — EPERM), а `io_uring_*` был
открыт.
Кроме того, `chroot` в нём был только под `CAP_SYS_CHROOT`, а compose
сбрасывает все возможности (`cap_drop: ALL`) — `chroot` песочницы Chromium
получил бы EPERM, и браузер с песочницей, скорее всего, не стартовал бы.

## Что добавлено и убрано поверх moby

1. **Песочница Chromium** (как в профиле Playwright, но с флагами):
   `clone` и `unshare` — только без `CLONE_NEWNS`/`NEWUTS`/`NEWIPC`/`NEWCGROUP`
   (и `NEWTIME` у `unshare`), то есть user/pid/net namespaces зиготы
   разрешены; `setns` — только в user/pid/net; `chroot` — Chromium делает
   `chroot("/proc/self/fdinfo")` в своём user namespace, а при `cap_drop: ALL`
   правило moby под `CAP_SYS_CHROOT` в фильтр не попадает. `clone3` остаётся,
   как у moby, ENOSYS (glibc откатывается на `clone`).
2. **`ptrace`, `process_vm_readv`, `process_vm_writev`** — moby разрешает их без
   возможностей на ядре ≥ 4.8. Chromium они не нужны, а процесс Node того же
   uid держит HMAC-секрет и ключ конверта учёток: правило убрано.
3. **`socket`** — только `AF_UNIX`, `AF_INET`, `AF_INET6`, `AF_NETLINK`.

Остальное — умолчание moby: под возможностями (`CAP_SYS_ADMIN`, `CAP_BPF`, …)
правила при `cap_drop: ALL` в фильтр не попадают.

## Обновление

1. Скачать новый `default.json` той версии `github.com/moby/profiles/seccomp`,
   которую вендорит актуальный moby (`go.mod`), положить рядом под новым именем.
2. В `seccomp-build.cjs` поменять `BASE_FILE`, `BASE_SHA256`, `BASE_SOURCE`;
   запустить без флага. Скрипт падает, если основа изменилась так, что
   правки выше надо пересмотреть.
3. `npx jest test/unit/seccomp.spec.ts`, затем на VPS — проверка песочницы
   (doc/DEPLOYMENT.md §6.25): воркер при старте сам запускает Chromium с
   песочницей и падает, если seccomp или ядро её не пустили.
