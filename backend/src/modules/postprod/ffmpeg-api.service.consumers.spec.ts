/**
 * Инвентаризация потребителей `FfmpegApiService` (ТЗ FFmpeg-server v1.1
 * §2.1: «поиск только `this.ffmpeg` неполон — инвентаризировать
 * инъекции и другие имена клиента»).
 *
 * Тест читает исходники: находит каждый файл, куда инжектится
 * `FfmpegApiService` под ЛЮБЫМ именем поля, и каждый вызов `.submit(`
 * на этом поле. У каждого вызова обязан быть `product: '<продукт>'` из
 * `FFMPEG_PRODUCTS` — иначе canary по продукту и вкладка «FFmpeg» его не
 * увидят. Новый потребитель без `product` или не внесённый в перечень
 * ниже роняет тест.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { FFMPEG_PRODUCTS } from './ffmpeg-api.service';

const SRC = join(__dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.spec.ts')) out.push(p);
  }
  return out;
}

/** Текст аргументов вызова от открывающей скобки до парной. */
function callArgs(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  throw new Error('незакрытый вызов submit(');
}

interface Site {
  file: string;
  field: string;
  product: string | null;
  operationKey: boolean;
}

function inventory(): { injected: Map<string, string[]>; sites: Site[] } {
  const injected = new Map<string, string[]>();
  const sites: Site[] = [];
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file);
    if (rel === join('modules', 'postprod', 'ffmpeg-api.service.ts')) continue;
    const text = readFileSync(file, 'utf8');
    const fields = [
      ...text.matchAll(/(\w+)\??\s*:\s*FfmpegApiService\b(?!\[)/g),
    ].map((m) => m[1]);
    if (fields.length === 0) continue;
    injected.set(rel, fields);
    for (const field of fields) {
      const re = new RegExp(
        `this\\.${field}(?:\\s+as\\s+FfmpegApiService\\))?\\s*\\.submit\\(`,
        'g',
      );
      for (const m of text.matchAll(re)) {
        const args = callArgs(text, m.index + m[0].length - 1);
        const product = /\bproduct:\s*'([a-z-]+)'/.exec(args)?.[1] ?? null;
        sites.push({
          file: rel,
          field,
          product,
          operationKey: /\boperationKey:/.test(args),
        });
      }
    }
  }
  return { injected, sites };
}

describe('потребители FfmpegApiService — product у каждого submit', () => {
  const { injected, sites } = inventory();

  it('инъекции найдены под разными именами полей (не только this.ffmpeg)', () => {
    const names = new Set([...injected.values()].flat());
    expect(names).toEqual(new Set(['ffmpeg', 'api']));
  });

  it('у каждого вызова submit есть product из FFMPEG_PRODUCTS', () => {
    const missing = sites.filter(
      (s) =>
        !s.product ||
        !(FFMPEG_PRODUCTS as readonly string[]).includes(s.product),
    );
    expect(missing).toEqual([]);
  });

  it('перечень вызовов совпадает с инвентаризацией (новый потребитель — осознанно)', () => {
    const byFile: Record<string, string[]> = {};
    for (const s of sites)
      (byFile[s.file.split(/[\\/]/).pop()!] ??= []).push(s.product!);
    expect(byFile).toEqual({
      'actors.service.ts': ['actors'],
      'portfolio-watermark.service.ts': ['portfolio'],
      'client-site-tutorial-admin.service.ts': [
        'client-site-tutorial',
        'client-site-tutorial',
      ],
      'audio-track.service.ts': ['audio-track'],
      'tutorial-scenario-runner.service.ts': ['tutorial-runner'],
      'shared-video-poster.service.ts': ['shared-video'],
      'postprod.service.ts': ['postprod', 'postprod', 'postprod'],
      'tutorial-video-versions.service.ts': ['tutorial-video-versions'],
      'story-video.service.ts': ['story'],
      'demo-quality.service.ts': ['tutorial-quality'],
    });
  });

  it('каждый продукт из FFMPEG_PRODUCTS кем-то используется', () => {
    const used = new Set(sites.map((s) => s.product));
    expect(FFMPEG_PRODUCTS.filter((p) => !used.has(p))).toEqual([]);
  });

  it('стабильный ключ операции — только там, где одна строка = одна попытка', () => {
    const keyed = sites
      .filter((s) => s.operationKey)
      .map((s) => `${s.file.split(/[\\/]/).pop()}:${s.product}`)
      .sort();
    expect(keyed).toEqual(
      [
        'client-site-tutorial-admin.service.ts:client-site-tutorial',
        'client-site-tutorial-admin.service.ts:client-site-tutorial',
        'story-video.service.ts:story',
        'tutorial-scenario-runner.service.ts:tutorial-runner',
        'tutorial-video-versions.service.ts:tutorial-video-versions',
      ].sort(),
    );
  });

  it('вкладка «FFmpeg» не создаёт задач: в ffmpeg-admin нет submit', () => {
    const dir = join(SRC, 'modules', 'ffmpeg-admin');
    for (const file of walk(dir))
      expect(readFileSync(file, 'utf8')).not.toMatch(/\.submit\(/);
  });

  it('колонки jobId в Prisma — text, без @db.VarChar (id selfhosted:<uuid> не обрежется)', () => {
    const schema = readFileSync(
      join(SRC, '..', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const jobCols = schema
      .split('\n')
      .filter((l) => /^\s+\w*[jJ]obId\s+String/.test(l));
    expect(jobCols.length).toBeGreaterThanOrEqual(8);
    expect(jobCols.filter((l) => /@db\.VarChar|@db\.Char/.test(l))).toEqual([]);
  });
});
