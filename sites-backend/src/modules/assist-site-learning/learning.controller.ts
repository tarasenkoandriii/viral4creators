/**
 * «Обучение (посетители)» — L (ТЗ §4-тер.13, §4-тер.14):
 *   GET    /assist/sites/:id/learning/site/queue?kind=&status=
 *   POST   /assist/sites/:id/learning/site/queue                     кандидат оператора (operator+)
 *   POST   /assist/sites/:id/learning/site/queue/:itemId/resolve     (manager)
 *   POST   /assist/sites/:id/learning/site/queue/:itemId/draft       (manager; бюджет обучения)
 *   GET    /assist/sites/:id/learning/site/golden?status=            (operator+ читает)
 *   POST   /assist/sites/:id/learning/site/golden                    (manager)
 *   PATCH  /assist/sites/:id/learning/site/golden/:gid               (manager)
 *   DELETE /assist/sites/:id/learning/site/golden/:gid               (manager; = архив)
 *   POST   /assist/sites/:id/learning/site/golden/copy-to/:targetSiteId (manager)
 *   GET    /assist/sites/:id/learning/site/quality                   (manager)
 *   POST   /assist/sites/:id/learning/site/eval-run                  (manager)
 *   POST   /assist/sites/:id/learning/site/simulate                  (manager; №31)
 * Версии, исключения, карантин, мастер, полнота — маршруты Э1–Э2 (не трогать).
 *
 * Тела — интерфейсы api-types (не DTO-классы): глобальный ValidationPipe их
 * пропускает, разбор и коды отказов — в сервисах (их же зовут бот и тесты).
 * Права — дважды: гвард маршрута (403 PRODUCT_ROLE_REQUIRED) и сервис.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  REQUIRE_ASSIST_ANY,
  REQUIRE_ASSIST_MANAGER,
  type AccountMembership,
} from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import {
  LEARNING_KINDS,
  type CandidateRequest,
  type GoldenCopyRequest,
  type GoldenCreateRequest,
  type GoldenPatchRequest,
  type LearningKind,
  type ResolveRequest,
} from './api-types';
import { GoldenAnswersService } from './golden.service';
import { LearningQueueService } from './learning-queue.service';
import { LearningQualityService } from './quality.service';

function queueKind(v: unknown): LearningKind | null {
  return typeof v === 'string' &&
    (LEARNING_KINDS as readonly string[]).includes(v)
    ? (v as LearningKind)
    : null;
}

function queueStatus(v: unknown): 'open' | 'resolved' | 'all' {
  return v === 'resolved' || v === 'all' ? v : 'open';
}

function goldenStatus(
  v: unknown,
): 'active' | 'needs_review' | 'archived' | 'all' {
  return v === 'active' || v === 'needs_review' || v === 'archived' ? v : 'all';
}

@Controller('assist/sites')
@AllowApps('assist')
@UseGuards(SiteAccountGuard)
export class SiteLearningQueueController {
  constructor(
    readonly queue: LearningQueueService,
    readonly golden: GoldenAnswersService,
    readonly quality: LearningQualityService,
  ) {}

  @Get(':id/learning/site/queue')
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  list(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('kind') kind?: string,
    @Query('status') status?: string,
  ) {
    return this.queue.list(m, id, {
      kind: queueKind(kind),
      status: queueStatus(status),
    });
  }

  @Post(':id/learning/site/queue')
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  propose(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: CandidateRequest,
  ) {
    return this.queue.propose(m, id, body);
  }

  @Post(':id/learning/site/queue/:itemId/resolve')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  resolve(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() body: ResolveRequest,
  ) {
    return this.queue.resolve(m, id, itemId, body);
  }

  @Post(':id/learning/site/queue/:itemId/draft')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  draft(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('itemId') itemId: string,
  ) {
    return this.queue.draft(m, id, itemId);
  }

  @Get(':id/learning/site/golden')
  @RequireProductRoles(REQUIRE_ASSIST_ANY)
  goldenList(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Query('status') status?: string,
  ) {
    return this.golden.list(m, id, { status: goldenStatus(status) });
  }

  @Post(':id/learning/site/golden')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  goldenCreate(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Body() body: GoldenCreateRequest,
  ) {
    return this.golden.create(m, id, body);
  }

  @Post(':id/learning/site/golden/copy-to/:targetSiteId')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  goldenCopy(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('targetSiteId') targetSiteId: string,
    @Body() body: GoldenCopyRequest,
  ) {
    return this.golden.copyTo(m, id, targetSiteId, body);
  }

  @Patch(':id/learning/site/golden/:gid')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  goldenPatch(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('gid') gid: string,
    @Body() body: GoldenPatchRequest,
  ) {
    return this.golden.patch(m, id, gid, body);
  }

  @Delete(':id/learning/site/golden/:gid')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  async goldenArchive(
    @Membership() m: AccountMembership,
    @Param('id') id: string,
    @Param('gid') gid: string,
  ): Promise<{ ok: true }> {
    await this.golden.archive(m, id, gid);
    return { ok: true };
  }

  @Get(':id/learning/site/quality')
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  qualityView(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.quality.quality(m, id);
  }

  @Post(':id/learning/site/eval-run')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  evalRun(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.quality.runEval(m, id, 'manual');
  }

  @Post(':id/learning/site/simulate')
  @HttpCode(200)
  @RequireProductRoles(REQUIRE_ASSIST_MANAGER)
  simulate(@Membership() m: AccountMembership, @Param('id') id: string) {
    return this.quality.simulate(m, id);
  }
}
