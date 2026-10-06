/**
 * browser-worker/deploy/worker-egress-docker-user.sh — правила хоста для
 * браузерного воркера Ш3 (копия приёма doc/relay-egress-docker-user.sh). Настоящий iptables в CI не трогается: `ip` и
 * `iptables` подменяются заглушками в PATH, которые пишут свои вызовы в
 * журнал. Проверяется главное для сервера без панели Hetzner: скрипт не
 * может отрезать доступ (SSH, `-i eth0`, правило порта 3000) и меняет
 * только своё.
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
  writeFileSync(
    join(dir, 'ip'),
    `#!/bin/sh
case "$*" in
  "-4 -o addr show dev eth0 scope global") echo "2: eth0    inet 203.0.113.7/32 scope global eth0" ;;
  "link show br-bworker") exit 0 ;;
  "-d link show docker0") echo "3: docker0: <UP>\n    bridge forward_delay 1500" ;;
  "-d link show br-bworker") echo "5: br-bworker: <UP> mtu 1500\\n    bridge forward_delay 1500" ;;
  "link show "*) exit 0 ;;
  "-d link show "*) echo "2: x: <UP> mtu 1500 link/ether" ;;
esac
exit 0
`,
  );
  chmodSync(join(dir, 'iptables'), 0o755);
  chmodSync(join(dir, 'ip'), 0o755);
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
      env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
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
    expect(r.out).toContain('--dports 80,443 -j RETURN');
    expect(r.out).not.toContain('8080');
    expect(r.out).toContain('-d 203.0.113.7/32');
    expect(r.out).toContain('-d 169.254.0.0/16');
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
