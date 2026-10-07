#!/usr/bin/env node
/**
 * Сборка seccomp-профиля браузерного воркера (Ш3-хвост (15)).
 *
 *   node docker/seccomp-build.cjs          # записать docker/seccomp-chromium.json
 *   node docker/seccomp-build.cjs --check  # только сверить (unit-тест seccomp.spec.ts)
 *
 * Основа — ТЕКУЩЕЕ умолчание Docker: `seccomp/default.json` модуля
 * github.com/moby/profiles/seccomp (с 2025 года профиль живёт там, moby/moby
 * его вендорит: `go.mod` ветки master → `github.com/moby/profiles/seccomp
 * v0.2.4`). Копия лежит рядом без правок (`moby-seccomp-default-v0.2.4.json`,
 * Apache-2.0), её sha256 сверяется ниже — правка основы руками невозможна
 * молча. Обновление: положить новый `default.json` под новым именем,
 * поменять BASE_FILE/BASE_SHA256, запустить без флага, прогнать unit и
 * проверку песочницы на VPS (doc/DEPLOYMENT.md §6.25).
 *
 * Поверх основы (всё — по смыслу профиля moby и песочницы Chromium):
 *  1. песочница Chromium (как в профиле Playwright `utils/docker/
 *     seccomp_profile.json`, но с флагами): `clone`/`unshare` — с
 *     CLONE_NEWUSER|CLONE_NEWPID|CLONE_NEWNET, без NEWNS/NEWUTS/NEWIPC/
 *     NEWCGROUP (и NEWTIME у unshare); `setns` — только в user/pid/net;
 *     `chroot` — Chromium делает chroot("/proc/self/fdinfo") в СВОЁМ user
 *     namespace, а у контейнера `cap_drop: ALL` — правило moby под
 *     CAP_SYS_CHROOT в фильтр не попадает;
 *  2. `ptrace`/`process_vm_readv`/`process_vm_writev` — moby разрешает их
 *     без возможностей на ядре ≥ 4.8; Chromium они не нужны, а процесс
 *     Node того же uid держит HMAC-секрет и ключ конверта учёток — правило
 *     убрано (правило под CAP_SYS_PTRACE осталось и при `cap_drop: ALL` не
 *     действует);
 *  3. `socket` — только AF_UNIX, AF_INET, AF_INET6, AF_NETLINK (moby
 *     разрешает почти все семейства, кроме AF_ALG/AF_VSOCK; редкие
 *     семейства — частый источник LPE через автозагрузку модулей).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIR = __dirname;
const BASE_FILE = 'moby-seccomp-default-v0.2.4.json';
const BASE_SHA256 =
  '785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334';
const BASE_SOURCE =
  'github.com/moby/profiles seccomp/v0.2.4 seccomp/default.json (moby/moby master go.mod), Apache-2.0';
const OUT_FILE = 'seccomp-chromium.json';

const CLONE_NEWNS = 0x00020000;
const CLONE_NEWCGROUP = 0x02000000;
const CLONE_NEWUTS = 0x04000000;
const CLONE_NEWIPC = 0x08000000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
const CLONE_NEWTIME = 0x00000080;
/** Пространства имён, которые песочнице Chromium НЕ нужны. */
const FORBIDDEN_NS =
  CLONE_NEWNS | CLONE_NEWCGROUP | CLONE_NEWUTS | CLONE_NEWIPC;

/** AF_UNIX, AF_INET, AF_INET6, AF_NETLINK. */
const SOCKET_FAMILIES = [1, 2, 10, 16];

const masked = (index, mask) => ({
  index,
  value: mask,
  valueTwo: 0,
  op: 'SCMP_CMP_MASKED_EQ',
});

