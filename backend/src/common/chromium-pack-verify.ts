/**
 * П-Г3 (docs-tz/SECURITY-PROPOSALS): проверка SHA-256 архива Chromium,
 * который `headless-chromium.ts` качает на холодном инстансе.
 *
 * Без проверки `@sparticuz/chromium-min` распаковывает и запускает ЛЮБОЙ
 * tar по `CHROMIUM_PACK_URL` (или по прибитому адресу GitHub-релиза): подмена
 * релиза, зеркала или ответа по пути — это чужой бинарник в функции бэкенда
 * со всеми её секретами. С `CHROMIUM_PACK_SHA256` архив качается здесь,
 * хеш считается по скачанному, и только совпавший архив распаковывается в
 * `/tmp/chromium-pack` — библиотеке дальше отдаётся папка, а не URL.
 *
 * Не задан — работа как раньше (прод не ломается), предупреждение в лог
 * один раз за инстанс. Задан неверно (не 64 hex) — отказ: оператор хотел
 * проверку, молча её пропустить нельзя.
 *
 * Распаковка — своим минимальным разбором ustar: только обычные файлы и
 * папки, пути без `..` и без абсолютных, внутри папки назначения; ссылки и
 * прочие типы — отказ (в архиве Chromium их нет).
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, posix, resolve, sep } from 'node:path';

export const PACK_SHA256_ENV = 'CHROMIUM_PACK_SHA256';
/** Реальный архив — ~65 МБ; потолок — от мусора без конца. */
export const MAX_PACK_BYTES = 200 * 1024 * 1024;

export type ExpectedSha =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'sha256'; value: string };

export function expectedPackSha256(env: NodeJS.ProcessEnv): ExpectedSha {
  const raw = env[PACK_SHA256_ENV]?.trim();
  if (!raw) return { kind: 'none' };
  return /^[0-9a-fA-F]{64}$/.test(raw)
    ? { kind: 'sha256', value: raw.toLowerCase() }
    : { kind: 'invalid' };
}

export type VerifyResult =
  | { ok: true; sha256: string; files: number }
  | { ok: false; diagnostic: string };

const short = (h: string) => `${h.slice(0, 12)}…`;

/** Скачать архив целиком, посчитать SHA-256, сверить и распаковать. */
export async function downloadVerifiedPack(opts: {
  url: string;
  expectedSha256: string;
  destDir: string;
  timeoutMs: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}): Promise<VerifyResult> {
  const max = opts.maxBytes ?? MAX_PACK_BYTES;
  const f = opts.fetchImpl ?? fetch;
  let tar: Buffer;
  let actual: string;
  try {
    const res = await f(opts.url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok || !res.body) {
      return {
        ok: false,
        diagnostic: `архив Chromium не скачался: HTTP ${res.status}`,
      };
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          diagnostic: `архив Chromium больше ${Math.round(max / 1e6)} МБ — не распаковывается`,
        };
      }
      const b = Buffer.from(value);
      hash.update(b);
      chunks.push(b);
    }
    tar = Buffer.concat(chunks, total);
    actual = hash.digest('hex');
  } catch (err) {
    return {
      ok: false,
      diagnostic: `архив Chromium не скачался: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (actual !== opts.expectedSha256) {
    return {
      ok: false,
      diagnostic: `архив Chromium не прошёл проверку SHA-256 (${PACK_SHA256_ENV}: ожидали ${short(opts.expectedSha256)}, получили ${short(actual)}) — браузер не запускается; проверьте CHROMIUM_PACK_URL и хеш релиза`,
    };
  }
  try {
    const files = await extractTar(tar, opts.destDir);
    return { ok: true, sha256: actual, files };
  } catch (err) {
    await rm(opts.destDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
    return {
      ok: false,
      diagnostic: `архив Chromium с верным хешем не распаковался: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function field(h: Buffer, start: number, len: number): string {
  const s = h.subarray(start, start + len).toString('utf8');
  const nul = s.indexOf('\0');
  return nul >= 0 ? s.slice(0, nul) : s;
}

/** Безопасный путь записи внутри `destDir` (или ошибка). */
export function safeEntryPath(destDir: string, name: string): string {
  if (!name || name.includes('\0') || name.startsWith('/')) {
    throw new Error(`недопустимое имя в архиве: ${JSON.stringify(name)}`);
  }
  const norm = posix.normalize(name);
  if (
    norm === '..' ||
    norm.startsWith('../') ||
    norm.split('/').includes('..')
  ) {
    throw new Error(`путь вне папки в архиве: ${JSON.stringify(name)}`);
  }
  const root = resolve(destDir);
  const out = resolve(root, norm);
  if (out !== root && !out.startsWith(root + sep)) {
    throw new Error(`путь вне папки в архиве: ${JSON.stringify(name)}`);
  }
  return out;
}

/** Минимальная распаковка ustar/GNU tar (файлы и папки). Возвращает число файлов. */
export async function extractTar(
  tar: Buffer,
  destDir: string,
): Promise<number> {
  await mkdir(destDir, { recursive: true });
  let off = 0;
  let files = 0;
  let longName: string | null = null;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const sizeRaw = field(h, 124, 12).trim();
    const size = sizeRaw ? parseInt(sizeRaw, 8) : 0;
    if (!Number.isFinite(size) || size < 0) {
      throw new Error('повреждённый заголовок tar');
    }
    const type = String.fromCharCode(h[156] || 0x30);
    const dataStart = off + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('обрезанный tar');
    const prefix = field(h, 257, 6).startsWith('ustar')
      ? field(h, 345, 155)
      : '';
    const base = field(h, 0, 100);
    const name = longName ?? (prefix ? `${prefix}/${base}` : base);
    longName = null;
    if (type === 'L') {
      longName = field(tar.subarray(dataStart, dataEnd), 0, size);
    } else if (type === 'x' || type === 'g') {
      // pax-заголовки: метаданные (время, владелец) — не нужны.
    } else if (type === '5') {
      await mkdir(safeEntryPath(destDir, name), { recursive: true });
    } else if (type === '0' || type === '\0' || type === '7') {
      const target = safeEntryPath(destDir, name);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, tar.subarray(dataStart, dataEnd));
      files += 1;
    } else {
      throw new Error(`тип записи tar «${type}» не поддерживается (${name})`);
    }
    off = dataStart + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** Для тестов: tar из пар «имя → содержимое» (ustar, обычные файлы). */
export function buildTarForTests(
  entries: Array<{ name: string; data: Buffer; type?: string }>,
): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100, 'utf8');
    h.write('0000644\0', 100, 'latin1');
    h.write('0000000\0', 108, 'latin1');
    h.write('0000000\0', 116, 'latin1');
    h.write(e.data.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    h.write('00000000000\0', 136, 'latin1');
    h.write(e.type ?? '0', 156, 'latin1');
    h.write('ustar\0', 257, 'latin1');
    h.write('00', 263, 'latin1');
    h.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    parts.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}
