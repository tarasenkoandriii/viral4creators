/**
 * Цели, статистика, экспорт, интеграции (Э3, агент A; ТЗ §5-тер.1–2,
 * §5-тер.6–7, §5-тер.13–16, §9.1) — формы REST кабинета. TMA (T)
 * повторяет их в `assist/src/lib/stats-types.ts` и разбирает строго.
 * Менять — через координатора; необязательные поля — можно (с записью).
 * Числа считает КОД по свёрткам (assist_site_daily_totals) — ни одной цифры
 * от модели в Э3 (ИИ-выводы — Э3-бис).
 */
import type {
  GoalAttribution,
  GoalDetector,
  GoalTemplate,
  GoalTrust,
} from './goal-types';
import type { AnalyticsConfig } from './analytics-config';

export type { AnalyticsConfig };

export interface GoalView {
  id: string;
  key: string;
  template: GoalTemplate;
  name: string;
  detectors: GoalDetector[];
  valueMode: 'none' | 'fixed' | 'event';
  fixedValue: number | null;
  currency: string | null;
  status: 'active' | 'paused' | 'stale';
  lastFiredAt: string | null;
  createdAt: string;
}

/** POST /assist/sites/:id/goals/picker-token — ссылка `?v4c_goal=` (30 мин) на verified-хост. */
export interface GoalPickerTokenView {
  tokenId: string;
  /** https://<хост><путь>?v4c_goal=<токен> — открыть в браузере. */
  url: string;
  expiresAt: string;
}

/** GET /assist/sites/:id/goals/picker/:tokenId — опрос TMA, пока владелец выбирает на сайте. */
export interface GoalPickerStatusView {
  status: 'waiting' | 'picked' | 'expired';
  result: {
    descriptor: import('./goal-types').ElementDescriptor;
    path: string;
    label: string;
    kind: 'click' | 'form_submit';
  } | null;
}

/** GET /assist/sites/:id/goals/:gid/recent — «Проверить цель» (последние 20, опрос 3 с). */
export interface GoalRecentEventView {
  id: string;
  occurredAt: string;
  source: string;
  trust: GoalTrust;
  attribution: GoalAttribution;
  path: string | null;
  orderId: string | null;
  value: number | null;
  currency: string | null;
  status: 'completed' | 'refunded' | 'cancelled';
}

/** Число со сравнением с прошлым периодом той же длины (§5-тер.6 «Обзор»). */
export interface MetricView {
  value: number;
  prev: number | null;
  /** Δ в процентах или null (prev = 0). */
  deltaPct: number | null;
  /** Тест двух долей p > 0.05 — «в пределах шума» (только для долей). */
  noise: boolean | null;
}

export interface StatsPeriod {
  from: string;
  to: string;
  /** Последние дни ещё могут получить конверсию (окно атрибуции, §5-тер.2). */
  attributionWindowOpenFrom: string | null;
  timezone: string;
}

/** GET /assist/sites/:id/stats/overview?from=&to=&compare=prev|none */
export interface StatsOverviewView {
  period: StatsPeriod;
  dialogs: MetricView;
  /** Решённые без человека (§9.1 а–г) и доля. */
  resolved: MetricView;
  resolvedShare: MetricView;
  /** «≈ N часов работы оператора» при minutesPerQuestion (подписано как оценка владельца). */
  operatorHoursSaved: number;
  minutesPerQuestion: number;
  handoffs: MetricView;
  handoffsMissed: MetricView;
  leads: MetricView;
  conversions: { total: MetricView; direct: MetricView; assisted: MetricView };
  thumbsUpShare: MetricView;
  costMicroUsd: number;
  /** Ряды для графика по дням. */
  series: Array<{
    day: string;
    dialogs: number;
    resolved: number;
    handoffs: number;
    leads: number;
    conversions: number;
  }>;
}

