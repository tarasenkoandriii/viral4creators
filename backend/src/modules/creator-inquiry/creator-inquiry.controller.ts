/**
 * Весь модуль — TelegramIdentityGuard: бриф принадлежит конкретному
 * заказчику (ТЗ §21.1), публичной стороны здесь нет (в отличие от
 * creator-profile/portfolio) — витрина каталога уже покрыта GET /creators.
 *
 *   POST /creator-inquiries                     создать бриф
 *   GET  /creator-inquiries/mine                свои брифы
 *   GET  /creator-inquiries/:id                 один бриф (для восстановления contactedCreatorId)
 *   GET  /creator-inquiries/:id/matches         подбор исполнителя (§21.3)
 *   POST /creator-inquiries/:id/contact         отметить «связался» (§21.3)
 *   GET  /creator-inquiries/:id/format-advice   совет по формату (§21.4)
 */

import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { CreatorInquiryService } from './creator-inquiry.service';
import { ContactCreatorDto, CreateCreatorInquiryDto } from './dto/creator-inquiry.dto';
import {
  CreatorInquiryMatchView,
  CreatorInquiryView,
  FormatAdviceView,
} from '../../common/types/marketplace.types';

@Controller('creator-inquiries')
@UseGuards(TelegramIdentityGuard)
export class CreatorInquiryController {
  constructor(private readonly service: CreatorInquiryService) {}

  @Post()
  create(
    @Req() req: IdentifiedRequest,
    @Body() dto: CreateCreatorInquiryDto,
  ): Promise<CreatorInquiryView> {
    return this.service.create(req.telegramUserId, dto);
  }

  @Get('mine')
  mine(@Req() req: IdentifiedRequest): Promise<CreatorInquiryView[]> {
    return this.service.listMine(req.telegramUserId);
  }

  @Get(':id')
  getOne(@Req() req: IdentifiedRequest, @Param('id') id: string): Promise<CreatorInquiryView> {
    return this.service.getOne(req.telegramUserId, id);
  }

  @Get(':id/matches')
  matches(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<CreatorInquiryMatchView[]> {
    return this.service.getMatches(req.telegramUserId, id);
  }

  @Post(':id/contact')
  contact(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
    @Body() dto: ContactCreatorDto,
  ): Promise<CreatorInquiryView> {
    return this.service.markContacted(req.telegramUserId, id, dto);
  }

  @Get(':id/format-advice')
  formatAdvice(
    @Req() req: IdentifiedRequest,
    @Param('id') id: string,
  ): Promise<FormatAdviceView> {
    return this.service.getFormatAdvice(req.telegramUserId, id);
  }
}
