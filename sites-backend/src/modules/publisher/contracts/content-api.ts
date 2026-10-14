/**
 * AI Publisher — контракт маршрутов пакета P-B1 «Контент F01–F04, F06
 * (ручной путь), публичное чтение» (проектный документ §11.3 «P-B1»,
 * §11.4 `GET /contents*`), по шаблону `_template.ts`. Тест
 * `content/content-api.spec.ts` сверяет `CONTENT_ROUTES` с контроллерами
 * (метод, путь, действие матрицы §4.2).
 *
 * AI-маршруты таблицы §11.3 (`questions/cluster`, `briefs/draft`,
 * `versions/draft`, `claims/extract`, `qa-checks/ai-review`,
 * `adaptations/draft`, `helper/answer`) — контроллер P-B2 (`ai-api.ts`).
 * P-B1 принимает результат AI только мутацией человека со ссылкой
 * `aiCallId` (бриф, группа вопросов, версия, claim) — §12.5.
 *
 * Общие правила: суммы — строки цифр, даты — ISO, неизвестное — `null`
 * (частотность вопроса без измерения — `null` и подпись «невідомо»).
 * Списки — `ListPage<T>` + `?format=csv` (без приватного текста источников
 * и без отозванных источников; аудит `export`). Ответы мутаций без ключей
 * ПД; группа вопросов (`task`) и факт бренда (произвольное `value`)
 * хранятся в ключе идемпотентности без тела (`storeResponse:false`).
 */
import { route } from './_template';
import type { ListPage, MutationBody, RevisionedBody } from './common';
import type {
  ApprovalStatus,
  ContentKind,
  ContentStatus,
  ReviewReason,
} from './states';

// ── Источники (F01–F04 вход) ─────────────────────────────────────────────

export type SourceKind =
  | 'url'
  | 'interview'
  | 'customer_question'
  | 'discussion'
  | 'search_data'
  | 'document'
  | 'manual_text'
  | 'experiment_record';
export type SourceUsage = 'allowed' | 'restricted' | 'revoked';
export type SourceVisibility = 'public' | 'private';

export interface SourceView {
  id: string;
  kind: SourceKind;
  url: string | null;
  externalRef: string | null;
  title: string | null;
  author: string | null;
  publishedOn: string | null;
  fragment: string;
  language: string | null;
  usage: SourceUsage;
  visibility: SourceVisibility;
  checkedAt: string | null;
  freshness: 'current' | 'stale' | 'unknown';
  importedVia: 'manual' | 'url_import';
  contentHash: string;
  supersedesId: string | null;
  injectionFlag: string | null;
  isSynthetic: boolean;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  /** Связан с замороженной версией/подтверждённым claim — содержимое неизменно. */
  locked: boolean;
  createdAt: string;
  createdBy: string;
  revision: number;
}

export interface CreateSourceBody extends MutationBody {
  kind: SourceKind;
  url?: string | null;
  externalRef?: string | null;
  title: string;
  author?: string | null;
  publishedOn?: string | null;
  fragment: string;
  language?: string | null;
  visibility: SourceVisibility;
  /** Ручной ввод разрешённого текста: `allowed` или `restricted`. */
  usage: 'allowed' | 'restricted';
}
export interface ImportUrlBody extends MutationBody {
  url: string;
  visibility: SourceVisibility;
}
/**
 * Метаданные — без новой строки; `usage` только `restricted → allowed`.
 * `url`/`fragment` у связанного источника — новая строка с `supersedesId`
 * и задачи `claim_changed` по версиям, которые ссылаются на прежнюю (§6.3).
 */
export interface PatchSourceBody extends RevisionedBody {
  title?: string | null;
  author?: string | null;
  publishedOn?: string | null;
  language?: string | null;
  externalRef?: string | null;
  visibility?: SourceVisibility;
  checkedAt?: string | null;
  freshness?: 'current' | 'stale' | 'unknown';
  usage?: 'allowed';
  url?: string | null;
  fragment?: string;
}
export interface RevokeSourceBody extends MutationBody {
  reason: string;
}
export interface RevokeSourceResponse {
  /**
   * Доказательство P-R (выдержка, первоисточник правил Reddit): `url`,
   * `title`, `author`, `externalRef` — `null`, `fragment` — `''` (Р-RD-41).
   */
  source: SourceView;
  revocationId: string;
  /** Новые задачи проверки (claims, версии, материалы, публикации). */
  tasksOpened: number;
}

