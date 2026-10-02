/**
 * Операции `site_ai_usage.operation` sites-backend (ТЗ помощника §7.3).
 * Э1 — знания и песочница; Э2 — виджет «Сайт». Бюджет, который платит, —
 * по операции:
 *  - обучения (месячный, подписка; Р-58): assist-embed, assist-eval, assist-learn;
 *  - платформы (онбординг/лендинг, суточный потолок): assist-sandbox-*;
 *  - виджета (суточный потолок сайта + платформы, `assist_budget_days`):
 *    assist-chat, assist-classify; голос (Э5) — ещё и потолок голоса сайта:
 *    assist-stt, assist-tts.
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
  // Э3: передача человеку — сводка и черновик оператору (№11, №14) и
  // перевод сообщений (№12); платит суточный бюджет сайта+платформы, как
  // ответ посетителю (обслуживание диалога, не обучение). Черновик
  // проверенного ответа владельцу (№4) и симуляция (№31) — assist-learn /
  // assist-eval (бюджет обучения).
  'assist-handoff',
  'assist-translate',
  // Э5: голос виджета — распознавание вопроса (секунды Soniox) и озвучка
  // ответа (символы). Платит суточный бюджет сайта+платформы и отдельный
  // потолок голоса сайта (§4.10, §7.3); не бюджет обучения.
  'assist-stt',
  'assist-tts',
] as const;
export type SiteAiOperation = (typeof SITE_AI_OPERATIONS)[number];

export const LEARNING_BUDGET_OPERATIONS: readonly SiteAiOperation[] = [
  'assist-embed',
  'assist-eval',
  'assist-learn',
];
