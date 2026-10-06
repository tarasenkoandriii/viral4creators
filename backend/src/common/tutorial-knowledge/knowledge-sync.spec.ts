/**
 * Э-С Ш5: синхронизация базы знаний генератора в тенант платформы —
 * документы без штампа сборки (идемпотентность: та же база → тот же
 * текст), проверка утечек секретов и ПДн ДО сети, подпись (общий вектор с
 * sites-backend `knowledge-api.spec.ts`), план удаления только своих
 * ключей, прогон на подменённой сети.
 */
import { ASSISTANT_KNOWLEDGE } from './generated';
import {
  SYNC_SIGNATURE_HEADER,
  buildSyncDocuments,
  findKnowledgeLeaks,
  landingPageBase,
  planSync,
  runKnowledgeSync,
  signKnowledgeRequest,
  stripBuildStamp,
  syncConfigFromEnv,
  type FetchLike,
  type SyncDocument,
} from './knowledge-sync';
import { buildAll } from '../../../scripts/build-assistant-knowledge';

const SECRET = 'knsec_test_vector_0123456789abcdef';

describe('knowledge-sync: документы', () => {
  it('документ на локаль, ключ gen-kb-<локаль>, без штампа сборки', () => {
    const docs = buildSyncDocuments(ASSISTANT_KNOWLEDGE);
    expect(docs.map((d) => d.key)).toEqual([
      'gen-kb-de',
      'gen-kb-en',
      'gen-kb-es',
      'gen-kb-ru',
      'gen-kb-uk',
    ]);
    for (const d of docs) {
      expect(d.content).not.toMatch(/Собрано автоматически/);
      expect(d.content).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
      expect(d.title).toMatch(new RegExp(`\\(${d.lang}\\)$`));
      expect(d.content.startsWith('# ')).toBe(true);
    }
  });

  it('пересборка базы в другой день и на другом коммите даёт ТОТ ЖЕ документ (иначе каждая синхронизация — новая версия)', () => {
    const fresh = buildAll();
    const restamped: Record<string, string> = {};
    for (const [k, v] of Object.entries(fresh)) {
      restamped[k] = v
        .replace(/\d{4}-\d{2}-\d{2}/, '2031-01-01')
        .replace(/(коммит — )[^.]*\./, '$1deadbeef.');
    }
    expect(buildSyncDocuments(restamped)).toEqual(buildSyncDocuments(fresh));
    expect(buildSyncDocuments(fresh)).toEqual(
      buildSyncDocuments(ASSISTANT_KNOWLEDGE),
    );
  });

  it('адрес страницы лендинга локали — только https-origin LANDING_PUBLIC_URL', () => {
    const base = landingPageBase('https://viral4creators.example/ru?x=1');
    expect(base).toBe('https://viral4creators.example');
    expect(
      buildSyncDocuments({ ru: '# База\n\nx\n' }, base).map((d) => d.url),
    ).toEqual(['https://viral4creators.example/ru']);
    expect(landingPageBase('http://viral4creators.example')).toBeNull();
    expect(landingPageBase('nonsense')).toBeNull();
    expect(landingPageBase(undefined)).toBeNull();
    expect(buildSyncDocuments({ ru: '# База\n\nx\n' })[0].url).toBeNull();
  });

  it('штамп снимается только в шапке', () => {
    const md = '# T\n\n_Собрано 2026-01-01_\n\nтекст\n\n_пример 2026-02-02_\n';
    expect(stripBuildStamp(md)).toBe('# T\n\nтекст\n\n_пример 2026-02-02_\n');
  });

  it('в настоящей базе нет ни секретов, ни ПДн', () => {
    for (const d of buildSyncDocuments(ASSISTANT_KNOWLEDGE)) {
      expect({ key: d.key, leaks: findKnowledgeLeaks(d.content) }).toEqual({
        key: d.key,
        leaks: [],
      });
    }
  });
});

