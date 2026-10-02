/**
 * Чистые модули кабинета виджета (W4): персона, форма лида, ключи, код
 * вставки и CSP-фрагмент, сигнатуры картинок (приёмка 5а: SVG со
 * `<script>`/`onload` — отказ), разбор CSP страницы (приёмка п.2).
 */
import {
  WIDGET_LOADER_PATH,
  WIDGET_ORIGIN_DEFAULT,
  WIDGET_PK_LIVE_PREFIX,
  WIDGET_PK_TEST_PREFIX,
} from '../../brand';
import { ASSET_MAX_BYTES, decodeBase64Strict, sniffImage } from './assets';
import {
  findLoaderTag,
  metaCsp,
  microphoneBlocked,
  missingCspDirectives,
} from './install-check.service';
import { generatePublicKey, parsePublicKey } from './keys';
import { defaultLeadsConfig, parseLeadsConfig } from './leads-config';
import { PERSONA_LIMITS, defaultPersona, parsePersona } from './persona';
import { buildCspSnippet, buildEmbedSnippet } from './snippet';
import {
  SVG_SCRIPT,
  jpegBytes,
  pngBytes,
  webpBytes,
} from './testing/images.testing';
import { defaultWidgetConfig } from './widget-config';

// Свой origin теста: функции принимают origin параметром (имена бренда — только brand.ts).
const W = 'https://w.cdn-test.example';
const LIVE = WIDGET_PK_LIVE_PREFIX;
const TEST = WIDGET_PK_TEST_PREFIX;

describe('картинки бренда: только сигнатура PNG/JPEG/WebP', () => {
  it('PNG, JPEG, WebP — тип и размеры из заголовка', () => {
    expect(sniffImage(pngBytes(200, 100))).toEqual({
      mime: 'image/png',
      width: 200,
      height: 100,
    });
    expect(sniffImage(jpegBytes(128, 256))).toEqual({
      mime: 'image/jpeg',
      width: 128,
      height: 256,
    });
    expect(sniffImage(webpBytes(300, 300))).toEqual({
      mime: 'image/webp',
      width: 300,
      height: 300,
    });
  });

  it('SVG со <script>/onload, HTML, GIF, пусто — отказ (приёмка 5а)', () => {
    for (const s of [
      SVG_SCRIPT,
      `<?xml version="1.0"?>${SVG_SCRIPT}`,
      '<html><img src=x onerror=alert(1)></html>',
      'GIF89a\x01\x00\x01\x00',
      '',
      '\x89PNG',
    ]) {
      expect(sniffImage(Buffer.from(s, 'latin1'))).toBeNull();
    }
  });

  it('нулевые и гигантские размеры — не картинка', () => {
    expect(sniffImage(pngBytes(0, 10))).toBeNull();
    expect(sniffImage(pngBytes(10, 100_000))).toBeNull();
  });

  it('base64: строгий, без data:-префикса; лимит до декодирования', () => {
    expect(decodeBase64Strict('aGVsbG8=', 10)).toEqual(Buffer.from('hello'));
    expect(
      decodeBase64Strict('data:image/png;base64,aGVsbG8=', 100),
    ).toBeNull();
    expect(decodeBase64Strict('aGVs bG8=', 100)).toBeNull();
    expect(decodeBase64Strict('', 100)).toBeNull();
    expect(decodeBase64Strict(5, 100)).toBeNull();
    const big = Buffer.alloc(ASSET_MAX_BYTES + 1).toString('base64');
    expect(decodeBase64Strict(big, ASSET_MAX_BYTES)).toBe('too_large');
    const max = Buffer.alloc(ASSET_MAX_BYTES).toString('base64');
    expect(Buffer.isBuffer(decodeBase64Strict(max, ASSET_MAX_BYTES))).toBe(
      true,
    );
  });
});

describe('публичные ключи (live/test)', () => {
  it('формат и разбор', () => {
    const live = generatePublicKey('live');
    const test = generatePublicKey('test');
    expect(live).toMatch(new RegExp(`^${LIVE}[0-9A-Za-z]{24}$`));
    expect(test).toMatch(new RegExp(`^${TEST}[0-9A-Za-z]{24}$`));
    expect(parsePublicKey(live)).toEqual({ kind: 'live', key: live });
    expect(parsePublicKey(test)).toEqual({ kind: 'test', key: test });
    for (const bad of [
      `${LIVE}short`,
      `${live}x`,
      `pk_other_${live.slice(8)}`,
      `${LIVE}${'a'.repeat(23)}!`,
      ` ${live}`,
      null,
      42,
    ]) {
      expect(parsePublicKey(bad)).toBeNull();
    }
  });

  it('неугадываемы: 2000 ключей без повторов, все символы base62 встречаются', () => {
    const seen = new Set<string>();
    const chars = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const k = generatePublicKey('live');
      seen.add(k);
      for (const c of k.slice(8)) chars.add(c);
    }
    expect(seen.size).toBe(2000);
    expect(chars.size).toBe(62);
  });
});

