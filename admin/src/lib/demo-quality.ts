// Проверка качества демо — чистые помощники вкладки «Видео-контент»
// (doc/TUTORIAL-DEMO-QUALITY-SPEC.md). Чистые — чтобы их проверял
// demo-quality.test.ts без браузера.
//
// Фаза наблюдения: бейдж и отчёт — сигнал оператору, одобрение ролика
// проверка не ставит и не снимает. «Не проверен ИИ» — ролик без записи
// проверки, а не «прошёл».

import type { DemoQualityCheck, DemoQualityEnqueueResult, DemoQualityIssue, DemoQualityVerdict } from './types';

export type BadgeTone = 'ok' | 'warning' | 'critical' | 'muted';

/** Бейдж в колонке «Качество». */
export function qualityBadge(check: DemoQualityCheck | null | undefined): { label: string; tone: BadgeTone } {
  if (!check) return { label: 'не проверен ИИ', tone: 'muted' };
  switch (check.status) {
    case 'pending':
      return {
        label: check.attempts > 0 ? `повтор (${check.attempts}/3)` : check.phase === 'upload' ? 'в очереди' : 'проверяется',
        tone: 'muted',
      };
    case 'running':
      return { label: 'проверяется', tone: 'muted' };
    case 'error':
      return { label: 'сбой проверки', tone: 'critical' };
    case 'complete': {
      // Заход 7: оператор переопределил вердикт — бейдж по итоговому, с
      // пометкой, чтобы «ok» оператора не читался как «ok» модели.
      const verdict = effectiveVerdictOf(check);
      const mark = check.override ? ' (оператор)' : '';
      if (verdict === 'ok') return { label: `ok${mark}`, tone: 'ok' };
      if (verdict === 'warn') return { label: `warn${mark}`, tone: 'warning' };
      if (verdict === 'fail') return { label: `fail${mark}`, tone: 'critical' };
      return { label: 'без вердикта', tone: 'muted' };
    }
    default:
      return { label: String(check.status), tone: 'muted' };
  }
}

/** Таймкод «м:сс.д» — для кнопки перемотки. */
export function formatTimecode(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00.0';
  const tenths = Math.floor(ms / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

const CATEGORY_LABEL: Record<string, string> = {
  readability: 'читаемость',
  step_mismatch: 'шаг/подпись',
  cut_speech: 'обрезанная речь',
  artifact: 'артефакт',
  pii: 'ПД в кадре',
  theme_mismatch: 'тема',
  locale_mismatch: 'язык',
  loading_error: 'загрузка/ошибка',
  pacing: 'темп',
  technical: 'техпроверка',
  other: 'другое',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category] ?? category;
}

export const SEVERITY_LABEL: Record<string, string> = {
  critical: 'критично',
  major: 'заметно',
  minor: 'мелочь',
};

export const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: 'critical',
  major: 'warning',
  minor: 'muted',
};

/** Замечания по порядку в ролике; при равном начале — серьёзные первыми. */
export function sortIssues(issues: DemoQualityIssue[]): DemoQualityIssue[] {
  const rank: Record<string, number> = { critical: 0, major: 1, minor: 2 };
  return [...issues].sort((a, b) => a.startMs - b.startMs || (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

/** Что сказать оператору после нажатия «Проверить». */
export function enqueueMessage(res: DemoQualityEnqueueResult): string {
  if (res.created) return 'Проверка поставлена в очередь — результат появится после ближайших тиков крона сборок.';
  if (res.reason === 'already-queued') return 'Проверка этого файла уже в очереди.';
  if (res.reason === 'retry') return 'Прежняя проверка не удалась — она запущена заново.';
  return 'Этот файл уже проверен этой рубрикой — повтор не оплачивается.';
}

export function formatCost(check: DemoQualityCheck): string {
  if (check.unpriced) return 'цена модели неизвестна';
  if (check.costMicroUsd == null) return '—';
  return `$${(check.costMicroUsd / 1_000_000).toFixed(4)}`;
}

const RESULT_LABEL: Record<string, string> = {
  match: 'совпадает',
  mismatch: 'НЕ совпадает',
  unknown: 'не определено',
  not_applicable: 'нет речи и подписей',
};

export function checkResultLabel(result: string): string {
  return RESULT_LABEL[result] ?? result;
}

const FRESHNESS_LABEL: Record<string, string> = {
  current: 'текущая сборка интерфейса',
  stale_candidate: 'возможно, устарело (сборка интерфейса не текущая)',
  unknown: 'актуальность неизвестна',
};

export function freshnessLabel(freshness: string): string {
  return FRESHNESS_LABEL[freshness] ?? freshness;
}

// ── заход 7 (07.10.2026) ──

/** Итоговый вердикт: переопределение оператора сильнее модели. Старый
 *  бэкенд без поля — вердикт модели. */
export function effectiveVerdictOf(check: DemoQualityCheck): DemoQualityVerdict | null {
  if (check.effectiveVerdict !== undefined) return check.effectiveVerdict;
  return check.override?.verdict ?? check.verdict;
}

const CAPTURE_MODE_LABEL: Record<string, string> = {
  tma: 'TMA',
  polygon: 'витрина лендинга',
  'client-site': 'сайт заказчика',
};

export function captureModeLabel(mode: string | null): string {
  if (!mode) return 'режим съёмки не записан';
  return CAPTURE_MODE_LABEL[mode] ?? mode;
}

export const VERDICT_LABEL: Record<DemoQualityVerdict, string> = {
  ok: 'ok — годится',
  warn: 'warn — с замечаниями',
  fail: 'fail — непригоден',
};

/** Проверка причины переопределения — та же граница, что у бэкенда. */
export function overrideReasonProblem(reason: string): string | null {
  const t = reason.trim();
  if (t.length < 3) return 'Причина обязательна — не короче 3 символов.';
  if (t.length > 500) return 'Причина — не длиннее 500 символов.';
  return null;
}

/** Строка о чёрных/замерших кадрах декодером; `null` — не заказывались. */
export function signalsSummary(check: DemoQualityCheck): string | null {
  const s = check.signals;
  if (!s) return null;
  if (s.status === 'pending' || s.status === 'running') return 'Декодер (чёрные/замершие кадры): в работе.';
  if (s.status === 'error') return `Декодер (чёрные/замершие кадры): сбой — ${s.error ?? 'без текста'}.`;
  if (s.suspicious.length === 0) return 'Декодер: чёрных кадров и замерших переходов между шагами не найдено.';
  return `Декодер: подозрительных мест ${s.suspicious.length} — см. замечания «Декодер» с таймкодами.`;
}
