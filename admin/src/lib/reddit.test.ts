// Вкладка «Reddit» (P-R-ADM): чистая часть Админки — адаптер маршрутов
// (`products/<pid>/…` кабинета → `/admin/reddit/{rx,cx}/…`, allowlist),
// `opKey` в теле, ошибки словами (кабинет + отказы актора Админки),
// статус/импорт/параметры, адрес вкладки. Логика кабинета (тела «только
// изменённые поля», WARN, markdown) проверяется своими тестами в assist —
// здесь только то, что она доходит до маршрутов Админки без искажений.
// Запуск (из admin/): npx tsx src/lib/reddit.test.ts
import assert from 'node:assert/strict';
import { ApiRequestError } from './admin-api';
import {
  conflictValueText,
  aiReadiness,
  productLine,
  adminPathOf,
  approvalIdOf,
  csvFilenameOf,
  decodeParams,
  fetchCsv,
  hintValue,
  createAdminPublisherHttp,
  createRedditClients,
  decideBody,
  decodeImportReport,
  decodeStatus,
  describeAdminRedditError,
  markMutationError,
  emptyImportForm,
  IMPORT_MAX_BYTES,
  IMPORT_MARKET_MAX,
  IMPORT_TITLE_MAX,
  importApplyNotice,
  importBlocksShown,
  keptCurrentText,
  IMPORT_WARNING_KIND_LABELS,
  IMPORT_KIND_LABELS,
  importBody,
  importFingerprint,
  importSummaryRows,
  isOwnActor,
  parseParamValue,
  parseRedditRoute,
  queryOf,
  redditRouteSearch,
  sectionState,
  toPubError,
  type Transport,
  type ImportReport,
} from './reddit';
import { ApiError } from './reddit-shared/kit/envelope';
import { copyText } from './reddit-shared/kit/clipboard';
import { projectPatchBody } from './reddit-shared/lib/publisher/reddit-view';
import { briefForm, briefPatchBody } from './reddit-shared/lib/publisher/reddit-studio-view';
import { pollCall } from './reddit-shared/lib/publisher/ai-api';
import { factValue, sourceBody } from './reddit-shared/lib/publisher/brand-view';

const OP_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = 'cabcdefghijklmnopqrstuvwx';
const ID2 = 'czyxwvutsrqponmlkjihgfedc';
const AI_CALL = {
  callId: 'aic_1',
  generator: 'pub.reddit.draft',
  status: 'ok',
  taskId: 't1',
  attemptNo: 1,
  output: null,
  findings: [],
  errorCode: null,
  costStatus: 'unpriced',
  costMicroUsd: null,
  requestedAt: '2026-10-14T10:00:00.000Z',
  finishedAt: null,
  contextFactIds: [],
  contextSourceIds: [],
};