// ── Вопросы F01 ──────────────────────────────────────────────────────────

export type QuestionStage =
  'awareness' | 'consideration' | 'decision' | 'unknown';
export type ScoreKey = 'offer_fit' | 'confirmed_task' | 'own_answer' | 'cost';
export interface ScoreEntry {
  score: 0 | 1 | 2 | null;
  why: string | null;
}
export type QuestionScores = Partial<Record<ScoreKey, ScoreEntry>>;

export interface QuestionView {
  id: string;
  text: string;
  audience: string | null;
  stage: QuestionStage;
  groupId: string | null;
  observedRepeats: number | null;
  /** NULL — частотность не измерялась (не ноль). */
  frequency: number | null;
  frequencySourceId: string | null;
  /** `«невідомо»` при `frequency = null`. */
  frequencyLabel: string;
  scores: QuestionScores;
  priorityNote: string | null;
  status: 'candidate' | 'selected' | 'rejected';
  selectedRank: number | null;
  sources: Array<{ sourceId: string; fragment: string | null }>;
  revision: number;
}

export interface QuestionSourceInput {
  sourceId: string;
  fragment?: string | null;
}
export interface CreateQuestionBody extends MutationBody {
  text: string;
  audience?: string | null;
  stage?: QuestionStage;
  observedRepeats?: number | null;
  frequency?: number | null;
  frequencySourceId?: string | null;
  scores?: QuestionScores;
  priorityNote?: string | null;
  sources?: QuestionSourceInput[];
}
export interface PatchQuestionBody extends RevisionedBody {
  text?: string;
  audience?: string | null;
  stage?: QuestionStage;
  observedRepeats?: number | null;
  frequency?: number | null;
  frequencySourceId?: string | null;
  scores?: QuestionScores;
  priorityNote?: string | null;
  /** Заменяет набор источников. */
  sources?: QuestionSourceInput[];
  /** Ручная группировка; `null` — вне группы. */
  groupId?: string | null;
  status?: 'candidate' | 'selected' | 'rejected';
  /** 1..6 при `selected`. */
  selectedRank?: number | null;
}

export interface QuestionGroupView {
  id: string;
  key: string;
  task: string;
  stage: QuestionStage;
  audience: string | null;
  rationale: string;
  mergeRisk: string | null;
  status: 'proposed' | 'confirmed' | 'split' | 'rejected';
  aiCallId: string | null;
  questionIds: string[];
  revision: number;
}
/** Группа создаётся человеком (AI-кластеризация в P0 выключена, ДТ-2). */
export interface CreateQuestionGroupBody extends MutationBody {
  key: string;
  task: string;
  stage: QuestionStage;
  audience?: string | null;
  rationale: string;
  mergeRisk?: string | null;
  questionIds: string[];
  /** Предложение `pub.questions.cluster`, принятое человеком (в P0 не бывает). */
  aiCallId?: string | null;
  /**
   * Вопрос уже в другой группе — перенос только явным `true`
   * (разные задачи не склеиваются без решения человека, AT-F01-02).
   */
  moveFromOtherGroups?: boolean;
}
export interface PatchQuestionGroupBody extends RevisionedBody {
  task?: string;
  rationale?: string;
  mergeRisk?: string | null;
  audience?: string | null;
  stage?: QuestionStage;
  /** `split` — вопросы выходят из группы (`groupId = null`). */
  status?: 'confirmed' | 'split' | 'rejected';
}

// ── Факты бренда и оффер F02 ─────────────────────────────────────────────

export type BrandFactKind =
  | 'fact'
  | 'price'
  | 'condition'
  | 'example'
  | 'case'
  | 'contact'
  | 'tone'
  | 'limitation'
  | 'forbidden_promise'
  | 'faq';
export type BrandFactStatus =
  'draft' | 'active' | 'superseded' | 'needs_resolution' | 'rejected';