describe('knowledge-sync: утечки', () => {
  const cases: Array<[string, string]> = [
    ['private-key', ['-----BEGIN', 'PRIVATE KEY-----'].join(' ')],
    ['api-key-sk', 'sk-proj-abcdefghijklmnopqrstu'],
    ['google-api-key', ['AIza', 'SyA1234567890abcdefghijklmnopqrstu'].join('')],
    ['telegram-bot-token', '1234567890:AAH-abcdefghijklmnopqrstuvwxyz012345'],
    ['platform-secret', 'knsec_abcdefghijklmnopqrstuvwxyz'],
    ['credentialed-url', 'postgres://user:pw@localhost:5432/db'],
    ['widget-public-key', 'pk_live_ABCDEFGHIJKLMNOPQRSTUVWX'],
    ['env-assignment', 'GEMINI_API_KEY=abcdef123456'],
    ['email', 'пишите на owner@viral4creators.example'],
    ['phone', 'звоните +380 44 123 45 67'],
    ['iban', 'UA21 3223 1300 0002 6007 2335 6600 1'],
    ['card-number', 'карта 4111 1111 1111 1111'],
    // Аудит Ш5: внутренние адреса и обход кодировками.
    ['internal-url', 'API: http://localhost:3001/api'],
    ['internal-url', 'сервис http://backend.railway.internal/x'],
    ['internal-url', 'https://10.0.0.12:8080'],
    [
      'vercel-preview-host',
      'https://v4c-landing-git-feature-x-acme.vercel.app',
    ],
    ['supabase-project-host', 'abcdefghijklmnopqrst.supabase.co'],
    ['api-key-sk', 'sk-\u200bproj-abcdefghijklmnopqrstu'],
    ['platform-secret', 'knsec&#95;abcdefghijklmnopqrstuvwxyz'],
    ['email', 'owner%40viral4creators.example'],
  ];
  it.each(cases)('%s', (rule, text) => {
    expect(findKnowledgeLeaks(`до ${text} после`)).toContain(rule);
  });

  it('аудит Ш5: обычные адреса и текст — не «внутренние»', () => {
    expect(
      findKnowledgeLeaks(
        'Сайт https://viral4creators.app/ru, ролик на https://example.com/local-news; 100% готово',
      ),
    ).toEqual([]);
  });

  it('не номер карты, если не сходится Лун', () => {
    expect(findKnowledgeLeaks('1234 5678 9012 3456')).not.toContain(
      'card-number',
    );
  });
});

describe('knowledge-sync: подпись и план', () => {
  it('общий вектор с sites-backend', () => {
    expect(
      signKnowledgeRequest(
        SECRET,
        {
          method: 'PUT',
          siteId: 'site_1',
          key: 'gen-kb-ru',
          rawBody: '{"title":"База","content":"# Привет"}',
        },
        1_790_000_000,
      ),
    ).toBe(
      't=1790000000,v1=b0e1c9473baf5a322d75cb7f4c5af2db15c7facd1af37be0986d6a9dadec45e9',
    );
  });

  it('удаляются только свои ключи, которых больше нет', () => {
    const local = [
      { key: 'gen-kb-ru' },
      { key: 'gen-kb-uk' },
    ] as SyncDocument[];
    expect(
      planSync(local, ['gen-kb-ru', 'gen-kb-xx', 'owner-faq', 'gen-old'])
        .remove,
    ).toEqual(['gen-kb-xx', 'gen-old']);
  });

  it('конфиг из env: чего не хватает — имена, без значений', () => {
    expect(syncConfigFromEnv({})).toEqual({
      ok: false,
      missing: [
        'SITES_BACKEND_URL',
        'ASSIST_LANDING_SITE_ID',
        'ASSIST_KNOWLEDGE_API_KEY',
      ],
    });
    expect(
      syncConfigFromEnv({
        SITES_BACKEND_URL: 'http://evil.example',
        ASSIST_LANDING_SITE_ID: 'site_1',
        ASSIST_KNOWLEDGE_API_KEY: ['whsec', 'abcdefghijklmnopqrstuvwxyz'].join(
          '_',
        ),
      }),
    ).toEqual({
      ok: false,
      missing: ['SITES_BACKEND_URL', 'ASSIST_KNOWLEDGE_API_KEY'],
    });
    expect(
      syncConfigFromEnv({
        SITES_BACKEND_URL: 'https://sites.example/x',
        ASSIST_LANDING_SITE_ID: 'site_1',
        ASSIST_KNOWLEDGE_API_KEY: SECRET,
      }),
    ).toEqual({
      ok: true,
      config: {
        origin: 'https://sites.example',
        siteId: 'site_1',
        secret: SECRET,
      },
    });
  });
});

