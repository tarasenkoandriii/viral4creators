/**
 * Кабинет (TMA): голосовая карта × браузерный воркер Ш3 (Э6-тер (е), задание
 * `assist-voice-map-check`; ТЗ §5-кватер.13):
 *   POST /assist/sites/:id/voice-map/site/snapshots                { url, viewport? } → задание «Снимок»
 *   GET  /assist/sites/:id/voice-map/site/snapshots/:sid           статус, элементы с рамками, ссылка на скриншот (≤ 15 мин)
 *   POST /assist/sites/:id/voice-map/site/versions/:n/worker-check сверка дескрипторов версии на образцах (без кликов)
 *   GET  /assist/sites/:id/voice-map/site/versions/:n/worker-check последняя сверка версии и её отчёт
 * Права — как у карты: владелец или `assist: manager`. Воркер выключен —
 * 409 `BROWSER_WORKER_DISABLED`.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  AccountMembership,
  REQUIRE_ASSIST_MANAGER,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { VoiceMapWorkerService } from './voice-map-worker.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceMapWorkerController {
  constructor(private readonly svc: VoiceMapWorkerService) {}

  @Post(':id/voice-map/site/snapshots')
  @HttpCode(200)
  requestSnapshot(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.svc.requestSnapshot(m, id, body);
  }

  @Get(':id/voice-map/site/snapshots/:sid')
  snapshot(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('sid') sid: string,
  ) {
    return this.svc.snapshot(m, id, sid);
  }

  @Post(':id/voice-map/site/versions/:n/worker-check')
  @HttpCode(200)
  requestCheck(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.svc.requestCheck(m, id, n);
  }

  @Get(':id/voice-map/site/versions/:n/worker-check')
  check(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('n') n: string,
  ) {
    return this.svc.check(m, id, n);
  }
}
