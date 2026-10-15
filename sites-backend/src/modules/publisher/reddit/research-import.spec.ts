/**
 * P-R — импорт чернового исследования (Р-RD-87): разбор CSV, план записей
 * (правила из вторичных источников — unreviewed с пометкой «secondary»,
 * только валидные треды, факторы и обоснования из CSV, все запросы),
 * очистка текстов от контактов, детерминированный `opKey`, аргументы CLI и
 * заголовки сессии из окружения (значения не попадают в ошибки).
 */
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
  parseCsv,
  parseWhy,
  safeText,
  splitConditions,
  stableOpKey,
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

  it('тексты: ссылка с длинным числом → хост; дата остаётся; контакт → отказ', () => {
    const t = safeText(
      'checked 2026-10-13; hint: https://www.indiehackers.com/post/list-72c1129428',
      300,
    )!;
    expect(t).toEqual({
      text: 'checked 2026-10-13; hint: www.indiehackers.com/…',
      sanitized: true,
    });
    expect(looksLikeContact(t.text)).toBe(false);
    expect(safeText('ok text', 300)).toEqual({
      text: 'ok text',
      sanitized: false,
    });
    expect(safeText('mail me john@example.com', 300)).toBeNull();
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
    expect(saas.rules).toMatchObject({
      sourceUrl: 'https://www.reddit.com/r/SaaS/about/rules',
      promotionPolicy: 'allowed_with_conditions',
      linksPolicy: 'restricted',
      flairRequired: false,
      conditions: [
        'Promo only in weekly thread',
        '10:1 ratio',
        'secondary: www.indiehackers.com/…',
      ],
      checkedAt: '2026-10-13T12:00:00.000Z',
    });
    expect(saas.rules.sourceExcerpt).toMatch(
      /Secondary sources only — not verified first-hand/,
    );
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
    expect(p.opportunities).toHaveLength(1);
    const o = p.opportunities[0];
    expect(o).toMatchObject({
      threadKey: '1k302zp',
      subreddit: 'saas',
      body: {
        threadUrl:
          'https://www.reddit.com/r/saas/comments/1k302zp/chatbase_vs_sitegpt',
        titleManual: 'Chatbase vs SiteGPT',
        intent: 'comparison',
        angle: 'Buyer comparing bots.',
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
      ['opportunity', 'saas', 'O3', 'community_missing'],
      ['opportunity', 'saas', 'O4', 'duplicate_in_csv'],
      ['opportunity', 'smb', 'O1', 'duplicate_in_csv'],
      ['opportunity', 'smb', 'O2', 'not_thread'],
      ['opportunity', 'smb', 'O3', 'community_missing'],
      ['opportunity', 'smb', 'O4', 'duplicate_in_csv'],
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
