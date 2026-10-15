/**
 * Вкладка «Reddit» админки платформы (пакет P-R-ADM, Р-RD-ADM-1…5):
 * СТРОГИЙ список маршрутов внутреннего API sites-backend
 * `/internal/admin/reddit/*`, который генератор пропускает к нему от
 * оператора. Таблица — единственный источник: контроллер
 * (`admin-reddit.controller.ts`) объявляет ровно эти пары «метод + путь»
 * (`admin-reddit.client.spec.ts` сверяет метаданные Nest с таблицей), клиент
 * (`admin-reddit.client.ts`) строит адрес ТОЛЬКО по ней — никакого
 * проксирования произвольного пути или метода.
 *
 * Путь Админки `/api/admin/reddit/<path>` ↔ внутренний
 * `/internal/admin/reddit/<path>` (1:1, тот же метод и та же форма тела).
 * Контракт внутреннего API — v1.4 от 14.10.2026 (код sites-backend
 * `publisher/reddit/admin/admin-reddit-routes.ts`): `status`, `setup`,
 * `params*`, `import/*`, `rx/<путь REDDIT_ROUTES>` (все 39) и `cx/<путь
 * маршрута контента>` (студия, только Reddit-материалы; v1.2 — 24).
 * Тела и ответы — контракты Publisher (`sites-backend/src/modules/publisher/
 * contracts/{reddit-api,content-api}.ts`); генератор их не разбирает
 * (правила и проверки — на стороне sites-backend), только:
 *  - параметры пути — по формату (id объекта Publisher — `PUB_ID_RE`, ключ
 *    параметра — из списка гейта `reddit_publish` + двух параметров P-R);
 *  - query — только перечисленные ключи, строкой, с ограничением длины;
 *  - тело — JSON-объект, не больше `maxBodyBytes`.
 */

export type AdminRedditMethod = 'GET' | 'POST' | 'PATCH';

/** Вид параметра пути → проверка формата (см. `PATH_PARAM_KIND`). */
export type AdminRedditParamKind = 'id' | 'paramKey';

