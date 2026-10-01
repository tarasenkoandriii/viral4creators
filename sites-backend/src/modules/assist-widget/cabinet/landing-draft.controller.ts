/**
 * GET /assist/widget-drafts/:id → `{ config }` — читатель `wd_` в кабинете
 * («к Л3»; интеграция Э2: TMA W4 зовёт его, сервер W2 делал только
 * публичный `POST /public/widget-drafts`). Любой участник кабинета может
 * ПРОЧИТАТЬ анонимный черновик (данные лендинга, без хостов и картинок);
 * применить его к сайту — `PATCH …/widget/draft`, это уже права manager.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { SiteAccountGuard } from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import {
  LandingDraftService,
  type LandingDraftView,
} from './landing-draft.service';

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
export class LandingDraftController {
  constructor(private readonly drafts: LandingDraftService) {}

  @Get('widget-drafts/:id')
  get(@Param('id') id: string): Promise<LandingDraftView> {
    return this.drafts.get(id);
  }
}
