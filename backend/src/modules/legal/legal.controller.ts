/**
 *   GET  /me/terms          has this user accepted the current version?
 *   POST /me/terms/accept    record acceptance (version defaults to current)
 *
 * Behind TelegramIdentityGuard — acceptance needs someone to attach it to;
 * the anonymous path stores its own consent in the browser (see
 * LegalService doc comment).
 */

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { LegalService, TermsStatus, TERMS_VERSION } from './legal.service';

export class AcceptTermsRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  version?: string;
}

@Controller('me/terms')
@UseGuards(TelegramIdentityGuard)
export class LegalController {
  constructor(private readonly service: LegalService) {}

  @Get()
  status(@Req() req: IdentifiedRequest): Promise<TermsStatus> {
    return this.service.status(req.telegramUserId);
  }

  @Post('accept')
  accept(
    @Req() req: IdentifiedRequest,
    @Body() dto: AcceptTermsRequestDto,
  ): Promise<TermsStatus> {
    return this.service.accept(
      req.telegramUserId,
      dto.version ?? TERMS_VERSION,
    );
  }
}