export interface BrandFactView {
  id: string;
  factKey: string;
  kind: BrandFactKind;
  value: unknown;
  scope: string | null;
  sourceId: string | null;
  version: number;
  status: BrandFactStatus;
  approvedBy: string | null;
  approvedAt: string | null;
  conflictWithId: string | null;
  revision: number;
}
export interface CreateBrandFactBody extends MutationBody {
  factKey: string;
  kind: BrandFactKind;
  /** `price`: `{amountMinor, currency, note?}`; `faq`: `{question, answer}`; иначе `{text}`. */
  value: unknown;
  scope?: string | null;
  sourceId?: string | null;
}
export interface CreateBrandFactResponse {
  fact: BrandFactView;
  /** Задача `fact_conflict` открыта (второе значение ключа без решения). */
  conflictTaskOpened: boolean;
}
export interface ActivateFactBody extends MutationBody {
  basis?: string | null;
}
export interface ResolveFactBody extends MutationBody {
  keepId: string;
  reason: string;
}
export interface RetireFactBody extends MutationBody {
  reason: string;
}
export interface CascadeSummary {
  /** Новые задачи проверки. */
  tasksOpened: number;
  /** Опубликованные материалы/адаптации → `correction_required`. */
  correctionRequired: string[];
  /** Согласования неопубликованных версий → `superseded`. */
  approvalsSuperseded: string[];
}
export interface FactDecisionResponse {
  fact: BrandFactView;
  cascade: CascadeSummary;
}

export interface OfferVersionView {
  id: string;
  version: number;
  title: string;
  text: string;
  priceNote: string | null;
  status: 'draft' | 'active' | 'superseded' | 'historical';
  approvedBy: string | null;
  approvedAt: string | null;
  hash: string;
  factIds: string[];
  revision: number;
}
export interface CreateOfferBody extends MutationBody {
  title: string;
  text: string;
  priceNote?: string | null;
  factIds?: string[];
}
export interface ActivateOfferBody extends MutationBody {
  basis: string;
}
export interface ActivateOfferResponse {
  offer: OfferVersionView;
  parameterVersion: number;
  cascade: CascadeSummary;
}

/** `GET context-preview` — что увидит AI (правила `ctx@1`, §12.3). */
export interface ContextPreview {
  purpose: string;
  audience: 'internal' | 'public';
  sources: Array<{
    id: string;
    title: string | null;
    visibility: SourceVisibility;
    injectionFlag: string | null;
  }>;
  facts: Array<{
    id: string;
    factKey: string;
    kind: BrandFactKind;
    version: number;
    value: unknown;
  }>;
  offer: {
    id: string;
    version: number;
    title: string;
    priceNote: string | null;
  } | null;
  forbiddenPromises: Array<{ id: string; factKey: string; value: unknown }>;
  excluded: {
    restricted: number;
    revoked: number;
    privateForPublic: number;
    notRequested: number;
  };
}

// ── Брифы F03 ────────────────────────────────────────────────────────────

export type BriefFormat = 'instruction' | 'case_review' | 'choice_guide';
export interface BriefView {
  id: string;
  questionId: string;
  offerVersionId: string;
  goal: string;
  format: BriefFormat;
  ownContribution: string | null;
  shortAnswer: string | null;
  cta: string | null;
  ctaIntentNote: string | null;
  structure: string[];
  channels: string[];
  readinessCriteria: string[];
  effortMinutes: number | null;
  unresolved: string[];
  status: 'draft' | 'ready' | 'rejected';
  aiCallId: string | null;
  sourceIds: string[];
  /** Чего не хватает для `ready` (пусто — можно отметить готовым). */
  missing: BriefMissing[];
  revision: number;
}
export type BriefMissing =
  | 'own_contribution'
  | 'cta'
  | 'cta_intent_note'
  | 'allowed_source'
  | 'offer_active';
export interface CreateBriefBody extends MutationBody {
  questionId: string;
  /** По умолчанию — активная версия оффера. */
  offerVersionId?: string | null;
  goal: string;
  format: BriefFormat;
  ownContribution?: string | null;
  shortAnswer?: string | null;
  cta?: string | null;
  ctaIntentNote?: string | null;
  structure?: string[];
  channels?: string[];
  readinessCriteria?: string[];
  effortMinutes?: number | null;
  unresolved?: string[];
  sourceIds?: string[];
  /** Предложение `pub.brief.draft`, принятое человеком. */
  aiCallId?: string | null;
}
/** Правка готового брифа возвращает его в `draft`. */
export interface PatchBriefBody extends RevisionedBody {
  offerVersionId?: string;
  goal?: string;
  format?: BriefFormat;
  ownContribution?: string | null;
  shortAnswer?: string | null;
  cta?: string | null;
  ctaIntentNote?: string | null;
  structure?: string[];
  channels?: string[];
  readinessCriteria?: string[];
  effortMinutes?: number | null;
  unresolved?: string[];
  sourceIds?: string[];
  status?: 'draft' | 'rejected';
}

// ── Материалы, версии, claims, QA, согласование F03/F04/F06 ──────────────

