import {
  Body,
  Controller,
  HttpStatus,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  Equals,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { FFMPEG_PRODUCTS } from '../postprod/ffmpeg-api.service';
import { FfmpegAdminAccess } from './ffmpeg-admin-access';
import {
  FFMPEG_JOB_STATES,
  FFMPEG_PERIODS,
  FfmpegAdminService,
  MutationOutcome,
} from './ffmpeg-admin.service';

/** `in_progress` — 202 (первый запрос с этим operationId ещё в работе). */
async function reply(
  res: Response,
  p: Promise<MutationOutcome>,
): Promise<MutationOutcome> {
  const r = await p;
  if (r.outcome === 'in_progress') res.status(HttpStatus.ACCEPTED);
  return r;
}

class FfmpegOperationDto {
  /** UUID операции от клиента: ключ идемпотентности и журнала. */
  @IsUUID() operationId!: string;
}
class FfmpegControlDto extends FfmpegOperationDto {
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class FfmpegResumeDto extends FfmpegControlDto {
  /** Выход из recovery после сверки (CORE): только с ffmpeg.configure и причиной. */
  @IsOptional() @IsBoolean() reconciled?: boolean;
}
class FfmpegReasonDto extends FfmpegOperationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @Matches(/^(?:\s*\S){3}/)
  reason!: string;
}
class FfmpegPurgeDto extends FfmpegReasonDto {
  @Equals(true) confirmIrreversible!: boolean;
}
class FfmpegReconcileDto extends FfmpegControlDto {
  @IsOptional() @IsString() @MaxLength(128) idempotencyKey?: string;
}
class FfmpegDownloadDto extends FfmpegControlDto {
  @IsString() @MaxLength(128) file!: string;
}
class FfmpegLimitsDto extends FfmpegOperationDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsObject() limits!: Record<string, unknown>;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class FfmpegRoutingDto extends FfmpegOperationDto {
  @Type(() => Number) @IsInt() @Min(1) expectedRevision!: number;
  @IsIn(['hosted', 'selfhosted']) defaultProvider!: 'hosted' | 'selfhosted';
  @IsArray()
  @ArrayMaxSize(FFMPEG_PRODUCTS.length)
  @IsIn(FFMPEG_PRODUCTS, { each: true })
  canaryProducts!: string[];
  /** Отдельное подтверждение владельца для default = selfhosted. */
  @IsOptional() @IsBoolean() confirmSelfhostedDefault?: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
class FfmpegJobsQuery {
  @IsOptional() @IsIn(['hosted', 'selfhosted']) provider?:
    | 'hosted'
    | 'selfhosted';
  @IsOptional() @IsIn(FFMPEG_JOB_STATES) state?: string;
  @IsOptional() @IsIn(FFMPEG_PRODUCTS) product?: string;
  @IsOptional() @IsIn(FFMPEG_PERIODS) period?: string;
  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[\x21-\x7e]+$/)
  clientOperationId?: string;
  @IsOptional() @IsString() @MaxLength(160) jobId?: string;
  @IsOptional() @IsString() @MaxLength(512) cursor?: string;
}

/**
 * Вкладка «FFmpeg» (ТЗ FFmpeg-server v1.1 §13.1): `/api/admin/ffmpeg/*`.
 * Cookie-сессия админки + Origin/CSRF для не-GET (AdminSessionGuard),
 * затем серверное право `ffmpeg.*` (до RBAC — только владелец).
 * GET ничего не меняет.
 */
@Controller('admin/ffmpeg')
@UseGuards(AdminSessionGuard)
export class FfmpegAdminController {
  constructor(
    private readonly service: FfmpegAdminService,
    private readonly access: FfmpegAdminAccess,
  ) {}

  @Header('Cache-Control', 'no-store')
  @Get('overview')
  async overview(@Req() req: AdminAuthenticatedRequest) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.read');
    return {
      ...(await this.service.overview()),
      permissions: actor.permissions,
    };
  }

  @Header('Cache-Control', 'no-store')
  @Get('jobs')
  async jobs(
    @Req() req: AdminAuthenticatedRequest,
    @Query() query: FfmpegJobsQuery,
  ) {
    await this.access.assert(req.userId, 'ffmpeg.read');
    return this.service.jobs(query);
  }

  @Header('Cache-Control', 'no-store')
  @Get('jobs/:id')
  async job(@Req() req: AdminAuthenticatedRequest, @Param('id') id: string) {
    await this.access.assert(req.userId, 'ffmpeg.read');
    return this.service.job(id);
  }

  @Header('Cache-Control', 'no-store')
  @Get('limits')
  async limits(@Req() req: AdminAuthenticatedRequest) {
    await this.access.assert(req.userId, 'ffmpeg.read');
    return this.service.limits();
  }

  @Post('pause') @HttpCode(200) async pause(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FfmpegControlDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    return reply(res, this.service.control(actor, 'pause', dto));
  }

  @Post('drain') @HttpCode(200) async drain(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FfmpegControlDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    return reply(res, this.service.control(actor, 'drain', dto));
  }

  @Post('resume') @HttpCode(200) async resume(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FfmpegResumeDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    // Выход из recovery меняет допуск задач к работе — право configure.
    if (dto.reconciled === true)
      await this.access.assert(req.userId, 'ffmpeg.configure');
    return reply(res, this.service.control(actor, 'resume', dto));
  }

  @Post('jobs/:id/cancel') @HttpCode(200) async cancel(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() dto: FfmpegReasonDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    return reply(res, this.service.cancel(actor, id, dto));
  }

  @Post('jobs/:id/purge') @HttpCode(200) async purge(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() dto: FfmpegPurgeDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    return reply(res, this.service.purge(actor, id, dto));
  }

  @Post('jobs/:id/reconcile') @HttpCode(200) async reconcile(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() dto: FfmpegReconcileDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.operate');
    return reply(res, this.service.reconcile(actor, id, dto));
  }

  @Post('jobs/:id/download-link') @HttpCode(200) async downloadLink(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Param('id') id: string,
    @Body() dto: FfmpegDownloadDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.media.read');
    return reply(res, this.service.downloadLink(actor, id, dto));
  }

  @Post('limits') @HttpCode(200) async updateLimits(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FfmpegLimitsDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.configure');
    return reply(res, this.service.updateLimits(actor, dto));
  }

  @Post('routing') @HttpCode(200) async updateRouting(
    @Req() req: AdminAuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
    @Body() dto: FfmpegRoutingDto,
  ) {
    const actor = await this.access.assert(req.userId, 'ffmpeg.configure');
    return reply(res, this.service.updateRouting(actor, dto));
  }
}
