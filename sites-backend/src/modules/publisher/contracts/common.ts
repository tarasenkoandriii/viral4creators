/**
 * AI Publisher — общие типы API (контракт P-A1, проектный документ §9, §10,
 * §11.1). Файлы маршрутов пакетов (`contracts/<пакет>-api.ts`) строятся из
 * этих типов по образцу `_template.ts`; assist и publisher-site сверяют
 * свои декодеры с ними тестами (§14.3).
 *
 * Чистый модуль: только типы и константы.
 */
import type {
  DependentStage,
  ParameterStatus,
  ProductKind,
  ProductMode,
  ProductStatus,
  PubRole,
} from './states';

// ── Числа (§1 п.9, §9) ────────────────────────────────────────────────────

/**
 * Сумма в минимальных единицах (копейки). В коде — `bigint`; в JSON API —
 * строка из цифр со знаком (`"-1500"`), потому что `bigint` не
 * сериализуется, а `number` теряет точность за 2^53. Разбор и печать —
 * `core/money.ts`.
 */
export type Minor = bigint;
export type MinorJson = string;
/** Базисные пункты: целое 0..10000. */
export type Bp = number;

// ── «Неизвестное ≠ ноль» (§1 п.2, §9) ─────────────────────────────────────

export type NotComputableReason =
  | 'zero_denominator'
  | 'unknown_input'
  | 'non_positive_contribution'
  | 'probability_out_of_range'
  | 'share_out_of_range'
  | 'new_customer_unknown'
  | 'no_session_link';

export type Computable<T> =
  | {
      kind: 'value';
      value: T;
      preliminary?: boolean;
      lowerBound?: boolean;
      unknownParts?: string[];
    }
  | {
      kind: 'not_computable';
      reason: NotComputableReason;
      inputs: Record<string, string | number | null>;
    };

/** Ответы с данными неполноты (§11.1). */
export interface Completeness {
  state: 'complete' | 'partial' | 'unknown';
  missing: string[];
}

// ── Мутации и списки (§11.1) ──────────────────────────────────────────────

/** Тело любой мутации: клиентский ключ попытки действия (UUID v4). */
export interface MutationBody {
  opKey: string;
}
/** Мутация «головы»: ревизия, которую видел клиент (CAS, §8). */
export interface RevisionedBody extends MutationBody {
  expectedRevision: number;
}
/** Параметры списка: `?before=<id>&limit≤100`. */
export interface ListQuery {
  before?: string;
  limit?: number;
}
export interface ListPage<T> {
  items: T[];
  /** id последнего элемента — для следующей страницы; null — конец. */
  nextBefore: string | null;
}
export const LIST_LIMIT_DEFAULT = 50;
export const LIST_LIMIT_MAX = 100;

// ── Ошибка (§11.1, конверт sites-backend) ────────────────────────────────

export interface ApiErrorBody {
  success: false;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: { timestamp: string; requestId: string; path?: string };
}

// ── Продукт (§3) ─────────────────────────────────────────────────────────

/** Контекст продукта для сервисов пакетов (§3.3). */
export interface ProductCtx {
  id: string;
  accountId: string;
  siteId: string;
  kind: ProductKind;
  mode: ProductMode;
  status: ProductStatus;
  revision: number;
}

/** Роли участника в продукте: гранты + `admin` (publisher=admin) + владелец. */
export interface MyRoles {
  roles: PubRole[];
  /** `productRoles.publisher = 'admin'` (или владелец кабинета). */
  admin: boolean;
  /** Владелец кабинета: неявно все роли, включая `sales` (Р-PUB-2). */
  accountOwner: boolean;
}

export interface ProductView {
  id: string;
  siteId: string;
  kind: ProductKind;
  name: string;
  publicKey: string;
  mode: ProductMode;
  liveSince: string | null;
  status: ProductStatus;
  revision: number;
  createdAt: string;
  myRoles: MyRoles;
  gates: Record<GateName, { open: boolean; missingCount: number }>;
  /**
   * Включённые разделы вне P0 (пакет P-R, Р-RD-9): `reddit` — env-флаг
   * `PUBLISHER_REDDIT_ENABLED`; выключен — кабинет скрывает раздел, а API
   * `…/reddit/**` отвечает 404.
   */
  features: { reddit: boolean };
}

// ── Гейты (§10) ──────────────────────────────────────────────────────────

export const GATE_NAMES = [
  'public_publish',
  'real_leads',
  'spend',
  'purchases',
  'ai_use',
  /** P-R M2 (Р-RD-9): копирование утверждённого Reddit-текста. */
  'reddit_publish',
] as const;
export type GateName = (typeof GATE_NAMES)[number];

/**
 * Вид недостающего пункта гейта. Список §10 + `product` (вид/режим/статус
 * продукта: eval/restored, archived, не live) и `budget` (строка лимита не
 * собрана из текущих версий бюджетных параметров) — Р-PUB-A1-4.
 */