export interface ContentView {
  id: string;
  kind: ContentKind;
  parentContentId: string | null;
  briefId: string | null;
  slug: string | null;
  status: ContentStatus;
  currentVersionId: string | null;
  approvedVersionId: string | null;
  publishedVersionId: string | null;
  ownerMemberId: string | null;
  ownerDisplayName: string | null;
  nextDueAt: string | null;
  blockReason: string | null;
  criticalStale: boolean;
  firstPublishedAt: string | null;
  /** P-R M2: Reddit-бриф материала `reddit_post|reddit_comment` (иначе null). */
  redditBriefId: string | null;
  /**
   * P-R M2 (раунд 4, аудит экранов S3-10): есть только у Reddit-материала —
   * его версии, согласование с подтверждением WARN, копирование и отметка о
   * публикации ведутся в студии Reddit; общий экран «Матеріали» прячет
   * общие действия публикации и согласования и даёт ссылку в студию.
   */
  redditStudio?: true;
  /** Открытые задачи проверки по материалу и его версиям. */
  openTasks: Array<{ id: string; reason: ReviewReason; objectType: string }>;
  /** Допустимые переходы машины 7.1 из текущего статуса. */
  allowedTransitions: ContentStatus[];
  revision: number;
}
export interface CreateContentBody extends MutationBody {
  kind: ContentKind;
  /** Статья. */
  briefId?: string | null;
  /** Адаптация (`post|cards|checklist|video_script`). */
  parentContentId?: string | null;
  slug?: string | null;
  ownerMemberId?: string | null;
  ownerDisplayName?: string | null;
}
export interface PatchContentBody extends RevisionedBody {
  slug?: string | null;
  ownerMemberId?: string | null;
  ownerDisplayName?: string | null;
  nextDueAt?: string | null;
  blockReason?: string | null;
}

/** `meta` версии — только эти ключи (= белый список `pub_public_contents`). */
export interface VersionMeta {
  description?: string;
  shortAnswer?: string;
  example?: string;
  limitations?: string[];
  editor?: string;
  cta?: string;
  cards?: Array<{ title: string; text: string }>;
  scenes?: Array<{ visual: string; voice: string; caption: string }>;
  substantiallyUpdatedAt?: string;
}

/**
 * `meta` версии Reddit-материала (P-R M2, §M2.1; белый список
 * `REDDIT_VERSION_META_KEYS` в `content/rules.ts`). Весь `meta` входит в
 * hash версии (Р-RD-7). Поля `ruleSnapshotId`, `affiliation`, `threadUrl`
 * ставит сервер (переданные клиентом → 400 `derived`).
 */
export interface RedditVersionMeta {
  disclosure?: string;
  flairSuggestion?: string | null;
  claimMap?: Array<{
    text: string;
    sourceIds: string[] | 'needs_verification';
  }>;
  uncertainties?: string[];
  ruleSnapshotId?: string | null;
  affiliation?: 'founder' | 'employee' | 'agency' | 'customer' | 'none';
  threadUrl?: string | null;
}
export interface VersionView {
  id: string;
  contentId: string;
  number: number;
  title: string;
  body: string;
  meta: VersionMeta & RedditVersionMeta;
  format: ContentKind;
  /** Сценарий видео помечен как сценарий (F06, не готовый ролик). */
  isScript: boolean;
  parentVersionId: string | null;
  offerVersionId: string;
  authorMemberId: string;
  aiCallId: string | null;
  status:
    | 'draft'
    | 'submitted'
    | 'changes_requested'
    | 'approved'
    | 'rejected'
    | 'superseded';
  hash: string | null;
  frozenAt: string | null;
  sourceIds: string[];
  claimIds: string[];
  factIds: string[];
  revision: number;
}
export interface CreateVersionBody extends MutationBody {
  title: string;
  body: string;
  meta?: VersionMeta;
  sourceIds?: string[];
  claimIds?: string[];
  /** Факты бренда, на которые опирается текст (`pub_version_facts`). */
  factIds?: string[];
  offerVersionId: string;
  /** Адаптация: версия родительской статьи (F06 `parent_version`). */
  parentVersionId?: string | null;
  /** Предложение `pub.adaptation.make`, принятое человеком. */
  aiCallId?: string | null;
  /** P-R M2: индекс выбранного варианта вызова `pub.reddit.draft` (0..2). */
  variantIndex?: number | null;
}
export interface PatchVersionBody extends RevisionedBody {
  title?: string;
  body?: string;
  meta?: VersionMeta;
  sourceIds?: string[];
  claimIds?: string[];
  factIds?: string[];
  offerVersionId?: string;
  parentVersionId?: string | null;
}
/**
 * P-R M2 (замечание экранов, Р-RD-72): тела версий Reddit-материала на тех
 * же маршрутах `createVersion`/`patchVersion`. `title` — только у
 * `reddit_post` (у комментария служебный, клиент → 400 `derived`);
 * `offerVersionId`/`sourceIds` ставит сервер (→ 400 `derived`), родителя
 * нет (→ 400 `not_allowed`); `meta` — клиентская часть
 * (`RedditVersionClientMeta`); выбор варианта генерации — `aiCallId` +
 * `variantIndex` (и при PATCH черновика).
 */
