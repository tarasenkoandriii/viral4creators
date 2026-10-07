/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1; П-Т1, П-Т2
 * `docs-tz/SECURITY-PROPOSALS-2026-10-02.md` §2).
 *
 * Режим не выбирает пользователь — его определяет статус хоста во
 * внутреннем API `sites-backend` (`SitesInternalClient`):
 *  - **A «подтверждённый сайт»** — хост (или его родительский домен в
 *    пределах того же регистрируемого домена) подтверждён DNS/файлом/метой
 *    в кабинете сайтов, где этот человек владелец или менеджер. Привязка —
 *    по Telegram-id (кабинет у человека один на все боты).
 *  - **B «сайт не подтверждён»** — всё остальное, в том числе «sites-backend
 *    не настроен/не ответил». Это МЕТКА, а не ограничение.
 *
 * Решение владельца 02.10.2026: «для обучалки все сайты свои,
 * подтверждение не требуется — максимум удобства для пользователей».
 * Поэтому подтверждение прав на аккаунт (П-Т2) управляется переключателем
 * `SITE_TUTORIAL_ACCOUNT_CONSENT` (`accountConsentPolicy`):
 *  - `journal` (по умолчанию) — ничего не блокирует и галочку не
 *    показывает; при первом запуске нашего браузера по домену в режиме B
 *    пишется строка журнала (`locale = 'journal'`) в ту же таблицу;
 *  - `required` — прежние ворота: в B без галочки 409
 *    `SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED` на explore/step/login/undo/
 *    refresh/живой вход (старт и завершение);
 *  - `off` — ни ворот, ни журнала.
 *
 * Кэш режима (аудит, дефект 10): решение лежит в черновике
 * (`siteMode`/`siteModeCheckedAt`), и раунды визарда не ходят в
 * sites-backend чаще раза в `SITE_MODE_CACHE_MS`; явные `/access` и
 * `/verify-site` всегда спрашивают заново. «Липкий A» (дефект 1): сбой
 * кабинета сайтов не превращает подтверждённый сайт в B, пока последняя
 * удачная проверка A моложе `STICKY_A_MS` и хост тот же.
 */
import { isIP } from 'net';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SitesHostReason,
  SitesHostStatus,
  SitesInternalClient,
  SitesNotConfiguredError,
  SitesRejectedError,
  sitesTelegramId,
} from '../sites-internal/sites-internal.client';
import { rateLimitSubject } from '../../common/rate-limit';
import {
  ACCOUNT_CONSENT_LEGAL_REVIEWED,
  AccountConsentPolicy,
  accountConsentPolicy,
  ACCOUNT_CONSENT_TEXTS,
  ACCOUNT_CONSENT_TEXT_VERSION,
  AccountConsentLocale,
  consentDomainOf,
} from './account-consent';

export type SiteMode = 'A' | 'B';

export {
  ACCOUNT_CONSENT_POLICIES,
  DEFAULT_ACCOUNT_CONSENT_POLICY,
  accountConsentPolicy,
} from './account-consent';
export type { AccountConsentPolicy } from './account-consent';

/** Почему режим B (или `null` у A) — плашка фронтенда ветвится по коду. */
export type SiteAccessReason =
  | Exclude<SitesHostReason, null>
  | 'unavailable'
  | 'not_configured'
  | 'no_telegram'
  | 'unsupported_url'
  /** Адрес по IP: владение подтверждается только для доменного имени. */
  | 'ip_address'
  | null;

/** Раунды визарда не перепроверяют режим чаще (дефект 10 аудита). */
export const SITE_MODE_CACHE_MS = 10 * 60 * 1000;
/** Сколько держится A при недоступном кабинете сайтов (дефект 1 аудита). */
export const STICKY_A_MS = 24 * 60 * 60 * 1000;

/** Колонки режима черновика — для кэша и «липкого A». */
export interface DraftModeColumns {
  id: string;
  baseUrl: string;
  siteMode?: string | null;
  siteModeCheckedAt?: Date | null;
  siteHostId?: string | null;
}

