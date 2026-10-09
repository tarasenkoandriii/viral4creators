/**
 * Заход 11 (№117): общая сервисная часть карты двух контуров — без базы.
 * Хеш, ошибки операций, вид версии, разбор ссылки редактора, подпись файла
 * (метки контуров разные — файл «Админки» не «наш» для «Сайта»), и ядро,
 * параметризованное контуром: экспорт несёт `kind`, импорт другого
 * контура — отказ целиком (У-28).
 */
import {
  applyMapOps,
  emptyVoiceMap,
  exportPayload,
  importOps,
  versionContent,
  type VoiceMapContent,
} from './voice-map';
import {
  editorFocusKey,
  editorLinkPath,
  mapExportSigner,
  mapIssuesToErrors,
  mapVersionSummary,
  mapVersionView,
  sha256Hex,
  utcDay,
  voiceMapContentHash,
} from './voice-map-service-core';

const KEK = 'k'.repeat(44);

function content(): VoiceMapContent {
  const r = applyMapOps(
    emptyVoiceMap(),
    [
      {
        op: 'upsert-target',
        target: {
          key: 'orders',
          scope: 'site',
          descriptor: {
            tag: 'a',
            role: 'link',
            text: 'Замовлення',
            hrefPath: '/admin/orders',
            hrefHost: 'admin.shop.example',
            unique: true,
          },
          names: { uk: 'Замовлення' },
          synonyms: { uk: [{ text: 'список замовлень' }] },
        },
      },
    ],
    { hosts: ['admin.shop.example'], newId: () => 't-1', source: 'tma' },
  );
  expect(r.issues).toEqual([]);
  return r.content;
}

