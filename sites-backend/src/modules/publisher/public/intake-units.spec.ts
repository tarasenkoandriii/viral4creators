/**
 * Публичный приём P-D — чистые части (проектный документ §11.4, §13.4–13.5):
 * номер обращения, детерминированный id события успеха, канонический вид
 * тела для HMAC повтора, Origin, тест-флаг по виду/режиму, разбор события
 * (`text/plain`), путь и referrer без данных, хост сборки.
 */
import { validateLeadBody } from '../contracts/lead-validation';
import {
  canonicalBodyJson,
  newPublicRef,
  requestCanonical,
  successEventIdOf,
} from './lead-intake';
import { landingPathOf, parseEventBody, referrerHostOf } from './event-intake';
import {
  PublicError,
  assertIntakeConfigured,
  assertOrigin,
  originOf,
  publicKeyOf,
  testFlagOf,
} from './public-guard';
import { buildHostOf, siteConfigView } from './site-config';

const KEY = `pp_${'a'.repeat(24)}`;
const lead = (over: Record<string, unknown> = {}) => {
  const v = validateLeadBody({
    key: KEY,
    submissionKey: '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
    name: 'Олена',
    contactMethod: 'email',
    contact: 'olena@example.com',
    business: 'Пекарня',
    task: 'Стаття про сервіс',
    dataNoticeVersion: 'draft-1',
    consentState: 'not_required',
    elapsedMs: 5000,
    ...over,
  });
  if (!v.ok) throw new Error(JSON.stringify(v.fields));
  return v.value;
};