export type RedditVersionClientMeta = Pick<
  RedditVersionMeta,
  'disclosure' | 'flairSuggestion' | 'claimMap' | 'uncertainties'
>;
export interface CreateRedditVersionBody extends MutationBody {
  /** Только `reddit_post` (≤ 300). */
  title?: string;
  /** post ≤ 40 000, comment ≤ 10 000, без сырого HTML. */
  body: string;
  meta?: RedditVersionClientMeta;
  claimIds?: string[];
  factIds?: string[];
  aiCallId?: string | null;
  variantIndex?: number | null;
}
export interface PatchRedditVersionBody extends RevisionedBody {
  title?: string;
  body?: string;
  meta?: RedditVersionClientMeta;
  claimIds?: string[];
  factIds?: string[];
  aiCallId?: string | null;
  variantIndex?: number | null;
}
export type SubmitVersionBody = RevisionedBody;
export interface DiffLine {
  op: 'eq' | 'add' | 'del';
  text: string;
}
export interface VersionDiff {
  a: string;
  b: string;
  title: { from: string; to: string } | null;
  body: DiffLine[];
  /** `true` — тело слишком велико, показан блок «было/стало». */
  bodyCoarse: boolean;
  metaChanged: string[];
  offerChanged: boolean;
  sources: { added: string[]; removed: string[] };
  claims: { added: string[]; removed: string[] };
  facts: { added: string[]; removed: string[] };
}

export interface TransitionBody extends RevisionedBody {
  to: ContentStatus;
  reason?: string | null;
  /** `approved → scheduled`: плановая дата (ISO). */
  plannedAt?: string | null;
}

export type ClaimType = 'fact' | 'estimate' | 'hypothesis' | 'example';
export type ClaimRisk = 'critical' | 'high' | 'normal';
export type ClaimStatus =
  'unverified' | 'supported' | 'unsupported' | 'unknown' | 'needs_review';
export type ClaimSupports = 'yes' | 'no' | 'partial' | 'unknown';
export interface ClaimView {
  id: string;
  statement: string;
  type: ClaimType;
  risk: ClaimRisk;
  status: ClaimStatus;
  extractedFromVersionId: string | null;
  experimentId: string | null;
  supersedesId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  nextCheckAt: string | null;
  aiCallId: string | null;
  sources: Array<{
    sourceId: string;
    supports: ClaimSupports;
    checkedBy: string | null;
    checkedAt: string | null;
    note: string | null;
  }>;
  versionIds: string[];
  revision: number;
}
export interface CreateClaimBody extends MutationBody {
  statement: string;
  type: ClaimType;
  risk: ClaimRisk;
  extractedFromVersionId?: string | null;
  /** Собственный результат ссылается на эксперимент (F04). */
  experimentId?: string | null;
  nextCheckAt?: string | null;
  aiCallId?: string | null;
}
/**
 * Правка `statement/type/risk` claim, связанного с замороженной версией, —
 * новая строка с `supersedesId` и задачи `claim_changed` (§6.3, F04).
 */
export interface PatchClaimBody extends RevisionedBody {
  statement?: string;
  type?: ClaimType;
  risk?: ClaimRisk;
  nextCheckAt?: string | null;
}
export interface PatchClaimResponse {
  claim: ClaimView;
  /** Прежняя строка, если создана новая (`supersedesId`). */
  supersededId: string | null;
  cascade: CascadeSummary | null;
}
export interface ClaimSourceBody extends MutationBody {
  sourceId: string;
  supports: ClaimSupports;
  note?: string | null;
}
export interface VerifyClaimBody extends RevisionedBody {
  status: 'supported' | 'unsupported' | 'unknown' | 'needs_review';
}

