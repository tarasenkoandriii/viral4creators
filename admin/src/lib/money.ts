/**
 * Деньги в админке (ТЗ §26).
 *
 * Бэкенд считает и хранит суммы в МИКРОДОЛЛАРАХ целым числом — сложение
 * float-долларов по десяткам тысяч строк даёт дрейф, а сумма расходов
 * это как раз та цифра, которой обязаны верить. В доллары пересчитываем
 * здесь, один раз, на готовой сумме.
 */

const USD = 1_000_000;

/**
 * «$12.34» для заметных сумм и «$0.0042» для мелких. Округлять расход
 * одного вызова до центов бессмысленно: почти все они дешевле цента, и
 * колонка превратилась бы в столбик нулей.
 */
export function usd(micro: number): string {
  const value = micro / USD;
  if (value === 0) return '$0';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  if (Math.abs(value) < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Доля в процентах — для полосок в разбивке. */
export function share(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/** Человеческие названия операций — зеркало AI_OPERATION_LABEL на бэкенде. */
export const OPERATION_LABEL: Record<string, string> = {
  analysis: 'Разбор референса',
  relevance: 'Релевантность',
  audit: 'Аудит ролика',
  transcribe: 'Расшифровка голоса',
  'product-photo': 'Распознавание фото',
  prompt: 'Сборка промпта',
  generation: 'Генерация ролика',
  'analog-search': 'Поиск аналогов',
  'video-search': 'Поиск на YouTube',
  // Этап 136 (ТЗ TZ-Multilingual-YouTube.md): теги исходного ролика —
  // отдельный вызов videos.list в 1 единицу квоты, не поиск в 100.
  'video-tags': 'Теги исходного ролика',
  'analysis-translate': 'Перевод разбора видео',
  // GREETING_VIDEO (ТЗ TZ-Greeting-Video-Project-Type.md) — зеркало
  // AI_OPERATION_LABEL['greeting-prompt'] на бэкенде (common/ai-pricing.ts).
  'greeting-prompt': 'Сценарий ролика-поздравления',
};

export function operationLabel(key: string): string {
  return OPERATION_LABEL[key] ?? key;
}
