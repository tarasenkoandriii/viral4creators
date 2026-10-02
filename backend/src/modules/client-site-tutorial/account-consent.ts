/**
 * Подтверждение прав на аккаунт и согласия с условиями сайта — режим B
 * обучалки «сайт не подтверждён» (Э-С Ш1; П-Т2, P0
 * `docs-tz/SECURITY-PROPOSALS-2026-10-02.md` §2.3).
 *
 * С 02.10.2026 (решение владельца «для обучалки все сайты свои») галочка
 * нужна только при `SITE_TUTORIAL_ACCOUNT_CONSENT=required`; по умолчанию
 * (`journal`) тот же текст и версия пишутся строкой журнала
 * (`locale = 'journal'`) при первом запуске браузера по домену, без
 * показа человеку (`site-access.service.ts`).
 *
 * ЧЕРНОВИК ДО ЮРИСТА (вопрос 10 аудита слияния, §2.4 предложений): текст
 * написан разработчиком, чтобы механизм работал и запись подтверждения
 * велась с первого дня. Юрист меняет формулировки → поднимается
 * `ACCOUNT_CONSENT_TEXT_VERSION` → все пользователи режима B подтверждают
 * заново (старые записи остаются журналом: что человек видел тогда).
 *
 * Текст отдаёт сервер, а не словарь фронтенда: в записи хранится ВЕРСИЯ,
 * и она обязана однозначно указывать на слова, которые человек видел.
 * Два места с текстом однажды разошлись бы. Языки — uk/ru/en; остальные
 * локали интерфейса показывают английский.
 */
import { registrableDomain } from './draft-rounds';

/** Меняется при ЛЮБОЙ правке текста ниже (в т.ч. перевода). */
export const ACCOUNT_CONSENT_TEXT_VERSION = '2026-10-02-draft1';

/** Пометка для экрана и админки: текст ещё не согласован юристом. */
export const ACCOUNT_CONSENT_LEGAL_REVIEWED = false;

export const ACCOUNT_CONSENT_LOCALES = ['uk', 'ru', 'en'] as const;
export type AccountConsentLocale = (typeof ACCOUNT_CONSENT_LOCALES)[number];

/** `{domain}` — регистрируемый домен сайта. */
export const ACCOUNT_CONSENT_TEXTS: Readonly<
  Record<AccountConsentLocale, string>
> = {
  uk:
    'Я підтверджую, що обліковий запис, під яким я працюватиму на сайті {domain}, належить мені або я маю право ним користуватися, і що запис навчального ролика по цьому сайту не порушує його умов використання. ' +
    'Я розумію, що наш сервер відкриватиме цей сайт і виконуватиме в ньому дії, які я оберу, від імені цього облікового запису, і відповідальність за ці дії несу я. ' +
    'Підтвердження, його дата та хеш моєї IP-адреси зберігаються.',
  ru:
    'Я подтверждаю, что аккаунт, под которым я буду работать на сайте {domain}, принадлежит мне или я вправе им пользоваться, и что запись обучающего ролика по этому сайту не нарушает его условия использования. ' +
    'Я понимаю, что наш сервер будет открывать этот сайт и выполнять в нём действия, которые я выберу, от имени этого аккаунта, и ответственность за эти действия несу я. ' +
    'Подтверждение, его дата и хеш моего IP-адреса сохраняются.',
  en:
    'I confirm that the account I will use on {domain} belongs to me or that I am authorised to use it, and that recording a tutorial video of this site does not violate its terms of use. ' +
    'I understand that our server will open this site and perform the actions I choose on behalf of this account, and that I am responsible for those actions. ' +
    'This confirmation, its date and a hash of my IP address are stored.',
};

/**
 * Ключ подтверждения: регистрируемый домен (eTLD+1 по PSL с приватной
 * частью — `alice.github.io` и `bob.github.io` разные), иначе хост как
 * есть. `shop.` и `admin.` одного сайта — одно подтверждение.
 */
export function consentDomainOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return registrableDomain(host) ?? host;
}

export function parseConsentLocale(v: unknown): AccountConsentLocale {
  return typeof v === 'string' &&
    (ACCOUNT_CONSENT_LOCALES as readonly string[]).includes(v)
    ? (v as AccountConsentLocale)
    : 'en';
}

/** Переключатель П-Т2 (`SITE_TUTORIAL_ACCOUNT_CONSENT`). */
export type AccountConsentPolicy = 'off' | 'journal' | 'required';
export const ACCOUNT_CONSENT_POLICIES: readonly AccountConsentPolicy[] = [
  'off',
  'journal',
  'required',
];
export const DEFAULT_ACCOUNT_CONSENT_POLICY: AccountConsentPolicy = 'journal';

/**
 * Значение переключателя. Пусто — `journal`; неизвестное — тоже `journal`
 * (безопасная середина: не блокирует людей и не теряет журнал), а
 * `onUnknown` получает сырое значение, чтобы вызывающий предупредил в лог.
 */
export function accountConsentPolicy(
  env: NodeJS.ProcessEnv,
  onUnknown?: (raw: string) => void,
): AccountConsentPolicy {
  const raw = env.SITE_TUTORIAL_ACCOUNT_CONSENT?.trim().toLowerCase();
  if (!raw) return DEFAULT_ACCOUNT_CONSENT_POLICY;
  if ((ACCOUNT_CONSENT_POLICIES as readonly string[]).includes(raw)) {
    return raw as AccountConsentPolicy;
  }
  onUnknown?.(raw);
  return DEFAULT_ACCOUNT_CONSENT_POLICY;
}
