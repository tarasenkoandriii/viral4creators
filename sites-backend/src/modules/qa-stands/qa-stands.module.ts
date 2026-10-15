import { compareForms } from './form-drift';
import { QaFindingService } from '../qa-catalog/qa-finding.service';
import { SiteAiModule } from '../site-ai/site-ai.module';
import { SiteSonioxStt } from '../assist-site-voice/public/soniox-stt.client';
import { QaStandsGenerator } from './qa-stands-generator.service';
import type { Response } from 'express';
import { isDeepStrictEqual } from 'node:util';
import {
  Body,
  Delete,
  Query,
  Res,
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { SitesDb } from '../../prisma/sites-db.service';
import { SiteCoreModule } from '../site-core/site-core.module';
import { AccountMembership } from '../site-core/account/roles';
import {
  Membership,
  RequireProductRoles,
  SiteAccountGuard,
} from '../site-core/account/site-account.guard';
import { AllowApps } from '../telegram-auth/allow-apps.decorator';
import { QaCatalogModule } from '../qa-catalog/qa-catalog.module';
import {
  QA_READ,
  QA_WRITE,
  QaCatalogService,
} from '../qa-catalog/qa-catalog.service';
import {
  baseline,
  checkStand,
  mockTransition,
  planStand,
  StandContract,
  StandRecord,
} from './stand-contract';
@Injectable()
export class QaStandsService {
  constructor(
    private readonly db: SitesDb,
    private readonly catalog: QaCatalogService,
    private readonly findings?: QaFindingService,
  ) {}
  async scoped(m: AccountMembership, site: string, write = false) {
    await this.catalog.scoped(m, site, write);
    return this.db.forAccount(m.accountId);
  }
  async list(m: AccountMembership, site: string, before?: string) {
    if (before && !/^[a-zA-Z0-9_-]{1,100}$/.test(before))
      throw new BadRequestException('Неверный курсор.');
    const db = await this.scoped(m, site);
    return {
      items: await db.qaStand.findMany({
        where: {
          accountId: m.accountId,
          siteId: site,
          ...(before ? { id: { lt: before } } : {}),
        },
        orderBy: { id: 'desc' },
        take: 50,
      }),
    };
  }
  async create(m: AccountMembership, site: string, input: unknown) {
    const db = await this.scoped(m, site, true);
    const contract = planStand(input);
    const requestId = (input as { requestId?: unknown }).requestId;
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId))
      throw new BadRequestException('Нужен requestId UUID.');
    const existing = await db.qaStand.findFirst({
      where: { accountId: m.accountId, siteId: site, requestId },
    });
    if (existing) {
      if (!isDeepStrictEqual(existing.contract, contract))
        throw new ConflictException(
          'requestId уже использован для другого описания.',
        );
      return existing;
    }
    try {
      return await db.qaStand.create({
        data: {
          accountId: m.accountId,
          siteId: site,
          requestId,
          contract: JSON.parse(JSON.stringify(contract)),
          records: baseline(contract),
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e;
      const retry = await db.qaStand.findFirst({
        where: { accountId: m.accountId, siteId: site, requestId },
      });
      if (!retry || !isDeepStrictEqual(retry.contract, contract))
        throw new ConflictException('Повтор создания с другим описанием.');
      return retry;
    }
  }
  async get(m: AccountMembership, site: string, id: string, write = false) {
    const db = await this.scoped(m, site, write);
    const row = await db.qaStand.findFirst({
      where: { id, accountId: m.accountId, siteId: site },
    });
    if (!row) throw new NotFoundException('Стенд не найден.');
    return { db, row };
  }
  async compareForm(
    m: AccountMembership,
    site: string,
    id: string,
    input: unknown,
  ) {
    const { row } = await this.get(m, site, id, true);
    const comparison = compareForms(input);
    if (!comparison.blocked)
      return {
        ...comparison,
        findingId: null,
        duplicate: false,
        fillAvailable: false,
      };
    const context = `stand:${id}; contract:${(row.contract as unknown as StandContract).version}; baseline:${comparison.baselineVersion}; hash:${comparison.baselineHash}`;
    const payload = {
      title: 'Обновить мок: рабочая форма изменилась',
      category: 'logic',
      severity: 'P1',
      status: 'needs_confirmation',
      url: comparison.url,
      context,
      steps:
        'Промпт для исправления: обновите контракт мока и сопоставление полей по перечисленным различиям. Сохраните запрет переноса credentials и принятия условий. Добавьте регрессионные кейсы; повторите сверку формы и сценарии стенда перед подтверждением адаптера.',
      expected:
        'Структура формы совпадает; перед заполнением требуется отдельный предпросмотр и подтверждение.',
      actual:
        `current:${comparison.currentHash}; changes:${comparison.changes.length}; ${comparison.changes.join(', ')}`.slice(
          0,
          1000,
        ),
      impact:
        'Перенос заблокирован. Проверить все сценарии выбранного стенда и сопоставления полей.',
      evidence: [
        `baseline:${comparison.baselineHash}`,
        `current:${comparison.currentHash}`,
        `versions:${comparison.baselineVersion} -> ${comparison.currentVersion}`,
      ],
      deployedSha: null,
      observedAt: new Date().toISOString(),
      verification: null,
    };
    try {
      const finding = await this.findings!.create(m, site, payload);
      return {
        ...comparison,
        findingId: finding.id,
        duplicate: false,
        fillAvailable: false,
      };
    } catch (e) {
      const response =
        e instanceof ConflictException
          ? (e.getResponse() as {
              code?: string;
              details?: { findingId?: string };
            })
          : null;
      if (
        response?.code !== 'QA_FINDING_DUPLICATE' ||
        !response.details?.findingId
      )
        throw e;
      return {
        ...comparison,
        findingId: response.details.findingId,
        duplicate: true,
        fillAvailable: false,
      };
    }
  }
  async command(
    m: AccountMembership,
    site: string,
    id: string,
    input: unknown,
    reset = false,
  ) {
    const { db, row } = await this.get(
      m,
      site,
      id,
      reset || (input as { method?: string })?.method !== 'GET',
    );
    const contract = row.contract as unknown as StandContract;
    const result = reset
      ? {
          status: 200,
          data: { reset: true },
          records: baseline(contract),
          changed: true,
        }
      : mockTransition(
          contract,
          row.records as unknown as StandRecord[],
          input,
        );
    if (result.changed) {
      const updated = await db.qaStand.updateMany({
        where: {
          id,
          accountId: m.accountId,
          siteId: site,
          revision: row.revision,
        },
        data: { records: result.records, revision: { increment: 1 } },
      });
      if (!updated.count)
        throw new ConflictException(
          'Стенд изменён. Обновите данные и повторите действие.',
        );
    }
    return {
      status: result.status,
      data: result.data,
      revision: row.revision + (result.changed ? 1 : 0),
    };
  }
}
@Controller('qa/sites/:siteId/stands')
@AllowApps('qa', 'assist')
@UseGuards(SiteAccountGuard)
export class QaStandsController {
  constructor(
    private readonly stands: QaStandsService,
    private readonly generator: QaStandsGenerator,
  ) {}
  @Get() @RequireProductRoles(QA_READ) list(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Query('before') before?: string,
  ) {
    return this.stands.list(m, site, before);
  }
  @Get(':id')
  @RequireProductRoles(QA_READ)
  async get(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return (await this.stands.get(m, site, id)).row;
  }
  @Delete(':id')
  @RequireProductRoles(QA_WRITE)
  async remove(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    const { db } = await this.stands.get(m, site, id, true);
    await db.qaStand.deleteMany({
      where: { id, accountId: m.accountId, siteId: site },
    });
    return { deleted: true };
  }
  @Post('generate')
  @RequireProductRoles(QA_WRITE)
  generate(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.generator.generate(m, site, body);
  }
  @Post('voice')
  @RequireProductRoles(QA_WRITE)
  voice(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() body: unknown,
  ) {
    return this.generator.transcribe(m, site, body);
  }
  @Post('plan') @RequireProductRoles(QA_WRITE) plan(@Body() input: unknown) {
    return planStand(input);
  }
  @Post() @RequireProductRoles(QA_WRITE) create(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Body() input: unknown,
  ) {
    return this.stands.create(m, site, input);
  }
  @Get(':id/mock/records')
  @RequireProductRoles(QA_READ)
  async readRecords(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('q') query: string,
    @Query('entity') entityId: string,
    @Query('scenario') scenario: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.stands.command(m, site, id, {
      method: 'GET',
      entityId,
      role: 'viewer',
      query,
      scenario: scenario || 'normal',
    });
    res.status(result.status);
    return result.data;
  }
  @Post(':id/mock/records')
  @RequireProductRoles(QA_WRITE)
  async createRecord(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() input: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = input as {
      role?: string;
      entityId?: string;
      values?: unknown;
      scenario?: string;
    };
    const result = await this.stands.command(m, site, id, {
      method: 'POST',
      entityId: body?.entityId,
      role: body?.role || 'editor',
      values: body?.values,
      scenario: body?.scenario || 'normal',
    });
    res.status(result.status);
    return result.data;
  }
  @Delete(':id/mock/records/:recordId')
  @RequireProductRoles(QA_WRITE)
  async deleteRecord(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Param('recordId') recordId: string,
    @Query('role') role: string,
    @Query('entity') entityId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.stands.command(m, site, id, {
      method: 'DELETE',
      entityId,
      role: role || 'admin',
      id: recordId,
    });
    res.status(result.status);
    return result.data;
  }
  @Patch(':id/mock/records/:recordId')
  @RequireProductRoles(QA_WRITE)
  async updateRecord(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Param('recordId') recordId: string,
    @Body()
    body: {
      entityId?: string;
      role?: string;
      values?: unknown;
      expectedVersion?: number;
    },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.stands.command(m, site, id, {
      ...body,
      method: 'PATCH',
      id: recordId,
    });
    res.status(result.status);
    return result.data;
  }
  @Post(':id/mock/records/:recordId/transitions/:transitionId')
  @RequireProductRoles(QA_WRITE)
  async transitionRecord(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Param('recordId') recordId: string,
    @Param('transitionId') transitionId: string,
    @Body()
    body: { entityId?: string; role?: string; expectedVersion?: number },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.stands.command(m, site, id, {
      ...body,
      method: 'TRANSITION',
      id: recordId,
      transitionId,
    });
    res.status(result.status);
    return result.data;
  }
  @Post(':id/check') @RequireProductRoles(QA_READ) async check(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    const { row } = await this.stands.get(m, site, id);
    return checkStand(row.contract as unknown as StandContract);
  }
  @Get(':id/mock')
  @RequireProductRoles(QA_READ)
  readMock(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Query('entity') entityId: string,
    @Query('q') query: string,
    @Query('scenario') scenario: string,
  ) {
    return this.stands.command(m, site, id, {
      method: 'GET',
      role: 'viewer',
      entityId,
      query,
      scenario: scenario || 'normal',
    });
  }
  @Post(':id/mock') @RequireProductRoles(QA_WRITE) command(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.stands.command(m, site, id, input);
  }
  @Post(':id/bridge/compare') @RequireProductRoles(QA_WRITE) compareForm(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    return this.stands.compareForm(m, site, id, input);
  }
  @Post(':id/reset') @RequireProductRoles(QA_WRITE) reset(
    @Membership() m: AccountMembership,
    @Param('siteId') site: string,
    @Param('id') id: string,
  ) {
    return this.stands.command(m, site, id, {}, true);
  }
}
@Module({
  imports: [SiteCoreModule, QaCatalogModule, SiteAiModule],
  controllers: [QaStandsController],
  providers: [QaStandsService, QaStandsGenerator, SiteSonioxStt],
})
export class QaStandsModule {}