export type QaKind = 'editorial' | 'technical' | 'adaptation_meaning';
/**
 * Машиночитаемые параметры находки (P-R M2, раунд 4, аудит экранов S3-4):
 * у `reddit_policy` — найденные фрагменты (`found`), причина (`reason`),
 * бренд брифа (`brand`), номера пунктов claimMap (`claims`); тексты по
 * коду и параметрам делает клиент (`text` у `reddit_policy` = код).
 */
export type QaFindingParams = Record<
  string,
  string | number | string[] | number[]
>;
export interface QaBlocker {
  code: string;
  claimId?: string | null;
  text: string;
  params?: QaFindingParams;
}
export interface QaCheckBody extends MutationBody {
  kind: QaKind;
  result: 'pass' | 'fail' | 'unknown';
  blockers?: QaBlocker[];
}
/** Предупреждение проверки (P-R M2, Р-RD-8): подтверждается при согласовании. */
export interface QaWarning {
  code: string;
  text: string;
  params?: QaFindingParams;
}
export interface QaCheckView {
  id: string;
  versionId: string;
  kind: QaKind | 'ai_review' | 'reddit_policy';
  result: 'pass' | 'fail' | 'unknown';
  blockers: QaBlocker[];
  /** WARN `reddit_policy` (у прочих видов — пусто). */
  warnings: QaWarning[];
  checkedBy: string;
  checkedAt: string;
  selfReview: boolean;
  aiCallId: string | null;
}

export interface ApproveBody extends MutationBody {
  versionHash: string;
  reason?: string | null;
  /**
   * P-R M2 (§M2.4): коды WARN свежей проверки `reddit_policy` — ровно они
   * (порядок не важен), иначе 409 `PUB_CONFLICT {reason:
   * 'warnings_not_acknowledged', codes}`; хранится в `meta` аудита
   * согласования. У не-Reddit материала непустой список — 400.
   */
  acknowledgedWarnings?: string[];
}
export interface ApprovalView {
  id: string;
  type: 'publish_version';
  objectType: 'content_version';
  objectId: string;
  versionHash: string;
  approverMemberId: string;
  /**
   * Снимок имени согласующего — с сервера (снимок гранта роли продукта,
   * иначе «Учасник …xxxxxx»); из тела не берётся (аудит P-B1 S3-6).
   */
  approverDisplayName: string;
  decidedAt: string;
  status: ApprovalStatus;
  selfReview: boolean;
  reason: string | null;
}
export interface RevokeApprovalBody extends MutationBody {
  reason: string;
}
/** Блокер согласования (`PUB_BLOCKERS_OPEN {blockers}`). */
export interface ApprovalBlocker {
  code:
    | 'qa_editorial_missing'
    | 'qa_technical_missing'
    | 'qa_adaptation_meaning_missing'
    | 'qa_blocker'
    | 'claim_not_supported'
    | 'claim_unsupported'
    | 'source_not_allowed'
    | 'offer_inactive'
    | 'change_task_open'
    | 'parent_not_approved'
    /** P-R M2: последняя `reddit_policy` версии отсутствует или с блокерами. */
    | 'reddit_policy_block';
  id?: string;
  /** `reddit_policy_block`: коды BLOCK последней проверки (без id строки). */
  codes?: string[];
}

// ── Публичное чтение (§11.4) ─────────────────────────────────────────────

export interface PublicContentListItem {
  slug: string;
  title: string | null;
  description: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  stage: 'test' | 'live';
  withdrawn: boolean;
}
export interface PublicContent {
  title: string;
  shortAnswer: string | null;
  body: string;
  example: string | null;
  limitations: string[];
  editor: string | null;
  publishedAt: string | null;
  substantiallyUpdatedAt: string | null;
  sources: Array<
    { title: string | null; url: string | null } | { private: true }
  >;
  cta: string | null;
  versionHash: string;
  stage: 'test' | 'live';
}

const C = '/publisher/products/:pid';
const PUBLIC = '/public/publisher/v1';

