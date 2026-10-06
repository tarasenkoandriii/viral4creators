/**
 * Э-С Ш5: чистая часть системного API знаний — подпись (метод, сайт и
 * ключ внутри подписи; окно; формы заголовка), тело, ключ документа,
 * фильтр «похоже на секрет». Вектор подписи — общий с генератором
 * (`backend/src/common/tutorial-knowledge/knowledge-sync.spec.ts`):
 * расхождение = скрипт синхронизации шлёт подпись, которую сервер отвергает.
 */
import {
  KNOWLEDGE_API_DEFAULTS,
  findSecretLike,
  knowledgeRequestDigest,
  parseKnowledgeApiBody,
  signKnowledgeApiRequest,
  validDocumentKey,
  verifyKnowledgeApiRequest,
} from './knowledge-api';

const SECRET = 'knsec_test_vector_0123456789abcdef';
const NOW = 1_790_000_000;

describe('API знаний: подпись', () => {
  const req = {
    method: 'PUT' as const,
    siteId: 'site_1',
    key: 'gen-kb-ru',
    rawBody: '{"title":"База","content":"# Привет"}',
  };

  it('общий вектор с генератором', () => {
    expect(signKnowledgeApiRequest(SECRET, req, NOW)).toBe(SHARED_VECTOR);
  });

  it('своя подпись — ok; чужие метод/сайт/ключ/тело/секрет — mismatch', () => {
    const h = signKnowledgeApiRequest(SECRET, req, NOW);
    expect(verifyKnowledgeApiRequest(SECRET, req, h, NOW)).toBe('ok');
    for (const other of [
      { ...req, method: 'DELETE' as const },
      { ...req, siteId: 'site_2' },
      { ...req, key: 'gen-kb-uk' },
      { ...req, rawBody: `${req.rawBody} ` },
    ]) {
      expect(verifyKnowledgeApiRequest(SECRET, other, h, NOW)).toBe('mismatch');
    }
    expect(verifyKnowledgeApiRequest('knsec_other', req, h, NOW)).toBe(
      'mismatch',
    );
  });

  it('аудит Ш5: отпечаток повтора — от метки и содержимого, не от лишних v1', () => {
    const h = signKnowledgeApiRequest(SECRET, req, NOW);
    const d = knowledgeRequestDigest(SECRET, req, h);
    expect(d).toEqual({ t: NOW, digest: h.split('v1=')[1] });
    expect(
      knowledgeRequestDigest(SECRET, req, ` t = ${NOW} ,v1=${'0'.repeat(64)}`),
    ).toEqual(d);
    expect(
      knowledgeRequestDigest(SECRET, { ...req, key: 'other' }, h)?.digest,
    ).not.toBe(d?.digest);
    expect(knowledgeRequestDigest(SECRET, req, 'garbage')).toBeNull();
  });

  it('окно ±5 мин; формы заголовка', () => {
    const old = signKnowledgeApiRequest(SECRET, req, NOW - 301);
    expect(verifyKnowledgeApiRequest(SECRET, req, old, NOW)).toBe('stale');
    const edge = signKnowledgeApiRequest(SECRET, req, NOW - 300);
    expect(verifyKnowledgeApiRequest(SECRET, req, edge, NOW)).toBe('ok');
    // Аудит тестов: метка из БУДУЩЕГО за окном — тоже stale (|Δt|), на
    // границе окна — ok.
    const future = signKnowledgeApiRequest(SECRET, req, NOW + 301);
    expect(verifyKnowledgeApiRequest(SECRET, req, future, NOW)).toBe('stale');
    const futureEdge = signKnowledgeApiRequest(SECRET, req, NOW + 300);
    expect(verifyKnowledgeApiRequest(SECRET, req, futureEdge, NOW)).toBe('ok');
    expect(verifyKnowledgeApiRequest(SECRET, req, undefined, NOW)).toBe(
      'missing',
    );
    expect(verifyKnowledgeApiRequest(SECRET, req, 'garbage', NOW)).toBe(
      'malformed',
    );
    expect(verifyKnowledgeApiRequest(SECRET, req, `t=${NOW},v1=abc`, NOW)).toBe(
      'malformed',
    );
    expect(
      verifyKnowledgeApiRequest(SECRET, req, `t=${NOW},t=${NOW}`, NOW),
    ).toBe('malformed');
    expect(verifyKnowledgeApiRequest(SECRET, req, 'x'.repeat(700), NOW)).toBe(
      'malformed',
    );
  });
});

