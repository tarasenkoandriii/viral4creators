/**
 * Кабинет «Пригласить» — «Условно бесплатный Lite» §7, этап 133.
 *
 * Пока здесь половина кабинета: сколько генераций осталось, подтверждена
 * ли подписка и чем она подтверждается. Приглашения, лестница и список
 * приведённых приезжают этапом 134 — и приедут В ЭТОТ ЖЕ ответ, чтобы
 * экран не пришлось собирать из двух запросов.
 *
 * ## Почему подтверждение подписки живёт здесь, а не в `RenderAccess`
 *
 * Тот сервис отвечает на один вопрос — пускать ли этот старт рендера, —
 * и знать, чем именно человек заплатил, ему незачем. Здесь наоборот:
 * вся сделка целиком, и ни одного знания о том, как устроен рендер.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import { TelegramMembershipService } from './telegram-membership.service';
import { hasRenderRight, wallEnabled } from '../../common/free-tier';
import {
  funnelOf,
  isCounted,
  referralUnlockTarget,
} from '../../common/referral';
import { ReferralService } from './referral.service';
import { LiteUnlockService } from './lite-unlock.service';
import { YoutubeUnlockService } from './youtube-unlock.service';

/** Приглашённый в списке кабинета — СОБЫТИЯ, а не человек (§7.2). */
export interface InviteeView {
  /** Когда пришёл. Ни имени, ни аватарки, ни идентификатора. */
  joinedAt: string;
  /** Дошёл ли до своего ролика — единственное, что двигает счётчик. */
  counted: boolean;
}

/** Состояние сделки, как его видит экран. */
export interface InviteState {
  /** Стена включена. Выключена — экран объясняет, что условий пока нет. */
  wallEnabled: boolean;
  /** Доступных генераций (баланс кредитов). */
  generationsAvailable: number;
  /** Стена снята насовсем — подпиской или заработанным доступом. */
  unlocked: boolean;
  subscription: {
    /** Подтверждена ли подписка и чем. */
    confirmed: boolean;
    confirmedKind: string | null;
    /** Канал Telegram, если способ настроен на стенде. */
    telegramChannel: string | null;
    /** Второй способ — подписка на наш YouTube-канал (этап 140). */
    youtube: {
      /** Способ настроен на стенде (задан канал и ключи Google). */
      available: boolean;
      /** Проверять можно прямо сейчас: вход уже есть или не нужен. */
      ready: boolean;
      /** Проверять будем правом, которое человек уже дал под загрузку. */
      viaConnectedChannel: boolean;
      /** Ролик, лайк которого засчитывается вместо подписки. */
      videoId: string | null;
      channelId: string | null;
    };
  };
  referrals: {
    /** Персональный код; ссылку из него собирает клиент. */
    code: string;
    /** Сколько нужно засчитанных, чтобы стена снялась насовсем. */
    target: number;
    /** Три числа воронки: перешли / вошли / сделали ролик. */
    funnel: { visited: number; identified: number; generated: number };
    /** Список приглашённых — событиями, без имён (§7.2). */
    invitees: InviteeView[];
  };
}

export const SUBSCRIPTION_NOT_MEMBER =
  'Подписка не найдена. Подпишитесь на канал и нажмите «Проверить» ещё раз.';

export const SUBSCRIPTION_ALREADY =
  'Подписка уже подтверждена — генерация за неё начислена.';

export const YOUTUBE_SIGN_IN_REQUIRED =
  'Сначала войдите через Google — иначе подписку не у кого спросить.';

export const YOUTUBE_NOT_SUBSCRIBED =
  'Подписка не найдена. Подпишитесь на канал и нажмите «Проверить» ещё раз.';

export const SUBSCRIPTION_ACCOUNT_TAKEN =
  'Этим аккаунтом подписку уже подтверждали для другого пользователя.';

export const SUBSCRIPTION_UNAVAILABLE =
  'Не удалось спросить Telegram о подписке. Попробуйте ещё раз через минуту.';

/** Оплаченная подписка, действующая прямо сейчас. Те же условия, что в
 * `RenderAccessService`: PAST_DUE намеренно не считается — это «списание
 * не прошло», и рендерить в долг незачем. */
