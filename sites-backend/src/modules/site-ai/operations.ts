/**
 * Операции `site_ai_usage.operation` sites-backend (ТЗ помощника §7.3).
 * Э1 — знания и песочница; Э2 — виджет «Сайт». Бюджет, который платит, —
 * по операции:
 *  - обучения (месячный, подписка; Р-58): assist-embed, assist-eval, assist-learn;
 *  - платформы (онбординг/лендинг, суточный потолок): assist-sandbox-*;
 *  - виджета (суточный потолок сайта + платформы, `assist_budget_days`):
 *    assist-chat, assist-classify.
 */
export const SITE_AI_OPERATIONS = [
  'assist-embed',
  'assist-eval',
  'assist-learn',
  // Эмбеддинг вопроса посетителя в search() (≈10 токенов): учёт, не бюджет обучения.
  'assist-query-embed',
  'assist-sandbox-embed',
  'assist-sandbox-chat',
  // Э2: ответ посетителю виджета и перевод/классификация вопроса (§4-тер.10;
  // пока той же GEMINI_MODEL — О-4).
  'assist-chat',
  'assist-classify',
] as const;
export type SiteAiOperation = (typeof SITE_AI_OPERATIONS)[number];

export const LEARNING_BUDGET_OPERATIONS: readonly SiteAiOperation[] = [
  'assist-embed',
  'assist-eval',
  'assist-learn',
];
