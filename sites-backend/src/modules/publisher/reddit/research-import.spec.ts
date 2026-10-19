/**
 * P-R — импорт чернового исследования (Р-RD-87): разбор CSV, план записей
 * (правила из вторичных источников — unreviewed с пометкой «secondary»,
 * только валидные треды, факторы и обоснования из CSV, все запросы),
 * очистка текстов от контактов, детерминированный `opKey`, аргументы CLI и
 * заголовки сессии из окружения (значения не попадают в ошибки).
 */
import { createHash } from 'crypto';
import { OP_KEY_RE } from '../contracts/common';
import { looksLikeContact } from '../core/pii-guard';
import {
  AUTH_ENV,
  formatReport,
  parseArgs,
  parseAuthHeaders,
} from '../cli/reddit-import';
import {
  buildImportPlan,
  offlineReport,
  CsvError,
  parseCsv,
  parseFlair,
  parseWhy,
  runImport,
  safeText,
  splitConditions,
  stableOpKey,
  type ImportHttp,
  type ResearchSegment,
} from './research-import';

const NOW = new Date('2026-10-14T10:00:00Z');

const COMMUNITIES = `name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at
r/SaaS,https://www.reddit.com/r/SaaS/,"SaaS founders, ""growth""",null,allowed_with_conditions,restricted,false,"Promo only in weekly thread; 10:1 ratio","https://www.reddit.com/r/SaaS/about/rules (not readable); hint: https://www.indiehackers.com/post/list-of-subreddits-72c1129428",2026-10-13
r/smallbusiness,https://www.reddit.com/r/smallbusiness/,Owners,null,unknown,unknown,null,No readable source,https://www.reddit.com/r/smallbusiness/about/rules (not readable),2026-10-13
not a sub!,https://example.com/,x,null,unknown,unknown,null,,,2026-10-13
`;
const OPPS = `id,url,title,subreddit,context,intent,date,topic_fit,intent_fit,audience_fit,answerability,promotionality,evidence_gap,context_uncertainty,policy_risk,relevance,risk,priority,gate,gate_reason,why,found_via,checked_at,kind
O1,https://www.reddit.com/r/SaaS/comments/1k302zp/chatbase_vs_sitegpt/?utm_source=x,"Chatbase vs SiteGPT",r/SaaS,"Buyer comparing bots.",comparison,unknown,90,85,80,80,55,70,75,50,85,59,35,PASS,OK,"tf: direct; itf: comparison; af: buyers; prom: medium",x,2026-10-13,thread
O2,https://www.reddit.com/r/SaaS/,New post,r/SaaS,ctx,other,n/a,75,70,60,70,30,60,60,20,70,36,45,PASS,OK,tf: pilot,x,2026-10-13,new_post
O3,https://www.reddit.com/r/Other/comments/abc123/x/,Other,r/Other,ctx,how_to,n/a,50,50,50,50,50,50,50,50,50,50,50,PASS,OK,,x,2026-10-13,thread
O4,https://old.reddit.com/r/SaaS/comments/1k302zp/dup/,Dup,r/SaaS,ctx,weird_intent,n/a,,,,,,,,,,,,PASS,OK,,x,2026-10-13,thread
`;
const KEYWORDS = `phrase,intent,priority
AI chatbot for SaaS,recommendation,5
ai  chatbot for saas,comparison,4
Tidio vs Intercom,comparison,9
`;

function seg(segment: string, k = KEYWORDS): ResearchSegment {
  return {
    segment,
    communities: parseCsv(COMMUNITIES),
    opportunities: parseCsv(OPPS),
    keywords: parseCsv(k),
  };
}