export const GATE_MISSING_KINDS = [
  'parameter',
  'host',
  'integration',
  'evidence',
  'observation',
  'reconcile',
  'ai_config',
  'report_decision',
  'product',
  'budget',
] as const;
export type GateMissingKind = (typeof GATE_MISSING_KINDS)[number];

export interface GateMissing {
  kind: GateMissingKind;
  key: string;
  /** Машинная причина (`not_approved`, `stale`, `not_verified`, …). */
  detail: string;
}

export interface GateResult {
  gate: GateName;
  open: boolean;
  missing: GateMissing[];
}

/**
 * Предметный контекст гейта, который знает только вызывающий пакет:
 * закупка (P-C) и AI-вызов (P-B2). Без него гейт проверяет только общие
 * условия продукта.
 */
export interface GateContext {
  /** `purchases` для конкретной закупки (§7.2). */
  placement?: {
    observationOk: boolean;
    purchaseSeq: number;
    reportDecisionId: string | null;
  };
  /** `spend`: категория расхода (`tools|other`) для проверки сверки. */
  category?: 'tools' | 'other';
  /** `ai_use`: генератор и параметры вызова (§10, §12.1). */
  ai?: {
    generator: string;
    model: string;
    instructionVersion: string;
    /** Цена модели известна (`shared/ai-pricing`). */
    priced: boolean;
    /**
     * Остальной состав конфигурации вызова (аудит P-B2 S2-5): если задан —
     * сверяется с привязанной конфигурацией (`detail:'mismatch'`).
     */
    provider?: string;
    contextRulesVersion?: string;
    schemaSetVersion?: string;
  };
}

// ── Параметры (§6.2) ─────────────────────────────────────────────────────

export interface ParameterView {
  key: string;
  value: unknown;
  status: ParameterStatus;
  version: number;
  approvedAt: string | null;
  approvedBy: string | null;
  revision: number;
  updatedAt: string;
  openProposals: number;
  /** Гейты, которые требуют утверждения ключа. */
  gates: GateName[];
}

export interface ParameterDecisionView {
  id: string;
  parameterKey: string;
  version: number;
  proposalId: string | null;
  fromStatus: ParameterStatus;
  toStatus: ParameterStatus;
  valueSnapshot: unknown;
  decidedBy: string;
  decidedAt: string;
  basis: string;
  dependentStages: DependentStage[];
}

/**
 * Формат актёра журналов (§4.1, функция `pub_is_actor` триггера
 * `pub_actor_format`). `admin:<userId>` — оператор Админки платформы
 * (P-R-ADM, Р-RD-ADM-2; миграция `20261023090000_publisher_admin_actor`):
 * id пользователя backend ≤ 58 знаков — актор целиком ≤ 64, как столбцы
 * `…MemberId` (длина 1..64), куда попадает синтетический `memberId`.
 */
export const ACTOR_RE =
  /^(member:[A-Za-z0-9_-]{1,64}|admin:[A-Za-z0-9_-]{1,58}|system:[a-z0-9][a-z0-9-]{0,63}|public|restore:[A-Za-z0-9_-]{1,64})$/;
export const MEMBER_ACTOR_RE = /^member:[A-Za-z0-9_-]{1,64}$/;
/** Оператор Админки платформы (только внутренний путь `internal/admin/reddit`). */
export const ADMIN_ACTOR_RE = /^admin:[A-Za-z0-9_-]{1,58}$/;
/** Id пользователя backend в заголовке `X-Admin-Actor`. */
export const ADMIN_USER_ID_RE = /^[A-Za-z0-9_-]{1,58}$/;
/**
 * Человек (решения, проверки, согласования): участник кабинета или
 * оператор Админки (функция `pub_is_person`).
 */
export const PERSON_ACTOR_RE =
  /^(member:[A-Za-z0-9_-]{1,64}|admin:[A-Za-z0-9_-]{1,58})$/;
export const adminActor = (userId: string): string => `admin:${userId}`;
export const isAdminActor = (v: string | null | undefined): boolean =>
  typeof v === 'string' && ADMIN_ACTOR_RE.test(v);
/**
 * Актор участника. Синтетическое членство Админки несёт `memberId` вида
 * `admin:<userId>` (настоящие id участников — cuid без `:`), и его актор —
 * этот же `admin:<userId>`, а не `member:admin:…`.
 */
export const memberActor = (memberId: string): string =>
  isAdminActor(memberId) ? memberId : `member:${memberId}`;
/**
 * `memberId` автора по актору: `member:<id>` → `<id>`, `admin:<id>` →
 * `admin:<id>` (синтетический участник), прочее — null (для `selfReview`).
 */
export function memberIdOfActor(
  actor: string | null | undefined,
): string | null {
  if (!actor) return null;
  if (isAdminActor(actor)) return actor;
  const m = /^member:([A-Za-z0-9_-]{1,64})$/.exec(actor);
  return m ? m[1] : null;
}
export const systemActor = (job: string): string => `system:${job}`;

/** opKey — UUID v4 нижним регистром (триггер `pub_uuid4`). */
export const OP_KEY_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
