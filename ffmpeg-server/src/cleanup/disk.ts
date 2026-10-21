/**
 * Пороги диска (ТЗ §9): свободно <15 GiB — новые задачи не принимаются;
 * workspaces вместе ≤15 GiB, outputs вместе ≤10 GiB. Для активной задачи
 * workspace резервируется заранее: claim только если влезает
 * maxWorkspaceBytes. Снимок обновляется периодически (обход каталогов —
 * не на каждом запросе).
 */
import type { ServerConfig } from '../config';
import { dirSize, diskFreeBytes } from '../files/fsutil';

export interface DiskSnapshot {
  at: number;
  freeBytes: number | null;
  workspacesBytes: number;
  outputsBytes: number;
}

export class DiskMonitor {
  private snap: DiskSnapshot = {
    at: 0,
    freeBytes: null,
    workspacesBytes: 0,
    outputsBytes: 0,
  };
  private refreshing: Promise<DiskSnapshot> | null = null;

  constructor(private readonly cfg: ServerConfig) {}

  get snapshot(): DiskSnapshot {
    return this.snap;
  }

  /** Свободное место — минимум по всем трём томам. */
  freeNow(): number | null {
    const vals = [
      this.cfg.dataDir,
      this.cfg.workspaceRoot,
      this.cfg.outputsRoot,
    ]
      .map((p) => diskFreeBytes(p))
      .filter((v): v is number => v !== null);
    return vals.length ? Math.min(...vals) : null;
  }

  async refresh(): Promise<DiskSnapshot> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      const [ws, out] = await Promise.all([
        dirSize(this.cfg.workspaceRoot),
        dirSize(this.cfg.outputsRoot),
      ]);
      this.snap = {
        at: Date.now(),
        freeBytes: this.freeNow(),
        workspacesBytes: ws,
        outputsBytes: out,
      };
      return this.snap;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Приём новых задач: свободного места не меньше порога. */
  acceptsNew(): { ok: boolean; reason?: string } {
    const free = this.freeNow();
    if (free === null) return { ok: false, reason: 'disk_unknown' };
    if (free < this.cfg.disk.minFreeBytes) {
      return { ok: false, reason: 'disk_low' };
    }
    return { ok: true };
  }

  /** Можно ли забрать задачу: резерв workspace и место под outputs. */
  async canClaim(
    maxWorkspaceBytes: number,
    maxOutputBytes: number,
  ): Promise<{ ok: boolean; reason?: string }> {
    const s = await this.refresh();
    if (
      s.workspacesBytes + maxWorkspaceBytes >
      this.cfg.disk.maxWorkspacesBytes
    ) {
      return { ok: false, reason: 'workspaces_quota' };
    }
    if (s.outputsBytes + maxOutputBytes > this.cfg.disk.maxOutputsBytes) {
      return { ok: false, reason: 'outputs_quota' };
    }
    if (s.freeBytes !== null && s.freeBytes < maxWorkspaceBytes) {
      return { ok: false, reason: 'disk_low' };
    }
    return { ok: true };
  }
}