describe('lead-intake: номер, событие успеха, канонический вид', () => {
  it('publicRef — L- + 10 base32; разные вызовы — разные номера', () => {
    const refs = new Set(Array.from({ length: 200 }, newPublicRef));
    for (const r of refs) expect(r).toMatch(/^L-[A-Z2-7]{10}$/);
    expect(refs.size).toBe(200);
  });

  it('eventId успеха — UUID v4-вида, детерминирован по leadId (повтор отправки — тот же)', () => {
    const a = successEventIdOf('pl_1');
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(successEventIdOf('pl_1')).toBe(a);
    expect(successEventIdOf('pl_2')).not.toBe(a);
  });

  it('тот же запрос: порядок ключей и время заполнения не влияют; другой текст задачи — влияет', () => {
    expect(canonicalBodyJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe(
      '{"a":[2,{"c":null,"d":1}],"b":1}',
    );
    expect(requestCanonical(lead({ elapsedMs: 100 }))).toBe(
      requestCanonical(lead({ elapsedMs: 900_000 })),
    );
    expect(requestCanonical(lead())).not.toBe(
      requestCanonical(lead({ task: 'Інша задача' })),
    );
    expect(requestCanonical(lead())).not.toContain(KEY);
  });
});

describe('public-guard: ключ, Origin, тест-флаг', () => {
  it('ключ — формат pp_ + 24; иначе 400 PUB_VALIDATION', () => {
    expect(publicKeyOf(` ${KEY} `)).toBe(KEY);
    for (const bad of [undefined, '', 'pk_x', `pp_${'a'.repeat(23)}`, 42]) {
      expect(() => publicKeyOf(bad)).toThrow(PublicError);
    }
  });

  it('Origin: из списка режима — да; чужой — 403; без Origin — только GET', () => {
    const p = {
      allowedOrigins: ['https://ai-publisher.org', 'https://test.example:8443'],
    };
    expect(() =>
      assertOrigin(p, 'https://ai-publisher.org', 'POST'),
    ).not.toThrow();
    expect(() =>
      assertOrigin(p, 'https://test.example:8443', 'POST'),
    ).not.toThrow();
    expect(() => assertOrigin(p, 'https://evil.example', 'POST')).toThrow(
      PublicError,
    );
    expect(() => assertOrigin(p, 'http://ai-publisher.org', 'GET')).toThrow(
      PublicError,
    );
    expect(() => assertOrigin(p, undefined, 'GET')).not.toThrow();
    expect(() => assertOrigin(p, undefined, 'POST')).toThrow(PublicError);
    expect(originOf({ headers: { origin: 'HTTPS://AI-Publisher.org/' } })).toBe(
      'https://ai-publisher.org',
    );
    expect(originOf({ headers: { origin: 'null' } })).toBeUndefined();
  });

  it('без строки publisher_public приём закрыт честным 503 PUB_FORM_CLOSED (intake_unavailable)', () => {
    let err: unknown;
    try {
      assertIntakeConfigured({ configured: false } as never);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PublicError);
    expect((err as PublicError).getStatus()).toBe(503);
    expect((err as PublicError).details).toEqual({
      altContact: null,
      reason: 'intake_unavailable',
    });
    expect(() =>
      assertIntakeConfigured({ configured: true } as never),
    ).not.toThrow();
  });

  it('тест-флаг: тестовый продукт → test_product; рабочий не в live → test_mode; live рабочего → нетестовая', () => {
    expect(testFlagOf({ kind: 'test', mode: 'test' })).toEqual({
      testFlag: true,
      testReason: 'test_product',
    });
    expect(testFlagOf({ kind: 'working', mode: 'test' })).toEqual({
      testFlag: true,
      testReason: 'test_mode',
    });
    expect(testFlagOf({ kind: 'working', mode: 'live' })).toEqual({
      testFlag: false,
      testReason: null,
    });
  });
});

describe('event-intake: разбор и очистка события', () => {
  const now = new Date('2026-10-20T10:00:00Z');
  const base = {
    key: KEY,
    eventId: '1B4E28BA-2FA1-41D2-883F-0016D3CCA427',
    name: 'cta_click',
    consentState: 'unknown',
  };

  it('text/plain с JSON разбирается; eventId — в нижний регистр; битый JSON → body/json', () => {
    const r = parseEventBody(JSON.stringify(base), now);
    expect(r.ok && r.value.eventId).toBe(
      '1b4e28ba-2fa1-41d2-883f-0016d3cca427',
    );
    expect(parseEventBody('{"key":', now)).toEqual({
      ok: false,
      fields: [{ field: 'body', code: 'json' }],
    });
    expect(parseEventBody([], now)).toEqual({
      ok: false,
      fields: [{ field: '$', code: 'type' }],
    });
  });

  it('обязательные поля и закрытые списки; lead_submit_success от клиента — отказ', () => {
    const r = parseEventBody(
      {
        ...base,
        name: 'lead_submit_success',
        consentState: 'maybe',
        eventId: 'x',
      },
      now,
    );
    expect(r).toEqual({
      ok: false,
      fields: [
        { field: 'eventId', code: 'format' },
        { field: 'name', code: 'enum' },
        { field: 'consentState', code: 'enum' },
      ],
    });
  });

  it('мягкие поля: slug/код размещения кривые или похожие на контакт — отброшены; sessionRef — формат; clientAt дальше 12 ч — null', () => {
    const r = parseEventBody(
      {
        ...base,
        contentSlug: '0671234567',
        placementCode: 'BAD CODE',
        sessionRef: 'short',
        clientAt: '2026-10-10T10:00:00Z',
      },
      now,
    );
    expect(r.ok && r.value).toMatchObject({
      contentSlug: null,
      placementCode: null,
      sessionRef: null,
      clientAt: null,
    });
    const ok = parseEventBody(
      {
        ...base,
        contentSlug: 'kak-vybraty',
        placementCode: 'pl-1',
        sessionRef: 'sref_Ab3-x9_kQ2',
        clientAt: '2026-10-20T09:59:00Z',
      },
      now,
    );
    expect(ok.ok && ok.value).toMatchObject({
      contentSlug: 'kak-vybraty',
      placementCode: 'pl-1',
      sessionRef: 'sref_Ab3-x9_kQ2',
    });
    // S3-2: формат подходит, но похоже на телефон — не хранится.
    for (const sessionRef of [
      '380671234567',
      '0501234567x',
      'sr_067-123-45-67',
    ]) {
      const ph = parseEventBody({ ...base, sessionRef }, now);
      expect({ sessionRef, kept: ph.ok && ph.value.sessionRef }).toEqual({
        sessionRef,
        kept: null,
      });
    }
  });

  it('путь — без query/фрагмента, с @ или не от / — «/»; referrer — только хост', () => {
    expect(landingPathOf('/materials/a?email=x@y.z#top')).toBe('/materials/a');
    expect(landingPathOf('/u/@ivan')).toBe('/');
    expect(landingPathOf('materials/a')).toBe('/');
    expect(landingPathOf(undefined)).toBe('/');
    // S3-2: сегмент, похожий на телефон/контакт, — весь путь «/»; даты — не контакт.
    expect(landingPathOf('/call-me/380671234567/ivan.petrenko')).toBe('/');
    expect(landingPathOf('/c/%2B380%2067%20123%2045%2067')).toBe('/');
    expect(landingPathOf('/c/t.me%2Fivan')).toBe('/');
    expect(landingPathOf('/c/%E0%A4%A')).toBe('/');
    expect(landingPathOf('/blog/guide-2026-10-16')).toBe(
      '/blog/guide-2026-10-16',
    );
    expect(landingPathOf('/materials/kak-vybraty')).toBe(
      '/materials/kak-vybraty',
    );
    expect(referrerHostOf('https://www.Google.com/search?q=0671234567')).toBe(
      'www.google.com',
    );
    expect(referrerHostOf('t.me')).toBe('t.me');
    expect(referrerHostOf('ivan@example.com')).toBeNull();
    expect(referrerHostOf('')).toBeNull();
  });
});

describe('site-config: хост сборки и представление', () => {
  it('хост: без схемы, пути и :443; кривой — null', () => {
    expect(buildHostOf('https://AI-Publisher.org:443/materials')).toBe(
      'ai-publisher.org',
    );
    expect(buildHostOf('test.example:8443')).toBe('test.example:8443');
    expect(buildHostOf('bad host')).toBeNull();
  });

  it('indexable — только хост из indexableHosts; лимит формы отдаётся сайту', () => {
    const p = {
      id: 'p',
      accountId: 'a',
      publicKey: KEY,
      kind: 'working' as const,
      mode: 'live' as const,
      formOpen: true,
      allowedOrigins: ['https://ai-publisher.org'],
      indexableHosts: ['ai-publisher.org'],
      altContact: { label: 'x', href: null },
      formLimitCount: 5,
      formLimitWindowSec: 600,
      analyticsStorage: 'none' as const,
      consentState: 'not_required' as const,
      dataNotice: null,
      faq: [],
      offer: null,
      contactSla: { rule: 'next_business_day_end' },
    };
    expect(siteConfigView(p, 'ai-publisher.org').indexable).toBe(true);
    expect(siteConfigView(p, 'preview.vercel.app').indexable).toBe(false);
    expect(siteConfigView(p, null)).toMatchObject({
      indexable: false,
      formLimit: { count: 5, windowSec: 600 },
      contactSla: { rule: 'next_business_day_end' },
    });
    // Р-PUB-Z2-9: нет утверждённого правила — null (сайт берёт умолчание).
    expect(siteConfigView({ ...p, contactSla: null }, null).contactSla).toBe(
      null,
    );
  });
});
