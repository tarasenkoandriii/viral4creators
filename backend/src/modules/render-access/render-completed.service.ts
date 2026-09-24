/**
 * Успешное завершение рендера — одно место на весь продукт, этап 134.
 *
 * ## Почему это сервис, а не строчка в четырёх местах
 *
 * Момент «ролик готов» существует в коде ЧЕТЫРЕЖДЫ: две ветки в
 * `generation.service.ts` (путь Veo и путь Grok завершаются каждый у
 * себя) и две в `greeting-video.service.ts` (аватар и Grok). Счётчик
 * конверсии шеринга (`markConverted`) стоял только в первых двух — то
 * есть поздравлений он не видел вовсе, и это расхождение существовало
 * задолго до этой работы.
 *
 * Повесить сюда же засчёт приглашения копиями значило бы завести второе
 * такое расхождение, причём в месте, где оно стоит денег. Поэтому
 * потребителей момента держит один сервис, а зовут его все четыре
 * ветки; что каждая зовёт — сторожит `scripts/check-docs.mjs`.
 *
 * Всё здесь **best-effort**: учёт не должен портить человеку только что
 * готовый ролик. Отсюда `.catch()` на каждом потребителе, а не общий
 * `try` — упавший счётчик шеринга не должен отменять засчёт
 * приглашения.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SharedVideoService } from '../shared-video/shared-video.service';
import { ReferralService } from '../invite/referral.service';

@Injectable()
export class RenderCompletedService {
  private readonly logger = new Logger(RenderCompletedService.name);

  constructor(
    private readonly sharedVideos: SharedVideoService,
    private readonly referrals: ReferralService,
  ) {}

  /**
   * @param session владелец и происхождение сессии. Оба поля
   *   необязательны: анонимная сессия и сессия, начатая не по ссылке
   *   шеринга, — обычное дело, и потребители это знают.
   */
  async onRenderCompleted(session: {
    userId?: string | null;
    sharedFromPageId?: string | null;
  }): Promise<void> {
    await Promise.all([
      this.sharedVideos
        .markConverted(session.sharedFromPageId)
        .catch((e) =>
          this.logger.warn(`счётчик конверсии шеринга: ${String(e)}`),
        ),
      // Первая генерация приглашённого — единственное, что засчитывает
      // приглашение (§5.3). Сервис сам разберётся, что делать: у
      // большинства сессий приглашения нет вовсе.
      this.referrals
        .countFirstGeneration(session.userId)
        .catch((e) => this.logger.warn(`засчёт приглашения: ${String(e)}`)),
    ]);
  }
}
