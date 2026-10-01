/**
 * site-tma-kit — общий код TMA клиентских сайтов (Помощник и QA):
 * Telegram init, API ядра `site-core`, i18n uk/ru/en, экраны кабинета.
 *
 * Подключение — «копия со сверкой» (контракт Э0 п.3): источник —
 * `site-tma-kit/src/**`, копия — `<app>/src/kit/**` (сейчас `assist/`),
 * пишет `node scripts/sync-site-tma-kit.mjs`, CI проверяет `--check`.
 * Править только здесь.
 */

export * from './brand';
export * from './envelope';
export * from './types';
export * from './hosts';
export * from './verification';
export * from './start-param';
export * from './i18n';
export * from './telegram';
export * from './api-client';
export * from './sites-api';
export * from './format';
export * from './errors';
export * from './web-auth';
export * from './account-select';
export * from './invite';
export type { Dictionary } from './dictionaries/ru';
export { KitContext, useKit, type KitValue } from './kit-context';
export { useAsync } from './use-async';