function chromiumRules() {
  return [
    {
      comment: `Песочница Chromium (user/pid/net namespaces). Основа профиля: ${BASE_SOURCE}; сборка — docker/seccomp-build.cjs`,
      names: ['clone'],
      action: 'SCMP_ACT_ALLOW',
      args: [masked(0, FORBIDDEN_NS)],
      excludes: { arches: ['s390', 's390x'] },
    },
    {
      comment: 'Песочница Chromium: clone на s390 (флаги — второй аргумент)',
      names: ['clone'],
      action: 'SCMP_ACT_ALLOW',
      args: [masked(1, FORBIDDEN_NS)],
      includes: { arches: ['s390', 's390x'] },
    },
    {
      comment:
        'Песочница Chromium: unshare(CLONE_NEWUSER|…) без mount/uts/ipc/cgroup/time',
      names: ['unshare'],
      action: 'SCMP_ACT_ALLOW',
      args: [masked(0, FORBIDDEN_NS | CLONE_NEWTIME)],
    },
    ...[CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET].map((ns) => ({
      comment: 'Песочница Chromium: setns только в user/pid/net',
      names: ['setns'],
      action: 'SCMP_ACT_ALLOW',
      args: [{ index: 1, value: ns, valueTwo: 0, op: 'SCMP_CMP_EQ' }],
    })),
    {
      comment:
        'Песочница Chromium: chroot("/proc/self/fdinfo") в своём user namespace (cap_drop: ALL убирает правило moby под CAP_SYS_CHROOT)',
      names: ['chroot'],
      action: 'SCMP_ACT_ALLOW',
    },
  ];
}

const isSocketRule = (r) =>
  r.names.length === 1 && r.names[0] === 'socket' && Array.isArray(r.args);
const isUncappedPtrace = (r) =>
  r.names.includes('ptrace') && !!r.includes && !!r.includes.minKernel;

function build(base) {
  const p = JSON.parse(JSON.stringify(base));
  if (p.defaultAction !== 'SCMP_ACT_ERRNO') {
    throw new Error(
      'основа: defaultAction не SCMP_ACT_ERRNO — пересмотреть сборку',
    );
  }
  const main = p.syscalls[0];
  for (const n of [
    'clone',
    'clone3',
    'unshare',
    'setns',
    'chroot',
    'socket',
    'ptrace',
  ]) {
    if (main.names.includes(n)) {
      throw new Error(
        `основа: ${n} в общем списке без условий — пересмотреть сборку`,
      );
    }
  }
  const ptrace = p.syscalls.filter(isUncappedPtrace);
  if (ptrace.length !== 1) {
    throw new Error(
      'основа: не найдено правило ptrace по minKernel — пересмотреть сборку',
    );
  }
  const firstSocket = p.syscalls.findIndex(isSocketRule);
  if (firstSocket < 0) {
    throw new Error('основа: нет правил socket — пересмотреть сборку');
  }
  const drop = (r) => isUncappedPtrace(r) || isSocketRule(r);
  // Семейства socket — на месте прежних правил socket основы.
  const socketAt = p.syscalls
    .slice(0, firstSocket)
    .filter((r) => !drop(r)).length;
  const rest = p.syscalls.filter((r) => !drop(r));
  const sockets = SOCKET_FAMILIES.map((family) => ({
    names: ['socket'],
    action: 'SCMP_ACT_ALLOW',
    args: [{ index: 0, value: family, valueTwo: 0, op: 'SCMP_CMP_EQ' }],
  }));
  rest.splice(socketAt, 0, ...sockets);
  p.syscalls = [...chromiumRules(), ...rest];
  return p;
}

function render(profile) {
  return `${JSON.stringify(profile, null, '\t')}\n`;
}

function main() {
  const raw = fs.readFileSync(path.join(DIR, BASE_FILE));
  const sha = crypto.createHash('sha256').update(raw).digest('hex');
  if (sha !== BASE_SHA256) {
    process.stderr.write(
      `${BASE_FILE}: sha256 ${sha} ≠ ${BASE_SHA256} — основа изменена; обновите BASE_SHA256 осознанно\n`,
    );
    process.exit(1);
  }
  const out = render(build(JSON.parse(raw.toString('utf8'))));
  const target = path.join(DIR, OUT_FILE);
  if (process.argv.includes('--check')) {
    const cur = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (cur !== out) {
      process.stderr.write(
        `${OUT_FILE} расходится со сборкой из ${BASE_FILE}: node docker/seccomp-build.cjs\n`,
      );
      process.exit(1);
    }
    process.stdout.write(
      `${OUT_FILE}: совпадает со сборкой (${BASE_SOURCE})\n`,
    );
    return;
  }
  fs.writeFileSync(target, out);
  process.stdout.write(`${OUT_FILE}: записан (${BASE_SOURCE})\n`);
}

module.exports = { build, render, BASE_FILE, BASE_SHA256, BASE_SOURCE };

if (require.main === module) main();
