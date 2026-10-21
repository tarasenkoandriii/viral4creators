/**
 * Файловые операции сервера с жёсткими границами: удаление — только
 * внутри заданного корня и не сам корень, без следования symlink.
 */
import { promises as fsp, statfsSync } from 'node:fs';
import path from 'node:path';

export function isInside(root: string, p: string): boolean {
  const r = path.resolve(root);
  const x = path.resolve(p);
  return x !== r && x.startsWith(r + path.sep);
}

/** Рекурсивное удаление `p` строго внутри `root`. Отсутствие — не ошибка. */
export async function safeRemove(root: string, p: string): Promise<void> {
  if (!isInside(root, p)) {
    throw new Error('safeRemove: путь вне корня');
  }
  // fs.rm не следует по symlink внутри дерева — удаляет сами ссылки.
  await fsp.rm(path.resolve(p), { recursive: true, force: true });
}

/** Суммарный размер обычных файлов (symlink не считаются и не обходятся). */
export async function dirSize(p: string): Promise<number> {
  let total = 0;
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(p, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) {
      try {
        total += (await fsp.lstat(full)).size;
      } catch {
        /* исчез между readdir и lstat */
      }
    }
  }
  return total;
}

/** rename, а между файловыми системами — копия + удаление. */
export async function moveFile(src: string, dst: string): Promise<void> {
  try {
    await fsp.rename(src, dst);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    await fsp.copyFile(src, dst);
    await fsp.unlink(src);
  }
}

export function diskFreeBytes(p: string): number | null {
  try {
    const s = statfsSync(p);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

export async function fsyncDir(dir: string): Promise<void> {
  try {
    const fh = await fsp.open(dir, 'r');
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch {
    /* не все ФС поддерживают fsync каталога */
  }
}
