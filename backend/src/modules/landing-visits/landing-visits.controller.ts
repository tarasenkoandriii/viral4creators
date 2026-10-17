import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsUUID } from 'class-validator';
import { Request } from 'express';
import { RateLimit, RateLimitGuard, clientIp } from '../../common/rate-limit';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { LandingVisitsService } from './landing-visits.service';
import {
  LANDINGS,
  VISIT_LOCALES,
  visitOriginAllowed,
} from './landing-visits.contract';
export class LandingVisitDto {
  @IsUUID('4') eventId!: string;
  @IsIn(LANDINGS) landing!: string;
  @IsIn(VISIT_LOCALES) locale!: string;
}
class VisitSettingsDto {
  @IsBoolean() ipUniquenessEnabled!: boolean;
}
class VisitPeriodDto {
  @IsIn(['1', '7', '30', '90']) days = '7';
}
@Controller('public/landing-visits')
export class LandingVisitsController {
  constructor(private readonly visits: LandingVisitsService) {}
  @Post()
  @HttpCode(202)
  @UseGuards(RateLimitGuard)
  @RateLimit({ name: 'landing-visits', limit: 60, windowSec: 60 })
  record(@Body() body: LandingVisitDto, @Req() req: Request) {
    if (!visitOriginAllowed(req.headers.origin, body.landing))
      throw new ForbiddenException('Запрос с этого источника отклонён');
    return this.visits.record(body, clientIp(req));
  }
}
@Controller('admin/landing-visits')
@UseGuards(AdminSessionGuard)
export class AdminLandingVisitsController {
  constructor(
    private readonly visits: LandingVisitsService,
    private readonly admin: AdminPanelService,
  ) {}
  @Get() async report(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: VisitPeriodDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.visits.report(Number(query.days));
  }
  @Patch('settings') async configure(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: VisitSettingsDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.visits.configure(dto.ipUniquenessEnabled, req.userId);
  }
}