describe('API знаний: тело и ключ', () => {
  it('ключ документа', () => {
    for (const k of ['gen-kb-ru', 'a', 'kb.v2_ru', '0']) {
      expect(validDocumentKey(k)).toBe(true);
    }
    for (const k of [
      '',
      'Gen',
      '-a',
      'a-',
      '.a',
      'a/b',
      'a b',
      'x'.repeat(81),
    ]) {
      expect(validDocumentKey(k)).toBe(false);
    }
  });

  it('url документа: https без учётных данных и порта, фрагмент снимается', () => {
    const p = (url: unknown) =>
      parseKnowledgeApiBody(JSON.stringify({ title: 't', content: 'c', url }));
    expect(p('https://v4c.example/ru#faq')).toMatchObject({
      ok: true,
      doc: { url: 'https://v4c.example/ru' },
    });
    expect(p(null)).toMatchObject({ ok: true, doc: { url: null } });
    for (const bad of [
      'http://v4c.example/ru',
      'https://u:p@v4c.example/',
      'https://v4c.example:8443/',
      'javascript:alert(1)',
      'x'.repeat(3000),
      42,
    ]) {
      expect(p(bad)).toEqual({ ok: false, reason: 'url' });
    }
  });

  it('белый список полей, длины, формат', () => {
    const ok = parseKnowledgeApiBody(
      JSON.stringify({ title: ' База ', lang: 'ru', content: '# x' }),
    );
    expect(ok).toEqual({
      ok: true,
      doc: {
        title: 'База',
        lang: 'ru',
        format: 'markdown',
        content: '# x',
        url: null,
      },
    });
    expect(parseKnowledgeApiBody('{')).toEqual({ ok: false, reason: 'json' });
    expect(parseKnowledgeApiBody('[]')).toEqual({ ok: false, reason: 'shape' });
    expect(
      parseKnowledgeApiBody(
        JSON.stringify({ title: 't', content: 'c', extra: 1 }),
      ),
    ).toEqual({ ok: false, reason: 'shape' });
    expect(
      parseKnowledgeApiBody(JSON.stringify({ title: '', content: 'c' })),
    ).toEqual({ ok: false, reason: 'title' });
    expect(
      parseKnowledgeApiBody(JSON.stringify({ title: 'a\nb', content: 'c' })),
    ).toEqual({ ok: false, reason: 'title' });
    expect(
      parseKnowledgeApiBody(
        JSON.stringify({ title: 't', content: 'c', lang: 'rus' }),
      ),
    ).toEqual({ ok: false, reason: 'shape' });
    expect(
      parseKnowledgeApiBody(
        JSON.stringify({ title: 't', content: 'c', format: 'html' }),
      ),
    ).toEqual({ ok: false, reason: 'shape' });
    expect(
      parseKnowledgeApiBody(JSON.stringify({ title: 't', content: '  ' })),
    ).toEqual({ ok: false, reason: 'content' });
    // Аудит тестов: заголовок — до titleMax включительно.
    const T = KNOWLEDGE_API_DEFAULTS.titleMax;
    expect(
      parseKnowledgeApiBody(
        JSON.stringify({ title: 'т'.repeat(T), content: 'c' }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      parseKnowledgeApiBody(
        JSON.stringify({ title: 'т'.repeat(T + 1), content: 'c' }),
      ),
    ).toEqual({ ok: false, reason: 'title' });
    // Аудит тестов: потолок СЫРОГО тела — до разбора, даже когда поля в
    // пределах (пробелы JSON, экранирование раздувают тело).
    const padded = `{"title":"t","content":"c"${' '.repeat(KNOWLEDGE_API_DEFAULTS.bodyMaxBytes)}}`;
    expect(parseKnowledgeApiBody(padded)).toEqual({
      ok: false,
      reason: 'too_large',
    });
    const atCap = `{"title":"t","content":"c"${' '.repeat(KNOWLEDGE_API_DEFAULTS.bodyMaxBytes - 27)}}`;
    expect(Buffer.byteLength(atCap)).toBe(KNOWLEDGE_API_DEFAULTS.bodyMaxBytes);
    expect(parseKnowledgeApiBody(atCap)).toMatchObject({ ok: true });
    const big = 'я'.repeat(KNOWLEDGE_API_DEFAULTS.contentMaxBytes / 2 + 1);
    expect(
      parseKnowledgeApiBody(JSON.stringify({ title: 't', content: big })),
    ).toEqual({ ok: false, reason: 'too_large' });
  });
});

describe('API знаний: «похоже на секрет»', () => {
  const cases: Array<[string, string]> = [
    ['private-key', ['-----BEGIN RSA', 'PRIVATE KEY-----\nMIIE'].join(' ')],
    ['api-key-sk', 'ключ sk-ant-api03-abcdefghijklmnop'],
    ['stripe-key', ['sk', 'live', 'abcdefghijklmnop1234'].join('_')],
    ['google-api-key', ['AIza', 'SyA1234567890abcdefghijklmnopqrstu'].join('')],
    ['aws-access-key', ['AKIA', 'ABCDEFGHIJKLMNOP'].join('')],
    ['github-token', ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_')],
    ['slack-token', ['xoxb', '1234567890', 'abcdef'].join('-')],
    ['telegram-bot-token', '1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'],
    ['platform-secret', ['whsec', 'abcdefghijklmnopqrstuvwxyz'].join('_')],
    ['vercel-blob-token', 'vercel_blob_rw_ABCDEFGHIJ_123'],
    ['bearer', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz'],
    ['credentialed-url', 'postgresql://postgres:hunter2@db.internal:5432/x'],
  ];
  it.each(cases)('%s', (name, text) => {
    expect(findSecretLike(`Текст до. ${text} после.`)).toBe(name);
  });

  it('аудит Ш5: обход кодировками — невидимые символы, полная ширина, %XX, HTML-сущности', () => {
    for (const text of [
      'sk-\u200bant-api03-abcdefghijklmnop',
      'sk-ant-\u00adapi03-abcdefghijklmnop',
      'ghp_\ufeffabcdefghijklmnopqrstuvwxyz0123456789',
      '\uff53\uff4b\uff0dant-api03-abcdefghijklmnop',
      '%73k-ant-api03-abcdefghijklmnop',
      '&#115;k-ant-api03-abcdefghijklmnop',
      '&#x73;k&#x2d;ant-api03-abcdefghijklmnop',
      'knsec\u2060_abcdefghijklmnopqrstuvwxyz',
    ]) {
      expect(findSecretLike(`Текст ${text} после`)).not.toBeNull();
    }
    // Кривые последовательности не роняют проверку.
    expect(findSecretLike('100% готово, %E0%A4%A и &#99999999;')).toBeNull();
  });

  it('обычный текст базы знаний — чисто', () => {
    expect(
      findSecretLike(
        '# База\n- **Проекты** — список роликов. Veo: до 8 секунд, https://example.com/a, 1200 грн, support@example.com, +380 44 123 45 67',
      ),
    ).toBeNull();
  });
});

/**
 * hex HMAC-SHA256("knsec_test_vector_0123456789abcdef",
 *   '1790000000.PUT.site_1.gen-kb-ru.{"title":"База","content":"# Привет"}')
 */
const SHARED_VECTOR =
  't=1790000000,v1=b0e1c9473baf5a322d75cb7f4c5af2db15c7facd1af37be0986d6a9dadec45e9';