describe('knowledge-sync: прогон', () => {
  const config = {
    origin: 'https://sites.example',
    siteId: 'site_1',
    secret: SECRET,
  };
  const docs = buildSyncDocuments({
    ru: '# База\n\nТарифы Lite.\n',
    uk: '# База\n\nТарифи Lite.\n',
  });

  function fakeNet(remote: string[]) {
    const calls: Array<{
      method: string;
      url: string;
      sig: string;
      body?: string;
    }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        method: init.method,
        url,
        sig: init.headers[SYNC_SIGNATURE_HEADER],
        body: init.body,
      });
      const data =
        init.method === 'GET'
          ? { siteId: 'site_1', documents: remote.map((key) => ({ key })) }
          : init.method === 'PUT'
            ? { key: 'x', status: 'unchanged' }
            : { key: 'x', status: 'deleted' };
      return {
        status: 200,
        text: async () => JSON.stringify({ success: true, data }),
      };
    };
    return { calls, fetchImpl };
  }

  it('сухой прогон — без сети', async () => {
    const net = fakeNet([]);
    const r = await runKnowledgeSync({
      docs,
      apply: false,
      config,
      fetchImpl: net.fetchImpl,
    });
    expect(r.applied).toBe(false);
    expect(net.calls).toHaveLength(0);
    expect(r.documents.map((d) => d.key)).toEqual(['gen-kb-ru', 'gen-kb-uk']);
  });

  it('--apply: GET → PUT каждого → DELETE лишних своих; подпись на каждом запросе', async () => {
    const net = fakeNet(['gen-kb-ru', 'gen-kb-old', 'owner-doc']);
    const r = await runKnowledgeSync({
      docs,
      apply: true,
      config,
      fetchImpl: net.fetchImpl,
      now: () => 1_790_000_000,
    });
    expect(
      net.calls.map((c) => `${c.method} ${c.url.replace(/^.*documents/, '')}`),
    ).toEqual([
      'GET ',
      'PUT /gen-kb-ru',
      'PUT /gen-kb-uk',
      'DELETE /gen-kb-old',
    ]);
    expect(net.calls[1].sig).toBe(
      signKnowledgeRequest(
        SECRET,
        {
          method: 'PUT',
          siteId: 'site_1',
          key: 'gen-kb-ru',
          rawBody: net.calls[1].body!,
        },
        1_790_000_000,
      ),
    );
    expect(r.results).toEqual([
      { key: 'gen-kb-ru', status: 'unchanged' },
      { key: 'gen-kb-uk', status: 'unchanged' },
    ]);
    expect(r.removed).toEqual(['gen-kb-old']);
    // Ключ по сети не ходит — только подпись.
    expect(JSON.stringify(net.calls)).not.toContain(SECRET);
  });

  it('утечка в документе — исключение ДО сети, ничего не отправлено', async () => {
    const net = fakeNet([]);
    const leaky = buildSyncDocuments({
      ru: `# База\n\nКлюч: ${['AIza', 'SyA1234567890abcdefghijklmnopqrstu'].join('')}\n`,
    });
    await expect(
      runKnowledgeSync({
        docs: leaky,
        apply: true,
        config,
        fetchImpl: net.fetchImpl,
      }),
    ).rejects.toThrow(/google-api-key/);
    expect(net.calls).toHaveLength(0);
  });

  it('ошибка сервера — исключение с кодом, без секрета', async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 401,
      text: async () => '{"error":{"code":"SIGNATURE_INVALID"}}',
    });
    const err = await runKnowledgeSync({
      docs,
      apply: true,
      config,
      fetchImpl,
    }).catch((e: Error) => e);
    expect(String(err)).toMatch(/HTTP 401.*SIGNATURE_INVALID/);
    expect(String(err)).not.toContain(SECRET);
  });
});
