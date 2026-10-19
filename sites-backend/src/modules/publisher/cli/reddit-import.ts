/**
 * AI Publisher, P-R — CLI импорта чернового исследования Reddit в раздел
 * «Reddit» продукта через HTTP API кабинета (reddit-manual-mvp-adapted.md
 * §8.1 «Импорт», Р-RD-87; план и выполнение — `reddit/research-import.ts`).
 *
 *   cd sites-backend
 *   # план (по умолчанию — dry-run: ничего не пишет; без --base-url — офлайн)
 *   npm run reddit:import -- --dir=<каталог CSV> --project-title="Pilot research" \
 *     --locale=en --market="US/EU SMB+SaaS" [--segments=smb,saas,agency] \
 *     [--base-url=https://api.example --site=<siteId> | --product=<productId>]
 *   # запись — тот же вызов с --apply (повторный запуск дублей не создаёт)
 *   PUB_REDDIT_IMPORT_HEADERS='{"Cookie":"…","Origin":"https://…","X-Telegram-App":"assist","X-Site-Account":"…"}' \
 *     npm run reddit:import -- … --apply [--out=report.json]
 *
 * Авторизация — ТОЛЬКО переменная окружения `PUB_REDDIT_IMPORT_HEADERS`
 * (JSON-объект или строки `Имя: значение`) с готовыми заголовками сессии
 * владельца продукта: в аргументах секретов нет, значения заголовков не
 * печатаются (в выводе — только имена). Запросы идут только на `--base-url`
 * и только по путям `/publisher/…`; адреса Reddit запрещены (`reddit.com`,
 * `redd.it`) — к Reddit инструмент не обращается.
 *
 * Код выхода: 0 — план/импорт выполнен (отказы отдельных строк — в отчёте),
 * 1 — ошибка аргументов, доступа или раздела.
 */
/* eslint-disable no-console */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  buildImportPlan,
  ImportError,
  offlineReport,
  CsvError,
  parseCsv,
  runImport,
  type ImportHttp,
  type ImportReport,
  type ImportResponse,
  type ResearchSegment,
} from '../reddit/research-import';

export const AUTH_ENV = 'PUB_REDDIT_IMPORT_HEADERS';

export interface ImportArgs {
  baseUrl: string | null;
  site: string | null;
  product: string | null;
  projectTitle: string;
  locale: string;
  market: string;
  dir: string;
  segments: string[] | null;
  apply: boolean;
  out: string | null;
}

/** Аргументы `--ключ=значение` / `--ключ значение`; `--apply` — флаг. */
export function parseArgs(argv: string[]): ImportArgs {
  const v: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`неизвестный аргумент: ${a}`);
    const eq = a.indexOf('=');
    if (eq > 0) v[a.slice(2, eq)] = a.slice(eq + 1);
    else if (['apply', 'dry-run'].includes(a.slice(2))) v[a.slice(2)] = true;
    else v[a.slice(2)] = argv[++i] ?? '';
  }
  const known = [
    'base-url',
    'site',
    'product',
    'project-title',
    'locale',
    'market',
    'dir',
    'segments',
    'apply',
    'dry-run',
    'out',
  ];
  for (const k of Object.keys(v))
    if (!known.includes(k)) throw new Error(`неизвестный аргумент: --${k}`);
  const str = (k: string): string | null =>
    typeof v[k] === 'string' && (v[k] as string).trim() !== ''
      ? (v[k] as string).trim()
      : null;
  if (v.apply && v['dry-run'])
    throw new Error('--apply и --dry-run одновременно');
  const projectTitle = str('project-title');
  if (!projectTitle) throw new Error('нужен --project-title');
  const baseUrl = str('base-url');
  if (baseUrl) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new Error('--base-url: не URL');
    }
    if (!/^https?:$/.test(u.protocol)) throw new Error('--base-url: http(s)');
    if (u.username || u.password || u.search || u.hash)
      throw new Error('--base-url: credentials, query и fragment запрещены');
    if (
      /(^|\.)(reddit\.com|redd\.it|redditmedia\.com|redditstatic\.com)$/i.test(
        u.hostname.replace(/\.+$/, ''),
      )
    )
      throw new Error('--base-url: адреса Reddit запрещены (MANUAL_COPY)');
  }
  const site = str('site');
  const product = str('product');
  if (site && product) throw new Error('--site или --product, не оба');
  if (baseUrl && !site && !product)
    throw new Error('нужен --site или --product');
  if (v.apply && !baseUrl) throw new Error('--apply требует --base-url');
  return {
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    site,
    product,
    projectTitle,
    locale: str('locale') ?? 'en',
    market: str('market') ?? 'global',
    dir: str('dir') ?? '.',
    segments:
      str('segments')
        ?.split(',')
        .map((x) => x.trim()) ?? null,
    apply: v.apply === true,
    out: str('out'),
  };
}

