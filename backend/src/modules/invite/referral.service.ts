/**
 * Приглашения — «Условно бесплатный Lite» §5, этап 134.
 *
 * ## Три момента, и все три разные
 *
 *  - **переход** (`registerVisit`) — анонимный клик по ссылке. Строк не
 *    создаёт вовсе, только двигает счётчик: у клика нет ключа, человек
 *    ещё никто;
 *  - **идентификация** (`claim`) — вошёл, появился `User`. Здесь
 *    рождается строка `Referral`, и здесь же решается, чей он: первое
 *    касание выигрывает;
 *  - **засчёт** (`countFirstGeneration`) — сам дошёл до готового ролика.
 *    Только он двигает прогресс и начисляет генерации.
 *
 * Разнести их важно: два первых бесплатны и происходят у кого угодно,
 * третий стоит нам денег и происходит один раз в жизни приглашённого.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { CreditLedgerService } from '../credit-ledger/credit-ledger.service';
import {
  isNewcomer,
  makeCode,
  normalizeCode,
  referralClaimWindowMs,
  referralDailyCountedCap,
  referralInviteeBonus,
} from '../../common/referral';

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly credits: CreditLedgerService,
  ) {}

  /** Код человека; заводится по первому обращению, не раньше. */
  async codeOf(userId: string): Promise<string> {
    const existing: { code: string } | null =
      await this.prisma.referralCode.findUnique({
        where: { userId },
        select: { code: true },
      });
    if (existing) return existing.code;

    // Коллизия кода почти невероятна (31^8), но «почти» на уникальном
    // индексе означает исключение у случайного человека. Три попытки
    // стоят дёшево и закрывают вопрос полностью.
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = makeCode((n) => randomBytes(n));
      try {
        await this.prisma.referralCode.create({ data: { userId, code } });
        return code;
      } catch (error) {
        if ((error as { code?: string })?.code !== 'P2002') throw error;
        // Либо код занят, либо параллельный запрос успел завести код
        // этому же человеку — во втором случае возвращаем его.
        const mine: { code: string } | null =
          await this.prisma.referralCode.findUnique({
            where: { userId },
            select: { code: true },
          });
        if (mine) return mine.code;
      }
    }
    throw new Error('не удалось выдать код приглашения');
  }

  /**
   * Переход по ссылке. Возвращает `false`, если кода нет — вызывающий
   * на этом не спотыкается: чужая или устаревшая ссылка не должна
   * ломать страницу, на которую человек пришёл.
   */
  async registerVisit(rawCode: unknown): Promise<boolean> {
    const code = normalizeCode(rawCode);
    if (!code) return false;
    const updated = await this.prisma.referralCode.updateMany({
      where: { code },
      data: { visitCount: { increment: 1 } },
    });
    return updated.count > 0;
  }

  /**
   * Привязать вошедшего к пригласившему.
   *
   * Правила здесь три, и каждое оплачено разбором:
   *
   *  - **только НОВЫЙ человек.** Приглашённым считается тот, кого раньше
   *    не было; иначе ссылками обменивались бы уже зарегистрированные;
   *  - **первое касание выигрывает.** Открыл две ссылки — засчитан
   *    первый. Последнее касание позволяло бы перехватывать чужих
   *    приглашённых, а спорить об этом дороже, чем выбрать правило;
   *  - **себя пригласить нельзя.**
   */
  async claim(inviteeId: string, rawCode: unknown): Promise<boolean> {
    const code = normalizeCode(rawCode);
    if (!code) return false;

    const owner: { userId: string } | null =
      await this.prisma.referralCode.findUnique({
        where: { code },
        select: { userId: true },
      });
    if (!owner || owner.userId === inviteeId) return false;

    // Найдено аудитом этапа 134: правило «только новый человек» было
    // записано в комментарии выше и не выполнялось НИГДЕ — привязывался
    // любой вошедший. Это не косметика: без проверки вся уже набранная
    // база пользователей годилась в приглашённые, по кредиту с каждого
    // и пригласившему, и «приглашённому».
    //
    // `User.createdAt` — дата первого появления этого `telegramId`
    // (поле уникально), то есть буквально то, что требует §5.2.
    const invitee: { createdAt: Date } | null =
      await this.prisma.user.findUnique({
        where: { id: inviteeId },
        select: { createdAt: true },
      });
    if (!invitee || !isNewcomer(invitee.createdAt, referralClaimWindowMs())) {
      return false;
    }

    try {
      await this.prisma.referral.create({
        data: { inviterId: owner.userId, inviteeId },
      });
      return true;
    } catch (error) {
      // P2002 на `inviteeId` — человек уже привязан к кому-то. Это и
      // есть «первое касание выигрывает»: второй код просто не
      // применяется, и молчать об этом правильно — человек не делал
      // ничего плохого.
      if ((error as { code?: string })?.code === 'P2002') return false;
      throw error;
    }
  }

  /**
   * Приглашённый дошёл до первой генерации — засчитываем.
   *
   * Зовётся из `onRenderCompleted`, то есть из места, которое
   * вызывается ПОВТОРНО (клиентские ретраи, опрос статуса). Поэтому
   * идемпотентность здесь не пожелание, а условие: переход
   * `IDENTIFIED → GENERATED` делается условным `updateMany`, и второй
   * раз он просто не находит строку.
   *
   * ## Что здесь исправил аудит этапа 134
   *
   * Первая редакция упиралась в суточный потолок ДО отметки и уходила,
   * ничего не записав. §5.4 говорит прямо противоположное: «приглашение
   * остаётся `GENERATED`, а начисление ... на следующий день». Разница
   * не в порядке строк, а в том, что запись `GENERATED` — это ПРАВДА о
   * человеке (он действительно дошёл до ролика), и потолки к ней
   * отношения не имеют: они про деньги. Не записав правду, мы теряли
   * сам факт — и «назавтра» не наступало никогда, потому что вернуться
   * к нему было неоткуда.
   *
   * Поэтому теперь: отметка — безусловно, начисление — через
   * `settlePending`, который идемпотентен и зовётся ещё и из
   * кабинета.
   *
   * Best-effort по духу всего, что висит на завершении рендера: сбой
   * учёта не должен портить человеку только что готовый ролик.
   */
  async countFirstGeneration(
    inviteeId: string | null | undefined,
  ): Promise<void> {
    if (!inviteeId) return;
    try {
      const referral: {
        id: string;
        inviterId: string;
        status: string;
        revokedAt: Date | null;
      } | null = await this.prisma.referral.findUnique({
        where: { inviteeId },
        select: { id: true, inviterId: true, status: true, revokedAt: true },
      });
      if (!referral || referral.revokedAt) return;

      if (referral.status === 'IDENTIFIED') {
        // §5.4: тестовые и заблокированные приглашённые не считаются.
        // Проверяем здесь, а не при привязке: заблокировать человека
        // могли и позже, а разблокировать — потом, и тогда следующий
        // его ролик засчитается как надо.
        const invitee: { isTestUser: boolean; isBlocked: boolean } | null =
          await this.prisma.user.findUnique({
            where: { id: inviteeId },
            select: { isTestUser: true, isBlocked: true },
          });
        if (!invitee || invitee.isTestUser || invitee.isBlocked) return;

        await this.prisma.referral.updateMany({
          where: { id: referral.id, status: 'IDENTIFIED' },
          data: { status: 'GENERATED', generatedAt: new Date() },
        });
      }

      // Оба — и пригласивший, и сам приглашённый: у второго свой бонус
      // (Р6), и он не должен зависеть от того, упёрся ли первый в свой
      // суточный потолок.
      await this.settlePending(referral.inviterId);
      await this.settlePending(inviteeId);
    } catch (error) {
      this.logger.warn(
        `не удалось засчитать приглашение для ${inviteeId}: ${String(error)}`,
      );
    }
  }

  /**
   * Догнать начисления, которые ждут, — обе роли человека сразу.
   *
   * Зачем это отдельный проход. Начисление может не состояться по двум
   * причинам, и обе временные: личный суточный потолок пригласившего
   * (`REFERRAL_DAILY_COUNTED_CAP`, §5.4) и общий предохранитель
   * программы (`FREE_GRANT_DAILY_CAP`, §12.3). Оба обещают «назавтра»,
   * и оба до этого аудита обещали впустую: строка помечалась, кредит не
   * начислялся, и вернуться к нему было некому.
   *
   * Идемпотентность держится не на флаге «уже начислено», а на
   * `@@unique([referralId, reason])` в журнале: повторный вызов
   * упирается в индекс и ничего не меняет. Поэтому звать этот метод
   * можно сколько угодно и откуда угодно — он и зовётся с двух сторон:
   * при завершении рендера приглашённого и при каждом открытии
   * кабинета (`InviteService.stateOf`), то есть ровно тогда, когда
   * человек приходит смотреть, что ему причитается.
   */
  async settlePending(userId: string): Promise<void> {
    await this.settleInviterCredits(userId);
    await this.settleInviteeBonus(userId);
  }

  /** Кредиты пригласившему за уже дошедших до ролика — в пределах суточного потолка. */
  private async settleInviterCredits(inviterId: string): Promise<void> {
    const cap = referralDailyCountedCap();
    // Ноль — законное значение: «приостановить программу».
    if (cap <= 0) return;

    const grantedToday = await this.prisma.creditLedger.count({
      where: {
        userId: inviterId,
        reason: 'REFERRAL',
        createdAt: { gte: startOfTodayUtc() },
      },
    });
    let budget = cap - grantedToday;
    if (budget <= 0) return;

    const counted: { id: string }[] = await this.prisma.referral.findMany({
      where: { inviterId, status: 'GENERATED', revokedAt: null },
      select: { id: true },
      // Старшие первыми: если потолка хватает не на всех, ждать должен
      // тот, кто пришёл последним, а не тот, кто ждёт со вчера.
      orderBy: { generatedAt: 'asc' },
    });
    if (counted.length === 0) return;

    const paid: { referralId: string | null }[] =
      await this.prisma.creditLedger.findMany({
        where: {
          reason: 'REFERRAL',
          referralId: { in: counted.map((r) => r.id) },
        },
        select: { referralId: true },
      });
    const paidIds = new Set(paid.map((p) => p.referralId));

    for (const referral of counted) {
      if (budget <= 0) break;
      if (paidIds.has(referral.id)) continue;
      // `grantFree` отвечает `false` и на «уже начисляли», и на
      // «упёрлись в предохранитель». Различать их здесь не нужно:
      // бюджет тратит только настоящее начисление, а всё остальное
      // просто подождёт следующего прохода.
      if (await this.credits.grantFree(inviterId, 'REFERRAL', referral.id)) {
        budget--;
      }
    }
  }

  /** Бонус самому приглашённому (Р6) — вне суточного потолка пригласившего: он не его. */
  private async settleInviteeBonus(inviteeId: string): Promise<void> {
    if (referralInviteeBonus() <= 0) return;
    const referral: {
      id: string;
      status: string;
      revokedAt: Date | null;
    } | null = await this.prisma.referral.findUnique({
      where: { inviteeId },
      select: { id: true, status: true, revokedAt: true },
    });
    if (!referral || referral.revokedAt || referral.status !== 'GENERATED') {
      return;
    }
    await this.credits.grantFree(inviteeId, 'REFERRAL_INVITEE', referral.id);
  }
}

/** Та же граница суток, что у расхода и у предохранителя начислений. */
function startOfTodayUtc(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}
