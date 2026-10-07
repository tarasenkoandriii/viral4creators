/**
 * seccomp-профиль воркера (Ш3-хвост (15)): собран из ТЕКУЩЕГО умолчания
 * moby (`docker/seccomp-build.cjs`, основа — github.com/moby/profiles
 * seccomp v0.2.4) + песочница Chromium. Проверки — на маленьком
 * интерпретаторе правил, повторяющем отбор Docker (`includes`/`excludes` по
 * возможностям и архитектуре; у контейнера `cap_drop: ALL`, x86_64, ядро
 * ≥ 5.x) и сравнение аргументов libseccomp.
 */
import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface Arg {
  index: number;
  value: number;
  valueTwo?: number;
  op: string;
}
interface Rule {
  names: string[];
  action: string;
  errnoRet?: number;
  args?: Arg[] | null;
  includes?: { caps?: string[]; arches?: string[]; minKernel?: string };
  excludes?: { caps?: string[]; arches?: string[] };
  comment?: string;
}
interface Profile {
  defaultAction: string;
  defaultErrnoRet?: number;
  syscalls: Rule[];
}

const DOCKER = join(__dirname, '../../docker');
const profile = JSON.parse(
  readFileSync(join(DOCKER, 'seccomp-chromium.json'), 'utf8'),
) as Profile;

/** Отбор правил так, как это делает Docker при `cap_drop: ALL`. */
function effective(p: Profile, caps: string[] = [], arch = 'amd64'): Rule[] {
  return p.syscalls.filter((r) => {
    const inc = r.includes ?? {};
    const exc = r.excludes ?? {};
    if (inc.caps?.length && !inc.caps.every((c) => caps.includes(c)))
      return false;
    if (inc.arches?.length && !inc.arches.includes(arch)) return false;
    if (exc.caps?.some((c) => caps.includes(c))) return false;
    if (exc.arches?.includes(arch)) return false;
    return true;
  });
}

function argOk(a: Arg, args: number[]): boolean {
  const v = args[a.index] ?? 0;
  switch (a.op) {
    case 'SCMP_CMP_EQ':
      return v === a.value;
    case 'SCMP_CMP_NE':
      return v !== a.value;
    case 'SCMP_CMP_LT':
      return v < a.value;
    case 'SCMP_CMP_LE':
      return v <= a.value;
    case 'SCMP_CMP_GT':
      return v > a.value;
    case 'SCMP_CMP_GE':
      return v >= a.value;
    case 'SCMP_CMP_MASKED_EQ':
      // eslint-disable-next-line no-bitwise
      return (v & a.value) >>> 0 === (a.valueTwo ?? 0);
    default:
      throw new Error(`неизвестный op ${a.op}`);
  }
}

/** Итог вызова: `allow` | `errno:<код>`. */
function verdict(
  name: string,
  args: number[] = [],
  caps: string[] = [],
  p = profile,
): string {
  for (const r of effective(p, caps)) {
    if (!r.names.includes(name)) continue;
    if ((r.args ?? []).every((a) => argOk(a, args))) {
      return r.action === 'SCMP_ACT_ALLOW'
        ? 'allow'
        : `errno:${r.errnoRet ?? p.defaultErrnoRet ?? 1}`;
    }
  }
  return `errno:${p.defaultErrnoRet ?? 1}`;
}

const CLONE_NEWNS = 0x00020000;
const CLONE_NEWUTS = 0x04000000;
const CLONE_NEWIPC = 0x08000000;
const CLONE_NEWCGROUP = 0x02000000;
const CLONE_NEWUSER = 0x10000000;
const CLONE_NEWPID = 0x20000000;
const CLONE_NEWNET = 0x40000000;
const CLONE_NEWTIME = 0x00000080;
const SIGCHLD = 17;
const THREAD = 0x003d0f00; // pthread_create: VM|FS|FILES|SIGHAND|THREAD|SYSVSEM|SETTLS|PARENT_SETTID|CHILD_CLEARTID