/**
 * Заголовки сессии из переменной окружения: JSON-объект или строки
 * `Имя: значение`. Имена — `[A-Za-z0-9-]`, значения — без переводов строк.
 */
export function parseAuthHeaders(
  raw: string | undefined,
): Record<string, string> {
  if (!raw || !raw.trim()) return {};
  let obj: Record<string, unknown>;
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      throw new Error(`${AUTH_ENV}: не JSON`);
    }
  } else {
    obj = {};
    for (const line of t.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const i = line.indexOf(':');
      if (i <= 0) throw new Error(`${AUTH_ENV}: строка без «Имя: значение»`);
      obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj)) {
    if (
      !/^[A-Za-z0-9-]{1,64}$/.test(k) ||
      typeof x !== 'string' ||
      /[\r\n]/.test(x)
    )
      throw new Error(`${AUTH_ENV}: недопустимый заголовок`);
    out[k] = x;
  }
  return out;
}

/**
 * Отказ чтения CSV исследования: имя файла (только `<сегмент>-<вид>.csv`,
 * сегмент — `[a-z0-9_]`), строка (1-based, если известна) и причина.
 * Содержимого файла в тексте нет: в CSV бывают контакты и ники.
 */
export class CsvFileError extends Error {
  constructor(
    readonly file: string,
    readonly line: number | null,
    readonly reason: string,
  ) {
    super(
      `Ошибка чтения CSV: ${file}${line !== null ? `, строка ${line}` : ''}: ${reason}`,
    );
    this.name = 'CsvFileError';
  }
}

/** Сегменты из каталога: `<сегмент>-communities.csv` (+ opportunities, keywords). */
export function loadSegments(
  dir: string,
  only: string[] | null,
): ResearchSegment[] {
  const names = readdirSync(dir)
    .map((f) => /^([a-z0-9_]+)-communities\.csv$/i.exec(f)?.[1])
    .filter((x): x is string => !!x)
    .filter((s) => !only || only.includes(s))
    .sort();
  const read = (seg: string, kind: string) => {
    const file = `${seg}-${kind}.csv`;
    let text: string;
    try {
      text = readFileSync(join(dir, file), 'utf8');
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (kind !== 'communities' && code === 'ENOENT') return [];
      throw new CsvFileError(file, null, `не читается (${code ?? 'ошибка'})`);
    }
    try {
      return parseCsv(text);
    } catch (e) {
      // IA-C-04: файл, строка и причина; содержимое строки — никогда.
      if (e instanceof CsvError) throw new CsvFileError(file, e.line, e.reason);
      throw new CsvFileError(file, null, 'неверный формат');
    }
  };
  return names.map((segment) => ({
    segment,
    communities: read(segment, 'communities'),
    opportunities: read(segment, 'opportunities'),
    keywords: read(segment, 'keywords'),
  }));
}

