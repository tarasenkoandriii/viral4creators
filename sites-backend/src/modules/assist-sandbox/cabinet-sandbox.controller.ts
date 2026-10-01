/**
 * Песочница в TMA (онбординг шаги 2–3, §3.1) — K3:
 *   POST /assist/url-preview                  { url } → UrlPreview (шаг 2, без записи)
 *   POST /assist/sites/:id/sandbox            → SandboxView (создать/вернуть текущую)
 *   GET  /assist/sites/:id/sandbox            → SandboxView
 *   POST /assist/sites/:id/sandbox/chat       { question } → SandboxAnswer
 *   POST /assist/sandbox/:sandboxId/transfer  → SandboxTransferResult (payload sb_<id>)
 * Права: @AllowApps('assist'), SiteAccountGuard; песочница и перенос —
 * owner|manager кабинета (создают сайт/хост, как POST /sites).
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
import type { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireAccountRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { SandboxChatDto, SandboxUrlDto } from './sandbox.dto';
import { SandboxService } from './sandbox.service';

@Controller('assist')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
@RequireAccountRoles('owner', 'manager')
export class CabinetSandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post('url-preview')
  @HttpCode(200)
  preview(@Body() dto: SandboxUrlDto) {
    return this.sandbox.urlPreview(dto.url);
  }

  @Post('sites/:id/sandbox')
  @HttpCode(200)
  create(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.sandbox.createCabinet(m, id);
  }

  @Get('sites/:id/sandbox')
  get(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.sandbox.getCabinet(m, id);
  }

  @Post('sites/:id/sandbox/chat')
  @HttpCode(200)
  chat(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() dto: SandboxChatDto,
  ) {
    return this.sandbox.chatCabinet(m, id, dto.question);
  }

  @Post('sandbox/:sandboxId/transfer')
  @HttpCode(200)
  transfer(
    @Membership() m: AccountMembership,
    @Param('sandboxId') sandboxId: string,
  ) {
    return this.sandbox.transfer(m, sandboxId);
  }
}