function activeSubscription(
  sub: { status: string; currentPeriodEnd: Date } | null,
): boolean {
  return (
    !!sub &&
    (sub.status === 'ACTIVE' || sub.status === 'RENEWING') &&
    sub.currentPeriodEnd.getTime() > Date.now()
  );
}

@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditLedgerService,
    private readonly telegram: TelegramMembershipService,
    private readonly referrals: ReferralService,
    private readonly liteUnlock: LiteUnlockService,
    private readonly youtube: YoutubeUnlockService,
  ) {}

  async stateOf(userId: string): Promise<InviteState> {
    // Догоняем отложенные начисления ПЕРЕД тем, как читать баланс:
    // кабинет — то самое место, куда человек приходит посмотреть, что
    // ему причитается, и показывать ему вчерашнее число, зная, что
    // начисление ждёт, незачем. Оба прохода идемпотентны и молчаливы
    // (§12.3, §5.4); упасть они не должны, но если упадут — кабинет
    // всё равно обязан открыться.
    await this.settleDeferredGrants(userId);

    const [user, balance, codeRow, identified, generated, invitees] =
      await Promise.all([
        this.prisma.user.findUnique({
          where: { id: userId },
          select: {
            liteUnlockedAt: true,
            liteRevokedAt: true,
            unlockCheck: { select: { kind: true } },
            // Найдено аудитом этапа 133: без подписки в выборке платящий
            // видел «лимит не снят» — притом что стена его не касается
            // вовсе. Экран, который врёт человеку про его же оплату, хуже
            // отсутствующего экрана.
            subscription: { select: { status: true, currentPeriodEnd: true } },
          },
        }) as Promise<{
          liteUnlockedAt: Date | null;
          liteRevokedAt: Date | null;
          unlockCheck: { kind: string } | null;
          subscription: { status: string; currentPeriodEnd: Date } | null;
        } | null>,
        this.credits.balanceOf(userId),
        // Код заводится здесь, по первому открытию кабинета: до того он
        // никому не нужен, а таблица кодов, которыми не поделились, —
        // мусор. Переходы читаем ТЕМ ЖЕ запросом: до аудита этапа 134
        // за ними ходили вторым, уже после `Promise.all`, — лишний
        // круг к базе на каждое открытие кабинета.
        this.referralCodeRow(userId),
        // Воронка считается ЗАПРОСАМИ, а не длиной списка ниже. Список
        // обрезан полусотней, и первая редакция считала по нему же: у
        // человека с шестьюдесятью приглашёнными на экране навсегда
        // стояло «50 вошли».
        this.prisma.referral.count({ where: { inviterId: userId } }),
        this.prisma.referral.count({
          where: { inviterId: userId, status: 'GENERATED', revokedAt: null },
        }),
        this.prisma.referral.findMany({
          where: { inviterId: userId },
          select: { status: true, revokedAt: true, identifiedAt: true },
          orderBy: { identifiedAt: 'desc' },
          // Список в кабинете — не отчёт: сто строк там никто не читает,
          // а три числа воронки выше отвечают на тот же вопрос точнее.
          take: 50,
        }) as Promise<
          { status: string; revokedAt: Date | null; identifiedAt: Date }[]
        >,
      ]);
    // Есть ли чем проверять подписку, если человек нажмёт «Проверить».
    // Именно `hasSource`, а не `tokenFor` (аудит этапа 140): второй у
    // человека с подключённым каналом пошёл бы обновлять токен в
    // Google — на КАЖДОМ открытии кабинета. Право спрашивают, когда
    // нажали кнопку, а не когда открыли страницу. Тихо: своя же
    // неполадка не должна мешать кабинету открыться.
    const youtubeSource = this.youtube.configured()
      ? await this.youtube
          .hasSource(userId)
          .catch(() => ({ ready: false, viaConnectedChannel: false }))
      : null;

    return {
      wallEnabled: wallEnabled(),
      generationsAvailable: Math.max(balance, 0),
      unlocked: hasRenderRight({
        liteUnlockedAt: user?.liteUnlockedAt ?? null,
        liteRevokedAt: user?.liteRevokedAt ?? null,
        hasActiveSubscription: activeSubscription(user?.subscription ?? null),
      }),
      subscription: {
        confirmed: !!user?.unlockCheck,
        confirmedKind: user?.unlockCheck?.kind ?? null,
        telegramChannel: this.telegram.channel() ?? null,
        youtube: {
          available: this.youtube.configured(),
          // `ready` считается ДО показа экрана: у человека с подключённым
          // каналом право уже есть, и предлагать ему вход через Google
          // значило бы терять конверсию на пустом месте (находка аудита
          // ТЗ). Отдельного запроса к Google на это не уходит — только
          // чтение своей же таблицы.
          ready: youtubeSource?.ready ?? false,
          viaConnectedChannel: youtubeSource?.viaConnectedChannel ?? false,
          videoId: this.youtube.videoId() ?? null,
          channelId: this.youtube.channelId() ?? null,
        },
      },
      referrals: {
        code: codeRow.code,
        target: referralUnlockTarget(),
        funnel: funnelOf({
          visitCount: codeRow.visitCount,
          identified,
          generated,
        }),
        invitees: invitees.map((r) => ({
          joinedAt: r.identifiedAt.toISOString(),
          counted: isCounted(r),
        })),
      },
    };
  }

  /** Код и его счётчик переходов одним обращением. */
  private async referralCodeRow(
    userId: string,
  ): Promise<{ code: string; visitCount: number }> {
    const code = await this.referrals.codeOf(userId);
    const row: { visitCount: number } | null =
      await this.prisma.referralCode.findUnique({
        where: { userId },
        select: { visitCount: true },
      });
    return { code, visitCount: row?.visitCount ?? 0 };
  }

  /**
   * Всё, что могло не начислиться из-за суточных потолков, — одним
   * проходом (§12.3).
   *
   * Найдено аудитом этапа 134. Обещание «начисление догонит его
   * следующими сутками» стояло в двух местах — у подписки здесь и у
   * приглашений в `ReferralService`, — и не выполнялось ни в одном:
   * строка о подтверждении уже есть, значит повторная попытка
   * отказывает раньше начисления, а больше её никто не делает.
   *
   * Оба вызова идемпотентны по индексам журнала: `SUBSCRIPTION` — по
   * паре (пользователь, причина), приглашения — по (приглашение,
   * причина). Поэтому проход безопасно делать на каждое открытие
   * кабинета.
   */
  private async settleDeferredGrants(userId: string): Promise<void> {
    try {
      const confirmed = await this.prisma.unlockCheck.findUnique({
        where: { userId },
        select: { id: true },
      });
      if (confirmed) await this.credits.grantFree(userId, 'SUBSCRIPTION');
    } catch (error) {
      this.logger.warn(
        `догон начисления за подписку ${userId}: ${String(error)}`,
      );
    }
    try {
      await this.referrals.settlePending(userId);
    } catch (error) {
      this.logger.warn(
        `догон начислений за приглашения ${userId}: ${String(error)}`,
      );
    }
  }

  /**
   * «Я подписался» — проверяем и начисляем генерацию.
   *
   * Порядок важен: сначала спрашиваем Telegram, потом пишем строку и
   * только потом начисляем. Обратный порядок означал бы начисление
   * тому, чью подписку мы не подтвердили, а откатывать кредит нечем —
   * человек успеет его потратить.
   */
  async confirmTelegram(userId: string): Promise<InviteState> {
    if (!this.telegram.configured()) {
      throw new BadRequestException(
        'Подтверждение через Telegram на этом стенде не настроено',
      );
    }

    const existing = await this.prisma.unlockCheck.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) throw new ConflictException(SUBSCRIPTION_ALREADY);

    const user: { telegramId: string } | null =
      await this.prisma.user.findUnique({
        where: { id: userId },
        select: { telegramId: true },
      });
    if (!user) throw new BadRequestException('Пользователь не найден');

    const member = await this.telegram.isMember(user.telegramId);
    // `null` — «спросить не удалось», и это НЕ «не подписан». Отказать
    // подписчику из-за нашей же неполадки — худший исход, поэтому здесь
    // 503 с предложением повторить, а не отказ.
    if (member === null) {
      throw new ServiceUnavailableException(SUBSCRIPTION_UNAVAILABLE);
    }
    if (!member) throw new BadRequestException(SUBSCRIPTION_NOT_MEMBER);

    try {
      await this.prisma.unlockCheck.create({
        data: {
          userId,
          kind: 'TELEGRAM_CHANNEL',
          // Telegram-идентификатор человека: один аккаунт — один
          // подтверждённый, иначе подтверждение ничего не значит.
          externalAccountId: `tg:${user.telegramId}`,
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        // Найдено аудитом этапа 133: сюда приходят ДВА разных случая, и
        // сказать человеку не тот — значит отправить его разбираться не
        // туда. Уникальных индекса тоже два: по `userId` (это он сам,
        // два быстрых нажатия) и по `externalAccountId` (тем же
        // Telegram-аккаунтом подтверждали кому-то ещё).
        const mine = await this.prisma.unlockCheck.findUnique({
          where: { userId },
          select: { id: true },
        });
        throw new ConflictException(
          mine ? SUBSCRIPTION_ALREADY : SUBSCRIPTION_ACCOUNT_TAKEN,
        );
      }
      throw error;
    }

    const granted = await this.credits.grantFree(userId, 'SUBSCRIPTION');
    if (!granted) {
      // Строка о подписке уже есть, а генерация не начислена: значит
      // упёрлись в суточный предохранитель (§12.3). Это не ошибка
      // человека, и отказывать ему нечем — говорим в лог, начисление
      // догонит его следующими сутками.
      this.logger.warn(
        `подписка ${userId} подтверждена, но генерация не начислена — ` +
          `суточный предохранитель`,
      );
    }
    // Вторая половина условия §4.2 могла выполниться ровно сейчас:
    // приглашения были набраны раньше, а подписки не хватало.
    await this.liteUnlock
      .maybeUnlock(userId)
      .catch((error) =>
        this.logger.warn(`проверка разблокировки ${userId}: ${String(error)}`),
      );
    return this.stateOf(userId);
  }

  /**
   * «Я подписался на YouTube» — этап 140. Тот же порядок, что у
   * Telegram-способа, и по той же причине: сначала спрашиваем Google,
   * потом пишем строку и только потом начисляем. Обратный порядок
   * начислил бы тому, чью подписку мы не подтвердили, а откатывать
   * кредит нечем — человек успеет его потратить.
   */
  async confirmYoutube(userId: string): Promise<InviteState> {
    if (!this.youtube.configured()) {
      throw new BadRequestException(
        'Подтверждение через YouTube на этом стенде не настроено',
      );
    }

    const existing = await this.prisma.unlockCheck.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (existing) throw new ConflictException(SUBSCRIPTION_ALREADY);

    const source = await this.youtube.tokenFor(userId);
    if (!source) throw new BadRequestException(YOUTUBE_SIGN_IN_REQUIRED);

    const kind = await this.youtube.check(source.accessToken);
    // `null` — «спросить не удалось», и это НЕ «не подписан»: отказать
    // подписчику из-за нашей же неполадки — худший исход.
    if (kind === null) {
      throw new ServiceUnavailableException(SUBSCRIPTION_UNAVAILABLE);
    }
    if (kind === false) throw new BadRequestException(YOUTUBE_NOT_SUBSCRIBED);

    try {
      await this.prisma.unlockCheck.create({
        data: {
          userId,
          kind,
          // Канал Google-аккаунта: один аккаунт — один подтверждённый.
          // Префикс тот же по смыслу, что `tg:` у Telegram-способа, —
          // иначе один и тот же идентификатор из двух разных миров мог
          // бы совпасть.
          externalAccountId: `yt:${source.googleChannelId}`,
        },
      });
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        const mine = await this.prisma.unlockCheck.findUnique({
          where: { userId },
          select: { id: true },
        });
        throw new ConflictException(
          mine ? SUBSCRIPTION_ALREADY : SUBSCRIPTION_ACCOUNT_TAKEN,
        );
      }
      throw error;
    } finally {
      // Токен нам больше не нужен ни при каком исходе — и держать его
      // дольше одной проверки мы не обещали (§6.3). Вход, взятый у
      // подключённого канала, не трогаем: он живёт своей жизнью.
      if (!source.fromConnectedChannel) await this.youtube.forget(userId);
    }

    const granted = await this.credits.grantFree(userId, 'SUBSCRIPTION');
    if (!granted) {
      this.logger.warn(
        `подписка YouTube ${userId} подтверждена, но генерация не начислена — ` +
          `суточный предохранитель`,
      );
    }
    await this.liteUnlock
      .maybeUnlock(userId)
      .catch((error) =>
        this.logger.warn(`проверка разблокировки ${userId}: ${String(error)}`),
      );
    return this.stateOf(userId);
  }
}
