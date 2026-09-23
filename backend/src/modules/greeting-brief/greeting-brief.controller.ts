/**
 * GreetingBriefController — the only two new routes this ТЗ adds (§8):
 *
 *   GET   /projects/:projectId/greeting-brief
 *   PATCH /projects/:projectId/greeting-brief
 *
 * Same guard/identity convention as ProjectController: a GreetingBrief is
 * owned through its Project, which requires an identified caller.
 */

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { GreetingBriefService } from './greeting-brief.service';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import { GreetingBriefView } from '../../common/types/greeting.types';

@Controller('projects/:projectId/greeting-brief')
@UseGuards(TelegramIdentityGuard)
export class GreetingBriefController {
  constructor(private readonly service: GreetingBriefService) {}

  @Get()
  getBrief(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<GreetingBriefView> {
    return this.service.getBrief(req.telegramUserId, projectId);
  }

  @Patch()
  updateBrief(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: UpdateGreetingBriefDto,
  ): Promise<GreetingBriefView> {
    return this.service.updateBrief(req.telegramUserId, projectId, dto);
  }
}