async function main() {
  // ── 1. Allowlist путей ──
  assert.equal(adminPathOf('products/platform/reddit/projects'), '/admin/reddit/rx/projects');
  assert.equal(adminPathOf(`products/platform/reddit/communities/${ID}/rules/${ID2}/source`), `/admin/reddit/rx/communities/${ID}/rules/${ID2}/source`);
  assert.equal(adminPathOf(`products/platform/reddit/rules/${ID}/review`), `/admin/reddit/rx/rules/${ID}/review`);
  assert.equal(adminPathOf(`products/platform/reddit/opportunities/${ID}/qualify`), `/admin/reddit/rx/opportunities/${ID}/qualify`);
  assert.equal(adminPathOf(`products/platform/reddit/contents/${ID}/report-publication`), `/admin/reddit/rx/contents/${ID}/report-publication`);
  assert.equal(adminPathOf(`products/platform/contents/${ID}/versions/${ID2}/diff/${ID}`), `/admin/reddit/cx/contents/${ID}/versions/${ID2}/diff/${ID}`);
  assert.equal(adminPathOf(`products/platform/versions/${ID}/approve`), `/admin/reddit/cx/versions/${ID}/approve`);
  assert.equal(adminPathOf(`products/platform/contents/${ID}/transition`), `/admin/reddit/cx/contents/${ID}/transition`);
  assert.equal(adminPathOf(`products/platform/sources/${ID}/revoke`), `/admin/reddit/cx/sources/${ID}/revoke`);
  assert.equal(adminPathOf(`products/platform/publications/${ID}/transition`), `/admin/reddit/cx/publications/${ID}/transition`);
  // v1.2: +14 маршрутов cx (контракт §4).
  for (const [from, to] of [
    [`approvals/${ID}/revoke`, `cx/approvals/${ID}/revoke`],
    ['sources', 'cx/sources'],
    ['offers', 'cx/offers'],
    [`offers/${ID}/activate`, `cx/offers/${ID}/activate`],
    ['brand-facts', 'cx/brand-facts'],
    [`brand-facts/${ID}/activate`, `cx/brand-facts/${ID}/activate`],
    [`brand-facts/${ID}/resolve`, `cx/brand-facts/${ID}/resolve`],
    [`brand-facts/${ID}/retire`, `cx/brand-facts/${ID}/retire`],
    ['ai/calls/aic_0123456789abcdef01234567', 'cx/ai/calls/aic_0123456789abcdef01234567'],
  ]) {
    assert.equal(adminPathOf(`products/platform/${from}`), `/admin/reddit/${to}`, from);
  }
  // Не из контракта — нет маршрута (никакого произвольного проксирования).
  for (const bad of [
    'products/platform/leads',
    'products/platform/roles',
    `products/platform/contents/${ID}`,
    'products/platform/parameters',
    'products/other/reddit/projects',
    'products/platform/reddit/../roles',
    'products/platform/reddit/projects?x=1',
    'products/platform/reddit/unknown',
    'https://www.reddit.com/r/x',
    'products/platform/sources/import-url',
    `products/platform/sources/${ID}`,
    `products/platform/offers/${ID}`,
    `products/platform/brand-facts/${ID}`,
    'products/platform/ai/calls',
    `products/platform/approvals/${ID}`,
    'products/platform/approvals',
  ]) {
    assert.equal(adminPathOf(bad), null, bad);
  }

  // ── 2. Адаптер PublisherHttp: opKey в теле, query без пустых ──
  const calls: Array<{ method: string; path: string; query?: unknown; body?: Record<string, unknown> }> = [];
  const fake = (reply: (path: string) => unknown): Transport =>
    async (method, path, query, body) => {
      calls.push({ method, path, query, body });
      return reply(path);
    };
  const http = createAdminPublisherHttp(fake(() => ({ ok: true })));
  await http.send('POST', 'products/platform/reddit/projects', { title: 't' }, 'k');
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/admin/reddit/rx/projects', query: undefined, body: { title: 't', opKey: 'k' } });
  await http.send('PATCH', `products/platform/reddit/projects/${ID}`, { expectedRevision: 2 });
  assert.match(String(calls.at(-1)?.body?.opKey), OP_KEY_RE, 'новый opKey — UUID v4');
  await http.get('products/platform/reddit/opportunities', { status: 'new', q: '', limit: 50, policyNow: undefined, x: null });
  assert.deepEqual(calls.at(-1)?.query, { status: 'new', limit: 50 });
  await assert.rejects(http.get('products/platform/leads'), (e: unknown) => e instanceof ApiError && e.code === 'PUB_NOT_FOUND');
  await assert.rejects(http.send('PUT', 'products/platform/reddit/projects', {}), (e: unknown) => e instanceof ApiError && e.status === 404);
  await assert.rejects(http.csv('products/platform/reddit/projects'), ApiError);
  assert.deepEqual(queryOf({ a: 1, b: true, c: '', d: undefined }), { a: 1, b: 'true' });

  // ── 3. Клиенты кабинета → маршруты Админки (тела не искажаются) ──
  calls.length = 0;
  const project = { id: ID, title: 'P', locale: 'en', market: 'US', status: 'active', revision: 3, createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z' };
  const api = createRedditClients(fake(() => project));
  // «Только изменённые поля» — тело кабинета (projectPatchBody) уходит как есть.
  const patch = projectPatchBody(project as never, { title: 'P2', locale: 'en', market: 'US' });
  assert.deepEqual(patch, { expectedRevision: 3, title: 'P2' });
  await api.reddit.patchProject(ID, 'op', patch as never);
  assert.deepEqual(calls.at(-1), {
    method: 'PATCH',
    path: `/admin/reddit/rx/projects/${ID}`,
    query: undefined,
    body: { expectedRevision: 3, title: 'P2', opKey: 'op' },
  });
  // Р-RD-AUD-1: восстановление архивного проекта — rx/projects/:id/restore.
  await api.reddit.restoreProject(ID, 'opr', 4);
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: `/admin/reddit/rx/projects/${ID}/restore`,
    query: undefined,
    body: { expectedRevision: 4, opKey: 'opr' },
  });
  await assert.rejects(api.content.approve(ID, { versionHash: 'h', acknowledgedWarnings: ['reddit_duplicate'] }, 'op2'));
  assert.deepEqual(calls.at(-1), {
    method: 'POST',
    path: `/admin/reddit/cx/versions/${ID}/approve`,
    query: undefined,
    body: { versionHash: 'h', acknowledgedWarnings: ['reddit_duplicate'], opKey: 'op2' },
  });
  await assert.rejects(api.content.revokeSource(ID, 'причина', 'op3'));
  assert.equal(calls.at(-1)?.path, `/admin/reddit/cx/sources/${ID}/revoke`);
  await assert.rejects(api.calendar.publicationTransition(ID, { expectedRevision: 1, to: 'withdrawn', reason: 'ошибка' }, 'op4'));
  assert.deepEqual(calls.at(-1)?.body, { expectedRevision: 1, to: 'withdrawn', reason: 'ошибка', opKey: 'op4' });
  await assert.rejects(api.studio.copy(ID, 'op5', { acknowledgedWarnings: ['reddit_offensive'] }));
  assert.equal(calls.at(-1)?.path, `/admin/reddit/rx/contents/${ID}/copy`);
  await assert.rejects(api.content.diff(ID, ID2, ID));
  assert.equal(calls.at(-1)?.path, `/admin/reddit/cx/contents/${ID}/versions/${ID2}/diff/${ID}`);
  // Ни одного адреса вне /admin/reddit (к Reddit Админка не ходит).
  assert.ok(calls.every((c) => c.path.startsWith('/admin/reddit/')));

  // ── 4. Ошибки: admin-api → ApiError кабинета, тексты ──
  const conflict = toPubError(new ApiRequestError('stale', 409, 'PUB_CONFLICT', { reason: 'revision', currentRevision: 4 }));
  assert.ok(conflict instanceof ApiError);
  assert.equal((conflict as ApiError).code, 'PUB_CONFLICT');
  assert.equal(describeAdminRedditError(conflict).conflict, true, 'CAS — «перечитать»');
  const net = toPubError(new TypeError('Failed to fetch'));
  assert.ok(net instanceof ApiError && net.code === 'network' && net.status === 0);
  assert.equal(describeAdminRedditError(new ApiError('PUB_PRODUCT_NONE', 'x', 404)).title.includes('Завести продукт'), true);
  const scope = describeAdminRedditError(new ApiError('PUB_ROLE_REQUIRED', 'x', 403, undefined, { action: 'lead.reveal', reason: 'admin_scope' }));
  assert.match(scope.title, /недоступно из Админки/);
  const tr = describeAdminRedditError(new ApiError('PUB_TRANSITION_INVALID', 'x', 409, undefined, { reason: 'admin_scope' }));
  assert.match(tr.title, /вернуть на доработку/);
  const site = describeAdminRedditError(new ApiError('PUB_CONFLICT', 'x', 409, undefined, { reason: 'platform_site_not_configured' }));
  assert.match(site.title, /ASSIST_INTERNAL_SITE_IDS/);
  assert.equal(site.conflict, false);
  const missingOffer = describeAdminRedditError(
    new ApiError('PUB_VALIDATION', 'x', 400, undefined, { fields: [{ field: 'offerVersionId', code: 'offer_missing' }] }),
  );
  assert.match(missingOffer.lines.join(' '), /нет активного оффера/);
  assert.ok(!missingOffer.lines.join(' ').includes('offer_missing'));
  // Причины кабинета — словами, без сырых кодов.
  const block = describeAdminRedditError(
    new ApiError('PUB_TRANSITION_INVALID', 'x', 409, undefined, { reason: 'policy_block', reasons: ['rules_unreviewed'] }),
  );
  assert.ok(block.lines.join(' ').includes('снимок правил не подтверждён'));
  assert.ok(!block.lines.join(' ').includes('rules_unreviewed'));
  const warn = describeAdminRedditError(
    new ApiError('PUB_CONFLICT', 'x', 409, undefined, { reason: 'warnings_not_acknowledged', codes: ['reddit_guarantee'] }),
  );
  assert.equal(warn.conflict, false, 'WARN — не «устаревшая версия»');
  assert.ok(warn.lines.some((l) => l.includes('гарантия')));
  const dup = describeAdminRedditError(new ApiError('PUB_CONFLICT', 'x', 409, undefined, { reason: 'duplicate', existingId: ID }));
  assert.equal(dup.existingId, ID);
  // Ответ backend без кода Publisher (503 «не подключено») — его текст.
  const off = describeAdminRedditError(toPubError(new ApiRequestError('Reddit не подключён к админке: задайте …', 503, 'SERVICE_UNAVAILABLE')));
  assert.match(off.title, /не подключён/);
  // Р-RD-AUD-7 (ui-1): 504 UPSTREAM_TIMEOUT и прочие ответы шлюза 502/503/504 —
  // повторяемые с тем же opKey; текст «результат неизвестен — повтор безопасен».
  {
    const { isRetryable, opKeyAfter } = await import('./reddit-shared/lib/publisher/common-pure');
    const upstream = toPubError(
      new ApiRequestError('Бэкенд клиентских сайтов не ответил вовремя — результат неизвестен, повтор безопасен', 504, 'UPSTREAM_TIMEOUT'),
    );
    assert.ok(upstream instanceof ApiError && upstream.code === 'UPSTREAM_TIMEOUT' && upstream.status === 504);
    const key = { key: 'k-1', sig: 'POST /x {}' };
    for (const e of [
      upstream,
      toPubError(new ApiRequestError('Бэкенд клиентских сайтов вернул ошибку', 502, 'Bad Gateway')),
      toPubError(new ApiRequestError('Сервер ответил 504', 504)),
      toPubError(new ApiRequestError('Сервер ответил 503', 503)),
      net,
    ]) {
      assert.equal(isRetryable(e), true, String((e as ApiError).code));
      assert.equal(opKeyAfter(key, e), key, 'тот же opKey на повтор');
      const safe = (x: { lines: string[] }) => x.lines.some((l) => l.startsWith('Результат неизвестен — повтор безопасен'));
      assert.ok(safe(describeAdminRedditError(e, {}, { mutation: true })));
      // Загрузчик (GET) — ключа операции нет, строки нет (кнопка «Повторить»).
      assert.ok(!safe(describeAdminRedditError(e)), 'GET без строки');
    }
    // Ошибка из useMutation помечается — ErrorAlert видит её как действие.
    const marked = toPubError(new ApiRequestError('Сервер ответил 504', 504));
    markMutationError(marked);
    assert.ok(describeAdminRedditError(marked).lines.some((l) => l.startsWith('Результат неизвестен')));
    const ut = describeAdminRedditError(upstream, {}, { mutation: true });
    assert.equal(ut.title, 'Бэкенд клиентских сайтов не ответил вовремя.');
    assert.equal(ut.retryable, true);
    for (const e of [conflict, new ApiError('PUB_VALIDATION', 'x', 400), new ApiError('http_500', 'x', 500)]) {
      assert.equal(opKeyAfter(key, e), null);
      assert.ok(!describeAdminRedditError(e, {}, { mutation: true }).lines.some((l) => l.startsWith('Результат неизвестен')));
    }
    // 503 с прикладным кодом — исход известен: отказ модели сохранён под
    // этим opKey, тот же ключ воспроизвёл бы его; строки «повтор безопасен» нет.
    for (const e of [
      new ApiError('PUB_AI_UNAVAILABLE', 'x', 503),
      toPubError(new ApiRequestError('Модель недоступна', 503, 'PUB_AI_UNAVAILABLE')),
    ]) {
      assert.equal(isRetryable(e), false);
      assert.equal(opKeyAfter(key, e), null, 'новый ключ на повтор AI');
      assert.ok(!describeAdminRedditError(e, {}, { mutation: true }).lines.some((l) => l.startsWith('Результат неизвестен')));
    }
    // PUB_BUSY — тот же ключ (повторяем); 503 «раздел не подключён» — исход известен.
    assert.equal(opKeyAfter(key, new ApiError('PUB_BUSY', 'x', 503)), key);
    const offM = describeAdminRedditError(
      toPubError(new ApiRequestError('Раздел Reddit не подключён к админке', 503, 'SERVICE_UNAVAILABLE')),
      {},
      { mutation: true },
    );
    assert.ok(!offM.lines.some((l) => l.startsWith('Результат неизвестен')), 'не подключён — без «повтор безопасен»');
  }

  // ── 5. Статус раздела ──
  const st = decodeStatus({ enabled: true, aiEnabled: false, platformSiteId: 's1', product: null, gate: null });
  assert.equal(sectionState(st), 'no_product');
  assert.equal(sectionState({ ...st, enabled: false }), 'disabled');
  assert.equal(sectionState({ ...st, platformSiteId: null }), 'no_site');
  const ready = decodeStatus({
    enabled: true,
    aiEnabled: true,
    platformSiteId: 's1',
    product: { id: 'p', siteId: 's1', kind: 'working', mode: 'closed', status: 'active' },
    gate: { open: false, missing: [{ kind: 'parameter', key: 'niche', detail: 'not_approved' }] },
    created: true,
  });
  assert.equal(sectionState(ready), 'ready');
  assert.equal(ready.created, true);
  assert.equal(ready.gate?.missing[0].key, 'niche');
  assert.throws(() => decodeStatus({ enabled: 'yes' }));

  // ── 6. Импорт ──
  const f = { ...emptyImportForm(), communitiesCsv: 'subreddit\nr/test\n', projectTitle: ' Тест ', market: 'US' };
  const ib = importBody(f);
  assert.deepEqual(ib.issues, []);
  assert.equal(ib.body?.projectTitle, 'Тест');
  assert.equal('segment' in (ib.body ?? {}), false, 'пустая метка не уходит');
  assert.deepEqual(importBody({ ...f, communitiesCsv: ' ' }).issues, ['communities']);
  assert.deepEqual(importBody({ ...f, locale: 'english!' }).issues, ['locale']);
  assert.deepEqual(importBody({ ...f, communitiesCsv: 'x'.repeat(IMPORT_MAX_BYTES) }).issues, ['size']);
  assert.notEqual(importFingerprint(ib.body), importFingerprint(importBody({ ...f, market: 'EU' }).body), 'другой набор — новый предпросмотр');
  const rep = decodeImportReport({
    apply: false,
    productId: 'p',
    items: [{ kind: 'community', ref: 'r/test', outcome: 'would_create' }, { kind: 'opportunity', ref: 'x', outcome: 'rejected', code: 'pii' }],
    blocks: [{ subreddit: 'test', now: ['rules_unreviewed'], afterReview: [] }],
    summary: { community: { would_create: 1 }, opportunity: { rejected: 1, created: 0 } },
  });
  assert.deepEqual(importSummaryRows(rep), [
    { kind: 'community', label: 'Сообщества', cells: [['будет создано', 1]] },
    { kind: 'opportunity', label: 'Возможности', cells: [['отклонено', 1]] },
  ]);
  // Старый ответ без новых полей — полный отчёт без предупреждений.
  assert.equal(rep.complete, true);
  assert.deepEqual(rep.warnings, []);
  assert.equal(rep.blocks[0].firstHandSource, true);

  // Аудит ui-2: границы полей проекта — как у создания проекта (120/64).
  assert.deepEqual(importBody({ ...f, projectTitle: 'т'.repeat(120), market: 'm'.repeat(64) }).issues, []);
  assert.deepEqual(importBody({ ...f, projectTitle: 'т'.repeat(121) }).issues, ['title']);
  assert.deepEqual(importBody({ ...f, market: 'm'.repeat(65) }).issues, ['market']);
  assert.equal(IMPORT_TITLE_MAX, 120);
  assert.equal(IMPORT_MARKET_MAX, 64);
  // Отказ проекта при apply — предупреждение, не «Импорт применён».
  const applied = (items: ImportReport['items'], extra: Partial<ImportReport> = {}): ImportReport => ({
    apply: true,
    productId: 'p',
    complete: true,
    items,
    blocks: [],
    warnings: [],
    summary: {},
    ...extra,
  });
  const rejectedProject = importApplyNotice(
    applied([{ kind: 'project', ref: 'T', outcome: 'rejected', code: 'market:length' }, { kind: 'community', ref: 'r/a', outcome: 'not_attempted', code: 'project_rejected' }], {
      complete: false,
      stoppedBy: 'project_rejected',
    }),
  );
  assert.equal(rejectedProject.tone, 'warning');
  assert.match(rejectedProject.text, /Проект не создан/);
  assert.doesNotMatch(rejectedProject.text, /Импорт применён\./);
  const late = importApplyNotice(applied([{ kind: 'community', ref: 'r/a', outcome: 'not_attempted', code: 'deadline' }], { complete: false, stoppedBy: 'deadline' }));
  assert.equal(late.tone, 'warning');
  assert.match(late.text, /частично/);
  assert.deepEqual(importApplyNotice(applied([{ kind: 'project', ref: 'T', outcome: 'created' }])), {
    tone: 'success',
    text: 'Импорт применён. Повтор безопасен: существующее останется «уже есть».',
  });
  const full = decodeImportReport({
    apply: true,
    productId: 'p',
    complete: false,
    stoppedBy: 'deadline',
    items: [{ kind: 'rules', ref: 'r/a', outcome: 'exists', code: 'kept_current', detail: 'unreviewed' }],
    blocks: [{ subreddit: 'a', now: [], afterReview: [], firstHandSource: false }],
    warnings: [{ kind: 'rules', ref: 'smb: r/a', code: 'flair_unparsed', field: 'flair_required', detail: 'depends' }],
    summary: { rules: { exists: 1, not_attempted: 2 } },
  });
  assert.equal(full.complete, false);
  assert.equal(full.stoppedBy, 'deadline');
  assert.equal(full.blocks[0].firstHandSource, false);
  assert.deepEqual(full.warnings[0], { kind: 'rules', ref: 'smb: r/a', code: 'flair_unparsed', field: 'flair_required', detail: 'depends' });
  assert.deepEqual(importSummaryRows(full)[0].cells, [
    ['уже есть', 1],
    ['не выполнялось', 2],
  ]);
  // Ревью 2 (S3): kept_current — по-русски, без сырых enum; `file` — «Файл»;
  // гейт/первоисточник — не для сообществ с оставленным текущим снимком.
  assert.equal(keptCurrentText('unreviewed'), 'текущий снимок: не подтверждён');
  const kt = keptCurrentText('reviewed; differs: promotion allowed_with_conditions, csv prohibited; links allowed, csv restricted');
  assert.equal(
    kt,
    'текущий снимок: проверено человеком; Продвижение: в снимке «разрешено с условиями», в CSV «запрещено»; Ссылки: в снимке «разрешены», в CSV «ограничены»',
  );
  assert.doesNotMatch(keptCurrentText('weird; differs: odd thing; links zzz, csv yyy'), /weird|odd|zzz|yyy|differs/);
  assert.equal(keptCurrentText(undefined), '');
  assert.equal(IMPORT_WARNING_KIND_LABELS.file, 'Файл');
  assert.equal(IMPORT_WARNING_KIND_LABELS.rules, IMPORT_KIND_LABELS.rules);
  assert.deepEqual(
    importBlocksShown({
      items: [...full.items, { kind: 'rules', ref: 'r/b', outcome: 'created' }],
      blocks: [...full.blocks, { subreddit: 'b', now: [], afterReview: [], firstHandSource: false }],
    }).map((b) => b.subreddit),
    ['b'],
  );

  // ── 7. Параметры гейта ──
  assert.deepEqual(parseParamValue('{"days": 30}'), { ok: true, value: { days: 30 } });
  assert.deepEqual(parseParamValue('{days: 30}'), { ok: false });
  assert.equal(decideBody({ revision: 1 }, { toStatus: 'approved', proposalId: '', basis: 'коротко', stages: [] }), null, 'основание ≥ 10');
  assert.deepEqual(decideBody({ revision: 5 }, { toStatus: 'approved', proposalId: ' prop_1 ', basis: '  утверждено владельцем  ', stages: ['reddit_publish'] }), {
    toStatus: 'approved',
    proposalId: 'prop_1',
    basis: 'утверждено владельцем',
    dependentStages: ['reddit_publish'],
    expectedRevision: 5,
  });

  // ── 8. Адрес вкладки, актор ──
  assert.deepEqual(parseRedditRoute('?tab=studio&id=abc_1&project=p1'), { tab: 'studio', project: 'p1', id: 'abc_1', opp: '' });
  assert.deepEqual(parseRedditRoute('?tab=evil&id=1'), { tab: 'setup', project: '', id: '', opp: '' });
  assert.deepEqual(parseRedditRoute('?tab=briefs&opp=o1&id=<x>'), { tab: 'briefs', project: '', id: '', opp: 'o1' });
  assert.equal(redditRouteSearch({ tab: 'briefs', project: 'p', id: '', opp: 'o' }), '?tab=briefs&project=p&opp=o');
  assert.equal(redditRouteSearch({ tab: 'studio', project: '', id: 'c', opp: 'o' }), '?tab=studio&id=c');
  assert.equal(isOwnActor('admin:u1', 'u1'), true);
  assert.equal(isOwnActor('member:u1', 'u1'), false);
  assert.equal(isOwnActor('admin:u2', 'u1'), false);
  assert.equal(isOwnActor(null, 'u1'), false);

  // ── 9. v1.2: опрос генерации, подсказки параметров, CSV, согласование ──
  {
    const seen: string[] = [];
    let n = 0;
    const call = (status: string) => ({ ...AI_CALL, status });
    const ai = createRedditClients(async (_m, path) => {
      seen.push(path);
      n += 1;
      return call(n < 3 ? 'running' : 'ok');
    }).ai;
    const last = await pollCall(ai, 'aic_1', { intervalMs: 1, maxMs: 100, sleep: async () => undefined });
    assert.equal(last.status, 'ok');
    assert.deepEqual(seen, ['/admin/reddit/cx/ai/calls/aic_1', '/admin/reddit/cx/ai/calls/aic_1', '/admin/reddit/cx/ai/calls/aic_1']);
    n = -100;
    const stuck = await pollCall(ai, 'aic_1', { intervalMs: 10, maxMs: 30, sleep: async () => undefined });
    assert.equal(stuck.status, 'running', 'после предела — «ещё выполняется», не ошибка');
  }
  const prm = decodeParams({
    items: [],
    keys: [],
    gate: { open: false, missing: [] },
    hints: { offerActiveVersion: { offerVersionId: 'of1', version: 2 }, accountOwnerMemberId: 'm1' },
  });
  assert.deepEqual(hintValue('offer_active_version', prm.hints), { offerVersionId: 'of1', version: 2 });
  assert.deepEqual(hintValue('responsibles', prm.hints), { formOwnerMemberId: 'm1', salesMemberIds: ['m1'], afterT72MemberId: null });
  assert.equal(hintValue('niche', prm.hints), null);
  assert.deepEqual(decodeParams({ items: [], keys: [], gate: { open: true, missing: [] } }).hints, { offerActiveVersion: null, accountOwnerMemberId: null, budget: null }, 'v1 без hints');
  assert.equal(csvFilenameOf('attachment; filename="reddit-projects-2026.csv"', 'projects'), 'reddit-projects-2026.csv');
  assert.equal(csvFilenameOf('attachment; filename="../../x.sh"', 'projects'), 'reddit-projects.csv');
  assert.equal(csvFilenameOf('', 'brand-facts'), 'reddit-brand-facts.csv');
  {
    const asked: Array<{ path: string; query: unknown }> = [];
    const file = (status: number, contentType: string, text: string) => async (path: string, query?: unknown) => {
      asked.push({ path, query });
      return { status, contentType, disposition: 'attachment; filename="opps.csv"', text, nextBefore: null };
    };
    const ok1 = await fetchCsv('opportunities', { status: 'new', q: '' }, file(200, 'text/csv; charset=utf-8', 'id,title\r\n1,x\r\n'));
    assert.deepEqual(ok1, { filename: 'opps.csv', text: 'id,title\r\n1,x\r\n', parts: 1, truncated: false }, 'файл — байт-в-байт');
    assert.deepEqual(asked.at(-1), { path: '/admin/reddit/rx/opportunities', query: { status: 'new', format: 'csv' } });
    await fetchCsv('sources', {}, file(200, 'text/csv', 'a'));
    assert.equal(asked.at(-1)?.path, '/admin/reddit/cx/sources');
    const env = await fetchCsv('briefs', {}, file(200, 'application/json', JSON.stringify({ success: true, data: 'a,b' })));
    assert.equal(env.text, 'a,b');
    await assert.rejects(
      fetchCsv('keywords', {}, file(404, 'application/json', JSON.stringify({ success: false, error: { code: 'PUB_PRODUCT_NONE', message: 'x' } }))),
      (e: unknown) => e instanceof ApiError && e.code === 'PUB_PRODUCT_NONE' && e.status === 404,
    );
    await assert.rejects(fetchCsv('keywords', {}, file(200, 'text/html', '<html>')), (e: unknown) => e instanceof ApiError && e.status === 502);
  }
  // Части по `X-Next-Before` (как `csvAll` кабинета): заголовок — один раз.
  {
    const asked: Array<Record<string, unknown> | undefined> = [];
    const parts: Record<string, { text: string; next: string | null }> = {
      '': { text: 'id,title\r\n1,a\r\n', next: 'cur1' },
      cur1: { text: 'id,title\r\n2,b\r\n', next: 'cur2' },
      cur2: { text: 'id,title\r\n3,c', next: null },
    };
    const get = async (_p: string, q?: Record<string, string | number | undefined>) => {
      asked.push(q);
      const pt = parts[String(q?.before ?? '')];
      return { status: 200, contentType: 'text/csv', disposition: '', text: pt.text, nextBefore: pt.next };
    };
    const all = await fetchCsv('publications', { status: 'published' }, get);
    assert.deepEqual(all, { filename: 'reddit-publications.csv', text: 'id,title\r\n1,a\r\n2,b\r\n3,c', parts: 3, truncated: false });
    assert.deepEqual(asked, [
      { status: 'published', format: 'csv' },
      { status: 'published', format: 'csv', before: 'cur1' },
      { status: 'published', format: 'csv', before: 'cur2' },
    ]);
    // Бесконечный курсор — стоп на пределе, файл помечен неполным.
    let n = 0;
    const endless = async () => ({ status: 200, contentType: 'text/csv', disposition: '', text: `h\n${n++}\n`, nextBefore: 'more' });
    const big = await fetchCsv('sources', {}, endless);
    assert.equal(big.parts, 20);
    assert.equal(big.truncated, true);
    assert.equal(big.text.split('\n').filter((l) => l === 'h').length, 1, 'заголовок — один раз');
    // Ошибка второй части — ошибка выгрузки (не обрезанный файл молча).
    let k = 0;
    const broken = async () =>
      k++ === 0
        ? { status: 200, contentType: 'text/csv', disposition: '', text: 'h\n1\n', nextBefore: 'c' }
        : { status: 409, contentType: 'application/json', disposition: '', text: JSON.stringify({ success: false, error: { code: 'PUB_CONFLICT', message: 'x', details: { reason: 'cursor' } } }), nextBefore: null };
    await assert.rejects(fetchCsv('keywords', {}, broken), (e: unknown) => e instanceof ApiError && e.code === 'PUB_CONFLICT');
  }
  const mat = { approvedVersion: { id: 'v2' }, publications: [{ versionId: 'v1', approvalId: 'ap_old' }, { versionId: 'v2', approvalId: 'ap2' }] };
  assert.equal(approvalIdOf(mat, {}), 'ap2', 'из отметки о публикации той же версии');
  assert.equal(approvalIdOf(mat, { v2: 'ap_mem' }), 'ap_mem', 'ответ согласования важнее');
  assert.equal(approvalIdOf({ approvedVersion: null, publications: [] }, { v2: 'x' }), null);
  assert.equal(approvalIdOf({ approvedVersion: { id: 'v3' }, publications: mat.publications }, {}), null);
  // v1.3: id — из `approval` вида материала (ручной ввод не нужен).
  const ap = { id: 'ap_srv', versionId: 'v2' };
  assert.equal(approvalIdOf({ ...mat, approval: ap }, { v2: 'ap_mem' }), 'ap_srv', 'approval сервера важнее запасных путей');
  assert.equal(approvalIdOf({ ...mat, approval: null }, { v2: 'ap_mem' }), null, 'approval null — согласования нет');
  assert.equal(approvalIdOf({ ...mat, approval: { id: 'ap_x', versionId: 'v1' } }, {}), null, 'согласование другой версии');
  // Факты и источники — чистые функции кабинета (brand-view).
  assert.deepEqual(factValue('price', { text: '', amount: '1900', currency: ' USD ', question: '', answer: '' }), {
    value: { amountMinor: 1900, currency: 'USD' },
    ready: true,
  });
  assert.equal(factValue('fact', { text: ' ', amount: '', currency: '', question: '', answer: '' }).ready, false);
  assert.deepEqual(
    sourceBody({ kind: 'url', title: ' T ', url: ' https://x.example/a ', author: '', publishedOn: '', fragment: ' F ', language: '', visibility: 'private', usage: 'allowed' }),
    { kind: 'url', title: 'T', url: 'https://x.example/a', author: null, publishedOn: null, fragment: 'F', language: null, visibility: 'private', usage: 'allowed' },
  );

  // ── 10. Аудит: AI-гейт и месяц (S2-1), сегмент (S3-1), флаг off (S3-3) ──
  {
    const base = decodeStatus({
      enabled: true,
      aiEnabled: true,
      platformSiteId: 's1',
      product: { id: 'p', siteId: 's1', kind: 'working', mode: 'closed', status: 'active' },
      gate: { open: true, missing: [] },
      aiGate: { open: false, missing: [{ kind: 'parameter', key: 'ai_fx_rate', detail: 'assumption' }], generatorEnabled: true, reason: 'gate_closed' },
      aiMonth: { month: '2026-10', open: false, reason: 'ai_params_missing', missing: [{ kind: 'parameter', key: 'ai_fx_rate', detail: 'assumption' }] },
    });
    const a = aiReadiness(base);
    assert.equal(a.ready, false);
    assert.ok(a.lines.some((l) => l.includes('Курс для AI')), 'недостающий ключ словами');
    const notOpen = aiReadiness({ ...base, aiGate: { ...base.aiGate!, open: true, missing: [], reason: null }, aiMonth: { month: '2026-10', open: false, reason: 'month_not_open', missing: [] } });
    const capped = aiReadiness({ ...base, aiGate: { ...base.aiGate!, open: true, missing: [], reason: null }, aiMonth: { month: '2026-10', open: true, reason: 'cap_exhausted', missing: [] } });
    assert.match(notOpen.lines.join(' '), /ещё не открыт/);
    assert.doesNotMatch(notOpen.lines.join(' '), /исчерпан/, '«не открыт» ≠ «исчерпан»');
    assert.match(capped.lines.join(' '), /исчерпан/);
    const okay = aiReadiness({ ...base, aiGate: { ...base.aiGate!, open: true, missing: [], reason: null }, aiMonth: { month: '2026-10', open: true, reason: null, missing: [] } });
    assert.equal(okay.ready, true);
    const gen = aiReadiness({ ...base, aiGate: { ...base.aiGate!, generatorEnabled: false, reason: 'generator_disabled' } });
    assert.equal(gen.ready, false);
    assert.match(gen.lines[0], /eval/, 'честно: до оценки качества');
    assert.equal(aiReadiness({ ...base, aiEnabled: false }).ready, false);
    assert.throws(() => decodeStatus({ ...base, aiGate: { ...base.aiGate, reason: 'bogus' } }));
    const old = decodeStatus({ enabled: true, aiEnabled: true, platformSiteId: 's1', product: null, gate: null });
    assert.equal(old.aiGate, null, 'сервер до v1.4 — без полей');
    assert.equal(productLine({ ...old, enabled: false }), 'скрыт — раздел выключен (PUBLISHER_REDDIT_ENABLED)');
    assert.equal(productLine(old), 'не заведён');
    const bh = decodeParams({
      items: [],
      keys: [],
      gate: { open: false, missing: [] },
      hints: {
        offerActiveVersion: null,
        accountOwnerMemberId: null,
        budget: {
          mode: 'ai_only',
          currency: 'UAH',
          months: 12,
          aiMonthMinor: 83000,
          values: {
            budget_total: { amountMinor: 996000, currency: 'UAH' },
            budget_split: { placementsMinor: 0, toolsMinor: 996000, reserveMinor: 0 },
            per_purchase_max: { amountMinor: 0 },
          },
        },
      },
    }).hints;
    assert.deepEqual(hintValue('budget_split', bh), { placementsMinor: 0, toolsMinor: 996000, reserveMinor: 0 });
    assert.deepEqual(hintValue('per_purchase_max', bh), { amountMinor: 0 });
    assert.equal(hintValue('budget_total', { ...bh, budget: { ...bh.budget!, values: null } }), null, 'без курса — нет подсказки');
    const seg = { ...emptyImportForm(), communitiesCsv: 'x', projectTitle: 't', market: 'US' };
    assert.deepEqual(importBody({ ...seg, segment: 'saas сегмент' }).issues, ['segment']);
    assert.deepEqual(importBody({ ...seg, segment: 'x'.repeat(41) }).issues, ['segment']);
    assert.deepEqual(importBody({ ...seg, segment: 'saas_2026-10' }).issues, []);
    assert.deepEqual(importBody({ ...seg, segment: '' }).issues, [], 'пусто — по умолчанию сервера');
  }

  // Аудит S2-2 (копия логики кабинета): правка только тезиса уходит в теле.
  {
    const b = { revision: 4, contentType: 'comment', opportunityId: 'ro1', communityId: 'rc1', context: 'Контекст', objective: 'Цель', keyPoints: [{ text: 'A', sourceIds: ['s1'] }, { text: 'B', sourceIds: ['s1'] }], constraints: [], forbiddenClaims: [], linksAllowed: false, language: 'en' };
    const base = briefForm(b as never);
    const mine = { ...base, keyPoints: base.keyPoints.map((k, i) => (i === 1 ? { ...k, text: 'B2' } : k)) };
    assert.deepEqual(briefPatchBody(b as never, mine, base), { expectedRevision: 4, keyPoints: [{ text: 'A', sourceIds: ['s1'] }, { text: 'B2', sourceIds: ['s1'] }] });
  }

  // Аудит S3-R2-1: конфликт по тезисам — текстом, не «[object Object]».
  assert.equal(conflictValueText([{ text: 'Тезис 1', sources: 'src1', needsVerification: false }, { text: 'Тезис 2' }]), 'Тезис 1; Тезис 2');
  assert.equal(conflictValueText(['a', 'b']), 'a, b');
  assert.equal(conflictValueText({ days: 30 }), '{"days":30}');
  assert.equal(conflictValueText(null), '');
  assert.ok(!conflictValueText([{ a: 1 }]).includes('[object Object]'));

  // ── 11. Копирование — ровно переданная строка; запасной путь ──
  const g = globalThis as unknown as { navigator?: unknown; document?: unknown };
  const text = 'I built **Acme**.\n\n- a\n- b\r\n  ';
  let got: string | null = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async (s: string) => void (got = s) } }, configurable: true });
  assert.equal(await copyText(text), true);
  assert.equal(got, text, 'копируется байт-в-байт');
  let fallback: string | null = null;
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => Promise.reject(new Error('denied')) } }, configurable: true });
  const ta = { value: '', style: {} as Record<string, string>, setAttribute() {}, select() {} };
  g.document = {
    createElement: () => ta,
    body: { appendChild: () => undefined, removeChild: () => undefined },
    execCommand: () => {
      fallback = ta.value;
      return true;
    },
  };
  assert.equal(await copyText(text), true);
  assert.equal(fallback, text, 'запасной путь — та же строка');
  delete g.document;

  // ── 12. Аудит UI 15.10.2026 (ui-3…ui-11): чистая логика экранов ──
  {
    const { decodeImportFile, readImportFile, csvFileText, IMPORT_FILE_TEXT } = await import('./reddit');
    const { confirmClick, CONFIRM_GUARD_MS } = await import('./reddit-shared/lib/publisher/view');
    const { isReloadable, isUncertainOutcome } = await import('./reddit-shared/lib/publisher/reddit-view');
    const { diffPartner } = await import('./reddit-shared/lib/publisher/reddit-studio-view');

    // ui-3: двойной клик не проходит двухшаговое подтверждение.
    assert.equal(confirmClick(null, 1000, 1), 'arm');
    assert.equal(confirmClick(1000, 1000 + 120, 2), 'ignore', 'второй щелчок двойного клика');
    assert.equal(confirmClick(1000, 1000 + 120, 1), 'ignore', 'раньше паузы');
    assert.equal(confirmClick(1000, 1000 + CONFIRM_GUARD_MS + 900, 3), 'ignore', 'тройной клик — серия');
    assert.equal(confirmClick(1000, 1000 + CONFIRM_GUARD_MS, 1), 'confirm');
    assert.equal(confirmClick(1000, 1000 + CONFIRM_GUARD_MS, 0), 'confirm', 'клавиатура: detail = 0');

    // ui-4/ui-5: файл импорта — строго UTF-8, ≤ 1 МБ, BOM снимается.
    const utf8 = new TextEncoder().encode('﻿subreddit,notes\r\nr/startups,заметка\r\n');
    const ok = decodeImportFile('a.csv', utf8);
    assert.ok(ok.ok && ok.text === 'subreddit,notes\r\nr/startups,заметка\r\n' && ok.lines === 2, JSON.stringify(ok));
    // «заметка» в Windows-1251.
    const cp1251 = new Uint8Array([...new TextEncoder().encode('subreddit,notes\r\nr/x,'), 0xe7, 0xe0, 0xec, 0xe5, 0xf2, 0xea, 0xe0, 0x0d, 0x0a]);
    const bad = decodeImportFile('b.csv', cp1251);
    assert.ok(!bad.ok && bad.error === IMPORT_FILE_TEXT.encoding('b.csv') && /UTF-8/.test(bad.error), JSON.stringify(bad));
    const big = decodeImportFile('c.csv', new Uint8Array(IMPORT_MAX_BYTES + 1));
    assert.ok(!big.ok && big.error === IMPORT_FILE_TEXT.tooLarge('c.csv'));
    let readCalls = 0;
    const tooBig = await readImportFile({ name: 'd.csv', size: IMPORT_MAX_BYTES + 1, arrayBuffer: async () => (readCalls++, new ArrayBuffer(0)) });
    assert.ok(!tooBig.ok && /больше 1 МБ/.test(tooBig.error) && !/Три файла/.test(tooBig.error), 'один файл — свой текст');
    assert.equal(readCalls, 0, 'большой файл не читается');
    const unread = await readImportFile({ name: 'e.csv', size: 10, arrayBuffer: async () => Promise.reject(new Error('NotReadableError')) });
    assert.ok(!unread.ok && unread.error === IMPORT_FILE_TEXT.unreadable('e.csv'));
    const read = await readImportFile({ name: 'f.csv', size: utf8.byteLength, arrayBuffer: async () => utf8.slice().buffer });
    assert.ok(read.ok && read.lines === 2);

    // ui-6: «исход неизвестен» — только сеть/502/503/504/UPSTREAM_TIMEOUT.
    const err = (code: string, status: number) => new ApiError(code, 'x', status);
    for (const e of [err('network', 0), err('Bad Gateway', 502), err('http_503', 503), err('UPSTREAM_TIMEOUT', 504), err('Gateway Timeout', 504)]) {
      assert.equal(isUncertainOutcome(e), true, `${e.code}/${e.status}`);
    }
    for (const e of [err('PUB_VALIDATION', 400), err('PUB_PAYLOAD_TOO_LARGE', 413), err('PUB_CONFLICT', 409), err('PUB_INTERNAL', 500), null]) {
      assert.equal(isUncertainOutcome(e), false, e ? `${e.code}/${e.status}` : 'null');
    }
    // Ответ backend 502/504 через адаптер Админки — тоже «неизвестен».
    assert.equal(isUncertainOutcome(toPubError(new ApiRequestError('Бэкенд клиентских сайтов не ответил', 502, 'Bad Gateway'))), true);
    assert.equal(isUncertainOutcome(toPubError(new ApiRequestError('timeout', 504, 'UPSTREAM_TIMEOUT'))), true);
    assert.equal(isUncertainOutcome(toPubError(new TypeError('Failed to fetch'))), true);

    // ui-7: «Повторить» у загрузчика — сеть, таймаут, PUB_BUSY, 5xx; 4xx — нет.
    for (const e of [err('network', 0), err('Bad Gateway', 502), err('PUB_INTERNAL', 500), err('PUB_BUSY', 409), err('UPSTREAM_TIMEOUT', 504), new Error('decode')]) {
      assert.equal(isReloadable(e), true, String(e));
    }
    for (const e of [err('PUB_NOT_FOUND', 404), err('PUB_CONFLICT', 409), err('PUB_VALIDATION', 400), err('ADMIN_ACTOR_REQUIRED', 401), null, undefined]) {
      assert.equal(isReloadable(e), false, String(e));
    }

    // ui-10: «сравнить с» = выбранная или исчезнувшая — сравнения нет.
    const ids = ['v1', 'v2', 'v3'];
    assert.equal(diffPartner('v2', 'v1', ids), 'v1');
    assert.equal(diffPartner('v2', 'v2', ids), '', 'с самой собой не сравнивается');
    assert.equal(diffPartner('v2', 'v9', ids), '', 'версии больше нет');
    assert.equal(diffPartner('v2', '', ids), '');
    assert.equal(diffPartner(null, 'v1', ids), '');

    // ui-11: файл CSV у оператора — с одним BOM (Excel читает UTF-8).
    assert.equal(csvFileText('id,title\r\n1,Привет\r\n'), '﻿id,title\r\n1,Привет\r\n');
    assert.equal(csvFileText('﻿id\r\n'), '﻿id\r\n', 'BOM не удваивается');
    assert.equal(csvFileText(''), '﻿');
  }

  console.log('reddit.test.ts: ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
