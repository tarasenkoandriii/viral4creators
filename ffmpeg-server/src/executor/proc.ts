/**
 * Процессы и ресурсы (Linux /proc): группа процессов, её завершение,
 * CPU/RSS ребёнка, признаки OOM в cgroup v2.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

const CLK_TCK = 100;

export interface ProcSample {
  cpuMs: number;
  peakRssKb: number | null;
  /** Текущий VmRSS, кБ. */
  rssKb: number | null;
  startTime: number;
}

/** CPU (utime+stime) и VmHWM процесса; null — процесса нет. */
export async function sampleProc(pid: number): Promise<ProcSample | null> {
  try {
    const stat = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
    // Поле comm в скобках может содержать пробелы — режем после ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // rest[0] — state (поле 3); utime/stime — поля 14/15; starttime — 22.
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const startTime = Number(rest[19]);
    let peak: number | null = null;
    let rss: number | null = null;
    try {
      const status = await fsp.readFile(`/proc/${pid}/status`, 'utf8');
      const m = /VmHWM:\s+(\d+)\s+kB/.exec(status);
      if (m) peak = Number(m[1]);
      const r = /VmRSS:\s+(\d+)\s+kB/.exec(status);
      if (r) rss = Number(r[1]);
    } catch {
      /* процесс завершился между чтениями */
    }
    return {
      cpuMs: ((utime + stime) * 1000) / CLK_TCK,
      peakRssKb: peak,
      rssKb: rss,
      startTime,
    };
  } catch {
    return null;
  }
}

/** Живые (не зомби) процессы группы pgid по /proc. */
export async function groupMembers(pgid: number): Promise<number[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return groupAliveBySignal(pgid) ? [pgid] : [];
  }
  const out: number[] = [];
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const stat = await fsp.readFile(path.join('/proc', e, 'stat'), 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const state = rest[0];
      const pgrp = Number(rest[2]);
      if (pgrp === pgid && state !== 'Z' && state !== 'X') out.push(Number(e));
    } catch {
      /* исчез */
    }
  }
  return out;
}

function groupAliveBySignal(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * SIGKILL всей группе и ожидание, пока в ней не останется живых
 * процессов. true — подтверждено, false — не удалось за timeoutMs.
 */
export async function killGroup(
  pgid: number,
  timeoutMs = 5000,
): Promise<boolean> {
  if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) return true;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      /* ESRCH — уже нет */
    }
    const alive = await groupMembers(pgid);
    if (alive.length === 0) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Счётчик oom_kill cgroup v2 текущего контейнера; null — недоступен. */
export async function readOomKillCount(): Promise<number | null> {
  try {
    const cg = (await fsp.readFile('/proc/self/cgroup', 'utf8')).trim();
    const rel = /^0::(.*)$/m.exec(cg)?.[1] ?? '/';
    const file = path.join('/sys/fs/cgroup', rel, 'memory.events');
    const txt = await fsp.readFile(file, 'utf8');
    const m = /^oom_kill (\d+)$/m.exec(txt);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Суммарный размер файлов в каталогах (без перехода по symlink). */
export async function dirBytes(dirs: string[]): Promise<number> {
  let total = 0;
  const walk = async (d: string): Promise<void> => {
    let list: import('node:fs').Dirent[];
    try {
      list = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        await walk(p);
      } else {
        try {
          const st = await fsp.lstat(p);
          total += Math.max(st.size, st.blocks * 512);
        } catch {
          /* исчез */
        }
      }
    }
  };
  for (const d of dirs) await walk(d);
  return total;
}