/**
 * Хеш адреса клиента для журнала подтверждений (дефект 8 аудита). Секрет
 * общий с лимитами (`rateLimitSubject`), но если ни одного настоящего
 * секрета нет — хеш считается фиксированной dev-солью, и перебор по
 * пространству IPv4 вернул бы адрес. На проде в этом случае пишем NULL;
 * сама функция лимитов не меняется (у неё другие потребители).
 */
export function consentIpHash(
  ip: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!ip || ip === 'unknown') return null;
  const realSecret =
    !!env.RATE_LIMIT_KEY_SECRET?.trim() ||
    !!env.ASSISTANT_IP_HASH_SECRET?.trim() ||
    !!env.CRON_SECRET?.trim();
  if (!realSecret && env.NODE_ENV === 'production') return null;
  return rateLimitSubject(ip, env);
}

function isIpHost(hostname: string): boolean {
  return hostname.startsWith('[') || isIP(hostname) !== 0;
}

export interface SiteAccessView {
  mode: SiteMode;
  host: string;
  registrableDomain: string;
  reason: SiteAccessReason;
  /** Статус хоста в кабинете сайтов; `null` — не узнали (B по недоступности). */
  hostStatus: SitesHostStatus['status'] | null;
  hostId: string | null;
  /** Где подтвердить сайт (TMA помощника / веб-кабинет), `SITES_VERIFY_URL`. */
  verifyUrl: string | null;
  /**
   * Показывать ли «Это мой сайт»: тупики (не настроено, нет Telegram,
   * кабинет не ответил, http/порт/IP, отказ домена, не задан
   * `SITES_VERIFY_URL` — подтверждать негде) и оператор кабинета без прав
   * владельца/менеджера (флаг sites-backend) — `false`. Нет кабинета —
   * `true`: `/verify-site` его создаст.
   */
  canRegister: boolean;
  /**
   * Решение взято из черновика без запроса к кабинету сайтов (кэш раундов
   * или «липкий A» при сбое) — `persistMode` его не перезаписывает.
   */
  cached: boolean;
  consent: {
    /** Действующий переключатель П-Т2 (`SITE_TUTORIAL_ACCOUNT_CONSENT`). */
    policy: AccountConsentPolicy;
    /** Галочка обязательна: только `required` и только в режиме B. */
    required: boolean;
    accepted: boolean;
    textVersion: string;
    /** Черновик до юриста — фронтенд показывает пометку. */
    legalReviewed: boolean;
    texts: Readonly<Record<AccountConsentLocale, string>>;
  };
}

export const ACCOUNT_CONSENT_REQUIRED =
  'SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED';
export const ACCOUNT_CONSENT_STALE = 'SITE_TUTORIAL_CONSENT_VERSION_STALE';
/**
 * П-Т11: домен в реестре отказов кабинета сайтов (`site_opt_out_domains`,
 * закрывает его подтверждённый владелец или жалоба) — обучалку по нему не
 * водим ни в каком режиме. sites-backend при отказе домена режим A не
 * даёт (`internal-sites.service.ts`), так что это всегда B с причиной
 * `opted_out`.
 */
export const SITE_OPTED_OUT = 'SITE_TUTORIAL_SITE_OPTED_OUT';

/** `locale` служебной записи подтверждения (съёмка кадров лендинга). */
export const SERVICE_CONSENT_LOCALE = 'service';
/**
 * `locale` строки журнала в режиме `journal`: галочку человеку не
 * показывали, запись — «наш браузер впервые открыл этот домен под его
 * аккаунтом», с версией текста, действовавшей тогда.
 */
export const JOURNAL_CONSENT_LOCALE = 'journal';

/**
 * Причины B, при которых «Это мой сайт» ведёт в тупик (дефект 4 аудита).
 * `no_account` — НЕ тупик (решение «максимум удобства», 02.10.2026):
 * `/verify-site` создаёт кабинет по Telegram-id (`registerHost`
 * sites-backend → `ensureAccount`), как первый вход в TMA помощника.
 */
const NO_REGISTER_REASONS: ReadonlySet<SiteAccessReason> = new Set([
  'not_configured',
  'no_telegram',
  'unavailable',
  'unsupported_url',
  'ip_address',
  'opted_out',
] as SiteAccessReason[]);

