// Дашборд внимания — типы ответа `GET /api/admin/attention`
// (backend/src/modules/admin-attention/attention-rules.ts) и чистые
// помощники страницы «Обзор». Чистые — чтобы их проверял
// attention.test.ts без браузера.

export type AttentionSeverity = 'blocker' | 'decision' | 'info';
export type AttentionOwner = 'operator' | 'owner' | 'system';

export interface AttentionItem {
  id: string;
  severity: AttentionSeverity;
  kind: string;
  title: string;
  reason: string;
  since: string;
  ageMs: number;
  owner: AttentionOwner;
  href: string;
  count?: number;
}

export type AttentionSourceStatus = 'ok' | 'error' | 'not_configured';

export interface AttentionSource {
  key: string;
  label: string;
  status: AttentionSourceStatus;
  error?: string;
}

export interface AttentionCounts {
  blocker: number;
  decision: number;
  info: number;
  total: number;
}

export interface AttentionView {
  generatedAt: string;
  items: AttentionItem[];
  counts: AttentionCounts;
  sources: AttentionSource[];
  truncated: boolean;
}

/** Секции страницы — в порядке срочности. */
export const ATTENTION_SECTIONS: Array<{ severity: AttentionSeverity; title: string; hint: string }> = [
  {
    severity: 'blocker',
    title: 'Блокирует',
    hint: 'Сломано или остановилось — демо и рабочие процессы страдают прямо сейчас.',
  },
  {
    severity: 'decision',
    title: 'Решения оператора',
    hint: 'Ждут одобрения или отказа: пока решения нет, посетители этого не видят.',
  },
  {
    severity: 'info',
    title: 'К сведению',
    hint: 'Обслуживание: пробелы, устаревшее, разовые сбои, которые уже прошли.',
  },
];

export const SEVERITY_LABEL: Record<AttentionSeverity, string> = {
  blocker: 'Блокирует',
  decision: 'Решение',
  info: 'К сведению',
};

/** Класс бейджа из общего набора `badge-status-*` (globals.css). */
export const SEVERITY_BADGE: Record<AttentionSeverity, 'critical' | 'warning' | 'ok'> = {
  blocker: 'critical',
  decision: 'warning',
  info: 'ok',
};

export const OWNER_LABEL: Record<AttentionOwner, string> = {
  operator: 'Оператор',
  owner: 'Владелец',
  system: 'Система',
};

/** Подпись кнопки перехода по типу карточки; по умолчанию — «Открыть». */
const ACTION_LABEL: Record<string, string> = {
  'cron-failed': 'Открыть запуски',
  'cron-silent': 'Открыть запуски',
  'cron-stuck': 'Открыть запуски',
  'cron-missed': 'Открыть запуски',
  'cron-recovered': 'Открыть запуски',
  'cron-only-skips': 'Открыть запуски',
  'assembly-stuck': 'Открыть ролики',
  'ui-snapshot-error': 'Открыть снимки',
  'ui-snapshot-changed': 'Сравнить снимки',
  'tutorial-review': 'Проверить ролики',
  'tempo-approval': 'Открыть темп',
  'publication-review': 'К модерации',
  'shared-video-review': 'К модерации',
  'portfolio-review': 'К модерации',
  'auction-review': 'К модерации',
  'blog-review': 'Открыть блог',
  'client-draft-expiring': 'Открыть черновик',
  'client-draft-review': 'Открыть черновик',
  'demo-theme-gap': 'Открыть матрицу',
  'demo-missing': 'Открыть матрицу',
  'demo-stale': 'Открыть матрицу',
  'demo-quality-fail': 'Открыть отчёт',
  'demo-quality-warn': 'Открыть отчёт',
  'demo-quality-error': 'Открыть ролики',
};

export function actionLabel(kind: string): string {
  return ACTION_LABEL[kind] ?? 'Открыть';
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Возраст коротко: «меньше минуты», «12 мин», «3 ч», «2 дн». */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) return 'меньше минуты';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} мин`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} ч`;
  return `${Math.floor(ms / DAY)} дн`;
}

/** Время для подписи «обновлено в …» — местное, без даты. */
export function formatClock(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Местные дата и время для «с какого момента». */
export function formatSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Карточки по секциям; порядок внутри — как прислал сервер. */
export function groupBySeverity(items: AttentionItem[]): Record<AttentionSeverity, AttentionItem[]> {
  const out: Record<AttentionSeverity, AttentionItem[]> = { blocker: [], decision: [], info: [] };
  for (const item of items) {
    if (item.severity in out) out[item.severity].push(item);
  }
  return out;
}

/**
 * Что показать, когда карточек нет. «Всё спокойно» — только если ВСЕ
 * подключённые источники ответили: недоступный источник — это «не
 * удалось проверить», а не зелёный ноль. Не настроенный источник
 * (проверка качества) спокойствию не мешает — он показан отдельно.
 */
export function calmState(view: AttentionView): 'calm' | 'partial' | null {
  if (view.items.length > 0) return null;
  return view.sources.some((s) => s.status === 'error') ? 'partial' : 'calm';
}

/** Период автообновления. */
export const ATTENTION_REFRESH_MS = 60_000;