export const CONTENT_ROUTES = {
  // Источники
  listSources: route<void, ListPage<SourceView>>({
    method: 'GET',
    path: `${C}/sources`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getSource: route<void, SourceView>({
    method: 'GET',
    path: `${C}/sources/:id`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createSource: route<CreateSourceBody, SourceView>({
    method: 'POST',
    path: `${C}/sources`,
    action: 'source.manage',
    mutation: true,
    status: 201,
  }),
  importUrl: route<ImportUrlBody, SourceView>({
    method: 'POST',
    path: `${C}/sources/import-url`,
    action: 'source.manage',
    mutation: true,
    status: 201,
  }),
  patchSource: route<PatchSourceBody, SourceView>({
    method: 'PATCH',
    path: `${C}/sources/:id`,
    action: 'source.manage',
    mutation: true,
    status: 200,
  }),
  revokeSource: route<RevokeSourceBody, RevokeSourceResponse>({
    method: 'POST',
    path: `${C}/sources/:id/revoke`,
    action: 'source.manage',
    mutation: true,
    status: 200,
  }),
  // Вопросы F01
  listQuestions: route<void, ListPage<QuestionView>>({
    method: 'GET',
    path: `${C}/questions`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createQuestion: route<CreateQuestionBody, QuestionView>({
    method: 'POST',
    path: `${C}/questions`,
    action: 'question.manage',
    mutation: true,
    status: 201,
  }),
  patchQuestion: route<PatchQuestionBody, QuestionView>({
    method: 'PATCH',
    path: `${C}/questions/:id`,
    action: 'question.manage',
    mutation: true,
    status: 200,
  }),
  listGroups: route<void, ListPage<QuestionGroupView>>({
    method: 'GET',
    path: `${C}/question-groups`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createGroup: route<CreateQuestionGroupBody, QuestionGroupView>({
    method: 'POST',
    path: `${C}/question-groups`,
    action: 'question.manage',
    mutation: true,
    status: 201,
  }),
  patchGroup: route<PatchQuestionGroupBody, QuestionGroupView>({
    method: 'PATCH',
    path: `${C}/question-groups/:id`,
    action: 'question.manage',
    mutation: true,
    status: 200,
  }),
  // Бренд и оффер F02
  listFacts: route<void, ListPage<BrandFactView>>({
    method: 'GET',
    path: `${C}/brand-facts`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createFact: route<CreateBrandFactBody, CreateBrandFactResponse>({
    method: 'POST',
    path: `${C}/brand-facts`,
    action: 'brand.draft',
    mutation: true,
    status: 201,
  }),
  activateFact: route<ActivateFactBody, FactDecisionResponse>({
    method: 'POST',
    path: `${C}/brand-facts/:id/activate`,
    action: 'brand.activate',
    mutation: true,
    status: 200,
  }),
  resolveFact: route<ResolveFactBody, FactDecisionResponse>({
    method: 'POST',
    path: `${C}/brand-facts/:id/resolve`,
    action: 'brand.activate',
    mutation: true,
    status: 200,
  }),
  retireFact: route<RetireFactBody, FactDecisionResponse>({
    method: 'POST',
    path: `${C}/brand-facts/:id/retire`,
    action: 'brand.activate',
    mutation: true,
    status: 200,
  }),
  listOffers: route<void, ListPage<OfferVersionView>>({
    method: 'GET',
    path: `${C}/offers`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createOffer: route<CreateOfferBody, OfferVersionView>({
    method: 'POST',
    path: `${C}/offers`,
    action: 'brand.activate',
    mutation: true,
    status: 201,
  }),
  activateOffer: route<ActivateOfferBody, ActivateOfferResponse>({
    method: 'POST',
    path: `${C}/offers/:id/activate`,
    action: 'brand.activate',
    mutation: true,
    status: 200,
  }),
  contextPreview: route<void, ContextPreview>({
    method: 'GET',
    path: `${C}/context-preview`,
    action: 'source.manage',
    mutation: false,
    status: 200,
  }),
  // Брифы F03
  listBriefs: route<void, ListPage<BriefView>>({
    method: 'GET',
    path: `${C}/briefs`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getBrief: route<void, BriefView>({
    method: 'GET',
    path: `${C}/briefs/:id`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createBrief: route<CreateBriefBody, BriefView>({
    method: 'POST',
    path: `${C}/briefs`,
    action: 'brief.manage',
    mutation: true,
    status: 201,
  }),
  patchBrief: route<PatchBriefBody, BriefView>({
    method: 'PATCH',
    path: `${C}/briefs/:id`,
    action: 'brief.manage',
    mutation: true,
    status: 200,
  }),
  briefReady: route<RevisionedBody, BriefView>({
    method: 'POST',
    path: `${C}/briefs/:id/ready`,
    action: 'brief.manage',
    mutation: true,
    status: 200,
  }),
  // Материалы и версии
  listContents: route<void, ListPage<ContentView>>({
    method: 'GET',
    path: `${C}/contents`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createContent: route<CreateContentBody, ContentView>({
    method: 'POST',
    path: `${C}/contents`,
    action: 'version.manage',
    mutation: true,
    status: 201,
  }),
  getContent: route<void, ContentView>({
    method: 'GET',
    path: `${C}/contents/:cid`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  patchContent: route<PatchContentBody, ContentView>({
    method: 'PATCH',
    path: `${C}/contents/:cid`,
    action: 'version.manage',
    mutation: true,
    status: 200,
  }),
  listVersions: route<void, { items: VersionView[] }>({
    method: 'GET',
    path: `${C}/contents/:cid/versions`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  getVersion: route<void, VersionView>({
    method: 'GET',
    path: `${C}/contents/:cid/versions/:vid`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  diff: route<void, VersionDiff>({
    method: 'GET',
    path: `${C}/contents/:cid/versions/:a/diff/:b`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createVersion: route<
    CreateVersionBody | CreateRedditVersionBody,
    VersionView
  >({
    method: 'POST',
    path: `${C}/contents/:cid/versions`,
    action: 'version.manage',
    mutation: true,
    status: 201,
  }),
  patchVersion: route<PatchVersionBody | PatchRedditVersionBody, VersionView>({
    method: 'PATCH',
    path: `${C}/contents/:cid/versions/:vid`,
    action: 'version.manage',
    mutation: true,
    status: 200,
  }),
  submitVersion: route<SubmitVersionBody, VersionView>({
    method: 'POST',
    path: `${C}/contents/:cid/versions/:vid/submit`,
    action: 'version.manage',
    mutation: true,
    status: 200,
  }),
  transition: route<TransitionBody, ContentView>({
    method: 'POST',
    path: `${C}/contents/:cid/transition`,
    action: ['version.manage', 'publication.manage'],
    mutation: true,
    status: 200,
  }),
  // Claims F04
  listClaims: route<void, ListPage<ClaimView>>({
    method: 'GET',
    path: `${C}/claims`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  createClaim: route<CreateClaimBody, ClaimView>({
    method: 'POST',
    path: `${C}/claims`,
    action: 'version.manage',
    mutation: true,
    status: 201,
  }),
  patchClaim: route<PatchClaimBody, PatchClaimResponse>({
    method: 'PATCH',
    path: `${C}/claims/:id`,
    action: 'version.manage',
    mutation: true,
    status: 200,
  }),
  claimSource: route<ClaimSourceBody, ClaimView>({
    method: 'POST',
    path: `${C}/claims/:id/sources`,
    action: 'claim.verify',
    mutation: true,
    status: 200,
  }),
  verifyClaim: route<VerifyClaimBody, ClaimView>({
    method: 'POST',
    path: `${C}/claims/:id/verify`,
    action: 'claim.verify',
    mutation: true,
    status: 200,
  }),
  // QA и согласование
  listQaChecks: route<void, { items: QaCheckView[] }>({
    method: 'GET',
    path: `${C}/versions/:vid/qa-checks`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  qaCheck: route<QaCheckBody, QaCheckView>({
    method: 'POST',
    path: `${C}/versions/:vid/qa-checks`,
    action: ['qa.editorial', 'qa.technical'],
    mutation: true,
    status: 201,
  }),
  approve: route<ApproveBody, ApprovalView>({
    method: 'POST',
    path: `${C}/versions/:vid/approve`,
    action: 'version.approve',
    mutation: true,
    status: 201,
  }),
  listApprovals: route<void, { items: ApprovalView[] }>({
    method: 'GET',
    path: `${C}/approvals`,
    action: 'product.read',
    mutation: false,
    status: 200,
  }),
  revokeApproval: route<RevokeApprovalBody, ApprovalView>({
    method: 'POST',
    path: `${C}/approvals/:id/revoke`,
    action: 'approval.revoke',
    mutation: true,
    status: 200,
  }),
  // Публичное чтение (§11.4)
  publicList: route<void, PublicContentListItem[]>({
    method: 'GET',
    path: `${PUBLIC}/contents`,
    action: null,
    mutation: false,
    status: 200,
  }),
  publicGet: route<void, PublicContent>({
    method: 'GET',
    path: `${PUBLIC}/contents/:slug`,
    action: null,
    mutation: false,
    status: 200,
  }),
} as const;

/** Подпись неизвестной частотности (F01: «невідомо», не ноль). */
export const FREQUENCY_UNKNOWN_LABEL = 'невідомо';
