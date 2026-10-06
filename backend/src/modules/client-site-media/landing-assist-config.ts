/**
 * Э-С Ш5: сайт помощника ЛЕНДИНГА генератора — тенант «viral4creators» в
 * sites-backend (кабинет владельца). Чистый модуль, без Nest.
 *
 *  - `ASSIST_LANDING_SITE_ID` — id сайта тенанта (тот же, что у
 *    синхронизации знаний `assist:knowledge-sync`);
 *  - `ASSIST_LANDING_OWNER_TELEGRAM_ID` — Telegram-id владельца или
 *    менеджера помощника в этом кабинете: sites-backend принимает ролики
 *    только от члена кабинета (`site-media.service.ts`);
 *  - `ASSIST_LANDING_HOSTS` — подтверждённые хосты тенанта, на которых
 *    показываются ролики (через запятую); по умолчанию — хост
 *    `LANDING_PUBLIC_URL`. Пусто — sites-backend сочтёт ролики «за
 *    логином» и выключит (закрытый отказ), поэтому без хостов синхронизация
 *    роликов просто не включается.
 *
 * Пока сайт не задан — всё по-старому: ролики видит только консультант
 * лендинга (`modules/assistant`), а сайт лендинга нельзя «занять»
 * роликами обучалок по чужим сайтам — проверять нечего.
 */

export interface LandingAssistConfig {
  siteId: string;
  ownerTelegramId: string;
  hosts: string[];
}

const SITE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** id сайта лендинга или null (не задан / не того вида). */
export function landingAssistSiteId(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = env.ASSIST_LANDING_SITE_ID?.trim() ?? '';
  return SITE_ID.test(v) ? v : null;
}

export function landingAssistConfig(
  env: NodeJS.ProcessEnv = process.env,
): LandingAssistConfig | null {
  const siteId = landingAssistSiteId(env);
  const owner = env.ASSIST_LANDING_OWNER_TELEGRAM_ID?.trim() ?? '';
  if (!siteId || !/^[1-9]\d{0,19}$/.test(owner)) return null;
  let hosts = (env.ASSIST_LANDING_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => HOST.test(h));
  if (!hosts.length) {
    try {
      const u = new URL(env.LANDING_PUBLIC_URL ?? '');
      if (u.protocol === 'https:' && HOST.test(u.hostname))
        hosts = [u.hostname];
    } catch {
      hosts = [];
    }
  }
  if (!hosts.length) return null;
  return {
    siteId,
    ownerTelegramId: owner,
    hosts: [...new Set(hosts)].slice(0, 10),
  };
}