describe('код вставки и CSP-фрагмент', () => {
  const pk = generatePublicKey('live');

  it('один тег async с нашим origin и data-site', () => {
    const s = buildEmbedSnippet({
      publicKey: pk,
      widgetOrigin: W,
      config: defaultWidgetConfig('x'),
    });
    expect(s).toBe(
      `<script async src="${W}${WIDGET_LOADER_PATH}" data-site="${pk}"></script>`,
    );
    // Код вставки находит собственная проверка установки.
    expect(findLoaderTag(`<body>${s}</body>`, W, [pk])).toBe(true);
  });

  it('мусорный ключ или не-https origin — исключение (не в HTML)', () => {
    const config = defaultWidgetConfig('x');
    expect(() =>
      buildEmbedSnippet({ publicKey: '"><script>', widgetOrigin: W, config }),
    ).toThrow();
    expect(() =>
      buildEmbedSnippet({ publicKey: pk, widgetOrigin: 'http://w.x', config }),
    ).toThrow();
  });

  it('CSP-фрагмент: 4 директивы с нашим origin; сайт с ним — ничего не не хватает', () => {
    const csp = buildCspSnippet(W);
    expect(csp.split('\n')).toEqual([
      `script-src ${W};`,
      `frame-src ${W};`,
      `img-src ${W} data:;`,
      `connect-src ${W};`,
    ]);
    expect(buildCspSnippet(WIDGET_ORIGIN_DEFAULT)).toContain(
      WIDGET_ORIGIN_DEFAULT,
    );
    // Политика сайта = «default-src 'self'» + наш фрагмент → всё разрешено.
    const site = `default-src 'self'; ${csp.replace(/\n/g, ' ')}`;
    expect(missingCspDirectives(site, W)).toEqual([]);
  });
});

describe('microphoneBlocked (Э5, §4.10: микрофон в чужом iframe)', () => {
  it('нет заголовков или наш origin/* в списке — можно', () => {
    expect(microphoneBlocked(null, null, W)).toBe(false);
    expect(microphoneBlocked('camera=()', null, W)).toBe(false);
    expect(microphoneBlocked('microphone=*', null, W)).toBe(false);
    expect(
      microphoneBlocked(`geolocation=(), microphone=(self "${W}")`, null, W),
    ).toBe(false);
    expect(
      microphoneBlocked(null, `camera 'none'; microphone 'self' ${W}`, W),
    ).toBe(false);
  });
  it("пустой список, только self, чужой origin, 'none' — нельзя", () => {
    expect(microphoneBlocked('microphone=()', null, W)).toBe(true);
    expect(microphoneBlocked('microphone=(self)', null, W)).toBe(true);
    expect(
      microphoneBlocked('microphone=("https://other.example")', null, W),
    ).toBe(true);
    expect(microphoneBlocked('microphone=self', null, W)).toBe(true);
    expect(microphoneBlocked(null, "microphone 'none'", W)).toBe(true);
    expect(microphoneBlocked(null, "microphone 'self'", W)).toBe(true);
  });
});

describe('missingCspDirectives (приёмка п.2: «вероятно, CSP»)', () => {
  it('нет CSP — ничего не не хватает', () => {
    expect(missingCspDirectives(null, W)).toEqual([]);
    expect(missingCspDirectives('', W)).toEqual([]);
    expect(missingCspDirectives('upgrade-insecure-requests', W)).toEqual([]);
  });

  it("default-src 'self' без наших директив — все четыре", () => {
    expect(missingCspDirectives("default-src 'self'", W)).toEqual([
      'script-src',
      'frame-src',
      'img-src',
      'connect-src',
    ]);
  });

  it('частичная политика — только недостающие; fallback child-src и script-src-elem', () => {
    expect(
      missingCspDirectives(
        `default-src 'self'; script-src 'self' ${W}; img-src * data:`,
        W,
      ),
    ).toEqual(['frame-src', 'connect-src']);
    expect(
      missingCspDirectives(
        `default-src 'none'; child-src ${W}; script-src-elem https:; img-src https:; connect-src https:`,
        W,
      ),
    ).toEqual([]);
    expect(
      missingCspDirectives(`script-src-elem 'self'; script-src ${W}`, W),
    ).toEqual(['script-src']);
  });

  it('wildcard-хосты, схема, путь, порт', () => {
    expect(missingCspDirectives(`default-src *.cdn-test.example`, W)).toEqual(
      [],
    );
    expect(missingCspDirectives(`default-src https://*.example`, W)).toEqual(
      [],
    );
    expect(
      missingCspDirectives(`default-src w.cdn-test.example:443`, W),
    ).toEqual([]);
    expect(
      missingCspDirectives(`default-src w.cdn-test.example:8443`, W),
    ).toHaveLength(4);
    expect(missingCspDirectives(`default-src ${W}/v1/`, W)).toEqual([
      'frame-src',
      'img-src',
      'connect-src',
    ]);
    // *.apex не покрывает сам apex; чужой домен с нашим суффиксом — не наш.
    expect(
      missingCspDirectives(`default-src *.w.cdn-test.example`, W),
    ).toHaveLength(4);
    expect(
      missingCspDirectives(`default-src https://evilw.cdn-test.example`, W),
    ).toHaveLength(4);
  });

  it("'strict-dynamic' — хост-источник для тега не действует; 'none' — блок", () => {
    expect(
      missingCspDirectives(
        `script-src 'nonce-abc' 'strict-dynamic' ${W}; default-src *`,
        W,
      ),
    ).toEqual(['script-src']);
    expect(missingCspDirectives(`img-src 'none'`, W)).toEqual(['img-src']);
  });

  it('несколько политик (через запятую): нужно пройти каждую', () => {
    expect(
      missingCspDirectives(`default-src *, connect-src 'self'`, W),
    ).toEqual(['connect-src']);
  });

  it('CSP из <meta http-equiv> и поиск тега', () => {
    const pk = generatePublicKey('live');
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src *"><meta name="x" content="y"></head><body><script async src="${W}${WIDGET_LOADER_PATH}" data-site='${pk}'></script></body></html>`;
    expect(metaCsp(html)).toEqual(["default-src 'self'; img-src *"]);
    expect(findLoaderTag(html, W, [pk])).toBe(true);
    expect(findLoaderTag(html, W, [`${LIVE}other`])).toBe(false);
    expect(
      findLoaderTag(html.replace(W, 'https://evil.example'), W, [pk]),
    ).toBe(false);
  });
});

