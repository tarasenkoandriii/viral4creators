/**
 * Чистые разборы недоверенного ввода W2: страница и `context` посетителя
 * (§4.6 п.5, §6.6 — без query), поля лида, события лендинга (путь без
 * query), payload атрибуции, cookie указателя, origin родителя.
 */
import * as fs from 'fs';
import * as path from 'path';
import { WIDGET_RESUME_COOKIE as C, widgetResumeCookieName } from '../../brand';
import { WIDGET_DEFAULTS } from '../../config/assist-defaults';
import { parseAcquisition } from './cabinet/acquisition.service';
import { cleanLandingEvent, cleanLandingPath } from './landing/landing.service';
import { exactOrigin, isLocalOrigin, siteOfOrigin } from './site-access';
import {
  cleanContext,
  cleanPage,
  cleanPageUrl,
  sseFrame,
} from './widget-chat.service';
import { cleanLeadFields } from './widget-public.controller';
import { resumeCookie, resumeKeyFromCookie } from './widget-session.service';

describe('страница и context посетителя', () => {
  it('URL — http(s) без логина, query и якоря; title — усечён', () => {
    expect(cleanPageUrl('https://shop.ua/cart?email=a@b.c#x')).toBe(
      'https://shop.ua/cart',
    );
    expect(cleanPageUrl('https://u:p@shop.ua/')).toBeNull();
    expect(cleanPageUrl('javascript:alert(1)')).toBeNull();
    expect(cleanPageUrl('https://x/' + 'a'.repeat(3000))).toBeNull();
    expect(cleanPage({ url: null, title: 'т'.repeat(500) }).title).toHaveLength(
      WIDGET_DEFAULTS.maxPageTitleChars,
    );
    expect(cleanPage(null)).toEqual({ url: null, title: null });
  });

  it('context: строки/числа, ключи [A-Za-z0-9_.-], всего ≤ maxContextChars', () => {
    expect(
      cleanContext({ sku: 'A1', n: 2, o: { x: 1 }, 'bad key': 'x' }),
    ).toEqual({
      sku: 'A1',
      n: 2,
    });
    const big = cleanContext({ a: 'x'.repeat(2000), b: 'y' })!;
    expect(JSON.stringify(big).length).toBeLessThanOrEqual(
      WIDGET_DEFAULTS.maxContextChars + 20,
    );
    expect(big.a).toHaveLength(WIDGET_DEFAULTS.maxContextChars - 1);
    expect(cleanContext([1, 2])).toBeNull();
    expect(cleanContext({})).toBeNull();
  });

  it('SSE-кадр: event + data JSON + пустая строка', () => {
    expect(sseFrame({ type: 'token', t: 'a\nb' })).toBe(
      'event: token\ndata: {"type":"token","t":"a\\nb"}\n\n',
    );
  });
});

describe('поля лида', () => {
  it('только известные поля-строки в пределах длины; пустые — выброшены', () => {
    expect(
      cleanLeadFields({ name: ' Олег ', phone: '+380', email: '' }),
    ).toEqual({
      name: 'Олег',
      phone: '+380',
    });
    expect(cleanLeadFields({ password: 'x' })).toBeNull();
    expect(cleanLeadFields({ name: 1 })).toBeNull();
    expect(
      cleanLeadFields({
        name: 'a'.repeat(WIDGET_DEFAULTS.leadFieldMaxChars + 1),
      }),
    ).toBeNull();
    expect(
      cleanLeadFields({
        comment: 'a'.repeat(WIDGET_DEFAULTS.leadCommentMaxChars),
      }),
    ).not.toBeNull();
  });
});