describe('voice-map-service-core — общая часть двух контуров карты', () => {
  it('хеш содержимого не зависит от порядка ключей; sha256Hex — hex', () => {
    const c = content();
    const rev = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(rev)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .reverse()
                .map(([k, x]) => [k, rev(x)]),
            )
          : v;
    const shuffled = rev(c) as VoiceMapContent;
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(c));
    expect(voiceMapContentHash(c)).toBe(voiceMapContentHash(shuffled));
    expect(voiceMapContentHash(c)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sha256Hex('x')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ошибки операций → `ops.N[.поле]`', () => {
    expect(
      mapIssuesToErrors([
        { index: 0, code: 'bad_key' },
        { index: 2, code: 'text_invalid', path: 'names.uk' },
      ]),
    ).toEqual([
      { path: 'ops.0', code: 'bad_key' },
      { path: 'ops.2.names.uk', code: 'text_invalid' },
    ]);
  });

  it('вид версии: ворота, дифф к опубликованной, ключи диффа', () => {
    const c = versionContent(content());
    const row = {
      number: 3,
      status: 'checking',
      content: c,
      gateReport: {
        ok: false,
        problems: [{ code: 'text' }],
        warnings: [],
        counts: {},
      },
      rollbackOf: null,
      requestedVia: 'editor',
      createdAt: new Date('2026-10-09T10:00:00Z'),
      publishedAt: null,
    };
    expect(mapVersionSummary(row, null)).toEqual({
      number: 3,
      status: 'checking',
      requestedVia: 'editor',
      rollbackOf: null,
      createdAt: '2026-10-09T10:00:00.000Z',
      publishedAt: null,
      ok: false,
      problems: 1,
      warnings: 0,
      diff: { added: 1, changed: 0, removed: 0 },
    });
    const same = mapVersionView(row, c);
    expect(same.diff).toEqual({ added: 0, changed: 0, removed: 0 });
    expect(same.content.targets[0].key).toBe('orders');
    expect(same.diffKeys).toEqual({ added: [], changed: [], removed: [] });
    expect(mapVersionSummary({ ...row, gateReport: null }, null).ok).toBe(
      false,
    );
  });

  it('путь ссылки редактора — только путь своего хоста (`//чужой` → `/`); focus — формат ключа', () => {
    expect(editorLinkPath('/admin/orders/1042')).toBe('/admin/orders/1042');
    expect(editorLinkPath('//evil.example/x')).toBe('/');
    expect(editorLinkPath('/\\evil.example')).toBe('/');
    expect(editorLinkPath('https://evil.example/')).toBe('/');
    expect(editorLinkPath('/a b')).toBe('/');
    expect(editorLinkPath(`/${'a'.repeat(400)}`)).toBe('/');
    expect(editorLinkPath(42)).toBe('/');
    expect(editorFocusKey('orders')).toBe('orders');
    expect(editorFocusKey('Bad Key')).toBeNull();
    expect(editorFocusKey(undefined)).toBeNull();
    expect(utcDay(new Date('2026-10-09T23:59:59Z'))).toBe('2026-10-09');
  });

  it('подпись: свой ключ контура, иначе производный по метке; метки контуров разные — файл одного не «наш» для другого', () => {
    const site = mapExportSigner(
      { ASSIST_SECRETS_KEY: KEK },
      {
        ownKeyEnv: 'ASSIST_VOICE_MAP_EXPORT_KEY',
        label: 'voice-map-export-v1',
        unsignedKey: 'u-site',
      },
    );
    const admin = mapExportSigner(
      { ASSIST_SECRETS_KEY: KEK },
      {
        ownKeyEnv: 'ASSIST_ADMIN_VOICE_MAP_EXPORT_KEY',
        label: 'admin-voice-map-export-v1',
        unsignedKey: 'u-admin',
      },
    );
    const p = { schemaVersion: 1, kind: 'admin', targets: [] };
    const sig = admin.sign(p);
    expect(admin.valid(p, sig)).toBe(true);
    expect(site.valid(p, sig)).toBe(false);
    expect(admin.valid({ ...p, terms: ['x'] }, sig)).toBe(false);
    expect(admin.valid(p, sig.slice(1))).toBe(false);
    expect(admin.valid(p, 1)).toBe(false);
    const own = mapExportSigner(
      { ASSIST_ADMIN_VOICE_MAP_EXPORT_KEY: 'e'.repeat(40) },
      {
        ownKeyEnv: 'ASSIST_ADMIN_VOICE_MAP_EXPORT_KEY',
        label: 'admin-voice-map-export-v1',
        unsignedKey: 'u-admin',
      },
    );
    expect(own.valid(p, own.sign(p))).toBe(true);
    const none = mapExportSigner(
      {},
      {
        ownKeyEnv: 'ASSIST_ADMIN_VOICE_MAP_EXPORT_KEY',
        label: 'admin-voice-map-export-v1',
        unsignedKey: 'u-admin',
      },
    );
    expect(none.valid(p, none.sign(p))).toBe(false);
  });

  it('ядро, параметризованное контуром: экспорт `kind: admin`; импорт файла другого контура — отказ целиком (У-28)', () => {
    const c = versionContent(content());
    const admin = JSON.parse(
      JSON.stringify(exportPayload(c, undefined, 'admin')),
    );
    const site = JSON.parse(JSON.stringify(exportPayload(c)));
    expect(admin.kind).toBe('admin');
    expect(site.kind).toBe('site');
    let n = 0;
    const ids = () => `t-${++n}`;
    expect(importOps(admin, ids)).toEqual({ ok: false, reason: 'kind' });
    expect(importOps(site, ids, 'admin')).toEqual({
      ok: false,
      reason: 'kind',
    });
    const ok = importOps(admin, ids, 'admin');
    expect(ok).toMatchObject({
      ok: true,
      ops: expect.arrayContaining([
        expect.objectContaining({ op: 'upsert-target' }),
      ]),
    });
    expect(importOps({ ...admin, kind: 'other' }, ids, 'admin')).toEqual({
      ok: false,
      reason: 'kind',
    });
  });
});