describe('персона', () => {
  it('умолчание проходит собственную проверку; язык по шаблону', () => {
    const d = defaultPersona('ru');
    expect(parsePersona(d)).toEqual({ ok: true, persona: d });
    expect(defaultPersona('<x>').languages.default).toBe('uk');
  });

  it('лимиты, языки, управляющие символы — отказ с путём', () => {
    const d = defaultPersona('uk');
    const bad = (patch: Record<string, unknown>) => {
      const r = parsePersona({ ...d, ...patch });
      if (r.ok) throw new Error('ожидался отказ');
      return r.errors;
    };
    expect(bad({ tone: 'rude' })).toContainEqual({
      path: 'tone',
      code: 'enum',
    });
    expect(bad({ style: 'x'.repeat(PERSONA_LIMITS.style + 1) })).toContainEqual(
      {
        path: 'style',
        code: 'too_long',
      },
    );
    expect(
      bad({
        forbiddenTopics: Array(PERSONA_LIMITS.forbiddenTopics + 1).fill('a'),
      }),
    ).toContainEqual({ path: 'forbiddenTopics', code: 'too_many' });
    expect(bad({ examples: ['a‮b'] })).toContainEqual({
      path: 'examples[0]',
      code: 'control_chars',
    });
    expect(
      bad({
        languages: { mode: 'auto', allowed: ['uk', 'EN'], default: 'uk' },
      }),
    ).toContainEqual({ path: 'languages.allowed[1]', code: 'lang' });
    expect(
      bad({ languages: { mode: 'auto', allowed: ['uk'], default: 'en' } }),
    ).toContainEqual({ path: 'languages.default', code: 'not_in_allowed' });
  });

  it('стоп-фразы — нижний регистр, дубли и пустые убираются; style многострочный', () => {
    const r = parsePersona({
      ...defaultPersona('uk'),
      style: 'Коротко.\r\nНа «ты».',
      stopPhrases: ['Скидка', 'скидка', '  ', 'ГАРАНТИЯ'],
      extra: 'x',
    });
    if (!r.ok) throw new Error('ожидался успех');
    expect(r.persona.stopPhrases).toEqual(['скидка', 'гарантия']);
    expect(r.persona.style).toBe('Коротко.\nНа «ты».');
    expect(Object.keys(r.persona)).not.toContain('extra');
  });
});

describe('форма лида', () => {
  it('умолчание проходит; канал — только telegram', () => {
    const d = defaultLeadsConfig();
    expect(parseLeadsConfig(d)).toEqual({ ok: true, config: d });
    expect(d.consentText.uk).toBeTruthy();
    const r = parseLeadsConfig({ ...d, channels: ['email'] });
    expect(r.ok).toBe(false);
  });

  it('без телефона и e-mail — отказ; дубль поля — отказ; согласие ≤ 1000', () => {
    const d = defaultLeadsConfig();
    const errs = (patch: Record<string, unknown>) => {
      const r = parseLeadsConfig({ ...d, ...patch });
      return r.ok ? [] : r.errors;
    };
    expect(
      errs({ fields: [{ field: 'name', required: true }] }),
    ).toContainEqual({ path: 'fields', code: 'contact_required' });
    expect(
      errs({
        fields: [
          { field: 'phone', required: true },
          { field: 'phone', required: false },
        ],
      }),
    ).toContainEqual({ path: 'fields[1]', code: 'duplicate' });
    expect(errs({ consentText: { uk: 'я'.repeat(1001) } })).toContainEqual({
      path: 'consentText.uk',
      code: 'too_long',
    });
    expect(errs({ consentText: {} })).toContainEqual({
      path: 'consentText',
      code: 'required',
    });
    expect(
      errs({ fields: [{ field: 'passport', required: true }] }),
    ).toContainEqual({
      path: 'fields[0]',
      code: 'type',
    });
  });
});