describe('события лендинга', () => {
  it('путь — без query/якоря, только с «/»', () => {
    expect(cleanLandingPath('/pricing?email=a@b.c')).toBe('/pricing');
    expect(cleanLandingPath('/a#b')).toBe('/a');
    expect(cleanLandingPath('pricing')).toBeNull();
    expect(cleanLandingPath('/<script>')).toBeNull();
  });
  it('имя, props (плоские, ≤ 20, строки ≤ 200), locale, variant', () => {
    expect(
      cleanLandingEvent({ name: 'cta_click', props: { a: 1, b: true } }),
    ).toEqual({
      name: 'cta_click',
      props: { a: 1, b: true },
    });
    expect(cleanLandingEvent({ name: 'CTA' })).toBeNull();
    expect(
      cleanLandingEvent({ name: 'x', props: { a: 'я'.repeat(201) } }),
    ).toBeNull();
    const many = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${i}`, i]),
    );
    expect(cleanLandingEvent({ name: 'x', props: many })).toBeNull();
    expect(cleanLandingEvent({ name: 'x', locale: 'de' })).toBeNull();
    expect(cleanLandingEvent({ name: 'x', variant: 'a b' })).toBeNull();
  });
});

describe('атрибуция (payload лендинга)', () => {
  it('lp_/pl_ — кампания; wd_/sb_ — без кампании (секретный id); utm_* ≤ 5, ≤ 100', () => {
    expect(parseAcquisition({ payload: 'lp_spring' })).toMatchObject({
      source: 'lp',
      campaign: 'spring',
    });
    expect(parseAcquisition({ payload: 'sb_abc123' })).toMatchObject({
      source: 'sb',
      campaign: null,
    });
    expect(parseAcquisition({ payload: 'xx_1' })).toBeNull();
    expect(parseAcquisition({ payload: 'lp_' })).toBeNull();
    expect(parseAcquisition({ payload: `lp_${'a'.repeat(62)}` })).toBeNull();
    const utm = Object.fromEntries(
      Array.from({ length: 7 }, (_, i) => [`utm_k${i}`, 'v']),
    );
    expect(
      Object.keys(parseAcquisition({ payload: 'lp_a', utm })!.utm!),
    ).toHaveLength(5);
    expect(
      parseAcquisition({
        payload: 'lp_a',
        utm: { ref: 'x', utm_a: 'я'.repeat(101) },
      })!.utm,
    ).toBeNull();
  });
});

describe('cookie указателя и origin родителя', () => {
  it('CHIPS-cookie: __Host-, Path=/, Secure, HttpOnly, SameSite=None, Partitioned; стирание — Max-Age=0', () => {
    const k = 'A'.repeat(43);
    const pk = 'key_shopA';
    const N = widgetResumeCookieName(pk);
    expect(N.startsWith(`${C}_`)).toBe(true);
    expect(resumeCookie(pk, k)).toBe(
      `${N}=${k}; Path=/; Max-Age=2592000; Secure; HttpOnly; SameSite=None; Partitioned`,
    );
    expect(C.startsWith('__Host-')).toBe(true);
    expect(resumeCookie(pk, null)).toContain(`${N}=; Path=/; Max-Age=0`);
    expect(resumeKeyFromCookie(`a=1; ${N}=${k}; b=2`, pk)).toBe(k);
    expect(resumeKeyFromCookie(`${N}=short`, pk)).toBeNull();
    expect(
      resumeKeyFromCookie(`${N.slice('__Host-'.length)}=${k}`, pk),
    ).toBeNull();
    expect(resumeKeyFromCookie(undefined, pk)).toBeNull();
  });

  it('интеграция Э2: два сайта на одном eTLD+1 (одна секция CHIPS) — разные имена; сервер читает только cookie своего pk', () => {
    const a = 'key_siteA';
    const b = 'key_siteB';
    const ka = 'A'.repeat(43);
    const kb = 'B'.repeat(43);
    expect(widgetResumeCookieName(a)).not.toBe(widgetResumeCookieName(b));
    // В одной секции браузер шлёт обе cookie — каждая на своём имени.
    const header = `${widgetResumeCookieName(a)}=${ka}; ${widgetResumeCookieName(b)}=${kb}`;
    expect(resumeKeyFromCookie(header, a)).toBe(ka);
    expect(resumeKeyFromCookie(header, b)).toBe(kb);
    // Старое общее имя (до правки) не читается ни одним сайтом.
    expect(resumeKeyFromCookie(`${C}=${ka}`, a)).toBeNull();
    expect(widgetResumeCookieName(a)).toMatch(/^__Host-[A-Za-z0-9_]+$/);
  });

  it('origin — только точный сериализованный; localhost; eTLD+1', () => {
    expect(exactOrigin('https://shop.ua')).toBe('https://shop.ua');
    expect(exactOrigin('https://shop.ua/')).toBeNull();
    expect(exactOrigin('https://Shop.ua')).toBeNull();
    expect(exactOrigin('https://shop.ua:443')).toBeNull();
    expect(exactOrigin('ftp://shop.ua')).toBeNull();
    expect(exactOrigin('null')).toBeNull();
    expect(isLocalOrigin('http://localhost:5173')).toBe(true);
    expect(isLocalOrigin('https://127.0.0.1')).toBe(true);
    expect(isLocalOrigin('https://localhost.evil.com')).toBe(false);
    expect(siteOfOrigin('https://shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOfOrigin('https://a.github.io')).not.toBe(
      siteOfOrigin('https://b.github.io'),
    );
  });
});

describe('§4-бис.10 п.9: cookie указателя читает только POST /widget/v1/session', () => {
  it('единственный вызов разбора cookie — в обработчике session; имя cookie вне виджета не встречается', () => {
    const root = path.resolve(__dirname, '../..');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name))
          files.push(p);
      }
    };
    walk(root);
    const callers = files.filter((f) =>
      /resumeKeyFromCookie\(req/.test(fs.readFileSync(f, 'utf8')),
    );
    expect(callers.map((f) => path.relative(root, f))).toEqual([
      'modules/assist-widget/widget-public.controller.ts',
    ]);
    const ctl = fs.readFileSync(callers[0], 'utf8');
    expect(ctl.match(/resumeKeyFromCookie\(req/g)).toHaveLength(1);
    const before = ctl.slice(0, ctl.indexOf('resumeKeyFromCookie(req'));
    expect(
      before.lastIndexOf("@Post(['session', 'session/resume'])"),
    ).toBeGreaterThan(before.lastIndexOf('@Get('));
    const outside = files.filter(
      (f) =>
        !f.includes(`${path.sep}assist-widget${path.sep}`) &&
        !f.endsWith(`${path.sep}brand.ts`) &&
        new RegExp(`WIDGET_RESUME_COOKIE|${C}`).test(
          fs.readFileSync(f, 'utf8'),
        ),
    );
    expect(outside).toEqual([]);
  });
});
