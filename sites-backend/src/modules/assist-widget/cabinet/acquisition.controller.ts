/**
 * POST /assist/acquisition — W2. Любой участник кабинета (атрибуция —
 * свойство кабинета, не роли): @AllowApps('assist') + SiteAccountGuard.
 */
import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import type { AccountMembership } from '../../site-core/account/roles';
import {
  Membership,
  SiteAccountGuard,
} from '../../site-core/account/site-account.guard';
import { AllowApps } from '../../telegram-auth/allow-apps.decorator';
import type { AcquisitionRequest } from '../landing/landing-types';
import { AcquisitionService } from './acquisition.service';

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
export class AcquisitionController {
  constructor(private readonly acquisitions: AcquisitionService) {}

  @Post('acquisition')
  @HttpCode(200)
  record(@Membership() m: AccountMembership, @Body() body: AcquisitionRequest) {
    return this.acquisitions.record(m, body);
  }
}
