/**
 * Переход по реферальной ссылке — этап 134.
 *
 * Отдельный контроллер, потому что `InviteController` целиком закрыт
 * `TelegramIdentityGuard`, а этот маршрут анонимный ПО СМЫСЛУ: его
 * зовёт лендинг в тот момент, когда человек ещё никто — он только что
 * перешёл по чужой ссылке. Ставить гвард на класс и снимать его на
 * одном методе — верный способ однажды снять его не там.
 */

import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { ReferralService } from './referral.service';
import { WizardTelemetryService } from '../wizard-guide/wizard-telemetry.service';
import {
  INVITE_EVENT_KIND,
  INVITE_TELEMETRY_SCENARIO,
} from '../../common/referral';
import { InviteEventsDto, VisitDto } from './dto/referral.dto';

@Controller('referrals')
export class ReferralPublicController {
  constructor(
    private readonly referrals: ReferralService,
    private readonly telemetry: WizardTelemetryService,
  ) {}

  /**
   * Отметить переход. Ответ всегда 200 и без подробностей: страница,
   * на которую человек пришёл, не должна ломаться из-за того, что
   * ссылка устарела, а знать, существует ли чужой код, ему незачем.
   *
   * Лимит жёсткий: маршрут анонимный, и накрутить им можно только одно
   * — число в чужом кабинете, но и оно должно что-то значить.
   */
  @Post('visit')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'referral-visit', limit: 30, windowSec: 60 })
  async visit(@Body() dto: VisitDto): Promise<{ ok: true }> {
    await this.referrals.registerVisit(dto.code);
    return { ok: true };
  }

  /**
   * Четыре события кабинета (§12.2) — в ту же таблицу, что телеметрия
   * мастера, и с теми же свойствами: ни одного идентифицирующего поля,
   * ретенция 30 дней, уже подметается кроном.
   *
   * Без идентичности НАМЕРЕННО: «упёрся в стену» случается и с тем, кто
   * ещё не вошёл, — а это ровно то событие, ради которого §12.2 и
   * заведено. Писать сюда можно только четыре заранее известных
   * значения (`InviteEventsDto`), так что открытость маршрута не даёт
   * возможности положить в таблицу чужое.
   *
   * Ответ всегда 200: телеметрия — наблюдение за продуктом, а не часть
   * пути человека, и её отказ не должен становиться ошибкой на экране.
   */
  @Post('events')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'referral-events', limit: 60, windowSec: 60 })
  async events(@Body() dto: InviteEventsDto): Promise<{ ok: true }> {
    // `.catch`, а не голый `await`: сам сервис свои ошибки уже глотает,
    // но обещание «отказ телеметрии не становится ошибкой на экране»
    // не должно держаться на внутренностях чужого сервиса — сегодня он
    // ловит, завтра перестанет, и упадёт при этом наш маршрут.
    await this.telemetry
      .record(
        dto.steps.map((stepId) => ({
          scenario: INVITE_TELEMETRY_SCENARIO,
          stepId,
          kind: INVITE_EVENT_KIND[stepId],
        })),
      )
      .catch(() => 0);
    return { ok: true };
  }
}