describe('research-import: CSV и план (Р-RD-87)', () => {
  it('CSV: кавычки, "", перевод строки в кавычках, CRLF, BOM, null', () => {
    const rows = parseCsv(
      '﻿a,b,c\r\n"x, ""y""","line1\nline2",null\r\n\r\n1,,3\n',
    );
    expect(rows).toEqual([
      { a: 'x, "y"', b: 'line1\nline2', c: null },
      { a: '1', b: null, c: '3' },
    ]);
    expect(parseCsv('')).toEqual([]);
  });

  it('rejects malformed CSV rather than silently changing research fields', () => {
    for (const csv of [
      'a,b\n"unfinished,b',
      'a,b\n"closed"garbage,b',
      'a,b\nx"y,z',
      'a,a\nx,y',
      'a,\nx,y',
      'a,b\nx,y,z',
    ])
      expect(() => parseCsv(csv)).toThrow('CSV:');
  });

  it('IA-C-04: отказ разбора CSV — причина и физическая строка файла (с учётом переводов строк в кавычках и CRLF)', () => {
    const fail = (csv: string): string => {
      let caught: unknown = null;
      try {
        parseCsv(csv);
      } catch (e) {
        caught = e;
      }
      if (!(caught instanceof CsvError))
        return `не CsvError: ${String(caught)}`;
      return `${caught.line}:${caught.reason}`;
    };
    expect(fail('a,b\n"unfinished,b')).toBe('2:незакрытая кавычка');
    expect(fail('a,b\r\nx,y\r\n"multi\nline",z\r\n"open')).toBe(
      '5:незакрытая кавычка',
    );
    expect(fail('a,b\nx,y\n"closed"garbage,b')).toBe(
      '3:текст после закрывающей кавычки',
    );
    expect(fail('a,b\n"q\n\nq",1\nx"y,z')).toBe(
      '5:кавычка внутри обычного поля',
    );
    expect(fail('\n\na,a\nx,y')).toBe('3:пустые или повторяющиеся заголовки');
    expect(fail('a,b\nx,y\n\nx,y,z')).toBe(
      '4:полей больше, чем заголовков (3 > 2)',
    );
    // Сообщение — без содержимого ячеек.
    expect(() => parseCsv('a\n"secret@example.com')).toThrow(
      'CSV: незакрытая кавычка (строка 2)',
    );
  });

  it('обоснования факторов из колонки why; opKey — детерминированный UUID v4', () => {
    expect(
      parseWhy('tf: direct; itf: comparison; xx: ignored; cu: old'),
    ).toEqual({
      topic_fit: 'direct',
      intent_fit: 'comparison',
      context_uncertainty: 'old',
    });
    const k = stableOpKey('a', 'b');
    expect(k).toMatch(OP_KEY_RE);
    expect(stableOpKey('a', 'b')).toBe(k);
    expect(stableOpKey('a', 'c')).not.toBe(k);
  });

  it('тексты: в ссылке длинное число → «…» (ссылка остаётся), профиль → хост; дата остаётся; контакт → отказ (аудит imp-5)', () => {
    const t = safeText(
      'checked 2026-10-13; hint: https://www.indiehackers.com/post/list-72c1129428',
      300,
    )!;
    expect(t).toEqual({
      text: 'checked 2026-10-13; hint: https://www.indiehackers.com/post/list-72c…',
      sanitized: true,
      clipped: false,
    });
    expect(looksLikeContact(t.text)).toBe(false);
    expect(safeText('see https://example.com/u/somebody now', 300)).toEqual({
      text: 'see example.com/… now',
      sanitized: true,
      clipped: false,
    });
    expect(safeText('ok text', 300)).toEqual({
      text: 'ok text',
      sanitized: false,
      clipped: false,
    });
    expect(safeText('x'.repeat(10), 5)).toEqual({
      text: 'xxxx…',
      sanitized: false,
      clipped: true,
    });
    // выдержка: переводы строк сохраняются
    expect(safeText('a  b\r\n\n\n\nc ', 100, true)?.text).toBe('a b\n\nc');
    expect(safeText('mail me john@example.com', 300)).toBeNull();
  });

  it('flair_required: «yes (…)» — required, «no …» — нет, unknown — null, прочее — null с предупреждением (аудит imp-4)', () => {
    expect(
      parseFlair(
        'yes (self-promo flair; name differs by source: "SHOW IH" vs "Self Promotion")',
      ),
    ).toEqual({ value: true, parsed: true });
    expect(parseFlair('TRUE')).toEqual({ value: true, parsed: true });
    expect(parseFlair('required for promo posts')).toEqual({
      value: true,
      parsed: true,
    });
    expect(parseFlair('no')).toEqual({ value: false, parsed: true });
    expect(parseFlair('not required')).toEqual({ value: false, parsed: true });
    expect(parseFlair('unknown')).toEqual({ value: null, parsed: true });
    expect(parseFlair(null)).toEqual({ value: null, parsed: true });
    expect(parseFlair('depends on mods')).toEqual({
      value: null,
      parsed: false,
    });
    expect(parseFlair('yesterday')).toEqual({ value: null, parsed: false });
  });

  it('план: сообщества одно на продукт (сегменты сливаются), правила — unreviewed с «secondary», гейт до/после проверки', () => {
    const p = buildImportPlan([seg('saas'), seg('smb')], {
      projectTitle: 'Pilot',
      locale: 'en',
      market: 'US',
      now: NOW,
    });
    expect(p.communities.map((c) => [c.subreddit, c.segments])).toEqual([
      ['saas', ['saas', 'smb']],
      ['smallbusiness', ['saas', 'smb']],
    ]);
    const saas = p.communities[0];
    expect(saas.body).toEqual({
      community: 'r/saas',
      descriptionManual: 'SaaS founders, "growth"',
      topics: ['saas', 'smb'],
      language: null,
    });
    // Р-RD-AUD-3: страница правил «not readable» — первоисточника нет.
    expect(saas.rules).toMatchObject({
      sourceUrl: null,
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: 'restricted',
      flairRequired: false,
      conditions: [
        'Promo only in weekly thread',
        '10:1 ratio',
        'secondary: rules page not readable; https://www.indiehackers.com/post/list-of-subreddits-72c…',
      ],
      checkedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(saas.rules.sourceExcerpt).toMatch(
      /Secondary sources only — the rules page was not read/,
    );
    // r/smallbusiness: «not readable» без подсказок — источник текстом.
    expect(p.communities[1].rules.conditions).toEqual([
      'No readable source',
      'secondary: rules page not readable; research CSV',
    ]);
    // Прочитанная страница правил — первоисточник.
    const read = buildImportPlan(
      [
        {
          ...seg('saas'),
          communities: parseCsv(
            COMMUNITIES.replace(
              '"https://www.reddit.com/r/SaaS/about/rules (not readable); hint: https://www.indiehackers.com/post/list-of-subreddits-72c1129428"',
              'https://www.reddit.com/r/SaaS/wiki/rules',
            ),
          ),
        },
      ],
      { projectTitle: 'Pilot', locale: 'en', market: 'US', now: NOW },
    );
    expect(read.communities[0].rules.sourceUrl).toBe(
      'https://www.reddit.com/r/SaaS/wiki/rules',
    );
    expect(read.communities[0].rules.conditions!.at(-1)).toBe(
      'secondary: research CSV',
    );
    expect(offlineReport(read).blocks[0].firstHandSource).toBe(true);
    expect(offlineReport(p).blocks[0].firstHandSource).toBe(false);
    // второй сегмент с тем же сообществом — предупреждение `merged`
    expect(
      p.warnings
        .filter((w) => w.code === 'merged')
        .map((w) => [w.ref, w.detail]),
    ).toEqual([
      ['smb: r/saas', 'rules from segment saas'],
      ['smb: r/smallbusiness', 'rules from segment saas'],
    ]);
    expect('reviewState' in saas.rules).toBe(false);
    expect(saas.gate).toEqual({ now: ['rules_unreviewed'], afterReview: [] });
    expect(p.communities[1].gate.afterReview).toEqual([
      'promotion_unknown',
      'links_unknown',
    ]);
    for (const c of p.communities) {
      expect(looksLikeContact(c.rules.sourceExcerpt)).toBe(false);
      c.rules.conditions!.forEach((x) =>
        expect(looksLikeContact(x)).toBe(false),
      );
    }
  });

  it('план: только валидные треды своего сообщества; факторы и why из CSV; без выдержки; все ключевые запросы (без дублей)', () => {
    const p = buildImportPlan([seg('saas'), seg('smb')], {
      projectTitle: 'Pilot',
      locale: 'en',
      market: 'US',
      now: NOW,
    });
    // O3 (r/Other — нет в CSV) не отклоняется в плане: сообщество ищется
    // среди уже заведённых в продукте (аудит imp-6).
    expect(p.opportunities.map((x) => [x.ref, x.communityInPlan])).toEqual([
      ['O1', true],
      ['O3', false],
    ]);
    const o = p.opportunities[0];
    expect(o).toMatchObject({
      threadKey: '1k302zp',
      subreddit: 'saas',
      body: {
        threadUrl:
          'https://www.reddit.com/r/saas/comments/1k302zp/chatbase_vs_sitegpt',
        titleManual: 'Chatbase vs SiteGPT',
        intent: 'comparison',
        angle: 'Buyer comparing bots. · Found via: x',
      },
    });
    expect('excerpt' in o.body).toBe(false);
    expect(o.body.factors).toEqual({
      topic_fit: { value: 90, why: 'direct' },
      intent_fit: { value: 85, why: 'comparison' },
      audience_fit: { value: 80, why: 'buyers' },
      answerability: {
        value: 80,
        why: 'research CSV (saas): no rationale given',
      },
      promotionality: { value: 55, why: 'medium' },
      evidence_gap: {
        value: 70,
        why: 'research CSV (saas): no rationale given',
      },
      context_uncertainty: {
        value: 75,
        why: 'research CSV (saas): no rationale given',
      },
    });
    expect(p.rejected.map((r) => [r.kind, r.segment, r.ref, r.code])).toEqual([
      ['community', 'saas', 'not a sub!', 'format'],
      ['community', 'smb', 'not a sub!', 'format'],
      ['opportunity', 'saas', 'O2', 'not_thread'],
      ['opportunity', 'saas', 'O4', 'duplicate_in_csv'],
      ['opportunity', 'smb', 'O1', 'duplicate_in_csv'],
      ['opportunity', 'smb', 'O2', 'not_thread'],
      ['opportunity', 'smb', 'O3', 'duplicate_in_csv'],
      ['opportunity', 'smb', 'O4', 'duplicate_in_csv'],
    ]);
    // imp-5: значения по умолчанию и отброшенные колонки — в предупреждениях
    expect(
      p.warnings
        .filter((w) => w.kind !== 'rules')
        .map((w) =>
          `${w.kind} ${w.ref} ${w.code} ${w.field ?? ''} ${w.detail ?? ''}`.trim(),
        ),
    ).toEqual([
      'file saas: opportunities dropped_columns  date, policy_risk, relevance, risk, priority, gate, gate_reason, checked_at',
      'file smb: opportunities dropped_columns  date, policy_risk, relevance, risk, priority, gate, gate_reason, checked_at',
      'keyword saas: Tidio vs Intercom enum_default priority 9 → 3',
    ]);
    expect(p.keywords.map((k) => k.body)).toEqual([
      {
        phrase: 'AI chatbot for SaaS',
        intent: 'recommendation',
        priority: 5,
        locale: 'en',
      },
      {
        phrase: 'Tidio vs Intercom',
        intent: 'comparison',
        priority: 3,
        locale: 'en',
      },
    ]);
    const r = offlineReport(p);
    expect(r.items.find((i) => i.ref === 'saas: O3')).toMatchObject({
      outcome: 'rejected',
      code: 'community_missing',
    });
    expect(r.summary).toEqual({
      community: { rejected: 2, would_create: 2 },
      opportunity: { rejected: 7, would_create: 1 },
      project: { would_create: 1 },
      rules: { would_create: 2 },
      keyword: { would_create: 2 },
    });
    expect(formatReport(r)).toMatch(
      /r\/saas: зараз rules_unreviewed; після перевірки власником — ok/,
    );
  });
});

describe('research-import: условия правил (аудит Админки S3-7)', () => {
  it('«; » делит условия, но не внутри скобок и кавычек; перевод строки делит всегда', () => {
    expect(
      splitConditions(
        'Max 1 mention OR 3 links per 60 days (posts+comments; alt accounts count); 10:1 ratio',
      ),
    ).toEqual([
      'Max 1 mention OR 3 links per 60 days (posts+comments; alt accounts count)',
      '10:1 ratio',
    ]);
    expect(
      splitConditions(
        'Title must say "[Promo]; weekly"; no DMs; tag «self; promo» only; see [rules; wiki]',
      ),
    ).toEqual([
      'Title must say "[Promo]; weekly"',
      'no DMs',
      'tag «self; promo» only',
      'see [rules; wiki]',
    ]);
    // прежние правила: «;» без пробела — не разделитель; пустые — отброшены
    expect(splitConditions('a;b;  c\n\nd;\te ;  ')).toEqual([
      'a;b',
      'c',
      'd',
      'e',
    ]);
    // незакрытая скобка не склеивает следующие строки
    expect(splitConditions('one (unclosed; x\ntwo; three')).toEqual([
      'one (unclosed; x',
      'two',
      'three',
    ]);
    expect(splitConditions('')).toEqual([]);
  });

  it('план импорта: условие со «;» в скобках — одно условие снимка', () => {
    const csv = COMMUNITIES.replace(
      '"Promo only in weekly thread; 10:1 ratio"',
      '"Max 1 mention OR 3 links per 60 days (posts+comments; alt accounts count); 10:1 ratio"',
    );
    expect(csv).not.toBe(COMMUNITIES);
    const p = buildImportPlan(
      [{ ...seg('saas'), communities: parseCsv(csv) }],
      { projectTitle: 'Pilot', locale: 'en', market: 'US', now: NOW },
    );
    expect(p.communities[0].rules.conditions!.slice(0, 2)).toEqual([
      'Max 1 mention OR 3 links per 60 days (posts+comments; alt accounts count)',
      '10:1 ratio',
    ]);
  });
});

describe('research-import: CLI', () => {
  const base = ['--project-title=Pilot', '--dir=/tmp'];
  it('аргументы: по умолчанию dry-run; --apply требует --base-url; адреса Reddit запрещены', () => {
    expect(parseArgs(base)).toMatchObject({
      apply: false,
      baseUrl: null,
      locale: 'en',
      market: 'global',
    });
    expect(() => parseArgs([...base, '--apply'])).toThrow(/--base-url/);
    expect(() =>
      parseArgs([...base, '--base-url=https://www.reddit.com', '--product=p']),
    ).toThrow(/Reddit/);
    expect(() => parseArgs([...base, '--base-url=http://x'])).toThrow(
      /--site или --product/,
    );
    expect(() => parseArgs([...base, '--token=secret'])).toThrow(/--token/);
    expect(
      parseArgs([
        ...base,
        '--base-url',
        'http://127.0.0.1:1/',
        '--product',
        'p1',
        '--apply',
        '--segments=smb,saas',
      ]),
    ).toMatchObject({
      baseUrl: 'http://127.0.0.1:1',
      product: 'p1',
      apply: true,
      segments: ['smb', 'saas'],
    });
  });
  it(`заголовки сессии — из ${AUTH_ENV} (JSON или строки), значения не попадают в ошибки`, () => {
    expect(parseAuthHeaders(undefined)).toEqual({});
    expect(
      parseAuthHeaders('{"Cookie":"s=SECRET","X-Telegram-App":"assist"}'),
    ).toEqual({
      Cookie: 's=SECRET',
      'X-Telegram-App': 'assist',
    });
    expect(parseAuthHeaders('Cookie: s=SECRET\nOrigin: https://a.b')).toEqual({
      Cookie: 's=SECRET',
      Origin: 'https://a.b',
    });
    for (const bad of ['{"Bad Name":"SECRET"}', '{nope', 'no-colon SECRET'])
      expect(() => parseAuthHeaders(bad)).toThrow(
        expect.objectContaining({
          message: expect.not.stringContaining('SECRET'),
        }),
      );
  });
});

describe('research-import: выполнение (Р-RD-AUD-2, Р-RD-AUD-4, аудит imp-1…imp-7)', () => {
  const PID = 'pid';
  const R = `/publisher/products/${PID}/reddit`;
  interface Call {
    method: 'GET' | 'POST' | 'PATCH';
    path: string;
    body?: Record<string, unknown>;
  }
  /** Фейковый API кабинета: списки из `state`, запись — 201 с id. */
  function fakeApi(
    state: {
      projects?: unknown[];
      communities?: unknown[];
      keywords?: unknown[];
      opportunities?: unknown[];
    } = {},
    onPost?: (c: Call) => { status: number; body: unknown } | undefined,
  ) {
    const calls: Call[] = [];
    let inflight = 0;
    let maxInflight = 0;
    let n = 0;
    const list = (path: string) => {
      const k = /\/reddit\/(\w+)\?/.exec(path)?.[1] as keyof typeof state;
      return { items: state[k] ?? [], nextBefore: null };
    };
    const write = async (c: Call) => {
      calls.push(c);
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 1));
      inflight--;
      const custom = onPost?.(c);
      if (custom) return custom as never;
      return { status: 201, body: { data: { id: `id${++n}` } } };
    };
    const http: ImportHttp = {
      get: async (path) => {
        calls.push({ method: 'GET', path });
        return path === `/publisher/products/${PID}`
          ? { status: 200, body: { data: { features: { reddit: true } } } }
          : { status: 200, body: { data: list(path) } };
      },
      post: (path, body) => write({ method: 'POST', path, body }),
      patch: (path, body) => write({ method: 'PATCH', path, body }),
    };
    return { http, calls, maxInflight: () => maxInflight };
  }
  const planOf = (segment: string, communities: string, opps = '') =>
    buildImportPlan(
      [
        {
          segment,
          communities: parseCsv(communities),
          opportunities: opps ? parseCsv(opps) : [],
          keywords: [],
        },
      ],
      { projectTitle: 'Pilot', locale: 'en', market: 'US', now: NOW },
    );
  const HEAD =
    'name,url,topic,size,promotion_policy,links_policy,flair_required,conditions,source_url,checked_at\n';
  const row = (name: string, policy = 'unknown') =>
    `r/${name},,t,null,${policy},unknown,null,c,https://www.reddit.com/r/${name}/wiki/rules,2026-10-13\n`;

  it('у сообщества с текущим снимком (любой проверки) — exists/kept_current с расхождением, сегмент → topics (PATCH с expectedRevision); без снимка — новый (opKey с «none»)', async () => {
    const plan = planOf(
      'saas',
      HEAD +
        row('alpha', 'allowed_with_conditions') +
        row('beta') +
        row('gamma'),
    );
    const api = fakeApi({
      projects: [{ id: 'pr1', title: 'Pilot', status: 'active' }],
      communities: [
        {
          id: 'ca',
          subreddit: 'alpha',
          projectId: 'pr1',
          topics: ['smb'],
          revision: 3,
          rules: {
            snapshotId: 'sa',
            reviewState: 'unreviewed',
            promotionPolicy: 'unknown',
            linksPolicy: 'unknown',
          },
        },
        {
          id: 'cb',
          subreddit: 'beta',
          projectId: 'pr1',
          topics: ['saas'],
          revision: 1,
          rules: null,
        },
      ],
    });
    const r = await runImport(api.http, PID, plan, true);
    expect(
      r.items.map((i) => [
        i.kind,
        i.ref,
        i.outcome,
        i.code ?? '',
        i.detail ?? '',
      ]),
    ).toEqual([
      ['project', 'Pilot', 'exists', '', ''],
      ['community', 'r/alpha', 'exists', 'topics_merged', 'topics +saas'],
      [
        'rules',
        'r/alpha',
        'exists',
        'kept_current',
        'unreviewed; differs: promotion unknown, csv allowed_with_conditions',
      ],
      ['community', 'r/beta', 'exists', '', ''],
      ['rules', 'r/beta', 'created', '', ''],
      ['community', 'r/gamma', 'created', '', ''],
      ['rules', 'r/gamma', 'created', '', ''],
    ]);
    const patch = api.calls.find((c) => c.method === 'PATCH')!;
    expect(patch.path).toBe(`${R}/communities/ca`);
    expect(patch.body).toMatchObject({
      expectedRevision: 3,
      topics: ['smb', 'saas'],
    });
    // снимок r/a не создавался; opKey правил r/b — от состояния «none»
    const rulesPosts = api.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith('/rules'),
    );
    expect(rulesPosts).toHaveLength(2);
    expect(rulesPosts.map((c) => c.path)).toEqual(
      expect.arrayContaining([
        `${R}/communities/cb/rules`,
        expect.stringMatching(/\/communities\/id\d\/rules$/),
      ]),
    );
    const beta = rulesPosts.find((c) => c.path.includes('/cb/'))!;
    const { opKey, ...body } = beta.body!;
    const hash = createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex')
      .slice(0, 16);
    expect(opKey).toBe(
      stableOpKey('reddit-import', PID, 'rules', 'beta', 'none', hash),
    );
    expect(r.complete).toBe(true);
  });

  it('dry-run: ничего не пишет; дописывание topics — topics_pending', async () => {
    const plan = planOf('saas', HEAD + row('alpha'));
    const api = fakeApi({
      projects: [{ id: 'pr1', title: 'Pilot', status: 'active' }],
      communities: [
        {
          id: 'ca',
          subreddit: 'alpha',
          projectId: 'pr1',
          topics: ['smb'],
          revision: 3,
          rules: null,
        },
      ],
    });
    const r = await runImport(api.http, PID, plan, false);
    expect(api.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(r.items.map((i) => [i.kind, i.outcome, i.code ?? ''])).toEqual([
      ['project', 'exists', ''],
      ['community', 'exists', 'topics_pending'],
      ['rules', 'would_create', ''],
    ]);
  });

  it('пул: не больше 4 записей одновременно, порядок отчёта — как в плане; 409 PUB_IDEMPOTENCY_REUSED — exists/other_actor', async () => {
    const plan = planOf(
      'smb',
      HEAD + Array.from({ length: 10 }, (_, i) => row(`sub${i}`)).join(''),
    );
    const api = fakeApi(
      { projects: [{ id: 'pr1', title: 'Pilot', status: 'active' }] },
      (c) =>
        c.path === `${R}/communities` && c.body?.community === 'r/sub3'
          ? {
              status: 409,
              body: { error: { code: 'PUB_IDEMPOTENCY_REUSED' } },
            }
          : undefined,
    );
    const r = await runImport(api.http, PID, plan, true);
    expect(api.maxInflight()).toBeGreaterThan(1);
    expect(api.maxInflight()).toBeLessThanOrEqual(4);
    expect(
      r.items.filter((i) => i.kind === 'community').map((i) => i.ref),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `r/sub${i}`));
    expect(r.items.find((i) => i.ref === 'r/sub3')).toMatchObject({
      outcome: 'exists',
      code: 'other_actor',
    });
  });

  it('дедлайн: остаток — not_attempted/deadline, отчёт частичный; повтор безопасен', async () => {
    const plan = planOf(
      'smb',
      HEAD + Array.from({ length: 6 }, (_, i) => row(`sub${i}`)).join(''),
    );
    const api = fakeApi({
      projects: [{ id: 'pr1', title: 'Pilot', status: 'active' }],
    });
    let t = 0;
    const r = await runImport(api.http, PID, plan, true, {
      concurrency: 1,
      deadlineAt: 2,
      clock: () => t++,
    });
    expect(r.complete).toBe(false);
    expect(r.stoppedBy).toBe('deadline');
    expect(r.items.map((i) => [i.ref, i.outcome, i.code ?? ''])).toEqual([
      ['Pilot', 'exists', ''],
      ['r/sub0', 'created', ''],
      ['r/sub0', 'created', ''],
      ...Array.from({ length: 5 }, (_, i) => [
        [`r/sub${i + 1}`, 'not_attempted', 'deadline'],
        [`r/sub${i + 1}`, 'not_attempted', 'deadline'],
      ]).flat(),
    ]);
    expect(r.summary.community).toEqual({ created: 1, not_attempted: 5 });
  });

  it('проект не создан (400) — остальное not_attempted/project_rejected, ничего не пишется', async () => {
    const plan = planOf('smb', HEAD + row('alpha'));
    const api = fakeApi({}, (c) =>
      c.path === `${R}/projects`
        ? {
            status: 400,
            body: {
              error: {
                code: 'PUB_VALIDATION',
                details: { fields: [{ field: 'market', code: 'length' }] },
              },
            },
          }
        : undefined,
    );
    const r = await runImport(api.http, PID, plan, true);
    expect(r.complete).toBe(false);
    expect(r.stoppedBy).toBe('project_rejected');
    expect(r.items.map((i) => [i.kind, i.outcome, i.code])).toEqual([
      ['project', 'rejected', 'market:length'],
      ['community', 'not_attempted', 'project_rejected'],
      ['rules', 'not_attempted', 'project_rejected'],
    ]);
    expect(api.calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });

  it('возможность в сообществе, заведённом раньше (не в этом CSV), — создаётся; в чужом проекте — other_project; нигде — community_missing (аудит imp-6)', async () => {
    const OPP_HEAD = 'id,url,title,kind\n';
    const plan = planOf(
      'saas',
      HEAD + row('alpha'),
      OPP_HEAD +
        'O1,https://www.reddit.com/r/oldsub/comments/aa1/x/,T1,thread\n' +
        'O2,https://www.reddit.com/r/foreign/comments/aa2/x/,T2,thread\n' +
        'O3,https://www.reddit.com/r/nowhere/comments/aa3/x/,T3,thread\n',
    );
    const api = fakeApi({
      projects: [{ id: 'pr1', title: 'Pilot', status: 'active' }],
      communities: [
        { id: 'cold', subreddit: 'oldsub', projectId: 'pr1', rules: null },
        { id: 'cfor', subreddit: 'foreign', projectId: 'pr9', rules: null },
      ],
    });
    const r = await runImport(api.http, PID, plan, true);
    expect(
      r.items
        .filter((i) => i.kind === 'opportunity')
        .map((i) => [i.ref, i.outcome, i.code ?? '']),
    ).toEqual([
      ['saas: O1', 'created', ''],
      ['saas: O2', 'rejected', 'other_project'],
      ['saas: O3', 'rejected', 'community_missing'],
    ]);
    expect(
      api.calls.find((c) => c.path === `${R}/opportunities` && c.body)?.body,
    ).toMatchObject({ communityId: 'cold', projectId: 'pr1' });
  });

  it('предупреждения: обрезка, отброшенные условия, нераспознанный флейр, enum по умолчанию (аудит imp-4, imp-5)', () => {
    const many = Array.from({ length: 22 }, (_, i) => `cond ${i}`).join('; ');
    const plan = planOf(
      'smb',
      HEAD +
        `r/wordy,,${'d'.repeat(2100)},null,maybe,unknown,depends,"${many}",https://www.reddit.com/r/wordy/wiki/rules,2026-10-13\n` +
        `r/flairy,,t,null,unknown,unknown,"yes (self-promo flair)",c,https://www.reddit.com/r/flairy/wiki/rules,2026-10-13\n`,
    );
    expect(
      plan.warnings.map((w) =>
        `${w.ref} ${w.code} ${w.field ?? ''} ${w.detail ?? ''}`.trim(),
      ),
    ).toEqual([
      'smb: r/wordy dropped_conditions conditions 3',
      'smb: r/wordy flair_unparsed flair_required depends',
      'smb: r/wordy enum_default promotion_policy maybe → unknown',
      'smb: r/wordy clipped descriptionManual ≤ 2000',
    ]);
    expect(plan.communities[0].rules.conditions).toHaveLength(20);
    expect(plan.communities[1].rules.flairRequired).toBe(true);
    expect(plan.communities[1].rules.sourceExcerpt).toMatch(
      /Flair: yes \(self-promo flair\)/,
    );
  });
});
