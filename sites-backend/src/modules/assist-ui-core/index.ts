/**
 * `assist-ui-core` — нейтральный код голосового управления (§5-бис.3 п.3,
 * У-19): формы, снимок, правила, словарь действий, проверки плана, промпт.
 * Без базы и без модулей режимов (правила графа `ui-core-neutral`,
 * `ui-core-no-db`, `neutral-names`). Импортируют режимы («Сайт» сегодня,
 * «Админка» — Э6-бис (б)) и стенд e2e виджета (те же проверки на моке).
 */
export * from './types';
export * from './normalize';
export * from './action-words';
export * from './snapshot';
export * from './rules';
export * from './plan-checks';
export * from './plan-prompt';
export * from './direct-plan';
