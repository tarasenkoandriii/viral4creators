import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  Equals,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService } from '../admin-panel/admin-panel.service';
import { StoryOperatorService } from './story-operator.service';
import { StoryRetentionService } from './story-retention.service';

class StoryOperatorDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @Matches(/^(?:\s*\S){3}/)
  reason!: string;
  @IsUUID() requestId!: string;
}
class StoryNoChargeDto extends StoryOperatorDto {
  @Equals(true) providerChargeConfirmedAbsent!: boolean;
}
class StoryBindJobDto extends StoryOperatorDto {
  @IsString() @MaxLength(128) jobId!: string;
  /** Optional fingerprint: any input URL of the job from the provider dashboard. */
  @IsOptional() @IsString() @MaxLength(2048) renderInputUrl?: string;
}
class StoryCloseRenderDto extends StoryOperatorDto {
  @IsBoolean() releaseReserve!: boolean;
  @IsOptional() @IsBoolean() providerChargeConfirmedAbsent?: boolean;
}
class StoryJournalQuery {
  @IsOptional() @IsString() @MaxLength(80) targetId?: string;
}

/** WP1: operator reconciliation of Story-Tales UNKNOWN results and retention preview. */
@Controller('admin/story-tales')
@UseGuards(AdminSessionGuard)
export class AdminStoryTalesController {
  constructor(
    private readonly operator: StoryOperatorService,
    private readonly retention: StoryRetentionService,
    private readonly admin: AdminPanelService,
  ) {}
  @Header('Cache-Control', 'no-store')
  @Get('queue')
  async queue(@Req() req: AdminAuthenticatedRequest) {
    await this.admin.assertOperator(req.userId);
    return this.operator.queue();
  }
  @Header('Cache-Control', 'no-store')
  @Get('journal')
  async journal(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: StoryJournalQuery,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.journal(query.targetId);
  }
  /** Dry-run only: what the retention cron would delete now. */
  @Header('Cache-Control', 'no-store')
  @Get('retention')
  async retentionPreview(@Req() req: AdminAuthenticatedRequest) {
    await this.admin.assertOperator(req.userId);
    return this.retention.run({ dryRun: true, withCandidates: true });
  }
  @Post('gifts/:id/close') @HttpCode(200) async closeGift(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryOperatorDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.closeGift(req.userId, id, dto);
  }
  @Post('gifts/:id/reopen') @HttpCode(200) async reopenGift(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryNoChargeDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.reopenGift(req.userId, id, dto);
  }
  @Post('gifts/:id/qa-reset') @HttpCode(200) async resetGiftQa(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryNoChargeDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.resetGiftQa(req.userId, id, dto);
  }
  @Post('renders/:id/bind-job') @HttpCode(200) async bindJob(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryBindJobDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.bindRenderJob(req.userId, id, dto);
  }
  @Post('renders/:id/close') @HttpCode(200) async closeRender(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryCloseRenderDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.closeRender(req.userId, id, dto);
  }
  @Post('renders/:id/qa-reset') @HttpCode(200) async resetRenderQa(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryNoChargeDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.resetRenderQa(req.userId, id, dto);
  }
  /** WP4 segment cache: UNKNOWN → DELETED, only with providerChargeConfirmedAbsent: true. */
  @Post('segments/:id/close') @HttpCode(200) async closeSegment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: StoryNoChargeDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.closeSegment(req.userId, id, dto);
  }
  @Post('references/:ref/close') @HttpCode(200) async closeReference(
    @Req() req: AdminAuthenticatedRequest,
    @Param('ref') ref: string,
    @Body() dto: StoryOperatorDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.closeReference(req.userId, ref, dto);
  }
  @Post('references/:ref/delete') @HttpCode(200) async deleteReference(
    @Req() req: AdminAuthenticatedRequest,
    @Param('ref') ref: string,
    @Body() dto: StoryOperatorDto,
  ) {
    await this.admin.assertOperator(req.userId);
    return this.operator.deleteReference(req.userId, ref, dto);
  }
}
