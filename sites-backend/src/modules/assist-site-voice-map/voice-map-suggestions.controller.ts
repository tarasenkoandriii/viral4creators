/**
 * Кабинет (TMA) «Обучение → Голос»: карточки подсказок голосовой карты
 * «Сайта» — заход 13 (Р-З13-Б3), см. `voice-map-suggestions.service.ts`:
 *   GET  /assist/sites/:id/voice-map/site/suggestions
 *   POST /assist/sites/:id/voice-map/site/suggestions/term     { expectedRevision, id }
 *   POST /assist/sites/:id/voice-map/site/suggestions/rebind   { expectedRevision, id, to }
 *   POST /assist/sites/:id/voice-map/site/suggestions/mute     { id }
 * Права — как у карты: владелец или `assist: manager` (В-49); оператор — 403.
 */
import {
  Body,
  Controller,
  Get,
  Header,
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
import { VoiceMapSuggestionsService } from './voice-map-suggestions.service';

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireProductRoles(REQUIRE_ASSIST_MANAGER)
export class VoiceMapSuggestionsController {
  constructor(private readonly suggestions: VoiceMapSuggestionsService) {}

  /** Фразы посетителей (маскированные) — мимо кэшей. */
  @Get(':id/voice-map/site/suggestions')
  @Header('Cache-Control', 'no-store')
  list(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.suggestions.list(m, id);
  }

  @Post(':id/voice-map/site/suggestions/term')
  @HttpCode(200)
  term(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.suggestions.acceptTerm(m, id, body);
  }

  @Post(':id/voice-map/site/suggestions/rebind')
  @HttpCode(200)
  rebind(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.suggestions.rebind(m, id, body);
  }

  @Post(':id/voice-map/site/suggestions/mute')
  @HttpCode(200)
  mute(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.suggestions.mute(m, id, body);
  }
}
