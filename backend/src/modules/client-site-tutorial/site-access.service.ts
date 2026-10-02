/**
 * Режим обучалки A/B и подтверждение прав на аккаунт (Э-С Ш1; П-Т1, П-Т2
 * `docs-tz/SECURITY-PROPOSALS-2026-10-02.md` §2).
 *
 * Режим не выбирает пользователь — его определяет статус хоста во
 * внутреннем API `sites-backend` (`SitesInternalClient`):
 *  - **A «свой сайт»** — хост подтверждён (DNS/файл/мета) в кабинете
 *    сайтов, где этот человек владелец или менеджер. Привязка — по
 *    Telegram-id (кабинет у человека один на все боты).
 *  - **B «чужой сайт со своим аккаунтом»** — всё остальное, в том числе
 *    «sites-backend не настроен/не ответил»: обучалка работает дальше,
 *    только с защитами B. Подтверждение владения — повышение до A, а не
 *    ворота для всех (решение владельца 02.10.2026).
 *
 * Ворота П-Т2: в режиме B перед `explore`/`login`/живым входом нужно
 * подтверждение прав на аккаунт и согласия с условиями сайта — одно на
 * регистрируемый домен для всех черновиков пользователя, пока не сменится
 * версия текста (`account-consent.ts`). Без него — 409
 * `SITE_TUTORIAL_ACCOUNT_CONSENT_REQUIRED`.
 *
 * Не делает здесь (следующие шаги, не мешаем им): П-Т3 (пароль в B не
 * хранится) и П-Т4 (личное хранилище сессий) читают `siteMode` черновика;
 * П-Т6+ (лимиты логинов/доменов, запрещённые категории) — свои проверки
 * рядом с этими воротами.
 */
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  SitesHostReason,
  SitesHostStatus,
  SitesInternalClient,
  SitesNotConfiguredError,
  SitesRejectedError,
  sitesTelegramId,
} from '../sites-internal/sites-internal.client';
import {
  ACCOUNT_CONSENT_LEGAL_REVIEWED,
  ACCOUNT_CONSENT_TEXTS,
  ACCOUNT_CONSENT_TEXT_VERSION,
  AccountConsentLocale,
  consentDomainOf,
} from './account-consent';

export type SiteMode = 'A' | 'B';

/** Почему режим B (или `null` у A) — плашка фронтенда ветвится по коду. */
export type SiteAccessReason =
  | Exclude<SitesHostReason, null>
  | 'unavailable'
  | 'not_configured'
  | 'no_telegram'
  | 'unsupported_url'
  | null;

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
  /** Можно ли завести хост в кабинет отсюда («Подтвердить сайт»). */
  canRegister: boolean;
  consent: {
    /** Режим B — подтверждение обязательно перед входом и обходом. */
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

/** `locale` служебной записи подтверждения (съёмка кадров лендинга). */
export const SERVICE_CONSENT_LOCALE = 'service';

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

@Injectable()
export class ClientSiteAccessService {
  private readonly logger = new Logger(ClientSiteAccessService.name);
  env: NodeJS.ProcessEnv = process.env;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
  ) {}

  /**
   * Режим и подтверждение для адреса. Сеть к sites-backend — один
   * подписанный POST; любая неудача — режим B с причиной, не исключение.
   */
  async resolve(userId: string, url: string): Promise<SiteAccessView> {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const domain = consentDomainOf(url);
    const telegramId = await this.telegramIdOf(userId);
    let status: SitesHostStatus | null = null;
    let reason: SiteAccessReason = null;
    if (!this.sites.configured()) reason = 'not_configured';
    else if (!telegramId) reason = 'no_telegram';
    else if (parsed.protocol !== 'https:' || parsed.port) {
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
          this.logger.warn(
            `режим обучалки: sites-backend недоступен (${(err as Error).name}) — режим B`,
          );
        }
      }
    }
    const mode: SiteMode = status?.mode === 'A' ? 'A' : 'B';
    const accepted = await this.hasConsent(userId, domain);
    return {
      mode,
      host,
      registrableDomain: domain,
      reason: mode === 'A' ? null : (reason ?? 'not_verified'),
      hostStatus: status?.status ?? null,
      hostId: status?.hostId ?? null,
      verifyUrl: verifyUrlFrom(this.env),
      canRegister:
        reason !== 'not_configured' &&
        reason !== 'no_telegram' &&
        reason !== 'unsupported_url' &&
        reason !== 'opted_out',
      consent: {
        required: mode === 'B',
        accepted,
        textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        legalReviewed: ACCOUNT_CONSENT_LEGAL_REVIEWED,
        texts: ACCOUNT_CONSENT_TEXTS,
      },
    };
  }

  /**
   * Ворота П-Т2 перед действием, которое водит наш браузер по сайту под
   * аккаунтом человека (`explore`, `login`, живой вход): режим B без
   * подтверждения — 409 с машинным кодом, фронтенд показывает галочку.
   */
  requireConsent(view: SiteAccessView): void {
    if (view.mode === 'B' && !view.consent.accepted) {
      throw new ConflictException({
        error: ACCOUNT_CONSENT_REQUIRED,
        code: ACCOUNT_CONSENT_REQUIRED,
        message: `сайт ${view.registrableDomain} не подтверждён как ваш: подтвердите, что аккаунт на нём ваш и запись не нарушает условия сайта, — или подтвердите владение сайтом`,
      });
    }
  }

  /**
   * Режим — в черновик (П-Т1: «пересчёт при подтверждении»). Без сдвига
   * `version`: это не правка пользователя, и раунд другой вкладки не
   * должен из-за неё получать 409.
   */
  async persistMode(draftId: string, view: SiteAccessView): Promise<void> {
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
    }
  }

  /**
   * «Подтвердить сайт»: завести хост в кабинете сайтов человека (кабинет
   * создаётся, если его нет, — как при первом входе в TMA помощника).
   * Подтверждение владения (DNS/файл/мета) — уже там, по `verifyUrl`.
   */
  async registerHost(userId: string, url: string): Promise<SiteAccessView> {
    const telegramId = await this.telegramIdOf(userId);
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
            ? 'подтверждение сайтов не подключено на этом стенде — запись работает в режиме «чужой сайт»'
            : 'кабинет сайтов сейчас не отвечает — попробуйте через минуту; запись можно продолжать в режиме «чужой сайт»',
      });
    }
    return this.resolve(userId, url);
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

  private async hasConsent(userId: string, domain: string): Promise<boolean> {
    const row = await this.prisma.siteTutorialAccountConsent.findUnique({
      where: {
        userId_registrableDomain_textVersion: {
          userId,
          registrableDomain: domain,
          textVersion: ACCOUNT_CONSENT_TEXT_VERSION,
        },
      },
      select: { id: true },
    });
    return row !== null;
  }

  private async telegramIdOf(userId: string): Promise<string | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    });
    return sitesTelegramId(user?.telegramId);
  }
}
