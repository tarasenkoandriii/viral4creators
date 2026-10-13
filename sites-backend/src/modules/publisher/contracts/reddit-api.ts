/**
 * AI Publisher — контракт маршрутов пакета P-R «Reddit Manual MVP», этап
 * M1 Research (doc/ai-publisher/reddit-manual-mvp-adapted.md §M1.5; Р-RD-13:
 * префикс `/publisher/products/:pid/reddit/**`). Заполнен по `_template.ts`;
 * `reddit/reddit-api.spec.ts` сверяет `REDDIT_ROUTES` с контроллером (метод,
 * путь, действие), `z-isolation.spec.ts` берёт реестр отсюда.
 *
 * Режим только MANUAL_COPY (Р-RD-0): ни один маршрут не обращается к Reddit —
 * ни API, ни страниц, ни oEmbed (правило графа `publisher-reddit-no-network`
 * и runtime-тест AT-RD-16). Всё, что известно о сообществе и треде, вводит
 * человек; сервер хранит канонический URL и не проверяет его сетью.
 *
 * Флаг `PUBLISHER_REDDIT_ENABLED` (по умолчанию выключен): пока он выключен,
 * КАЖДЫЙ маршрут ниже отвечает 404 `PUB_NOT_FOUND` без `details` (до входа и
 * ролей — неотличимо от отсутствия раздела); `GET /publisher/products/:pid`
 * отдаёт `features.reddit` (`ProductView`, `contracts/common.ts`).
 *
 * Имена в ответах: ключ `name` запрещён в ответах мутаций (`runOperation`,
 * Р-PUB-A1-13), поэтому имя проекта — `title`, имя сообщества — `subreddit`.
 *
 * Ошибки (Р-RD-14): 400 `PUB_VALIDATION {fields:[{field, code}]}`; 403
 * `PUB_ROLE_REQUIRED`; 404 `PUB_NOT_FOUND` (нет объекта, чужой кабинет,
 * флаг выключен); 409 `PUB_CONFLICT` (CAS — `{reason:'revision'}`; дубль —
 * `{reason:'duplicate', existingId}`), `PUB_TRANSITION_INVALID {reason, from}`,
 * `PUB_IDEMPOTENCY_REUSED`; 503 `PUB_BUSY` (повторить с тем же `opKey`).
 */
import { route } from './_template';
import type { ListPage, MutationBody, RevisionedBody } from './common';
import type {
  RedditCommunityStatus,
  RedditIntent,
  RedditKeywordStatus,
  RedditLinksPolicy,
  RedditOpportunityStatus,
  RedditPolicyVerdict,
  RedditProjectStatus,
  RedditPromotionPolicy,
  RedditReviewState,
  RedditScoreFactor,
  RedditSnapshotStatus,
} from './states';

export type {
  RedditCommunityStatus,
  RedditIntent,
  RedditKeywordStatus,
  RedditLinksPolicy,
  RedditOpportunityStatus,
  RedditPolicyVerdict,
  RedditProjectStatus,
  RedditPromotionPolicy,
  RedditReviewState,
  RedditScoreFactor,
  RedditSnapshotStatus,
};

// ── Policy Gate (§M1.3, `reddit/policy.ts`) ──────────────────────────────

/** Вычисляемое состояние снимка: `stale` = reviewed и `checkedAt + staleDays < now`. */
export type RedditSnapshotState = 'unreviewed' | 'reviewed' | 'stale';

export const REDDIT_POLICY_REASONS = [
  'rules_missing',
  'rules_unreviewed',
  'rules_stale',
  'promotion_prohibited',
  'promotion_unknown',
  'links_unknown',
  'links_prohibited',
  /** Возможность считалась по снимку, который сменила новая версия. */
  'rules_changed',
  /** Первоисточник снимка отозван (аудит P-R S2-2) — блокирует. */
  'rules_source_revoked',
] as const;
export type RedditPolicyReason = (typeof REDDIT_POLICY_REASONS)[number];
export const REDDIT_POLICY_WARNINGS = ['links_restricted'] as const;
export type RedditPolicyWarning = (typeof REDDIT_POLICY_WARNINGS)[number];

export interface RedditGateView {
  verdict: RedditPolicyVerdict;
  /** Причины BLOCK / `recheck_required` (пусто при `ok`). */
  reasons: RedditPolicyReason[];
  /** WARN (`links_restricted` — при ссылке в тексте, M2). */
  warnings: RedditPolicyWarning[];
}

// ── Проекты ──────────────────────────────────────────────────────────────