/** GET /assist/sites/:id/stats/conversions */
export interface StatsConversionsView {
  period: StatsPeriod;
  goals: Array<{
    goalId: string;
    key: string;
    name: string;
    total: number;
    direct: number;
    assisted: number;
    unassisted: number;
    refunds: number;
    /** Деньги по умолчанию — только verified/builtin (§5-тер.1). */
    value: { verified: number; page: number; currency: string | null };
    /** Конверсия диалогов: (direct+assisted) / dialogs. */
    dialogConversion: number | null;
  }>;
  /** Триггеры: показан → принят → диалог → цель (§5-тер.12 п.10). */
  proactive: Array<{
    key: string;
    shown: number;
    accepted: number;
    dismissed: number;
    dialogs: number;
    conversions: number;
  }>;
}

/** GET /assist/sites/:id/stats/topics — из кластеров очереди (L) + конверсия. */
export interface StatsTopicsView {
  period: StatsPeriod;
  topics: Array<{
    clusterId: string;
    label: string;
    kind: string;
    distinctVisitors: number;
    dialogs: number;
    conversions: number;
    unknownShare: number;
    status: 'open' | 'resolved' | 'ignored';
  }>;
  /** Непокрытые темы: открытые кластеры ≥ 3 разных посетителей. */
  uncovered: number;
}

/** GET /assist/stats/sites?from=&to= — сводная таблица сайтов кабинета (§5-тер.6 «Мультисайт»). */
export interface StatsSitesView {
  sites: Array<{
    siteId: string;
    name: string;
    dialogs: number;
    resolvedShare: number | null;
    conversions: number;
    costMicroUsd: number;
  }>;
}

export interface IntegrationsView {
  goalWebhook: {
    active: boolean;
    createdAt: string | null;
    lastUsedAt: string | null;
    endpoint: string;
  };
  identity: { active: boolean; createdAt: string | null };
}

/** POST …/integrations/goal-webhook/secret | …/identity/secret — показ ОДИН раз. */
export interface SecretIssuedView {
  kind: 'goal_webhook' | 'identity';
  secret: string;
  createdAt: string;
}

/** Тело вебхука s2s (POST /assist/v1/sites/:id/goal-events; Idempotency-Key = orderId). */
export interface GoalWebhookEvent {
  goalKey: string;
  orderId: string;
  value?: number | null;
  currency?: string | null;
  status: 'completed' | 'refunded' | 'cancelled';
  occurredAt: string;
  /** Э3-бис (контрольная группа / связанный режим) — принимаются и игнорируются. */
  assistGroup?: 'w' | 'h' | null;
  assistRef?: string | null;
}

export interface GoalWebhookResult {
  /** created | duplicate (тот же Idempotency-Key) | updated (возврат/отмена) | merged (с page-событием загрузчика) */
  result: 'created' | 'duplicate' | 'updated' | 'merged';
}

export interface ExportRequest {
  kind: 'daily' | 'conversions' | 'dialogs';
  from: string;
  to: string;
  /** Текст реплик (маскированный) — только владелец кабинета. */
  withText?: boolean;
}

export interface ExportView {
  id: string;
  kind: ExportRequest['kind'];
  status: 'queued' | 'running' | 'done' | 'failed' | 'expired';
  rows: number | null;
  /** Ссылка на 24 ч (приватный Blob) — только status=done. */
  url: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export interface ReportSubscriptionView {
  weekly: boolean;
  digest: boolean;
}

export interface AnalyticsSettingsView {
  config: AnalyticsConfig;
  timezone: string;
  currency: string;
}

export const ANALYTICS_ERROR_CODES = [
  'GOAL_INVALID',
  'GOAL_NOT_FOUND',
  'GOAL_LIMIT',
  'GOAL_KEY_TAKEN',
  'PICKER_EXPIRED',
  'HOST_NOT_VERIFIED',
  'STATS_RANGE_INVALID',
  'EXPORT_FORBIDDEN',
  'EXPORT_NOT_FOUND',
  'ANALYTICS_CONFIG_INVALID',
  'INTEGRATION_NOT_FOUND',
  // Вебхук s2s (сервер-сервер):
  'SIGNATURE_INVALID',
  'IDEMPOTENCY_KEY_REQUIRED',
  'WEBHOOK_BODY_INVALID',
] as const;
export type AnalyticsErrorCode = (typeof ANALYTICS_ERROR_CODES)[number];
