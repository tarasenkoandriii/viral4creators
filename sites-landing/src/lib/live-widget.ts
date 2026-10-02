import { assistEnv, loaderUrl, type AssistEnv } from './assist-env';
import { claimStatus, CLAIMS, type ClaimRegistry } from './claims';
import type { Locale } from './i18n';
import type { LoaderTag } from './widget-loader';

/**
 * Есть ли на лендинге живой виджет (Л2): утверждение `live-widget` —
 * `live` (точка С2) **и** в сборке задан ключ нашего сайта
 * (`ASSIST_WIDGET_PK`). Без ключа обещать «спросите помощника на этой
 * странице» нельзя — блок 2 главной остаётся местом под запись
 * (`demo-recording`, «скоро»), панели «покрутите виджет» нет.
 */
export function liveWidgetTag(locale: Locale, env: AssistEnv = assistEnv(), registry: ClaimRegistry = CLAIMS): LoaderTag | null {
  if (claimStatus('live-widget', registry) !== 'live' || !env.widgetPk) return null;
  return { src: loaderUrl(env), pk: env.widgetPk, lang: locale };
}