export interface RedditProjectView {
  id: string;
  /** Колонка `name` (1..120). */
  title: string;
  /** BCP-47, ≤ 16 (`uk`, `en-US`). */
  locale: string;
  /** ≤ 64, например `UA`, `US/EU SaaS`. */
  market: string;
  status: RedditProjectStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateRedditProjectBody extends MutationBody {
  title: string;
  locale: string;
  market: string;
}
export interface PatchRedditProjectBody extends RevisionedBody {
  title?: string;
  locale?: string;
  market?: string;
}
/** Переход `active → archived` (глагол, не PATCH статуса). */
export type ArchiveRedditProjectBody = RevisionedBody;

// ── Сообщества ───────────────────────────────────────────────────────────

/** Сводка текущего снимка правил сообщества (экран «Сообщества»). */
export interface RedditRulesSummary {
  snapshotId: string;
  version: number;
  state: RedditSnapshotState;
  reviewState: RedditReviewState;
  checkedAt: string;
  reviewedAt: string | null;
  selfReview: boolean;
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  /** Гейт для ответа без ссылок (возможности M1). */
  gate: RedditGateView;
}

export interface RedditCommunityView {
  id: string;
  projectId: string;
  /** Канал `pub_channels` kind=`community`, `utmSource='reddit'` (Р-RD-2). */
  channelId: string;
  /** Нормализованное имя без `r/`, нижний регистр, `^[a-z0-9_]{2,21}$`. */
  subreddit: string;
  /** `https://www.reddit.com/r/<subreddit>` — без завершающего `/`. */
  canonicalUrl: string;
  descriptionManual: string | null;
  language: string | null;
  topics: string[];
  status: RedditCommunityStatus;
  /** null — снимка правил нет (гейт `block`/`rules_missing`). */
  rules: RedditRulesSummary | null;
  /** Действующее значение параметра `reddit_rules_stale_days`. */
  staleDays: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateRedditCommunityBody extends MutationBody {
  projectId: string;
  /** `r/name`, `/r/name`, `name` или URL сообщества (`https://www|old.reddit.com/r/name/…`). */
  community: string;
  descriptionManual?: string | null;
  language?: string | null;
  /** ≤ 20 строк по ≤ 64. */
  topics?: string[];
}
export interface PatchRedditCommunityBody extends RevisionedBody {
  descriptionManual?: string | null;
  language?: string | null;
  topics?: string[];
  /** Архив и восстановление (сообщество одно на продукт, Р-RD-2). */
  status?: RedditCommunityStatus;
}

// ── Снимки правил (append-only после review, Р-RD-3) ────────────────────

export interface RedditRuleSnapshotView {
  id: string;
  communityId: string;
  version: number;
  /** Первоисточник: `pub_sources` kind=url, private, manual. */
  source: {
    id: string;
    url: string;
    /** Выдержка правил — только текстом (`<pre>`/`textContent`). */
    excerpt: string;
    injectionFlag: string | null;
    usage: 'allowed' | 'restricted' | 'revoked';
  };
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  flairRequired: boolean | null;
  conditions: string[];
  /** Когда оператор смотрел правила. */
  checkedAt: string;
  reviewState: RedditReviewState;
  state: RedditSnapshotState;
  /** `member:<id>` (или `restore:<id>` у восстановленного). */
  createdBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** Проверил автор снимка — экран показывает «перевірено автором». */
  selfReview: boolean;
  status: RedditSnapshotStatus;
  gate: RedditGateView;
  createdAt: string;
}
export interface CreateRedditRulesBody extends MutationBody {
  /** https-адрес правил (сайдбар, вики, rules) — хранится, не загружается. */
  sourceUrl: string;
  /** Выдержка правил своими словами или цитатой, 1..5000, без контактов. */
  sourceExcerpt: string;
  promotionPolicy: RedditPromotionPolicy;
  linksPolicy: RedditLinksPolicy;
  flairRequired?: boolean | null;
  /** ≤ 20 строк по ≤ 300 («только в еженедельном треде», «10:1»…). */
  conditions?: string[];
  /** ISO; не в будущем. */
  checkedAt: string;
}
/** Подтверждение проверки (`reddit.rules.review`). */
export type ReviewRedditRulesBody = MutationBody;

// ── Ключевые запросы ─────────────────────────────────────────────────────

export interface RedditKeywordView {
  id: string;
  projectId: string;
  phrase: string;
  /** Нижний регистр, сжатые пробелы; уникален в проекте. */
  phraseNorm: string;
  intent: RedditIntent;
  locale: string | null;
  priority: number;
  status: RedditKeywordStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateRedditKeywordBody extends MutationBody {
  projectId: string;
  /** 1..200, без контактов. Дубль (та же нормальная форма) → 409 `{existingId}`. */
  phrase: string;
  intent: RedditIntent;
  locale?: string | null;
  /** 1..5. */
  priority: number;
}
export interface PatchRedditKeywordBody extends RevisionedBody {
  phrase?: string;
  intent?: RedditIntent;
  locale?: string | null;
  priority?: number;
  status?: RedditKeywordStatus;
}

// ── Возможности ──────────────────────────────────────────────────────────

export interface RedditFactorValue {
  /** 0..100 или null — «не оценено» (не превращается в 0). */
  value: number | null;
  /** Обоснование оператора ≤ 300 (обязательно при значении); у `policy_risk` — null. */
  why: string | null;
  /**
   * Только `policy_risk`: машиночитаемое обоснование из снимка — коды
   * `rules_missing` | `promotion_<политика>` + `links_<политика>`; экран
   * переводит сам.
   */
  reasons?: string[];
}
export type RedditFactors = Record<RedditScoreFactor, RedditFactorValue>;
/** Факторы, которые вводит оператор: всё, кроме `policy_risk` (из снимка). */
export type RedditOperatorFactor = Exclude<RedditScoreFactor, 'policy_risk'>;
export type RedditFactorsInput = Partial<
  Record<RedditOperatorFactor, { value: number | null; why?: string | null }>
>;

export interface RedditScoreView {
  scoreVersion: 'v1';
  /** round(.35·topic + .25·intent + .20·audience + .20·answerability) | null. */
  relevance: number | null;
  /** round(.40·policy_risk + .25·promotionality + .20·evidence_gap + .15·context) | null. */
  risk: number | null;
  /** round(relevance·(1 − risk/100)) — только для сортировки | null. */
  priority: number | null;
  /** Факторы со значением null (группа с ними — «не рассчитано»). */
  missing: RedditScoreFactor[];
}

export interface RedditOpportunityView {
  id: string;
  projectId: string;
  communityId: string;
  subreddit: string;
  /** `https://www.reddit.com/r/<name>/comments/<id36>/<slug>` (без `/`, query, fragment). */
  threadUrl: string;
  /** `<id36>` — уникален в проекте. */
  threadKey: string;
  titleManual: string;
  /** Выдержка треда — `pub_sources` discussion/private/restricted ≤ 2000 (Р-RD-4). */
  excerpt: {
    sourceId: string;
    /** Только текстом, без markdown и HTML (A14). */
    text: string;
    /** Пометка «похоже на команду модели» (A14) или null. */
    injectionFlag: string | null;
    usage: 'allowed' | 'restricted' | 'revoked';
  } | null;
  intent: RedditIntent;
  angle: string | null;
  keywordIds: string[];
  factors: RedditFactors;
  score: RedditScoreView;
  /** Снимок, по которому считались риск и гейт; null — снимка не было. */
  ruleSnapshotId: string | null;
  ruleSnapshotVersion: number | null;
  /** Гейт НА МОМЕНТ ОЦЕНКИ (создание, правка факторов, `score`, каскад). */
  policy: RedditPolicyVerdict;
  policyReasons: RedditPolicyReason[];
  /**
   * Гейт СЕЙЧАС — пересчитан при чтении по текущему снимку, `staleDays` и
   * состоянию первоисточника (аудит P-R S2-3). `qualified` при
   * `policyNow≠ok` экран подсвечивает; дальше (бриф, M2) она не идёт.
   * Снимок сменился, а гейт ok — `recheck_required` (`rules_changed`).
   */
  policyNow: RedditPolicyVerdict;
  policyNowReasons: RedditPolicyReason[];
  status: RedditOpportunityStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
}
export interface CreateRedditOpportunityBody extends MutationBody {
  projectId: string;
  /** Сообщество того же проекта; сообщество в `threadUrl` должно совпасть (A15). */
  communityId: string;
  /** URL треда (`www.|old.|new.|m.reddit.com`, https); приводится к канону. */
  threadUrl: string;
  /** 1..300, без контактов. */
  titleManual: string;
  /** Выдержка ≤ 2000, без контактов (иначе 400 `pii`), без ников и ссылок на профили. */
  excerpt?: string | null;
  intent: RedditIntent;
  angle?: string | null;
  /** ≤ 10 id ключевых запросов своего проекта. */
  keywordIds?: string[];
  factors?: RedditFactorsInput;
}
export interface PatchRedditOpportunityBody extends RevisionedBody {
  /**
   * Новая редакция выдержки (≤ 2000, без контактов и ников): создаётся
   * новый источник с `supersedesId` прежнего, прежний не меняется
   * (аудит P-R S1-2); `null` — отвязать выдержку. Если текущая выдержка
   * отозвана — 409 `PUB_SOURCE_NOT_ALLOWED {sourceIds, reason:'revoked'}`
   * и на текст, и на `null` (реаудит N-1, Р-RD-40).
   */
  excerpt?: string | null;
  titleManual?: string;
  intent?: RedditIntent;
  angle?: string | null;
  keywordIds?: string[];
  /** Слияние по ключам; правка пересчитывает score и гейт по текущему снимку. */
  factors?: RedditFactorsInput;
}
/** Явный пересчёт score и гейта по ТЕКУЩЕМУ снимку сообщества. */
export type ScoreRedditOpportunityBody = RevisionedBody;
/** `qualify` (только `new` с гейтом `ok`), `skip`, `archive`. */
export interface RedditOpportunityTransitionBody extends RevisionedBody {
  /** Необязательная причина ≤ 2000, без контактов (в журнал аудита). */
  reason?: string;
}

// ── Доказательства P-R: редакции выдержки и первоисточник снимка ──────
// (UI-аудит S2-2, Р-RD-46). Только чтение при `reddit.read`; отзыв —
// существующим `POST /sources/:id/revoke` (`source.manage`), id берётся
// отсюда. Отозванные строки не скрываются: `usage='revoked'` + `revoked*`.

export interface RedditEvidenceView {
  sourceId: string;
  /** Порядковый номер редакции (1 — первая), по `createdAt`. */
  revision: number;
  supersedesId: string | null;
  /** Текущая выдержка возможности / первоисточник текущего снимка. */
  current: boolean;
  url: string;
  /** Текст — только текстом (`textContent`), и у отозванных тоже. */
  fragment: string;
  injectionFlag: string | null;
  usage: 'allowed' | 'restricted' | 'revoked';
  revokedAt: string | null;
  revokeReason: string | null;
  createdAt: string;
  createdBy: string;
}

/** `GET …/opportunities/:id/excerpts` — при любом статусе возможности. */
export interface RedditExcerptsView {
  opportunityId: string;
  /** `excerptSourceId` возможности (может быть `null` — отвязана). */
  currentSourceId: string | null;
  /**
   * Все выдержки треда возможности в продукте (`threadUrl`, вид
   * `discussion`, `origin='reddit'`) по возрастанию — цепочки
   * `supersedesId` и выдержки, отвязанные `excerpt: null`.
   */
  items: RedditEvidenceView[];
}

/** `GET …/communities/:id/rules/:sid/source` — и у `superseded` снимка. */
export interface RedditRulesSourceView {
  snapshotId: string;
  communityId: string;
  version: number;
  status: RedditSnapshotStatus;
  source: RedditEvidenceView;
}

// ── Списки (`?before&limit≤100&format=csv`) ──────────────────────────────

export interface RedditListQuery {
  before?: string;
  limit?: number;
  status?: string;
  projectId?: string;
  communityId?: string;
  /** Подстрока (без регистра): название, сообщество, заголовок, фраза. */
  q?: string;
  /**
   * Только возможности: живой гейт (`ok|recheck_required|block`), фильтр
   * по вычисленному `policyNow` (реаудит N-6). Сервер просматривает строки
   * пачками в порядке `id desc`, пока не наберёт страницу.
   */
  policyNow?: RedditPolicyVerdict;
  /** `csv` — выгрузка (аудит `export`), без пагинации, ≤ 5000 строк. */
  format?: 'json' | 'csv';
}

// ── Маршруты ─────────────────────────────────────────────────────────────

const P = '/publisher/products/:pid/reddit';

export const REDDIT_ROUTES = {
  // Проекты
  listProjects: route<void, ListPage<RedditProjectView>>({
    method: 'GET',
    path: `${P}/projects`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  createProject: route<CreateRedditProjectBody, RedditProjectView>({
    method: 'POST',
    path: `${P}/projects`,
    action: 'reddit.manage',
    mutation: true,
    status: 201,
  }),
  getProject: route<void, RedditProjectView>({
    method: 'GET',
    path: `${P}/projects/:id`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  patchProject: route<PatchRedditProjectBody, RedditProjectView>({
    method: 'PATCH',
    path: `${P}/projects/:id`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  archiveProject: route<ArchiveRedditProjectBody, RedditProjectView>({
    method: 'POST',
    path: `${P}/projects/:id/archive`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  // Сообщества
  listCommunities: route<void, ListPage<RedditCommunityView>>({
    method: 'GET',
    path: `${P}/communities`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  createCommunity: route<CreateRedditCommunityBody, RedditCommunityView>({
    method: 'POST',
    path: `${P}/communities`,
    action: 'reddit.manage',
    mutation: true,
    status: 201,
  }),
  getCommunity: route<void, RedditCommunityView>({
    method: 'GET',
    path: `${P}/communities/:id`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  patchCommunity: route<PatchRedditCommunityBody, RedditCommunityView>({
    method: 'PATCH',
    path: `${P}/communities/:id`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  // Правила
  listRules: route<void, ListPage<RedditRuleSnapshotView>>({
    method: 'GET',
    path: `${P}/communities/:id/rules`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  createRules: route<CreateRedditRulesBody, RedditRuleSnapshotView>({
    method: 'POST',
    path: `${P}/communities/:id/rules`,
    action: 'reddit.manage',
    mutation: true,
    status: 201,
  }),
  getRulesSource: route<void, RedditRulesSourceView>({
    method: 'GET',
    path: `${P}/communities/:id/rules/:sid/source`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  reviewRules: route<ReviewRedditRulesBody, RedditRuleSnapshotView>({
    method: 'POST',
    path: `${P}/rules/:id/review`,
    action: 'reddit.rules.review',
    mutation: true,
    status: 200,
  }),
  // Возможности
  listOpportunities: route<void, ListPage<RedditOpportunityView>>({
    method: 'GET',
    path: `${P}/opportunities`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  createOpportunity: route<CreateRedditOpportunityBody, RedditOpportunityView>({
    method: 'POST',
    path: `${P}/opportunities`,
    action: 'reddit.manage',
    mutation: true,
    status: 201,
  }),
  getOpportunity: route<void, RedditOpportunityView>({
    method: 'GET',
    path: `${P}/opportunities/:id`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  listOpportunityExcerpts: route<void, RedditExcerptsView>({
    method: 'GET',
    path: `${P}/opportunities/:id/excerpts`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  patchOpportunity: route<PatchRedditOpportunityBody, RedditOpportunityView>({
    method: 'PATCH',
    path: `${P}/opportunities/:id`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  scoreOpportunity: route<ScoreRedditOpportunityBody, RedditOpportunityView>({
    method: 'POST',
    path: `${P}/opportunities/:id/score`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  qualifyOpportunity: route<
    RedditOpportunityTransitionBody,
    RedditOpportunityView
  >({
    method: 'POST',
    path: `${P}/opportunities/:id/qualify`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  skipOpportunity: route<
    RedditOpportunityTransitionBody,
    RedditOpportunityView
  >({
    method: 'POST',
    path: `${P}/opportunities/:id/skip`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  archiveOpportunity: route<
    RedditOpportunityTransitionBody,
    RedditOpportunityView
  >({
    method: 'POST',
    path: `${P}/opportunities/:id/archive`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
  // Ключевые запросы
  listKeywords: route<void, ListPage<RedditKeywordView>>({
    method: 'GET',
    path: `${P}/keywords`,
    action: 'reddit.read',
    mutation: false,
    status: 200,
  }),
  createKeyword: route<CreateRedditKeywordBody, RedditKeywordView>({
    method: 'POST',
    path: `${P}/keywords`,
    action: 'reddit.manage',
    mutation: true,
    status: 201,
  }),
  patchKeyword: route<PatchRedditKeywordBody, RedditKeywordView>({
    method: 'PATCH',
    path: `${P}/keywords/:id`,
    action: 'reddit.manage',
    mutation: true,
    status: 200,
  }),
} as const;

/** Колонки CSV-выгрузок (`?format=csv`). */
export const REDDIT_CSV_COLUMNS = {
  projects: ['id', 'title', 'locale', 'market', 'status', 'createdAt'],
  communities: [
    'id',
    'projectId',
    'subreddit',
    'canonicalUrl',
    'language',
    'status',
    'rulesVersion',
    'rulesState',
    'rulesCheckedAt',
    'promotionPolicy',
    'linksPolicy',
  ],
  opportunities: [
    'id',
    'projectId',
    'subreddit',
    'threadUrl',
    'titleManual',
    'intent',
    'relevance',
    'risk',
    'priority',
    'missing',
    'policy',
    'policyReasons',
    'policyNow',
    'policyNowReasons',
    'status',
    'createdAt',
  ],
  keywords: [
    'id',
    'projectId',
    'phrase',
    'intent',
    'locale',
    'priority',
    'status',
  ],
} as const;
