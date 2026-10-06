/**
 * browser-worker/deploy/worker-egress-docker-user.sh — правила хоста для
 * браузерного воркера Ш3 (копия приёма doc/relay-egress-docker-user.sh). Настоящий iptables в CI не трогается: `ip` и
 * `iptables` подменяются заглушками в PATH, которые пишут свои вызовы в
 * журнал. Проверяется главное для сервера без панели Hetzner: скрипт не
 * может отрезать доступ (SSH, `-i eth0`, правило порта 3000) и меняет
 * только своё.
 *
 * Аудит P3 / Ш3-хвост (06.10.2026): самозащиты по фактам (адрес сервера
 * на «мосту», маршрут по умолчанию через него, адрес моста вне подсети),
 * сверка с сетью Docker (подсеть, мост, IPv6), DNS 53 — только к
 * резолверам хоста; и прогон `--apply`, повторный `--apply`, `--remove`
 * на заглушке iptables С СОСТОЯНИЕМ: правила владельца (SSH 22, порты
 * 3000/8088/2377) на месте и в том же порядке.
 */

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(
  __dirname,
  '..',
  '..',
  'deploy',
  'worker-egress-docker-user.sh',
);

let dir: string;
let log: string;

/** Ответы заглушки `ip` по умолчанию; тест переопределяет файлами в `dir`. */
const IP_DEFAULTS: Record<string, string> = {
  'bridge-addr':
    '5: br-bworker    inet 172.31.251.1/24 brd 172.31.251.255 scope global br-bworker',
  route: '1.1.1.1 via 172.31.1.1 dev eth0 src 203.0.113.7 uid 0',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bworker-egress-'));
  log = join(dir, 'calls.log');
  writeFileSync(log, '');
  // iptables: -C — «правила нет», -S своей цепочки — «цепочки нет»,
  // -S DOCKER-USER — содержимое из файла (для --remove).
  writeFileSync(
    join(dir, 'iptables'),
    `#!/bin/sh
echo "iptables $*" >> "${log}"
case "$*" in
  "-C "*) exit 1 ;;
  "-S BWORKER-EGRESS") exit 1 ;;
  "-S DOCKER-USER") cat "${dir}/docker-user.rules" 2>/dev/null; exit 0 ;;
esac
exit 0
`,
  );
  for (const [k, v] of Object.entries(IP_DEFAULTS))
    writeFileSync(join(dir, `ip-${k}`), `${v}\n`);
  writeFileSync(join(dir, 'resolv.conf'), 'nameserver 185.12.64.1\n');
  writeFileSync(
    join(dir, 'ip'),
    `#!/bin/sh
case "$*" in
  "-4 -o addr show dev eth0 scope global") echo "2: eth0    inet 203.0.113.7/32 scope global eth0" ;;
  "-4 -o addr show dev br-bworker") cat "${dir}/ip-bridge-addr" ;;
  "route get 1.1.1.1") cat "${dir}/ip-route" ;;
  "link show br-bworker") exit 0 ;;
  "-d link show docker0") echo "3: docker0: <UP>\n    bridge forward_delay 1500" ;;
  "-d link show br-bworker") echo "5: br-bworker: <UP> mtu 1500\\n    bridge forward_delay 1500" ;;
  "link show "*) exit 0 ;;
  "-d link show "*) echo "2: x: <UP> mtu 1500 link/ether" ;;
esac
exit 0
`,
  );
  // docker: сеть, как её создаёт compose (`<проект>_bworker-egress`);
  // подсеть/IPv6/мост — из файлов, без файла `docker-none` сети нет.
  writeFileSync(join(dir, 'net-subnet'), '172.31.251.0/24 \n');
  writeFileSync(join(dir, 'net-v6'), 'false\n');
  writeFileSync(join(dir, 'net-bridge'), 'br-bworker\n');
  writeFileSync(
    join(dir, 'docker'),
    `#!/bin/sh
N=browser-worker_bworker-egress
case "$*" in
  "network ls --format {{.Name}}")
    printf 'bridge\\nhost\\ndokploy-network\\n'
    [ -f "${dir}/docker-none" ] || echo "$N"
    exit 0 ;;
  "network inspect -f {{range .IPAM.Config}}{{.Subnet}} {{end}} $N") cat "${dir}/net-subnet" ;;
  "network inspect -f {{.EnableIPv6}} $N") cat "${dir}/net-v6" ;;
  'network inspect -f {{index .Options "com.docker.network.bridge.name"}} '"$N") cat "${dir}/net-bridge" ;;
  *) echo "docker: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(join(dir, 'iptables'), 0o755);
  chmodSync(join(dir, 'ip'), 0o755);
  chmodSync(join(dir, 'docker'), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(
  args: string[],
  env: Record<string, string> = {},
): { code: number; out: string; calls: string[] } {
  let code = 0;
  let out = '';
  try {
    out = execFileSync('sh', [SCRIPT, ...args], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        WORKER_RESOLV_CONF: join(dir, 'resolv.conf'),
        WORKER_SYSTEMD_RESOLV_CONF: join(dir, 'nope.conf'),
        ...env,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    code = e.status;
    out = `${e.stdout}${e.stderr}`;
  }
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { code, out, calls };
}

/** Вызовы, которые МЕНЯЮТ правила. */
const mutating = (calls: string[]) =>
  calls.filter((c) => / -(A|I|D|N|X|F|P|R|Z) /.test(` ${c.slice(9)} `));

describe('worker-egress-docker-user.sh', () => {
  it('без аргумента — только план: ни одного изменяющего вызова', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(mutating(r.calls)).toEqual([]);
    expect(r.out).toContain(
      '[план] iptables -I DOCKER-USER 1 -s 172.31.251.0/24 -j BWORKER-EGRESS',
    );
  });

  it('--apply: трогает только подсеть и мост воркера, не SSH, не eth0 и не порт 3000', () => {
    const r = run(['--apply']);
    expect(r.code).toBe(0);
    const changes = mutating(r.calls);
    expect(changes).toContain(
      'iptables -I DOCKER-USER 1 -s 172.31.251.0/24 -j BWORKER-EGRESS',
    );
    expect(changes).toContain('iptables -I INPUT 1 -i br-bworker -j DROP');
    const forbidden =
      /-i eth0|--dport (22|3000|2377|8088)\b| -P |-F (INPUT|DOCKER-USER|FORWARD)/;
    expect(changes.filter((c) => forbidden.test(c))).toEqual([]);
    // Каждое правило в общих цепочках — только про воркер.
    const shared = changes.filter((c) =>
      / (INPUT|DOCKER-USER|FORWARD) /.test(c),
    );
    expect(shared.length).toBeGreaterThan(0);
    expect(
      shared.filter((c) => !/-s 172\.31\.251\.0\/24|-i br-bworker/.test(c)),
    ).toEqual([]);
  });

  it.each([
    ['внешний интерфейс', { WORKER_BRIDGE: 'eth0' }],
    ['loopback', { WORKER_BRIDGE: 'lo' }],
    ['docker0', { WORKER_BRIDGE: 'docker0' }],
    ['не-мост', { WORKER_BRIDGE: 'br-fake' }],
  ])('WORKER_BRIDGE = %s — отказ до любых изменений', (_n, env) => {
    // `br-fake` у заглушки `ip` существует, но не bridge.
    const r = run(['--apply'], env);
    expect(r.code).not.toBe(0);
    expect(mutating(r.calls)).toEqual([]);
  });

  it.each([
    ['весь интернет', '0.0.0.0/0'],
    ['слишком широкая', '172.16.0.0/12'],
    ['без маски', '172.31.250.0'],
    ['мусор', 'abc/xx'],
  ])('WORKER_SUBNET = %s — отказ до любых изменений', (_n, subnet) => {
    const r = run(['--apply'], { WORKER_SUBNET: subnet });
    expect(r.code).not.toBe(0);
    expect(mutating(r.calls)).toEqual([]);
  });

  it('наружу — только 80/443 и DNS (QA-ТЗ §4.2), адрес сервера закрыт', () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('--dports 80,443 -j RETURN');
    expect(r.out).not.toContain('8080');
    expect(r.out).toContain('-d 203.0.113.7/32');
    expect(r.out).toContain('-d 169.254.0.0/16');
  });

  it.each([
    [
      'адрес сервера на «мосту»',
      'bridge-addr',
      '5: br-bworker    inet 203.0.113.7/24 scope global br-bworker',
      /адрес сервера/,
    ],
    [
      'маршрут по умолчанию через мост',
      'route',
      '1.1.1.1 via 172.31.251.254 dev br-bworker src 172.31.251.1 uid 0',
      /маршрут по умолчанию/,
    ],
    [
      'адрес моста вне WORKER_SUBNET',
      'bridge-addr',
      '5: br-bworker    inet 10.9.0.1/24 scope global br-bworker',
      /вне WORKER_SUBNET/,
    ],
    ['у моста нет IPv4', 'bridge-addr', '', /нет IPv4/],
  ])('самозащита: %s — отказ до любых изменений', (_n, file, text, msg) => {
    writeFileSync(join(dir, `ip-${file}`), text ? `${text}\n` : '');
    for (const mode of [[], ['--apply']]) {
      const r = run(mode);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(msg);
      expect(mutating(r.calls)).toEqual([]);
    }
  });

  it('WORKER_SUBNET — не начало подсети (опечатка) — отказ', () => {
    const r = run(['--apply'], { WORKER_SUBNET: '172.31.251.7/24' });
    expect(r.code).toBe(1);
    expect(mutating(r.calls)).toEqual([]);
  });

  it.each([
    [
      'подсеть сети Docker другая',
      'net-subnet',
      '172.31.99.0/24 ',
      /не совпадает с WORKER_SUBNET/,
    ],
    ['IPv6 у сети включён', 'net-v6', 'true', /IPv6/],
    [
      'у сети есть IPv6-подсеть',
      'net-subnet',
      '172.31.251.0/24 fd00:bw::/64 ',
      /IPv6-подсеть/,
    ],
    ['мост сети Docker другой', 'net-bridge', 'br-other', /мост сети Docker/],
  ])('--apply сверяет сеть Docker: %s — отказ', (_n, file, text, msg) => {
    writeFileSync(join(dir, file), `${text}\n`);
    const r = run(['--apply']);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(msg);
    expect(mutating(r.calls)).toEqual([]);
  });

  it('сети Docker нет (или docker недоступен в PATH) — сверка пропущена, не отказ', () => {
    writeFileSync(join(dir, 'docker-none'), '');
    expect(run(['--apply']).code).toBe(0);
    const ok = run(['--apply']);
    expect(ok.out).not.toContain('сеть Docker');
  });

  it('DNS 53 — только к резолверам из resolv.conf хоста, не на любой адрес (Ш3-хвост 14)', () => {
    writeFileSync(
      join(dir, 'resolv.conf'),
      '# hetzner\nnameserver 185.12.64.1\nnameserver 185.12.64.2\nnameserver 2a01:4ff:ff00::add:1\noptions edns0\n',
    );
    const r = run(['--apply']);
    expect(r.code).toBe(0);
    const dns = mutating(r.calls).filter((c) => /--dport 53\b/.test(c));
    expect(dns.sort()).toEqual(
      [
        'iptables -A BWORKER-EGRESS -d 185.12.64.1/32 -p tcp --dport 53 -j RETURN',
        'iptables -A BWORKER-EGRESS -d 185.12.64.1/32 -p udp --dport 53 -j RETURN',
        'iptables -A BWORKER-EGRESS -d 185.12.64.2/32 -p tcp --dport 53 -j RETURN',
        'iptables -A BWORKER-EGRESS -d 185.12.64.2/32 -p udp --dport 53 -j RETURN',
      ].sort(),
    );
  });

  it('DNS: только 127.0.0.53 в resolv.conf → резолверы systemd-resolved; пусто → запасные Docker', () => {
    writeFileSync(join(dir, 'resolv.conf'), 'nameserver 127.0.0.53\n');
    writeFileSync(join(dir, 'systemd.conf'), 'nameserver 9.9.9.9\n');
    const a = run([], {
      WORKER_SYSTEMD_RESOLV_CONF: join(dir, 'systemd.conf'),
    });
    expect(a.out).toContain('-d 9.9.9.9/32 -p udp --dport 53 -j RETURN');
    expect(a.out).not.toContain('127.0.0.53');
    const b = run([]);
    expect(b.out).toContain('-d 8.8.8.8/32 -p udp --dport 53 -j RETURN');
    expect(b.out).toContain('-d 8.8.4.4/32 -p tcp --dport 53 -j RETURN');
  });

  it.each([
    ['мусор', '1.1.1.1,abc'],
    ['loopback', '127.0.0.1'],
    ['ведущий ноль', '010.0.0.1'],
    ['октет > 255', '1.2.3.256'],
  ])('WORKER_DNS_RESOLVERS = %s — отказ', (_n, v) => {
    const r = run(['--apply'], { WORKER_DNS_RESOLVERS: v });
    expect(r.code).toBe(1);
    expect(mutating(r.calls)).toEqual([]);
  });

  it('WORKER_DNS_RESOLVERS задан — только он', () => {
    const r = run([], { WORKER_DNS_RESOLVERS: '1.1.1.1, 9.9.9.9' });
    expect(r.code).toBe(0);
    expect(r.out).toContain('-d 1.1.1.1/32 -p udp --dport 53 -j RETURN');
    expect(r.out).toContain('-d 9.9.9.9/32 -p tcp --dport 53 -j RETURN');
    expect(r.out).not.toContain('185.12.64.1/32');
  });

  it('--apply, повторный --apply, --remove на iptables с состоянием: правила владельца нетронуты', () => {
    // Заглушка с состоянием (JSON): -N/-X/-F/-A/-I/-D/-C/-S как у iptables.
    const state = join(dir, 'state.json');
    const owner = {
      INPUT: [
        '-i lo -j ACCEPT',
        '-p tcp -m tcp --dport 22 -j ACCEPT',
        '-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT',
      ],
      FORWARD: ['-j DOCKER-USER'],
      'DOCKER-USER': [
        '-i eth0 -p tcp -m tcp --dport 3000 -j DROP',
        '-i eth0 -p tcp -m tcp --dport 8088 -j DROP',
        '-i eth0 -p tcp -m tcp --dport 2377 -j DROP',
        '-j RETURN',
      ],
      'RELAY-EGRESS': ['-j RETURN'],
    };
    writeFileSync(state, JSON.stringify(owner));
    writeFileSync(
      join(dir, 'iptables'),
      `#!${process.execPath}
const fs = require('fs');
const f = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(f, 'utf8'));
const [op, c, ...rest] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, 'iptables ' + process.argv.slice(2).join(' ') + '\\n');
const save = () => fs.writeFileSync(f, JSON.stringify(s));
const out = (t) => process.stdout.write(t + '\\n');
if (op === '-S') {
  if (!c) { Object.keys(s).forEach((k) => out('-N ' + k)); process.exit(0); }
  if (!s[c]) process.exit(1);
  s[c].forEach((r) => out('-A ' + c + ' ' + r));
  process.exit(0);
}
if (op === '-N') { if (s[c]) process.exit(1); s[c] = []; save(); process.exit(0); }
if (op === '-X') {
  if (Object.values(s).some((rs) => rs.some((r) => r.endsWith('-j ' + c)))) process.exit(1);
  delete s[c]; save(); process.exit(0);
}
if (!s[c]) process.exit(1);
if (op === '-F') { s[c] = []; save(); process.exit(0); }
if (op === '-A') { s[c].push(rest.join(' ')); save(); process.exit(0); }
if (op === '-I') {
  let pos = 1; let r = rest;
  if (/^\\d+$/.test(r[0])) { pos = Number(r[0]); r = r.slice(1); }
  s[c].splice(pos - 1, 0, r.join(' ')); save(); process.exit(0);
}
if (op === '-C') process.exit(s[c].includes(rest.join(' ')) ? 0 : 1);
if (op === '-D') {
  const i = s[c].indexOf(rest.join(' '));
  if (i < 0) process.exit(1);
  s[c].splice(i, 1); save(); process.exit(0);
}
process.exit(2);
`,
    );
    chmodSync(join(dir, 'iptables'), 0o755);
    const read = () =>
      JSON.parse(readFileSync(state, 'utf8')) as Record<string, string[]>;
    const ownerKept = (st: Record<string, string[]>) => {
      for (const [ch, rules] of Object.entries(owner))
        // Все правила владельца на месте и в прежнем порядке.
        expect(st[ch].filter((r) => rules.includes(r))).toEqual(rules);
    };

    expect(run(['--apply']).code).toBe(0);
    const once = read();
    ownerKept(once);
    expect(once['DOCKER-USER'][0]).toBe('-s 172.31.251.0/24 -j BWORKER-EGRESS');
    expect(once.INPUT.slice(0, 2)).toEqual([
      '-i br-bworker -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
      '-i br-bworker -j DROP',
    ]);
    expect(once['BWORKER-EGRESS'].length).toBeGreaterThan(10);

    expect(run(['--apply']).code).toBe(0);
    expect(read()).toEqual(once); // идемпотентно: ни дублей, ни потерь

    expect(run(['--remove']).code).toBe(0);
    expect(read()).toEqual(owner); // ровно исходное состояние
  });

  it('--status и --remove работают и без IPv4 на внешнем интерфейсе', () => {
    expect(run(['--status'], { EXT_IF: 'nope0' }).code).toBe(0);
    expect(run(['--remove'], { EXT_IF: 'nope0' }).code).toBe(0);
  });

  it('--remove снимает переход в цепочку и при другой подсети, чем при --apply', () => {
    writeFileSync(
      join(dir, 'docker-user.rules'),
      '-N DOCKER-USER\n-A DOCKER-USER -s 172.31.99.0/24 -j BWORKER-EGRESS\n-A DOCKER-USER -i eth0 -p tcp -m tcp --dport 3000 -j DROP\n',
    );
    const r = run(['--remove']);
    expect(r.code).toBe(0);
    const changes = mutating(r.calls);
    expect(changes).toContain(
      'iptables -D DOCKER-USER -s 172.31.99.0/24 -j BWORKER-EGRESS',
    );
    // Правило панели Dokploy (порт 3000) — не наше и остаётся.
    expect(changes.join('\n')).not.toContain('3000');
  });
});
