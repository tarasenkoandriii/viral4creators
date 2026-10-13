/**
 * Чистые модули ядра P-A1 (проектный документ §6.1, §6.3, §9.3, §11.4):
 * content-hash, utm, pii-guard, schema-lite, attribution, money.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PII_VECTORS } from '../testing/pii-vectors.testing';
import type { Touch } from './attribution';
import { checkAuditInput } from './audit';
import { PubError } from './errors';
import {
  classifyChannel,
  firstKnown,
  lastNonDirect,
  leadAttribution,
  touchInWindow,
} from './attribution';
import {
  canonicalJson,
  contentVersionHash,
  requestHashOf,
  sourceContentHash,
  type ContentHashInput,
} from './content-hash';
import {
  applyBp,
  convertMinor,
  formatMinor,
  jsonSafe,
  parseFxRate,
  parseMinor,
  sumMinor,
} from './money';
import {
  AUDIT_META_FORBIDDEN_KEYS,
  PII_RULE,
  RESPONSE_FORBIDDEN_KEYS,
  contactValuesIn,
  forbiddenKeysIn,
  looksLikeContact,
  piiIssues,
} from './pii-guard';
import { conforms, jsonBytes, s } from './schema-lite';
import {
  UTM_REDACTED,
  UtmError,
  buildMeasurableUrl,
  cleanUtm,
  cleanUtmValue,
  utmOf,
} from './utm';

describe('content-hash (§6.3, AT-CORE-10)', () => {
  const base: ContentHashInput = {
    title: 'Як обрати',
    body: 'Текст',
    meta: { description: 'Опис', cta: { text: 'Напишіть' } },
    format: 'article',
    offerVersionId: 'ov1',
    offerHash: 'a'.repeat(64),
    parentVersionId: null,
    sources: [
      {
        id: 's2',
        contentHash: 'h2',
        title: 'Прайс',
        visibility: 'private',
        url: null,
      },
      {
        id: 's1',
        contentHash: 'h1',
        title: 'Сайт',
        visibility: 'public',
        url: 'https://x.ua/',
      },
    ],
    claims: [
      { id: 'c1', statement: 'Ціна від 1000', type: 'fact', risk: 'critical' },
    ],
    facts: [
      { id: 'f1', version: 1, value: { amountMinor: 100000, currency: 'UAH' } },
    ],
    claimSources: [
      { claimId: 'c1', sourceId: 's2', supports: 'yes' },
      { claimId: 'c1', sourceId: 's1', supports: 'partial' },
    ],
  };
  const h = contentVersionHash(base);

  it('64 hex, детерминирован, не зависит от порядка связей и ключей meta', () => {
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(
      contentVersionHash({
        ...base,
        meta: { cta: { text: 'Напишіть' }, description: 'Опис' },
        sources: [...base.sources].reverse(),
      }),
    ).toBe(h);
  });

  it('содержимое claim, источника и значения факта меняет hash (а не только id)', () => {
    expect(
      contentVersionHash({
        ...base,
        claims: [{ ...base.claims[0], statement: 'Ціна від 900' }],
      }),
    ).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        claims: [{ ...base.claims[0], risk: 'normal' }],
      }),
    ).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        sources: [{ ...base.sources[1], contentHash: 'h1x' }, base.sources[0]],
      }),
    ).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        facts: [
          { id: 'f1', version: 1, value: { amountMinor: 1, currency: 'UAH' } },
        ],
      }),
    ).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        facts: [{ ...base.facts[0], version: 2 }],
      }),
    ).not.toBe(h);
    expect(contentVersionHash({ ...base, offerHash: 'b'.repeat(64) })).not.toBe(
      h,
    );
    expect(contentVersionHash({ ...base, body: 'Текст.' })).not.toBe(h);
    // аудит P3-13: тип claim входит в hash
    expect(
      contentVersionHash({
        ...base,
        claims: [{ ...base.claims[0], type: 'opinion' }],
      }),
    ).not.toBe(h);
  });

  it('аудит P2-5: метаданные источника (название, видимость, URL) и связи claim → источник входят в hash', () => {
    const src = (patch: Partial<ContentHashInput['sources'][number]>) =>
      contentVersionHash({
        ...base,
        sources: [{ ...base.sources[0], ...patch }, base.sources[1]],
      });
    expect(src({ title: 'Прайс 2026' })).not.toBe(h);
    expect(src({ visibility: 'public' })).not.toBe(h);
    expect(src({ url: 'https://x.ua/price' })).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        claimSources: [{ claimId: 'c1', sourceId: 's2', supports: 'yes' }],
      }),
    ).not.toBe(h);
    expect(
      contentVersionHash({
        ...base,
        claimSources: [
          { claimId: 'c1', sourceId: 's2', supports: 'no' },
          base.claimSources[1],
        ],
      }),
    ).not.toBe(h);
    // порядок связей не важен
    expect(
      contentVersionHash({
        ...base,
        claimSources: [...base.claimSources].reverse(),
      }),
    ).toBe(h);
  });

  it('канонический JSON: ключи по алфавиту, undefined выброшен, не-JSON — ошибка', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 'x' }] })).toBe(
      '{"a":[2,{"c":"x"}],"b":1}',
    );
    expect(() => canonicalJson({ x: NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ x: 1n })).toThrow(TypeError);
    expect(sourceContentHash('https://a.b', 'f')).toBe(
      sourceContentHash('https://a.b', 'f'),
    );
    const A = 'member:a';
    expect(requestHashOf('s', { pid: '1' }, { a: 1 }, A)).not.toBe(
      requestHashOf('s', { pid: '2' }, { a: 1 }, A),
    );
    expect(requestHashOf('s', { pid: '1' }, { a: 1, b: 2 }, A)).toBe(
      requestHashOf('s', { pid: '1' }, { b: 2, a: 1 }, A),
    );
    // аудит P3-13/P3-2: scope и актёр входят в hash
    expect(requestHashOf('s', { pid: '1' }, { a: 1 }, A)).not.toBe(
      requestHashOf('t', { pid: '1' }, { a: 1 }, A),
    );
    expect(requestHashOf('s', { pid: '1' }, { a: 1 }, A)).not.toBe(
      requestHashOf('s', { pid: '1' }, { a: 1 }, 'member:b'),
    );
  });
});

describe('utm (§11.4, AT-CORE-09)', () => {
  it('только четыре ключа (с utm_ и без), email/телефон → [redacted] с флагом', () => {
    expect(
      cleanUtm({
        utm_source: 'telegram',
        medium: 'post',
        utm_term: 'x',
        gclid: 'y',
        campaign: 'a@b.ua',
      }),
    ).toEqual({
      utm: { source: 'telegram', medium: 'post', campaign: UTM_REDACTED },
      redacted: true,
      droppedKeys: ['utm_term', 'gclid'],
    });
    expect(cleanUtm({ content: '+38 (067) 123-45-67' }).utm).toEqual({
      content: UTM_REDACTED,
    });
    // Р-PUB-A0-20: дата в коде кампании похожа на телефон
    expect(cleanUtmValue('pilot_20261016')).toEqual({
      value: UTM_REDACTED,
      redacted: true,
    });
    expect(cleanUtm(null)).toEqual({
      utm: null,
      redacted: false,
      droppedKeys: [],
    });
    expect(cleanUtm({ source: '   ' }).utm).toBeNull();
  });

  it('алфавит [буквы цифры ._:/-], ≤ 100; вырезание не склеивает контакт', () => {
    expect(cleanUtmValue('Осінь<script>!')).toEqual({
      value: 'Осінь script',
      redacted: false,
    });
    expect(cleanUtmValue('x'.repeat(150)).value).toHaveLength(100);
    expect(cleanUtmValue('12#34#56#78')).toEqual({
      value: UTM_REDACTED,
      redacted: true,
    });
  });

  it('аудит P2-2: разделители / _ :, полноширинные цифры, t.me — redacted; даты остаются', () => {
    for (const v of [
      '067/123/45/67',
      '067_123_45_67',
      '067:123:45:67',
      '０６７１２３４５６７',
      't.me/ivan_petrenko',
    ]) {
      expect(cleanUtmValue(v)).toEqual({ value: UTM_REDACTED, redacted: true });
    }
    expect(cleanUtmValue('pilot-2026-10-16')).toEqual({
      value: 'pilot-2026-10-16',
      redacted: false,
    });
    expect(() =>
      buildMeasurableUrl('https://x.ua/', { content: '067/123/45/67' }),
    ).toThrow(UtmError);
  });

  it('измеряемая ссылка: https, метки заменяют прежние, контакт в метке — отказ', () => {
    expect(
      buildMeasurableUrl(
        'https://ai-publisher.org/p/x?utm_source=old&a=1#top',
        {
          source: 'tg',
          medium: 'post',
          campaign: 'pilot',
          content: 'pl-01',
        },
      ),
    ).toBe(
      'https://ai-publisher.org/p/x?a=1&utm_source=tg&utm_medium=post&utm_campaign=pilot&utm_content=pl-01#top',
    );
    expect(() => buildMeasurableUrl('http://x.ua/', { source: 'a' })).toThrow(
      UtmError,
    );
    expect(() =>
      buildMeasurableUrl('https://x.ua/', { source: 'me@x.ua' }),
    ).toThrow(UtmError);
    expect(utmOf('https://x.ua/?utm_content=pl-01')).toEqual({
      content: 'pl-01',
    });
  });
});

describe('pii-guard (§6.1, аудит P2-8, аудит P-A1 P2-2/P2-3/P3-4)', () => {
  it.each(PII_VECTORS.map(([v, c]) => [JSON.stringify(v), v, c] as const))(
    'вектор %s',
    (_label, v, c) => {
      expect(looksLikeContact(v)).toBe(c);
    },
  );

  it('null — не контакт; piiIssues отдаёт поля', () => {
    expect(looksLikeContact(null)).toBe(false);
    expect(piiIssues({ basis: 'ок', reason: 'тел 0671234567' })).toEqual([
      { field: 'reason', code: 'pii' },
    ]);
  });

  it('SQL pub_looks_contact миграции содержит шаблоны PII_RULE дословно', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../../prisma/migrations/20261016090000_publisher_core/migration.sql',
      ),
      'utf8',
    );
    const fn = sql.slice(
      sql.indexOf('CREATE FUNCTION "pub_looks_contact"'),
      sql.indexOf('$$;', sql.indexOf('CREATE FUNCTION "pub_looks_contact"')),
    );
    expect(fn).toContain('normalize(p_v, NFKC)');
    for (const p of [
      PII_RULE.email,
      PII_RULE.messenger,
      PII_RULE.phone,
      ...PII_RULE.strip,
    ]) {
      expect(fn).toContain(`'${p}'`);
    }
    expect(fn.split('regexp_replace(').length - 1).toBe(PII_RULE.strip.length);
  });

  it('ключи ПД на любой глубине — нормализованные, как pub_json_has_keys', () => {
    expect(
      forbiddenKeysIn(
        { a: [{ Phone: 1 }], b: { deep: { noteEnc: 'x' } } },
        AUDIT_META_FORBIDDEN_KEYS,
      ).sort(),
    ).toEqual(['Phone', 'noteEnc']);
    expect(
      forbiddenKeysIn(
        {
          memberDisplayName: 'x',
          parameterKey: 'name',
          contactMethod: 'phone',
          contactDueAt: 'x',
        },
        AUDIT_META_FORBIDDEN_KEYS,
      ),
    ).toEqual([]);
    expect(
      forbiddenKeysIn(
        {
          'e-mail': 1,
          contact_enc: 1,
          workPhone: 1,
          contactPerson: 1,
          FirstName: 1,
          db_password: 1,
        },
        RESPONSE_FORBIDDEN_KEYS,
      ).sort(),
    ).toEqual(
      [
        'FirstName',
        'contactPerson',
        'contact_enc',
        'db_password',
        'e-mail',
        'workPhone',
      ].sort(),
    );
  });

  it('значения-контакты на любой глубине', () => {
    expect(contactValuesIn({ a: 'ок', b: [{ c: 'ivan@x.ua' }], d: 5 })).toEqual(
      ['b[0].c'],
    );
    // id и hash с 7+ цифрами — не телефон
    expect(
      contactValuesIn({ memberId: 'c1234567890', productIds: ['9876543210'] }),
    ).toEqual([]);
    expect(() =>
      checkAuditInput({
        objectType: 'product',
        objectId: 'p1',
        action: 'update',
        meta: { what: 't.me/ivan' },
      }),
    ).toThrow(PubError);
  });
});

describe('schema-lite (§12.1)', () => {
  const sch = s.object({
    a: s.string({ min: 1, max: 3 }),
    b: s.nullable(s.int({ min: 0, max: 2 })),
    c: s.array(s.enum(['x', 'y'] as const), { max: 2, unique: true }),
    d: s.optional(s.boolean()),
  });

  it('строгий объект: лишний ключ, обязательные, null только где разрешён', () => {
    expect(sch.validate({ a: 'ok', b: null, c: ['x'] })).toEqual([]);
    expect(
      sch.validate({ a: '', b: 3, c: ['x', 'x', 'z'], e: 1 }, 'value'),
    ).toEqual([
      { field: 'value.e', code: 'unknown_field' },
      { field: 'value.a', code: 'length' },
      { field: 'value.b', code: 'range' },
      { field: 'value.c', code: 'length' },
      { field: 'value.c[2]', code: 'enum' },
      { field: 'value.c', code: 'duplicate' },
    ]);
    expect(sch.validate({ b: null, c: [] })).toEqual([
      { field: 'a', code: 'required' },
    ]);
    expect(sch.validate({ a: 'x', b: null, c: [], d: 'no' })).toEqual([
      { field: 'd', code: 'type' },
    ]);
    expect(conforms(sch, [])).toBe(false);
    expect(s.string({ min: 1 }).validate('   ')).toEqual([
      { field: '$', code: 'length' },
    ]);
    expect(s.int().validate(1.5)).toEqual([{ field: '$', code: 'type' }]);
    expect(s.record(s.int(), { keys: ['k'] }).validate({ k: 1, z: 2 })).toEqual(
      [{ field: 'z', code: 'unknown_field' }],
    );
    expect(
      s
        .refine(s.object({ x: s.int() }), (v) =>
          v.x > 0 ? null : { field: 'x', code: 'range' },
        )
        .validate({ x: 0 }),
    ).toEqual([{ field: 'x', code: 'range' }]);
    expect(jsonBytes({ a: 'ї' })).toBe(10);
  });
});

describe('attribution (§9.3, AT-F11-02)', () => {
  const t = (
    at: string,
    channelGroup: Touch['channelGroup'],
    placementId: string | null = null,
  ): Touch => ({
    at: new Date(at),
    channelGroup,
    source: channelGroup,
    placementId,
  });
  const lead = new Date('2026-11-20T12:00:00+02:00');

  it('последний непрямой за 30 дней Kyiv (граница включена); прямые пропускаются; нет истории — unknown', () => {
    const touches = [
      t('2026-10-21T12:00:00+03:00', 'paid_placement', 'pl1'),
      t('2026-11-10T10:00:00+02:00', 'organic_search'),
      t('2026-11-19T10:00:00+02:00', 'direct_unknown'),
    ];
    expect(lastNonDirect(touches, lead)).toBe(touches[1]);
    expect(firstKnown(touches, lead)).toBe(touches[0]);
    // ровно 30 дней (через переход) — ещё в окне, на минуту раньше — вне
    expect(
      touchInWindow(t('2026-10-21T12:00:00+03:00', 'organic_search'), lead),
    ).toBe(true);
    expect(
      touchInWindow(t('2026-10-21T11:59:00+03:00', 'organic_search'), lead),
    ).toBe(false);
    expect(
      lastNonDirect([t('2026-11-19T10:00:00+02:00', 'direct_unknown')], lead),
    ).toBe('unknown');
    expect(
      lastNonDirect([t('2026-11-21T10:00:00+02:00', 'organic_search')], lead),
    ).toBe('unknown');
    expect(leadAttribution([], lead)).toEqual({
      model: 'last_non_direct_30d',
      last: null,
      first: null,
      coverage: 'unknown',
    });
  });

  it('классификация: реестр размещений → utm_medium → хост перехода → прямой; paid только с placementId', () => {
    const own = ['ai-publisher.org'];
    expect(
      classifyChannel({
        placementId: 'pl',
        utmMedium: null,
        referrerHost: null,
        ownHosts: own,
      }),
    ).toBe('paid_placement');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: 'cpc',
        referrerHost: null,
        ownHosts: own,
      }),
    ).toBe('other_referral');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: 'social',
        referrerHost: null,
        ownHosts: own,
      }),
    ).toBe('unpaid_social_community');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: null,
        referrerHost: 'www.google.com.ua',
        ownHosts: own,
      }),
    ).toBe('organic_search');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: null,
        referrerHost: 't.me',
        ownHosts: own,
      }),
    ).toBe('unpaid_social_community');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: null,
        referrerHost: 'www.ai-publisher.org',
        ownHosts: own,
      }),
    ).toBe('direct_unknown');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: null,
        referrerHost: 'blog.example',
        ownHosts: own,
      }),
    ).toBe('other_referral');
    expect(
      classifyChannel({
        placementId: null,
        utmMedium: '(none)',
        referrerHost: null,
        ownHosts: own,
      }),
    ).toBe('direct_unknown');
  });
});

describe('money (§1 п.9)', () => {
  it('суммы — bigint; JSON — строка цифр; без плавающей точки', () => {
    expect(parseMinor('1500')).toBe(1500n);
    expect(parseMinor(-20)).toBe(-20n);
    expect(parseMinor(1.5)).toBeNull();
    expect(parseMinor('01')).toBeNull();
    expect(parseMinor('1e3')).toBeNull();
    expect(sumMinor([1n, 2n, 3n])).toBe(6n);
    expect(
      jsonSafe({
        a: 1n,
        d: new Date('2026-01-01T00:00:00Z'),
        x: undefined,
        l: [2n],
      }),
    ).toEqual({
      a: '1',
      d: '2026-01-01T00:00:00.000Z',
      l: ['2'],
    });
    expect(formatMinor(-123456n, 'UAH')).toBe('-1234.56 UAH');
  });

  it('курс Decimal(18,8) и пересчёт с явным округлением (AT-CORE-13)', () => {
    expect(parseFxRate('41.5')).toBe(4_150_000_000n);
    expect(() => parseFxRate('1e2')).toThrow(RangeError);
    expect(convertMinor(10_000n, '41.12345678')).toBe(411_235n);
    expect(convertMinor(10_000n, '41.12345678', 'floor')).toBe(411_234n);
    expect(convertMinor(1n, '0.5', 'half_up')).toBe(1n);
    // допустимый CPL: floor(10 001 × 3 333 × 5 000 / 10^8) = 1 666 (§9.4)
    expect(applyBp(applyBp(10_001n, 3_333), 5_000)).toBe(1_666n);
    expect(() => applyBp(1n, 10_001)).toThrow(RangeError);
  });
});