describe('seccomp-профиль воркера', () => {
  it('собран из вендоренной основы moby без ручных правок (--check)', () => {
    const out = execFileSync(
      process.execPath,
      [join(DOCKER, 'seccomp-build.cjs'), '--check'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('moby/profiles');
    expect(profile.syscalls[0].comment).toMatch(
      /moby\/profiles seccomp\/v0\.2\.4/,
    );
  });

  it('по умолчанию — отказ (EPERM), как у moby', () => {
    expect(profile.defaultAction).toBe('SCMP_ACT_ERRNO');
    expect(profile.defaultErrnoRet).toBe(1);
    expect(verdict('no_such_syscall_for_test')).toBe('errno:1');
  });

  it('новые вызовы текущего умолчания moby разрешены (их не было в старом профиле)', () => {
    for (const n of [
      'close_range',
      'faccessat2',
      'openat2',
      'epoll_pwait2',
      'pidfd_open',
      'pidfd_send_signal',
      'pkey_alloc',
      'pkey_free',
      'pkey_mprotect',
      'landlock_create_ruleset',
      'landlock_add_rule',
      'landlock_restrict_self',
      'futex_waitv',
      'process_mrelease',
      'map_shadow_stack',
      'fchmodat2',
      'cachestat',
      'mseal',
    ]) {
      expect([n, verdict(n)]).toEqual([n, 'allow']);
    }
  });

  it('то, без чего не живут Chromium и Node: seccomp-bpf, prctl, memfd, futex, rseq, statx', () => {
    for (const n of [
      'seccomp',
      'prctl',
      'memfd_create',
      'futex',
      'rseq',
      'statx',
      'getrandom',
      'mmap',
      'mprotect',
      'madvise',
      'sendmsg',
      'recvmsg',
      'socketpair',
      'epoll_ctl',
      'execve',
      'wait4',
      'sched_getaffinity',
      'arch_prctl',
    ]) {
      expect([n, verdict(n)]).toEqual([n, 'allow']);
    }
  });

  it('clone3 — ENOSYS (glibc откатывается на clone), как у moby без CAP_SYS_ADMIN', () => {
    expect(verdict('clone3')).toBe('errno:38');
  });

  it('песочница Chromium: clone/unshare с user/pid/net — да; mount/uts/ipc/cgroup/time — нет', () => {
    // Потоки и обычный fork — как у moby.
    expect(verdict('clone', [THREAD])).toBe('allow');
    expect(verdict('clone', [SIGCHLD])).toBe('allow');
    // Зигота Chromium: NEWUSER|NEWPID|NEWNET.
    expect(
      verdict('clone', [CLONE_NEWUSER | CLONE_NEWPID | CLONE_NEWNET | SIGCHLD]),
    ).toBe('allow');
    expect(verdict('clone', [CLONE_NEWPID | SIGCHLD])).toBe('allow');
    expect(verdict('unshare', [CLONE_NEWUSER])).toBe('allow');
    for (const bad of [
      CLONE_NEWNS,
      CLONE_NEWUTS,
      CLONE_NEWIPC,
      CLONE_NEWCGROUP,
    ]) {
      expect(verdict('clone', [CLONE_NEWUSER | bad | SIGCHLD])).toBe('errno:1');
      expect(verdict('unshare', [CLONE_NEWUSER | bad])).toBe('errno:1');
    }
    expect(verdict('unshare', [CLONE_NEWTIME])).toBe('errno:1');
    // setns — только в user/pid/net; «любой тип» (0) и mount — нет.
    expect(verdict('setns', [3, CLONE_NEWUSER])).toBe('allow');
    expect(verdict('setns', [3, CLONE_NEWNET])).toBe('allow');
    expect(verdict('setns', [3, 0])).toBe('errno:1');
    expect(verdict('setns', [3, CLONE_NEWNS])).toBe('errno:1');
    // chroot песочницы в своём user namespace (при cap_drop: ALL).
    expect(verdict('chroot')).toBe('allow');
  });

  it('опасное — отказ при cap_drop: ALL (ptrace — строже moby)', () => {
    for (const n of [
      'ptrace',
      'process_vm_readv',
      'process_vm_writev',
      'kcmp',
      'pidfd_getfd',
      'kexec_load',
      'kexec_file_load',
      'bpf',
      'perf_event_open',
      'mount',
      'umount2',
      'pivot_root',
      'move_mount',
      'open_tree',
      'fsopen',
      'keyctl',
      'add_key',
      'request_key',
      'userfaultfd',
      'io_uring_setup',
      'io_uring_enter',
      'io_uring_register',
      'init_module',
      'finit_module',
      'delete_module',
      'open_by_handle_at',
      'reboot',
      'swapon',
      'acct',
      'settimeofday',
      'clock_settime',
      'iopl',
      'ioperm',
      'syslog',
      'vhangup',
      'lookup_dcookie',
      'quotactl',
      'sethostname',
      'setdomainname',
      'nfsservctl',
      'uselib',
      '_sysctl',
    ]) {
      expect([n, verdict(n)]).toEqual([n, 'errno:1']);
    }
  });

  it('socket — только unix/inet/inet6/netlink (AF_ALG, AF_VSOCK, AF_PACKET и редкие — нет)', () => {
    expect(verdict('socket', [1])).toBe('allow');
    expect(verdict('socket', [2])).toBe('allow');
    expect(verdict('socket', [10])).toBe('allow');
    expect(verdict('socket', [16])).toBe('allow');
    for (const fam of [17, 21, 29, 30, 38, 40, 41, 44]) {
      expect([fam, verdict('socket', [fam])]).toEqual([fam, 'errno:1']);
    }
  });

  it('personality — только безопасные значения (ADDR_NO_RANDOMIZE — нет)', () => {
    expect(verdict('personality', [0])).toBe('allow');
    expect(verdict('personality', [0x0040000])).toBe('errno:1');
  });

  it('compose: профиль подключён, все возможности сброшены (на этом стоит интерпретатор)', () => {
    const compose = readFileSync(
      join(__dirname, '../../docker-compose.yml'),
      'utf8',
    );
    expect(compose).toMatch(/seccomp=\.\/docker\/seccomp-chromium\.json/);
    expect(compose).toMatch(/cap_drop:\s*\n\s*-\s*ALL/);
    expect(compose).not.toMatch(/cap_add/);
    expect(compose).not.toMatch(/seccomp[:=]unconfined/);
  });

  it('интерпретатор не врёт: с CAP_SYS_ADMIN moby открыл бы mount', () => {
    expect(verdict('mount', [], ['CAP_SYS_ADMIN'])).toBe('allow');
    expect(verdict('ptrace', [], ['CAP_SYS_PTRACE'])).toBe('allow');
  });
});