function verifyUrlFrom(env: NodeJS.ProcessEnv): string | null {
  const raw = env.SITES_VERIFY_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Префикс `startapp` «подтвердить ЭТОТ хост» в TMA помощника (Ш1-хвост,
 * item 18). КОНТРАКТ с разбором в TMA помощника (пакет E): `vh-` +
 * base64url(хост в нижнем регистре, без `=`), только `[A-Za-z0-9_-]`,
 * весь параметр ≤ 64 символов; длиннее — ссылка без параметра.
 */
export const VERIFY_HOST_START_PREFIX = 'vh-';
export const START_PARAM_MAX = 64;

/** `vh-<base64url(host)>` или `null`, если параметр не помещается. */
export function verifyHostStartParam(host: string): string | null {
  const encoded = Buffer.from(host.toLowerCase(), 'utf8').toString('base64url');
  const param = `${VERIFY_HOST_START_PREFIX}${encoded}`;
  return param.length <= START_PARAM_MAX && /^[A-Za-z0-9_-]+$/.test(param)
    ? param
    : null;
}

/** Ссылка на мини-приложение Telegram (`t.me/<бот>[/<app>]`). */
function isTelegramAppLink(u: URL): boolean {
  const h = u.hostname.toLowerCase();
  return h === 't.me' || h === 'telegram.me' || h === 'www.t.me';
}

/**
 * `SITES_VERIFY_URL` с глубокой ссылкой на хост: у ссылки на TMA
 * (`t.me/…` или уже с `startapp`) — `startapp=vh-…`, веб-кабинет — как
 * есть (параметр `startapp` он не разбирает).
 */
export function verifyUrlForHost(
  env: NodeJS.ProcessEnv,
  host: string,
): string | null {
  const base = verifyUrlFrom(env);
  if (!base) return null;
  const u = new URL(base);
  if (!isTelegramAppLink(u) && !u.searchParams.has('startapp')) return base;
  const param = verifyHostStartParam(host);
  if (!param) return base;
  u.searchParams.set('startapp', param);
  return u.toString();
}

/** Сайт продукта — съёмка кадров лендинга по умолчанию снимает его. */
export const PRODUCT_SITE_HOST = 'viral4creators.app';

/**
 * Хосты, на которых фикстура съёмки кадров лендинга видит режим A
 * (L5784 TODO): наш продукт и публичные адреса стенда
 * (`LANDING_PUBLIC_URL` — там же полигон `/qa/demo-shop`, `TMA_PUBLIC_URL`;
 * только https). Точное совпадение хоста, не домена: чужой поддомен
 * общего хостинга (`*.vercel.app`) «нашим» не становится.
 */
export function serviceOwnHosts(env: NodeJS.ProcessEnv): Set<string> {
  const out = new Set<string>([PRODUCT_SITE_HOST]);
  for (const raw of [env.LANDING_PUBLIC_URL, env.TMA_PUBLIC_URL]) {
    try {
      const u = new URL(String(raw ?? '').trim());
      if (u.protocol === 'https:') out.add(u.hostname.toLowerCase());
    } catch {
      // Не задан или кривой — не наш хост.
    }
  }
  return out;
}

/**
 * Фикстурный пользователь съёмки (`FIXTURE_TELEGRAM_ID`, тот же признак,
 * что у `UiSnapshotRunnerService.findFixtureUser`). Пусто — фикстуры нет.
 */
export function isCaptureFixture(
  rawTelegramId: string | null | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  const fixture = env.FIXTURE_TELEGRAM_ID?.trim();
  return !!fixture && !!rawTelegramId && rawTelegramId.trim() === fixture;
}

@Injectable()
export class ClientSiteAccessService {
  private readonly logger = new Logger(ClientSiteAccessService.name);
  env: NodeJS.ProcessEnv = process.env;
  /** Тесты подменяют часы (кэш режима, «липкий A»). */
  now: () => Date = () => new Date();
  private warnedPolicy = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
  ) {}

  /** Действующий переключатель П-Т2; неизвестное значение — warn один раз. */
  policy(): AccountConsentPolicy {
    return accountConsentPolicy(this.env, (raw) => {
      if (this.warnedPolicy) return;
      this.warnedPolicy = true;
      this.logger.warn(
        `SITE_TUTORIAL_ACCOUNT_CONSENT=${JSON.stringify(raw.slice(0, 32))} не распознан (off|journal|required) — работаем как journal`,
      );
    });
  }

  /**
   * Режим и подтверждение для адреса. Сеть к sites-backend — один
   * подписанный POST; любая неудача — режим B с причиной, не исключение.
   * `prior` — колонки черновика: при недоступности кабинета сайтов свежий
   * A того же хоста держится («липкий A»).
   */
  async resolve(
    userId: string,
    url: string,
    prior?: DraftModeColumns | null,
  ): Promise<SiteAccessView> {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const tg = await this.telegramOf(userId);
    const telegramId = tg.sites;
    // L5784: фикстура съёмки кадров лендинга на НАШЕМ хосте — служебное
    // подтверждение, режим A без похода в кабинет сайтов. Иначе на кадре 3
    // (экран `review`) стояла бы карточка «Сайт не подтверждён» с «Это мой
    // сайт». Только https:443 — как и у настоящего A.
    if (
      isCaptureFixture(tg.raw, this.env) &&
      parsed.protocol === 'https:' &&
      !parsed.port &&
      serviceOwnHosts(this.env).has(host)
    ) {
      return this.view(userId, url, {
        mode: 'A',
        reason: null,
        hostStatus: null,
        hostId: null,
        canRegister: false,
        cached: false,
      });
    }
    let status: SitesHostStatus | null = null;
    let reason: SiteAccessReason = null;
    let sticky = false;
    if (!this.sites.configured()) reason = 'not_configured';
    else if (!telegramId) reason = 'no_telegram';
    else if (isIpHost(parsed.hostname)) {
      // Кабинет сайтов подтверждает доменное имя, не адрес (дефект 6).
      reason = 'ip_address';
    } else if (parsed.protocol !== 'https:' || parsed.port) {
      // Кабинет сайтов подтверждает только https:443 (MVP) — такой хост
      // не может быть «своим» по построению, B без похода в сеть.
      reason = 'unsupported_url';
    } else {
      try {
        status = await this.sites.hostStatus(telegramId, url);
        reason = status.reason;
      } catch (err) {
        reason =
          err instanceof SitesRejectedError && err.code === 'HOST_INVALID'
            ? 'unsupported_url'
            : err instanceof SitesNotConfiguredError
              ? 'not_configured'
              : 'unavailable';
        if (reason === 'unavailable') {
          sticky = this.stickyA(prior, host);
          this.logger.warn(
            `режим обучалки: sites-backend недоступен (${(err as Error).name}) — ${sticky ? 'держим A последней проверки' : 'режим B'}`,
          );
        }
      }
    }
    const mode: SiteMode = sticky || status?.mode === 'A' ? 'A' : 'B';
    const finalReason: SiteAccessReason =
      mode === 'A' ? null : (reason ?? 'not_verified');
    return this.view(userId, url, {
      mode,
      reason: finalReason,
      hostStatus: sticky ? null : (status?.status ?? null),
      hostId: sticky ? (prior?.siteHostId ?? null) : (status?.hostId ?? null),
      // Без `SITES_VERIFY_URL` подтвердить владение негде — хост завёлся
      // бы `pending` навсегда, а человек ушёл бы с «подтвердите там» без
      // ссылки. Кнопку не показываем.
      canRegister:
        mode === 'B' &&
        verifyUrlFrom(this.env) !== null &&
        !NO_REGISTER_REASONS.has(finalReason) &&
        status?.canRegister !== false,
      cached: sticky,
    });
  }

  /**
   * Режим для черновика. Раунды (`force` нет) берут решение из черновика,
   * если оно моложе `SITE_MODE_CACHE_MS`; экрану (`needReason`) нужен и
   * код причины B, которого в черновике нет, — поэтому из кэша ему
   * отдаётся только A (у A причины нет). Свежее решение пишется в
   * черновик здесь же.
   */
  async resolveForDraft(
    userId: string,
    draft: DraftModeColumns,
    opts: { force?: boolean; needReason?: boolean } = {},
  ): Promise<SiteAccessView> {
    const mode =
      draft.siteMode === 'A' || draft.siteMode === 'B' ? draft.siteMode : null;
    const checked = draft.siteModeCheckedAt?.getTime();
    const fresh =
      !opts.force &&
      mode !== null &&
      checked !== undefined &&
      this.now().getTime() - checked < SITE_MODE_CACHE_MS &&
      (mode === 'A' || !opts.needReason);
    if (fresh) {
      return this.view(userId, draft.baseUrl, {
        mode,
        // Раундам причина не нужна; ближайшая честная по колонкам.
        reason:
          mode === 'A'
            ? null
            : draft.siteHostId
              ? 'not_verified'
              : 'not_registered',
        hostStatus: null,
        hostId: draft.siteHostId ?? null,
        canRegister: false,
        cached: true,
      });
    }
    const view = await this.resolve(userId, draft.baseUrl, draft);
    await this.persistMode(draft.id, view);
    return view;
  }

  /**
   * Перед запуском нашего браузера по сайту под аккаунтом человека
   * (`explore`, `step`, `login`, `undo`, `refresh`, живой вход): в
   * `required` — ворота 409, в `journal` — строка журнала при первом
   * запуске по домену в режиме B, в `off` — ничего.
   */
  async gate(
    userId: string,
    url: string,
    view: SiteAccessView,
    ipHash: string | null,
  ): Promise<void> {
    this.assertNotOptedOut(view);
    const policy = view.consent.policy;
    if (policy === 'required') {
      this.requireConsent(view);
      return;
    }
    if (policy === 'journal' && view.mode === 'B' && !view.consent.accepted) {
      await this.recordJournal(userId, url, ipHash);
    }
  }

  /**
   * П-Т11: домен в реестре отказов — ни обхода, ни входа, ни живого входа.
   * Решение из кэша черновика причины не знает (B из кэша — `not_verified`
   * или `not_registered`), поэтому отказ домена доходит до черновика в
   * работе не позже `SITE_MODE_CACHE_MS`; новый `/explore` — сразу.
   */
  assertNotOptedOut(view: SiteAccessView): void {
    if (view.mode === 'B' && view.reason === 'opted_out') {
      throw new ForbiddenException({
        error: SITE_OPTED_OUT,
        code: SITE_OPTED_OUT,
        message: `владелец сайта ${view.registrableDomain} запретил запись обучалок по нему — выберите другой сайт`,
      });
    }
  }

  /**
   * Ворота П-Т2 (только `required`): режим B без подтверждения — 409 с
   * машинным кодом, фронтенд показывает галочку.
   */
  requireConsent(view: SiteAccessView): void {
    if (view.consent.required && !view.consent.accepted) {
      throw new ConflictException({
        error: ACCOUNT_CONSENT_REQUIRED,
        code: ACCOUNT_CONSENT_REQUIRED,
        message: `сайт ${view.registrableDomain} не подтверждён: подтвердите, что аккаунт на нём ваш и запись не нарушает условия сайта`,
      });
    }
  }

  /**
   * Режим — в черновик (П-Т1: «пересчёт при подтверждении»). Без сдвига
   * `version`: это не правка пользователя, и раунд другой вкладки не
   * должен из-за неё получать 409.
   */
  async persistMode(draftId: string, view: SiteAccessView): Promise<void> {
    // Кэш и «липкий A» не обновляют отметку: иначе A при лежащем кабинете
    // сайтов продлевался бы бесконечно, а кэш — сам себя.
    if (view.cached) return;
    await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draftId },
      data: this.modeColumns(view),
    });
  }

  /**
   * Запись подтверждения. Версия обязана совпасть с текущей: текст могли
   * сменить, пока экран был открыт, — тогда человек подтвердил бы НЕ ТЕ
   * слова, что записаны версией.
   */
  async recordConsent(
    userId: string,
    url: string,
    input: { textVersion: string; locale: AccountConsentLocale },
    ipHash: string | null,
  ): Promise<SiteAccessView> {
    if (input.textVersion !== ACCOUNT_CONSENT_TEXT_VERSION) {
      throw new ConflictException({
        error: ACCOUNT_CONSENT_STALE,
        code: ACCOUNT_CONSENT_STALE,
        message:
          'текст подтверждения обновился — прочитайте его ещё раз и подтвердите заново',
      });
    }
    const domain = consentDomainOf(url);
    try {
      await this.prisma.siteTutorialAccountConsent.create({
        data: {
          userId,
          registrableDomain: domain,
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: input.locale,
          ipHash,
        },
      });
    } catch (err) {
      // Повтор (двойное нажатие) — уже подтверждено, это не ошибка.
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      // Строка уже есть, но это может быть журнал (`journal`, человек
      // галочку не видел): тогда она становится настоящим подтверждением
      // — с языком, адресом и временем нажатия. Иначе после перехода
      // journal → required человек не смог бы подтвердить (уникальный
      // индекс) и упирался бы в 409 навсегда.
      await this.prisma.siteTutorialAccountConsent.updateMany({
        where: {
          userId,
          registrableDomain: domain,
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: JOURNAL_CONSENT_LOCALE,
        },
        data: { locale: input.locale, ipHash, acceptedAt: new Date() },
      });
    }
    return this.resolve(userId, url);
  }

  /**
   * Служебное подтверждение — ТОЛЬКО для съёмки кадров лендинга
   * (`ui-snapshot/tutorial-frames-capture.service.ts`): фикстурный
   * пользователь по НАШЕМУ домену, запуск — оператор админки. Без него
   * мастер в режиме B показывал бы галочку вместо страницы, и шаг
   * ожидания кадра не дожидался бы ничего.
   *
   * Отличается от `recordConsent` честно: текст человеку не показывался,
   * поэтому `locale = 'service'` и `ipHash = NULL` — в журнале такая
   * строка не выдаёт себя за галочку живого человека. Какие домены
   * считаются «нашими», решает вызывающий; маршрута у этого метода нет.
   */
  async recordServiceConsent(userId: string, url: string): Promise<void> {
    try {
      await this.prisma.siteTutorialAccountConsent.create({
        data: {
          userId,
          registrableDomain: consentDomainOf(url),
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: SERVICE_CONSENT_LOCALE,
          ipHash: null,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code !== 'P2002') throw err;
      // Строка журнала того же домена (съёмка шла в `journal`) в
      // `required` подтверждением не считается — переводим её в
      // служебную, иначе мастер ждал бы галочку, а съёмщик думал бы, что
      // подтверждение есть.
      await this.prisma.siteTutorialAccountConsent.updateMany({
        where: {
          userId,
          registrableDomain: consentDomainOf(url),
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: JOURNAL_CONSENT_LOCALE,
        },
        data: { locale: SERVICE_CONSENT_LOCALE, ipHash: null },
      });
    }
  }

  /**
   * «Подтвердить сайт»: завести хост в кабинете сайтов человека (кабинет
   * создаётся, если его нет, — как при первом входе в TMA помощника).
   * Подтверждение владения (DNS/файл/мета) — уже там, по `verifyUrl`.
   */
  async registerHost(userId: string, url: string): Promise<SiteAccessView> {
    const telegramId = (await this.telegramOf(userId)).sites;
    if (!telegramId) {
      throw new ConflictException({
        error: 'SITE_TUTORIAL_SITES_NO_TELEGRAM',
        code: 'SITE_TUTORIAL_SITES_NO_TELEGRAM',
        message:
          'подтвердить сайт можно только из аккаунта Telegram — откройте приложение в Telegram',
      });
    }
    try {
      await this.sites.registerHost(telegramId, url);
    } catch (err) {
      if (err instanceof SitesRejectedError) {
        throw new ConflictException({
          error: `SITE_TUTORIAL_SITES_${err.code}`.slice(0, 64),
          code: `SITE_TUTORIAL_SITES_${err.code}`.slice(0, 64),
          message: err.message,
        });
      }
      throw new ConflictException({
        error: 'SITE_TUTORIAL_SITES_UNAVAILABLE',
        code: 'SITE_TUTORIAL_SITES_UNAVAILABLE',
        message:
          err instanceof SitesNotConfiguredError
            ? 'подтверждение сайтов не подключено на этом стенде — записывать можно и без него'
            : 'кабинет сайтов сейчас не отвечает — попробуйте через минуту; записывать можно и без подтверждения',
      });
    }
    return this.resolve(userId, url);
  }

  /**
   * Строка журнала (`journal`): идемпотентно (уникальный индекс
   * пользователь+домен+версия — P2002 молча), и сбой записи НЕ ломает
   * запуск — в лог без домена и пользователя.
   */
  private async recordJournal(
    userId: string,
    url: string,
    ipHash: string | null,
  ): Promise<void> {
    try {
      await this.prisma.siteTutorialAccountConsent.create({
        data: {
          userId,
          registrableDomain: consentDomainOf(url),
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
          locale: JOURNAL_CONSENT_LOCALE,
          ipHash,
        },
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') return;
      const code = (err as { code?: unknown })?.code;
      this.logger.warn(
        `журнал подтверждений обучалки не записан (${(err as Error)?.name ?? 'Error'}${typeof code === 'string' ? ` ${code}` : ''}) — запуск продолжается`,
      );
    }
  }

  /** A последней удачной проверки моложе суток и тот же хост. */
  private stickyA(
    prior: DraftModeColumns | null | undefined,
    host: string,
  ): boolean {
    if (!prior || prior.siteMode !== 'A' || !prior.siteModeCheckedAt) {
      return false;
    }
    let priorHost: string;
    try {
      priorHost = new URL(prior.baseUrl).hostname.toLowerCase();
    } catch {
      return false;
    }
    return (
      priorHost === host &&
      this.now().getTime() - prior.siteModeCheckedAt.getTime() < STICKY_A_MS
    );
  }

  private async view(
    userId: string,
    url: string,
    d: {
      mode: SiteMode;
      reason: SiteAccessReason;
      hostStatus: SiteAccessView['hostStatus'];
      hostId: string | null;
      canRegister: boolean;
      cached: boolean;
    },
  ): Promise<SiteAccessView> {
    const domain = consentDomainOf(url);
    const policy = this.policy();
    // В `off` журнал не ведётся и не читается — запрос в базу не нужен.
    const accepted =
      policy === 'off'
        ? false
        : await this.hasConsent(userId, domain, policy === 'required');
    return {
      mode: d.mode,
      host: new URL(url).hostname.toLowerCase(),
      registrableDomain: domain,
      reason: d.reason,
      hostStatus: d.hostStatus,
      hostId: d.hostId,
      // Ш1-хвост (item 18): глубокая ссылка «подтвердить ЭТОТ хост».
      verifyUrl: verifyUrlForHost(this.env, new URL(url).hostname),
      canRegister: d.canRegister,
      cached: d.cached,
      consent: {
        policy,
        required: policy === 'required' && d.mode === 'B',
        accepted,
        textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        legalReviewed: ACCOUNT_CONSENT_LEGAL_REVIEWED,
        texts: ACCOUNT_CONSENT_TEXTS,
      },
    };
  }

  /** Колонки черновика по решению (`siteMode`, `siteHostId`, отметка). */
  modeColumns(
    view: SiteAccessView,
    now = new Date(),
  ): {
    siteMode: SiteMode;
    siteHostId: string | null;
    siteModeCheckedAt: Date;
  } {
    return {
      siteMode: view.mode,
      siteHostId: view.hostId,
      siteModeCheckedAt: now,
    };
  }

  /**
   * Есть ли подтверждение текущей версии. В `required` строка журнала
   * (`locale = 'journal'`) подтверждением НЕ считается: её писал сервер
   * при запуске в `journal`, человек галочку не видел, — иначе переход
   * journal → required пропускал бы всех, кто уже запускал обучалку.
   */
  private async hasConsent(
    userId: string,
    domain: string,
    humanOnly: boolean,
  ): Promise<boolean> {
    const row = await this.prisma.siteTutorialAccountConsent.findUnique({
      where: {
        userId_registrableDomain_textVersion: {
          userId,
          registrableDomain: domain,
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        },
      },
      select: { id: true, locale: true },
    });
    if (!row) return false;
    return !humanOnly || row.locale !== JOURNAL_CONSENT_LOCALE;
  }

  /** Telegram-id: сырой (признак фикстуры) и годный для sites-backend. */
  private async telegramOf(
    userId: string,
  ): Promise<{ raw: string | null; sites: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    const raw = user?.telegramId ?? null;
    return { raw, sites: sitesTelegramId(raw) };
  }
}