/** HTTP к API кабинета: только `baseUrl` + `/publisher/…`, JSON. */
export function cabinetHttp(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): ImportHttp {
  const call = async (
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<ImportResponse> => {
    if (!path.startsWith('/publisher/'))
      throw new Error(`путь вне API кабинета: ${path}`);
    const r = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers: {
        ...headers,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    let parsed: ImportResponse['body'] = null;
    try {
      parsed = (await r.json()) as ImportResponse['body'];
    } catch {
      parsed = null;
    }
    return { status: r.status, body: parsed };
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

/** Текстовый отчёт (без значений заголовков и без тел ответов). */
export function formatReport(r: ImportReport): string {
  const lines: string[] = [
    `Імпорт дослідження Reddit — ${r.apply ? 'ЗАПИС' : 'dry-run (нічого не записано)'}; продукт ${r.productId}`,
    '',
    'Підсумок:',
  ];
  for (const [kind, s] of Object.entries(r.summary))
    lines.push(
      `  ${kind}: ${Object.entries(s)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`,
    );
  if (!r.complete)
    lines.push(
      '',
      r.stoppedBy === 'deadline'
        ? 'НЕ ЗАВЕРШЕНО: вичерпано час запиту — решту не виконано (not_attempted); повторіть той самий імпорт, створене стане «вже є».'
        : 'НЕ ЗАВЕРШЕНО: проєкт не створено — решту не виконано (not_attempted); виправте назву/ринок проєкту і повторіть.',
    );
  lines.push('', 'BLOCK за правилами (знімки імпортуються unreviewed):');
  for (const b of r.blocks)
    lines.push(
      `  r/${b.subreddit}: зараз ${b.now.join('+') || 'ok'}; після перевірки власником — ${b.afterReview.join('+') || 'ok'}${b.firstHandSource ? '' : ' (першоджерела немає — перевірка лише після нового знімка з посиланням на правила)'}`,
    );
  const kept = r.items.filter(
    (i) => i.code === 'kept_current' && /differs/.test(i.detail ?? ''),
  );
  if (kept.length) {
    lines.push('', 'Правила: поточний знімок збережено, CSV відрізняється:');
    for (const i of kept) lines.push(`  ${i.ref}: ${i.detail}`);
  }
  if (r.warnings?.length) {
    lines.push('', 'Попередження (записано не дослівно):');
    for (const w of r.warnings)
      lines.push(
        `  ${w.kind} ${w.ref}: ${w.code}${w.field ? ` [${w.field}]` : ''}${w.detail ? ` (${w.detail})` : ''}`,
      );
  }
  const bad = r.items.filter((i) => i.outcome === 'rejected');
  if (bad.length) {
    lines.push('', 'Відхилено:');
    for (const i of bad)
      lines.push(
        `  ${i.kind} ${i.ref}: ${i.code ?? '?'}${i.detail ? ` (${i.detail})` : ''}`,
      );
  }
  return lines.join('\n');
}

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ code: number; report: ImportReport | null }> {
  let args: ImportArgs;
  let headers: Record<string, string>;
  try {
    args = parseArgs(argv);
    headers = parseAuthHeaders(env[AUTH_ENV]);
  } catch (e) {
    console.error((e as Error).message);
    return { code: 1, report: null };
  }
  let segments: ResearchSegment[];
  try {
    segments = loadSegments(args.dir, args.segments);
  } catch (e) {
    // IA-C-04: «файл, строка: причина»; каталог не читается — общий текст.
    console.error(
      e instanceof CsvFileError
        ? e.message
        : 'Ошибка чтения CSV: проверьте доступ к каталогу и формат файлов',
    );
    return { code: 1, report: null };
  }
  if (!segments.length) {
    console.error(`у ${args.dir} немає файлів <сегмент>-communities.csv`);
    return { code: 1, report: null };
  }
  const plan = buildImportPlan(segments, {
    projectTitle: args.projectTitle,
    locale: args.locale,
    market: args.market,
    now: new Date(),
  });
  let report: ImportReport;
  if (!args.baseUrl) report = offlineReport(plan);
  else {
    if (!Object.keys(headers).length) {
      console.error(`${AUTH_ENV}: не задано (заголовки сесії власника)`);
      return { code: 1, report: null };
    }
    console.log(`Заголовки сесії: ${Object.keys(headers).join(', ')}`);
    const http = cabinetHttp(args.baseUrl, headers, fetchImpl);
    try {
      let pid = args.product;
      if (!pid) {
        const r = await http.get(
          `/publisher/sites/${encodeURIComponent(args.site!)}/product`,
        );
        if (r.status !== 200) throw new ImportError('site product', r);
        pid = (r.body?.data as { id: string }).id;
      }
      report = await runImport(http, pid, plan, args.apply);
    } catch (e) {
      console.error(
        e instanceof ImportError
          ? `доступ або розділ: ${e.message}`
          : `помилка: ${(e as Error).message}`,
      );
      return { code: 1, report: null };
    }
  }
  console.log(formatReport(report));
  if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2));
  return { code: 0, report };
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((r) => process.exit(r.code));
}
