/**
 * Разблокировка Lite — «Условно бесплатный Lite» §4.2, §5.4, этап 135.
 *
 * ## Почему отдельный сервис, а не метод в `InviteService`
 *
 * Разблокировку надо ставить из двух РАЗНЫХ мест: когда подтвердилась
 * подписка (`InviteService`) и когда засчиталось приглашение
 * (`ReferralService`). Метод в первом из них означал бы, что второй
 * зависит от кабинета целиком, — то есть кольцо в зависимостях ради
 * одной проверки. Здесь же нет ничего, кроме Prisma и правила.
 *
 * ## Одно правило, про которое стоит знать заранее
 *
 * **Автоматическая разблокировка НИКОГДА не спорит с оператором.** Если
 * доступ отозван (§5.4), сам собой он назад не вернётся, даже когда
 * засчитанных приглашений по-прежнему семь. Иначе отзыв, сделанный
 * отдельным действием и с обязательной причиной, отменялся бы первым же
 * следующим приглашением — то есть не работал бы вовсе. Вернуть доступ
 * после отзыва может только оператор, и это видно в `liteUnlockSource`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { earnsUnlock, liteUnlockActive } from '../../common/free-tier';
import { referralUnlockTarget } from '../../common/referral';

@Injectable()
export class LiteUnlockService {
  private readonly logger = new Logger(LiteUnlockService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Записать заработанную разблокировку, если условия выполнены.
   *
   * Идемпотентно и молчаливо: зовётся из мест, которые вызываются
   * повторно, и ни одно из них не должно упасть из-за того, что
   * разблокировка уже стоит.
   *
   * @returns поставили ли её именно сейчас — для тестов и логов.
   */
  async maybeUnlock(userId: string): Promise<boolean> {
    const user: {
      liteUnlockedAt: Date | null;
      liteRevokedAt: Date | null;
      unlockCheck: { id: string } | null;
    } | null = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        liteUnlockedAt: true,
        liteRevokedAt: true,
        unlockCheck: { select: { id: true } },
      },
    });
    if (!user) return false;

    // Уже открыто — ставить второй раз нечего.
    if (liteUnlockActive(user)) return false;
    // Отозвано оператором — см. шапку файла: сам собой доступ не
    // возвращается, иначе отзыв ничего не значил бы.
    if (user.liteRevokedAt) return false;
    // Подписку читаем ЗДЕСЬ, а не принимаем параметром: вызывающих двое,
    // и каждый знал бы только свою половину условия.
    if (!user.unlockCheck) return false;

    const countedReferrals = await this.prisma.referral.count({
      where: { inviterId: userId, status: 'GENERATED', revokedAt: null },
    });
    if (
      !earnsUnlock({
        countedReferrals,
        subscriptionConfirmed: true,
        target: referralUnlockTarget(),
      })
    ) {
      return false;
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { liteUnlockedAt: new Date(), liteUnlockSource: 'EARNED' },
    });
    this.logger.log(
      `стена снята заработанным доступом: ${userId} (${countedReferrals} приглашений)`,
    );
    return true;
  }

  /**
   * Отнять разблокировку — действие оператора, §5.4.
   *
   * `liteUnlockedAt` НЕ стирается: «почему у меня пропал доступ» должно
   * иметь ответ в базе, а не выясняться по отсутствию поля. Право
   * считается по паре дат (`hasRenderRight`), поэтому отзыв позже
   * разблокировки её и перекрывает.
   */
  async revoke(userId: string, reason: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { liteRevokedAt: new Date(), liteRevokedReason: reason },
    });
  }

  /**
   * Вернуть разблокировку после отзыва — тоже действие оператора.
   *
   * Новая дата `liteUnlockedAt` позже отзыва, и этого достаточно:
   * старые строки не правятся, история отзыва с причиной остаётся на
   * месте. `liteUnlockSource = OPERATOR` — чтобы в админке было видно,
   * что доступ не заработан, а возвращён руками.
   */
  async grantByOperator(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { liteUnlockedAt: new Date(), liteUnlockSource: 'OPERATOR' },
    });
  }
}
