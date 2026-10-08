/**
 * Общий каркас двух страниц-отчётов для разработчика (Р-З10-11): отчёт
 * мастера голосового управления (`/w/v1/vc-report/:token`, одноразовый,
 * кнопка POST) и отчёт голосовой карты (`…/voice-map/site/dev-report/:token`,
 * многоразовый со счётчиком). Обе страницы: одни заголовки, CSP без
 * скриптов, одинаковый 404 на любой отказ; HEAD и боты превью токен не
 * тратят и просмотром не считаются.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { VoiceDevReportController } from '../modules/assist-site-voice-control/share/dev-report.controller';
import type { VoiceDevReportService } from '../modules/assist-site-voice-control/share/dev-report.service';
import * as vcReport from '../modules/assist-site-voice-control/share/dev-report';
import * as mapReport from '../modules/assist-site-voice-map/dev-report';
import { DevReportController } from '../modules/assist-site-voice-map/dev-report.controller';
import type { DevReportService } from '../modules/assist-site-voice-map/dev-report.service';
import {
  escHtml,
  isReportView,
  PREVIEW_BOT_RE,
  REPORT_PAGE_HEADERS,
  reportPageCsp,
  reportPageHtml,
} from './report-page';

function fakeRes() {
  const r = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: '',
    status(c: number) {
      r.statusCode = c;
      return r;
    },
    setHeader(k: string, v: string) {
      r.headers[k.toLowerCase()] = v;
    },
    end(b: string) {
      r.body = b;
    },
    json(b: unknown) {
      r.body = JSON.stringify(b);
    },
  };
  return r;
}

const expectReportHeaders = (h: Record<string, string>, form: string) => {
  for (const [k, v] of Object.entries(REPORT_PAGE_HEADERS)) {
    expect([k, h[k.toLowerCase()]]).toEqual([k, v]);
  }
  expect(h['content-security-policy']).toBe(reportPageCsp(form as "'self'"));
};

describe('report-page — общие части', () => {
  it('escHtml: текст и атрибуты; null/undefined — пусто', () => {
    expect(escHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
    expect(escHtml(5)).toBe('5');
  });

  it('CSP: без скриптов, ресурсов и встраивания; форма — только где есть кнопка', () => {
    for (const f of ["'self'", "'none'"] as const) {
      const csp = reportPageCsp(f);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain(`form-action ${f}`);
      expect(csp).not.toMatch(/script-src|unsafe-eval|connect-src|img-src/);
    }
  });

  it('просмотр — только GET не от бота превью; без запроса — просмотр', () => {
    expect(isReportView()).toBe(true);
    expect(isReportView({ method: 'GET', headers: {} })).toBe(true);
    expect(isReportView({ method: 'HEAD', headers: {} })).toBe(false);
    for (const ua of [
      'TelegramBot (like TwitterBot)',
      'Slackbot-LinkExpanding 1.0',
      'WhatsApp/2.23',
      'Mozilla/5.0 (compatible; Googlebot/2.1)',
      'facebookexternalhit/1.1',
    ]) {
      expect([
        ua,
        isReportView({ method: 'GET', headers: { 'user-agent': ua } }),
      ]).toEqual([ua, false]);
    }
    expect(
      PREVIEW_BOT_RE.test('Mozilla/5.0 (Windows NT 10.0) Chrome/120'),
    ).toBe(false);
  });

  it('оболочка: noindex, без скриптов, заголовок экранирован; referrer-meta по запросу', () => {
    const html = reportPageHtml({
      lang: 'uk',
      title: '<x>',
      style: 'b{}',
      body: '<p>1</p>',
    });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<title>&lt;x&gt;</title>');
    expect(html).not.toContain('name="referrer"');
    expect(html).not.toMatch(/<script/i);
    expect(
      reportPageHtml({
        lang: 'en',
        title: 't',
        style: '',
        body: '',
        referrerMeta: true,
      }),
    ).toContain('<meta name="referrer" content="no-referrer">');
  });
});

describe('отчёт мастера (vc-report): HEAD/боты не тратят, 404 неотличим', () => {
  const TOKEN = 'A'.repeat(32);
  function ctrl(live: Set<string>) {
    const consume = jest.fn(async (t: string) => {
      if (!live.has(t)) return null;
      live.delete(t);
      return {
        v: 1,
        src: 's',
        lang: 'uk',
        host: 'h',
        page: '/',
        reportedAt: null,
        result: 'ok',
        items: [],
        markup: {
          total: 0,
          withId: 0,
          unnamed: [],
          closedShadow: 0,
          extIframes: 0,
          duplicates: [],
        },
        never: [],
        suspicious: [],
        denySuggestions: [],
        undo: [],
        fragment: '',
      };
    });
    const peekLang = jest.fn(async (t: string) => (live.has(t) ? 'uk' : null));
    const svc = { consume, peekLang } as unknown as VoiceDevReportService;
    return { c: new VoiceDevReportController(svc), consume, peekLang };
  }

  it('GET (в т.ч. бот превью и HEAD — Nest отвечает тем же обработчиком) токен не гасит', async () => {
    const live = new Set([TOKEN]);
    const { c, consume } = ctrl(live);
    for (let i = 0; i < 3; i++) {
      const res = fakeRes();
      await c.landing(TOKEN, res as never);
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('method="post"');
      expectReportHeaders(res.headers, "'self'");
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    }
    expect(consume).not.toHaveBeenCalled();
    const res = fakeRes();
    await c.open(TOKEN, res as never);
    expect(res.statusCode).toBe(200);
    expect(live.has(TOKEN)).toBe(false);
  });

  it('нет/истёк/открыт — один и тот же 404 и те же заголовки (GET и POST)', async () => {
    const { c } = ctrl(new Set());
    const answers: Array<{
      status: number;
      body: string;
      headers: Record<string, string>;
    }> = [];
    for (const t of [TOKEN, 'x'.repeat(32), 'short']) {
      for (const call of [c.landing.bind(c), c.open.bind(c)]) {
        const res = fakeRes();
        await call(t, res as never);
        expectReportHeaders(res.headers, "'self'");
        answers.push({
          status: res.statusCode,
          body: res.body,
          headers: res.headers,
        });
      }
    }
    expect(answers[0].status).toBe(404);
    for (const a of answers) expect(a).toEqual(answers[0]);
  });
});

describe('отчёт голосовой карты: HEAD/боты не считаются просмотром, 404 неотличим', () => {
  const content = {
    v: 1,
    host: 'shop.example.com',
    platform: null,
    draftRevision: 1,
    publishedVersion: 1,
    generatedAt: '2026-10-08T12:00:00.000Z',
    counts: { targets: 0, missing: 0, never: 0, fragile: 0 },
    groups: [],
  };
  function ctrl(fail?: HttpStatus | Error) {
    const read = jest.fn(async () => {
      if (fail instanceof Error) throw fail;
      if (fail) throw new HttpException('x', fail);
      return content;
    });
    return {
      c: new DevReportController({ read } as unknown as DevReportService),
      read,
    };
  }

  it('GET — просмотр; HEAD и боты — нет (страница та же)', async () => {
    const { c, read } = ctrl();
    const cases: Array<[unknown, boolean]> = [
      [
        { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } },
        true,
      ],
      [{ method: 'HEAD', headers: {} }, false],
      [
        {
          method: 'GET',
          headers: { 'user-agent': 'TelegramBot (like TwitterBot)' },
        },
        false,
      ],
      [
        {
          method: 'GET',
          headers: { 'user-agent': 'Slackbot-LinkExpanding 1.0' },
        },
        false,
      ],
    ];
    for (const [req, count] of cases) {
      read.mockClear();
      const res = fakeRes();
      await c.read('site1', 'tok', 'uk', undefined, res as never, req as never);
      expect(res.statusCode).toBe(200);
      expect(read).toHaveBeenCalledWith('site1', 'tok', { count });
      expectReportHeaders(res.headers, "'none'");
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body).not.toMatch(/<script/i);
    }
  });

  it('любой отказ ссылки — один 404 (HTML и JSON), заголовки те же; сбой базы — не 404', async () => {
    const html: string[] = [];
    const json: string[] = [];
    for (const st of [
      HttpStatus.NOT_FOUND,
      HttpStatus.FORBIDDEN,
      HttpStatus.GONE,
    ]) {
      const { c } = ctrl(st);
      const r1 = fakeRes();
      await c.read('site1', 'tok', 'ru', undefined, r1 as never);
      expect(r1.statusCode).toBe(404);
      expectReportHeaders(r1.headers, "'none'");
      html.push(r1.body);
      const r2 = fakeRes();
      await c.read('site1', 'tok', 'ru', 'json', r2 as never);
      expect(r2.statusCode).toBe(404);
      json.push(r2.body);
    }
    expect(new Set(html).size).toBe(1);
    expect(new Set(json).size).toBe(1);
    const { c } = ctrl(new Error('db down'));
    await expect(
      c.read('site1', 'tok', 'uk', undefined, fakeRes() as never),
    ).rejects.toThrow('db down');
  });
});

/**
 * Эталон HTML обеих страниц на фиксированных данных (P3-5): правка
 * каркаса или текстов не должна менять вывод незаметно. Эталон снят с
 * кода ДО выноса в общий модуль (заход 10) и совпал байт в байт; при
 * осознанной правке — обновить снимок (`jest -u`) и проверить diff глазами.
 */
