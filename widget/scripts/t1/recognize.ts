/**
 * Т-1, уровень «звук полный» (владелец): фикстуры `manifest.json` →
 * распознавание → WER и «смысл сохранён» по каждому файлу →
 * `recognized.json` (текст распознавания по ключу команды — его берёт
 * уровень «транскрипт» с `T1_RECOGNIZED=…/recognized.json`, чтобы
 * распознанный текст прошёл весь путь до стенда) и `wer.md`.
 *
 *   SONIOX_API_KEY=… npx tsx scripts/t1/recognize.ts --dir=test-results/t1-fixtures
 *   npx tsx scripts/t1/recognize.ts --dir=… --stt=mock    # CI: распознавание = текст фикстуры
 *
 * Soniox STT — асинхронный путь (формы — sites-backend/src/shared/soniox.ts):
 * файл → транскрипция → ожидание → текст → удаление файла и транскрипции.
 * Код по документации; ключа и сети в песочнице нет.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FixtureEntry, Manifest } from './synth';

/** Слова для WER: нижний регистр, ё→е, без пунктуации. */
export function words(s: string): string[] {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[’ʼ`´]/g, "'")
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** WER — расстояние Левенштейна по словам / длина эталона. */
export function wer(ref: string, hyp: string): number {
  const r = words(ref);
  const h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++)
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1)
      );
    prev = cur;
  }
  return prev[h.length] / r.length;
}

/**
 * «Смысл сохранён»: каждое содержательное слово эталона (≥ 4 букв) есть в
 * распознанном с точностью до окончания (общая основа: длина − 2, от 3 до 5
 * букв) — падежи и
 * опечатки распознавания не считаются потерей смысла; числа — точно.
 */
export function meaningKept(ref: string, hyp: string): boolean {
  const h = words(hyp);
  return words(ref)
    .filter((w) => w.length >= 4 || /^\d+$/.test(w))
    .every((w) => {
      if (/^\d+$/.test(w)) return h.includes(w);
      const n = Math.max(3, Math.min(5, w.length - 2));
      return h.some((x) => x.slice(0, n) === w.slice(0, n));
    });
}

export type Stt = (file: string, e: FixtureEntry) => Promise<string>;

export function sonioxStt(
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch
): Stt {
  const key = env.SONIOX_API_KEY?.trim();
  if (!key) throw new Error('SONIOX_API_KEY не задан');
  const base = 'https://api.soniox.com/v1';
  const auth = { Authorization: `Bearer ${key}` };
  const json = async (r: Response) => {
    if (!r.ok) throw new Error(`Soniox ответил ${r.status}`);
    return (await r.json()) as Record<string, unknown>;
  };
  return async (file, e) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([fs.readFileSync(file)], { type: 'audio/wav' }),
      path.basename(file)
    );
    const up = await json(
      await doFetch(`${base}/files`, {
        method: 'POST',
        headers: auth,
        body: form,
      })
    );
    const fileId = String(up.id);
    let trId = '';
    try {
      const tr = await json(
        await doFetch(`${base}/transcriptions`, {
          method: 'POST',
          headers: { ...auth, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'stt-async-v5',
            file_id: fileId,
            language_hints: e.lang ? [e.lang] : ['uk', 'ru', 'en'],
          }),
        })
      );
      trId = String(tr.id);
      for (let i = 0; i < 120; i++) {
        const s = await json(
          await doFetch(`${base}/transcriptions/${trId}`, { headers: auth })
        );
        if (s.status === 'completed') break;
        if (s.status === 'error')
          throw new Error('Soniox: ошибка распознавания');
        await new Promise((r) => setTimeout(r, 500));
      }
      const t = await json(
        await doFetch(`${base}/transcriptions/${trId}/transcript`, {
          headers: auth,
        })
      );
      return typeof t.text === 'string' ? t.text : '';
    } finally {
      if (trId)
        await doFetch(`${base}/transcriptions/${trId}`, {
          method: 'DELETE',
          headers: auth,
        }).catch(() => undefined);
      await doFetch(`${base}/files/${fileId}`, {
        method: 'DELETE',
        headers: auth,
      }).catch(() => undefined);
    }
  };
}

/** Мок CI: распознавание = текст фикстуры (шум — пусто). */
export const mockStt: Stt = async (_file, e) => e.text;

export interface WerRow {
  file: string;
  commandId: string | null;
  lang: string | null;
  snr: number | null;
  ref: string;
  hyp: string;
  wer: number;
  kept: boolean;
}

export async function recognizeAll(dir: string, stt: Stt): Promise<WerRow[]> {
  const m = JSON.parse(
    fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')
  ) as Manifest;
  const rows: WerRow[] = [];
  for (const e of m.entries) {
    const hyp = await stt(path.join(dir, e.file), e);
    rows.push({
      file: e.file,
      commandId: e.commandId,
      lang: e.lang,
      snr: e.snr,
      ref: e.text,
      hyp,
      wer: wer(e.text, hyp),
      kept:
        e.expect === 'none'
          ? words(hyp).length === 0 || !e.commandId
          : meaningKept(e.text, hyp),
    });
  }
  return rows;
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : undefined;
}

async function main() {
  const dir = path.resolve(
    arg('dir') || path.join('test-results', 't1-fixtures')
  );
  const stt = arg('stt') === 'mock' ? mockStt : sonioxStt();
  const rows = await recognizeAll(dir, stt);
  // Для уровня «транскрипт»: ключ — id.язык; берётся чистый файл первого голоса.
  const recognized: Record<string, string> = {};
  for (const r of rows)
    if (
      r.commandId &&
      r.snr === null &&
      !recognized[`${r.commandId}.${r.lang}`]
    )
      recognized[`${r.commandId}.${r.lang}`] = r.hyp;
  fs.writeFileSync(
    path.join(dir, 'recognized.json'),
    JSON.stringify(recognized, null, 2)
  );
  const groups = new Map<string, WerRow[]>();
  for (const r of rows.filter((x) => x.commandId)) {
    const k = r.snr === null ? 'чистый' : `SNR ${r.snr} дБ`;
    groups.set(k, [...(groups.get(k) || []), r]);
  }
  const md = [
    '# Т-1, уровень «звук полный»: распознавание',
    '',
    '| звук | файлов | средний WER | смысл сохранён |',
    '|---|---|---|---|',
    ...[...groups].map(([k, list]) => {
      const avg = list.reduce((a, r) => a + r.wer, 0) / list.length;
      const kept = list.filter((r) => r.kept).length;
      return `| ${k} | ${list.length} | ${(avg * 100).toFixed(1)}% | ${kept}/${list.length} |`;
    }),
    '',
    `Только шум: распознан текст в ${rows.filter((r) => !r.commandId && words(r.hyp).length).length} из ${rows.filter((r) => !r.commandId).length} (план при этом не строится, если текст — не команда).`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'wer.md'), md);
  console.log(md);
}

if (
  process.argv[1] &&
  path
    .resolve(process.argv[1])
    .endsWith(path.join('scripts', 't1', 'recognize.ts'))
) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