export interface AdminRedditRoute {
  method: AdminRedditMethod;
  /** Относительный путь без ведущего `/`, параметры — `:name`. */
  path: string;
  /** Разрешённые ключи query (остальные отбрасываются). */
  query?: readonly string[];
  /** Список с выгрузкой `?format=csv` (ответ `text/csv`, не конверт). */
  csv?: true;
  /** Таймаут запроса к sites-backend, мс (по умолчанию `DEFAULT_TIMEOUT_MS`). */
  timeoutMs?: number;
  /** Предел сериализованного тела, байт (по умолчанию `DEFAULT_MAX_BODY_BYTES`). */
  maxBodyBytes?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;
/**
 * Обычные тела (черновик Reddit ≤ 40 000 символов, правила сообщества,
 * выдержки) — с запасом; глобальный JSON-парсер backend всё равно
 * ограничивает их 100 КБ раньше.
 */
export const DEFAULT_MAX_BODY_BYTES = 256 * 1024;
/** Импорт исследования: три CSV ≤ 1 МБ вместе (спецификация P-R-ADM). */
export const IMPORT_MAX_BODY_BYTES = 1024 * 1024;
/** Модель Publisher отвечает до 40 с (`MODEL_TIMEOUT_MS`) + сохранение. */
const AI_TIMEOUT_MS = 60_000;
/**
 * Каскады (отзыв источника, смена оффера, решения по фактам бренда)
 * открывают задачи пересмотра по всем зависимым материалам в одной
 * транзакции.
 */
const CASCADE_TIMEOUT_MS = 30_000;
/** Импорт — одна транзакция на сотни строк. */
const IMPORT_TIMEOUT_MS = 60_000;

/**
 * id объекта Publisher в пути — ровно формат, который принимает
 * sites-backend (`ID_RE` в `reddit/admin/admin-reddit-routes.ts`; контракт-
 * тест сверяет). Раунд 2 (Р-RD-ADM-B11): НЕ только Prisma `cuid()` — вызовы
 * AI получают `aic_<24 hex>` (`aiRowId`), объекты восстановленного из копии
 * продукта — `rs_<24 hex>` (`restore.service.ts`). Обход пути исключён и
 * так: ни `/`, ни `.`, ни `%` в набор не входят.
 */
export const PUB_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Ключи параметров, которые Админка может предложить/утвердить — закрытый
 * список внутреннего контракта (§5, v1.4: 13 ключей; = `ADMIN_PARAMETER_KEYS`
 * sites-backend, контракт-тест сверяет): гейт `reddit_publish` и два
 * параметра P-R (Р-RD-ADM-5); v1.4 (Р-RD-ADM-14) — гейт `ai_use`,
 * `ai_unpriced_allowed` и бюджет месяца AI (`budget_total`, `budget_split`,
 * `per_purchase_max`). Прочие ключи продукта (сайт, лиды, закупки, отчёты)
 * не пропускаем — 400 без запроса.
 */
export const ADMIN_REDDIT_PARAM_KEYS = [
  'niche',
  'language',
  'market',
  'offer_active_version',
  'responsibles',
  'reddit_rules_stale_days',
  'reddit_excerpt_retention_days',
  'ai_budget_usd_month',
  'ai_fx_rate',
  'ai_unpriced_allowed',
  'budget_total',
  'budget_split',
  'per_purchase_max',
] as const;

export const PATH_PARAM_KIND: Readonly<Record<string, AdminRedditParamKind>> = {
  id: 'id',
  sid: 'id',
  cid: 'id',
  vid: 'id',
  a: 'id',
  b: 'id',
  callId: 'id',
  key: 'paramKey',
};

/**
 * Списки Reddit: `?before&limit&status&projectId&communityId&q` (+
 * `policyNow` у возможностей) и `format=csv` — выгрузка `text/csv`
 * (контракт §3; контроллер отдаёт её файлом, а не конвертом).
 */
const LIST_Q = [
  'before',
  'limit',
  'status',
  'projectId',
  'communityId',
  'q',
  'format',
] as const;

export const ADMIN_REDDIT_ROUTES = {
  // ── Раздел целиком ───────────────────────────────────────────────────
  status: { method: 'GET', path: 'status' },
  setup: { method: 'POST', path: 'setup', timeoutMs: 30_000 },
  // ── Параметры гейта `reddit_publish` ─────────────────────────────────
  listParams: { method: 'GET', path: 'params' },
  listProposals: {
    method: 'GET',
    path: 'params/:key/proposals',
    query: ['status', 'limit', 'before'],
  },
  proposeParam: { method: 'POST', path: 'params/:key/propose' },
  decideParam: { method: 'POST', path: 'params/:key/decide' },
  // ── Импорт исследования (CSV, как CLI) ───────────────────────────────
  importPlan: {
    method: 'POST',
    path: 'import/plan',
    timeoutMs: IMPORT_TIMEOUT_MS,
    maxBodyBytes: IMPORT_MAX_BODY_BYTES,
  },
  importApply: {
    method: 'POST',
    path: 'import/apply',
    timeoutMs: IMPORT_TIMEOUT_MS,
    maxBodyBytes: IMPORT_MAX_BODY_BYTES,
  },
  // ── rx/*: те же обработчики, что REDDIT_ROUTES (39) ─────────────────
  // Проекты
  listProjects: {
    method: 'GET',
    path: 'rx/projects',
    query: LIST_Q,
    csv: true,
  },
  createProject: { method: 'POST', path: 'rx/projects' },
  getProject: { method: 'GET', path: 'rx/projects/:id' },
  patchProject: { method: 'PATCH', path: 'rx/projects/:id' },
  archiveProject: { method: 'POST', path: 'rx/projects/:id/archive' },
  // Сообщества
  listCommunities: {
    method: 'GET',
    path: 'rx/communities',
    query: LIST_Q,
    csv: true,
  },
  createCommunity: { method: 'POST', path: 'rx/communities' },
  getCommunity: { method: 'GET', path: 'rx/communities/:id' },
  patchCommunity: { method: 'PATCH', path: 'rx/communities/:id' },
  // Правила
  listRules: { method: 'GET', path: 'rx/communities/:id/rules' },
  createRules: { method: 'POST', path: 'rx/communities/:id/rules' },
  getRulesSource: {
    method: 'GET',
    path: 'rx/communities/:id/rules/:sid/source',
  },
  reviewRules: { method: 'POST', path: 'rx/rules/:id/review' },
  // Возможности
  listOpportunities: {
    method: 'GET',
    path: 'rx/opportunities',
    query: [...LIST_Q, 'policyNow'],
    csv: true,
  },
  createOpportunity: { method: 'POST', path: 'rx/opportunities' },
  getOpportunity: { method: 'GET', path: 'rx/opportunities/:id' },
  listOpportunityExcerpts: {
    method: 'GET',
    path: 'rx/opportunities/:id/excerpts',
  },
  patchOpportunity: { method: 'PATCH', path: 'rx/opportunities/:id' },
  scoreOpportunity: { method: 'POST', path: 'rx/opportunities/:id/score' },
  qualifyOpportunity: {
    method: 'POST',
    path: 'rx/opportunities/:id/qualify',
  },
  skipOpportunity: { method: 'POST', path: 'rx/opportunities/:id/skip' },
  archiveOpportunity: {
    method: 'POST',
    path: 'rx/opportunities/:id/archive',
  },
  // Запросы
  listKeywords: {
    method: 'GET',
    path: 'rx/keywords',
    query: LIST_Q,
    csv: true,
  },
  createKeyword: { method: 'POST', path: 'rx/keywords' },
  patchKeyword: { method: 'PATCH', path: 'rx/keywords/:id' },
  // Брифы
  listBriefs: {
    method: 'GET',
    path: 'rx/briefs',
    query: [...LIST_Q, 'opportunityId', 'contentType'],
    csv: true,
  },
  createBrief: { method: 'POST', path: 'rx/briefs' },
  getBrief: { method: 'GET', path: 'rx/briefs/:id' },
  patchBrief: { method: 'PATCH', path: 'rx/briefs/:id' },
  briefReady: { method: 'POST', path: 'rx/briefs/:id/ready' },
  archiveBrief: { method: 'POST', path: 'rx/briefs/:id/archive' },
  generateDraft: {
    method: 'POST',
    path: 'rx/briefs/:id/generate',
    timeoutMs: AI_TIMEOUT_MS,
  },
  listBriefContents: { method: 'GET', path: 'rx/briefs/:id/contents' },
  createContent: { method: 'POST', path: 'rx/briefs/:id/contents' },
  // Материалы
  getContent: { method: 'GET', path: 'rx/contents/:cid' },
  checkContent: { method: 'POST', path: 'rx/contents/:cid/check' },
  copyContent: { method: 'POST', path: 'rx/contents/:cid/copy' },
  reportPublication: {
    method: 'POST',
    path: 'rx/contents/:cid/report-publication',
  },
  listPublications: {
    method: 'GET',
    path: 'rx/publications',
    query: [
      'before',
      'limit',
      'status',
      'stage',
      'communityId',
      'contentId',
      'format',
    ],
    csv: true,
  },
  // ── cx/*: студия — маршруты контента, только Reddit-материалы ───────
  listVersions: { method: 'GET', path: 'cx/contents/:cid/versions' },
  getVersion: { method: 'GET', path: 'cx/contents/:cid/versions/:vid' },
  createVersion: { method: 'POST', path: 'cx/contents/:cid/versions' },
  patchVersion: { method: 'PATCH', path: 'cx/contents/:cid/versions/:vid' },
  submitVersion: {
    method: 'POST',
    path: 'cx/contents/:cid/versions/:vid/submit',
  },
  diffVersions: {
    method: 'GET',
    path: 'cx/contents/:cid/versions/:a/diff/:b',
  },
  transitionContent: {
    method: 'POST',
    path: 'cx/contents/:cid/transition',
  },
  listQaChecks: { method: 'GET', path: 'cx/versions/:vid/qa-checks' },
  qaCheck: { method: 'POST', path: 'cx/versions/:vid/qa-checks' },
  approveVersion: { method: 'POST', path: 'cx/versions/:vid/approve' },
  // v1.2: согласование, источники, оффер, факты бренда, публикации, вызовы AI
  revokeApproval: { method: 'POST', path: 'cx/approvals/:id/revoke' },
  listSources: {
    method: 'GET',
    path: 'cx/sources',
    query: ['before', 'limit', 'usage', 'kind', 'visibility', 'format'],
    csv: true,
  },
  createSource: { method: 'POST', path: 'cx/sources' },
  revokeSource: {
    method: 'POST',
    path: 'cx/sources/:id/revoke',
    timeoutMs: CASCADE_TIMEOUT_MS,
  },
  listOffers: {
    method: 'GET',
    path: 'cx/offers',
    query: ['before', 'limit'],
  },
  createOffer: { method: 'POST', path: 'cx/offers' },
  activateOffer: {
    method: 'POST',
    path: 'cx/offers/:id/activate',
    timeoutMs: CASCADE_TIMEOUT_MS,
  },
  listBrandFacts: {
    method: 'GET',
    path: 'cx/brand-facts',
    query: ['status', 'factKey', 'before', 'limit', 'format'],
    csv: true,
  },
  createBrandFact: { method: 'POST', path: 'cx/brand-facts' },
  activateBrandFact: {
    method: 'POST',
    path: 'cx/brand-facts/:id/activate',
    timeoutMs: CASCADE_TIMEOUT_MS,
  },
  resolveBrandFact: {
    method: 'POST',
    path: 'cx/brand-facts/:id/resolve',
    timeoutMs: CASCADE_TIMEOUT_MS,
  },
  retireBrandFact: {
    method: 'POST',
    path: 'cx/brand-facts/:id/retire',
    timeoutMs: CASCADE_TIMEOUT_MS,
  },
  transitionPublication: {
    method: 'POST',
    path: 'cx/publications/:id/transition',
  },
  getAiCall: { method: 'GET', path: 'cx/ai/calls/:callId' },
} as const satisfies Record<string, AdminRedditRoute>;

export type AdminRedditRouteName = keyof typeof ADMIN_REDDIT_ROUTES;

/** Параметры пути маршрута (`:id` → `id`) — по шаблону. */
export function pathParamNames(path: string): string[] {
  return path
    .split('/')
    .filter((s) => s.startsWith(':'))
    .map((s) => s.slice(1));
}