describe('эталон HTML отчётов (снимок)', () => {
  const X = `<script>"'&</script>`;
  const vc: vcReport.DevReport = {
    v: 1,
    src: 's',
    lang: 'ru',
    host: `h${X}`,
    page: `/p${X}`,
    reportedAt: null,
    result: `r${X}`,
    items: [
      { step: 1, level: 'warn', code: `c${X}`, data: { a: 1, b: `x${X}` } },
    ],
    markup: {
      total: 1,
      withId: 0,
      unnamed: [{ tag: 'div', selector: `#a${X}` }],
      closedShadow: 0,
      extIframes: 0,
      duplicates: [{ name: `n${X}`, count: 2 }],
    },
    never: [{ text: `t${X}`, reason: 'r' }],
    suspicious: [
      { why: 'w', tag: 'a', label: `l${X}`, selector: 's', decision: null },
    ],
    denySuggestions: [`d${X}`, 'e'],
    undo: [{ text: 'u', reverse: `rv${X}`, problem: 'p' }],
    fragment: `<b>${X}</b>`,
  };
  const map: mapReport.DevReportContent = {
    v: 1,
    host: `h${X}`,
    platform: 'shopify@2',
    draftRevision: 1,
    publishedVersion: 1,
    generatedAt: '2026-10-08T12:34:56.000Z',
    counts: { targets: 2, missing: 1, never: 1, fragile: 1 },
    groups: [
      {
        kind: 'site',
        title: 't',
        pattern: null,
        sample: null,
        items: [
          {
            key: `k${X}`,
            name: `n${X}`,
            element: `e${X}`,
            css: `c${X}`,
            line: `l${X}`,
            has: `h${X}`,
            stability: 'fragile',
            risk: 'auto',
            denylisted: true,
            undo: `u${X}`,
          },
          {
            key: 'k2',
            name: null,
            element: 'e',
            css: null,
            line: null,
            has: null,
            stability: 'stable',
            risk: 'auto',
            denylisted: false,
            undo: null,
          },
        ],
      },
      {
        kind: 'template',
        title: `tpl${X}`,
        pattern: `/p/*${X}`,
        sample: `/p/1${X}`,
        items: [],
      },
      { kind: 'page', title: 'pg', pattern: null, sample: null, items: [] },
    ],
  };

  it('отчёт мастера (vc-report): кнопка, 404, отчёт; CSP', () => {
    expect({
      csp: vcReport.DEV_REPORT_CSP,
      landing: vcReport.devReportLanding(`tok_${X}`, 'ru'),
      gone: vcReport.devReportGone('en'),
      report: vcReport.devReportHtml(vc),
    }).toMatchSnapshot();
  });

  it('отчёт голосовой карты: отчёт (3 языка), «недействительна»; CSP', () => {
    expect({
      csp: mapReport.DEV_REPORT_CSP,
      invalid: mapReport.devReportInvalidHtml('uk'),
      report: (['uk', 'ru', 'en'] as const).map((l) =>
        mapReport.devReportHtml(map, l),
      ),
    }).toMatchSnapshot();
  });
});
