// Проверка качества демо — чистые помощники вкладки «Видео-контент»
// (doc/TUTORIAL-DEMO-QUALITY-SPEC.md). Чистые — чтобы их проверял
// demo-quality.test.ts без браузера.
//
// Фаза наблюдения: бейдж и отчёт — сигнал оператору, одобрение ролика
// проверка не ставит и не снимает. «Не проверен ИИ» — ролик без записи
// проверки, а не «прошёл».

import type { DemoQualityCheck, DemoQualityEnqueueResult, DemoQualityIssue } from './types';

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
    case 'complete':
      if (check.verdict === 'ok') return { label: 'ok', tone: 'ok' };
      if (check.verdict === 'warn') return { label: 'warn', tone: 'warning' };
      if (check.verdict === 'fail') return { label: 'fail', tone: 'critical' };
      return { label: 'без вердикта', tone: 'muted' };
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
