/**
 * AI Publisher — маршруты P-E (проектный документ §11.3 «P-E — отчёты,
 * эксперименты, труд, интеграции, бэкап»; контракт
 * `contracts/reports-api.ts`). Мутации — `runOperation` (`opKey`,
 * идемпотентность, аудит в той же транзакции); сеть (Blob копий) — ВНЕ
 * транзакции операции (§8.1); перенос восстановления — своей длинной
 * транзакцией после короткой операции `start` (контракт P-A0).
 */
import {
  Body,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { SitesDb } from '../../../prisma/sites-db.service';
import type {
  BackupView,
  ExperimentView,
  IntegrationView,
  MetricImportView,
  ReportView,
  RestoreView,
  TimeEntryView,
} from '../contracts/reports-api';
import { PubError, validationError } from '../core/errors';
import { PubOperations } from '../core/operation';
import { actorsOf } from '../core/product.controller';
import {
  PubAllow,
  PubCabinetController,
  PubRequest,
  type PubRequestCtx,
} from '../core/pub-role.guard';
import { can, type PubAction } from '../core/roles';
import type { ObjectType } from '../contracts/states';
import { csvOf, formatOf, sendCsv, sendEnvelope } from './csv';
import { BackupService, backupView } from './backup.service';
import { ExperimentsService } from './experiments.service';
import {
  IntegrationsService,
  MetricImportsService,
  metricImportView,
} from './integrations.service';
import { experimentConclusionAllowed } from './metrics/economics';
import { computeReport, type FrozenThresholds } from './metrics/report-compute';
import { ReportsService, reportView } from './reports.service';
import { RestoreService, restoreView } from './restore.service';
import { TimeEntriesService, timeEntryView } from './time-entries.service';
import { cohortWindowClosed } from './metrics/cohorts';

type Body = Record<string, unknown>;

function bodyOf(v: unknown): Body {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw validationError([{ field: '$', code: 'type' }]);
  }
  return v as Body;
}

function product(ctx: PubRequestCtx) {
  if (!ctx.product) throw new PubError('PUB_NOT_FOUND');
  return ctx.product;
}

@PubCabinetController()
export class PublisherReportsController {
  constructor(
    private readonly db: SitesDb,
    private readonly ops: PubOperations,
    private readonly time: TimeEntriesService,
    private readonly imports: MetricImportsService,
    private readonly integrations: IntegrationsService,
    private readonly experiments: ExperimentsService,
    private readonly reports: ReportsService,
    private readonly backup: BackupService,
    private readonly restore: RestoreService,
  ) {}

  private tenant(ctx: PubRequestCtx) {
    return this.db.forAccount(ctx.m.accountId);
  }

  /** Аудит выгрузки CSV (§11.1) — короткой транзакцией, до отдачи файла. */
  private exported(
    ctx: PubRequestCtx,
    action: PubAction,
    objectType: ObjectType,
    rows: number,
  ): Promise<void> {
    const p = product(ctx);
    return this.ops.recordRead(ctx.m, ctx.access, p, action, {
      objectType,
      objectId: p.id,
      action: 'export',
      meta: { format: 'csv', rows },
    });
  }

  // ── Труд ────────────────────────────────────────────────────────────────

  @Get('products/:pid/time-entries')
  @PubAllow('time.own', 'time.others')
  async listTime(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const p = product(ctx);
    const csv = formatOf(q.format) === 'csv';
    const page = await this.time.list(this.tenant(ctx), p, ctx.access, {
      ...q,
      ...(csv ? { limit: 100 } : {}),
    });
    if (!csv) return sendEnvelope(res, page);
    await this.exported(ctx, 'time.own', 'time_entry', page.items.length);
    sendCsv(
      res,
      'time-entries',
      csvOf(page.items as unknown as Array<Record<string, unknown>>, [
        'id',
        'memberId',
        'role',
        'workDate',
        'minutes',
        'category',
        'isInvestment',
        'rateMinorPerHour',
        'featureId',
        'contentId',
        'createdAt',
      ]),
    );
  }

  @Post('products/:pid/time-entries')
  @PubAllow('time.own', 'time.others')
  async createTime(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<TimeEntryView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'time.own',
        opKey: body.opKey,
        scope: 'time.create',
        pathParams: { pid: p.id },
        body,
        // В записи есть `task` (ключ из списка ПД ответа) — в ключе только hash и id.
        storeResponse: false,
        refOf: (v) => ({ id: v.id }),
        rebuild: async (tx, ref) =>
          timeEntryView(await this.oneTime(tx, String(ref?.id))),
      },
      async (tx, step) => {
        const out = await this.time.create(tx, p, ctx.access, body, step.actor);
        return { status: 201, body: timeEntryView(out.row), audit: out.audit };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Patch('products/:pid/time-entries/:id')
  @PubAllow('time.own', 'time.others')
  async patchTime(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<TimeEntryView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'time.own',
        opKey: body.opKey,
        scope: 'time.patch',
        pathParams: { pid: p.id, id },
        body,
        storeResponse: false,
        refOf: (v) => ({ id: v.id }),
        rebuild: async (tx, ref) =>
          timeEntryView(await this.oneTime(tx, String(ref?.id))),
      },
      async (tx) => {
        const out = await this.time.patch(tx, p, ctx.access, id, body);
        return { status: 200, body: timeEntryView(out.row), audit: out.audit };
      },
    );
    return r.body;
  }

  private async oneTime(
    tx: Parameters<Parameters<PubOperations['run']>[1]>[0],
    id: string,
  ) {
    const row = await tx.pubTimeEntry.findFirst({ where: { id } });
    if (!row) throw new PubError('PUB_NOT_FOUND');
    return row;
  }

  // ── Импорт метрик и интеграции ──────────────────────────────────────────

  @Get('products/:pid/metric-imports')
  @PubAllow('metrics.import')
  async listImports(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const csv = formatOf(q.format) === 'csv';
    const page = await this.imports.list(this.tenant(ctx), product(ctx), q);
    if (!csv) return sendEnvelope(res, page);
    await this.exported(
      ctx,
      'metrics.import',
      'metric_import',
      page.items.length,
    );
    sendCsv(
      res,
      'metric-imports',
      csvOf(page.items as unknown as Array<Record<string, unknown>>, [
        'id',
        'source',
        'periodStart',
        'periodEnd',
        'days',
        'importedBy',
        'importedAt',
        'fileRef',
      ]),
    );
  }

  @Post('products/:pid/metric-imports')
  @PubAllow('metrics.import')
  async createImport(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<MetricImportView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'metrics.import',
        opKey: body.opKey,
        scope: 'metrics.import',
        pathParams: { pid: p.id },
        body,
      },
      async (tx, step) => {
        const out = await this.imports.create(
          tx,
          p,
          body,
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: metricImportView(out.row),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('products/:pid/integrations')
  @PubAllow('metrics.import')
  async listIntegrations(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const csv = formatOf(q.format) === 'csv';
    const items = await this.integrations.list(
      this.tenant(ctx),
      product(ctx),
      new Date(),
    );
    if (!csv) return sendEnvelope(res, { items });
    await this.exported(ctx, 'metrics.import', 'integration', items.length);
    sendCsv(
      res,
      'integrations',
      csvOf(items as unknown as Array<Record<string, unknown>>, [
        'kind',
        'exists',
        'status',
        'stale',
        'manual',
        'lastSuccessAt',
        'lastCheckedAt',
        'staleAfterHours',
      ]),
    );
  }

  @Put('products/:pid/integrations/:kind')
  @PubAllow('metrics.import')
  async putIntegration(
    @PubRequest() ctx: PubRequestCtx,
    @Param('kind') kind: string,
    @Body() raw: unknown,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<IntegrationView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'metrics.import',
        opKey: body.opKey,
        scope: 'integration.put',
        pathParams: { pid: p.id, kind },
        body,
      },
      async (tx, step) => {
        const out = await this.integrations.put(
          tx,
          p,
          kind,
          body,
          actorsOf(ctx.access),
          step.actor,
          step.now,
        );
        return {
          status: 200,
          body: await this.integrations.one(tx, p, out.kind, step.now),
          audit: out.audit,
        };
      },
    );
    return r.body;
  }

  // ── Эксперименты F17 ────────────────────────────────────────────────────

  @Get('products/:pid/experiments')
  @PubAllow('product.read')
  async listExperiments(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const csv = formatOf(q.format) === 'csv';
    const items = await this.experiments.list(this.tenant(ctx), product(ctx));
    if (!csv) return sendEnvelope(res, { items });
    await this.exported(ctx, 'product.read', 'experiment', items.length);
    sendCsv(
      res,
      'experiments',
      csvOf(items as unknown as Array<Record<string, unknown>>, [
        'id',
        'key',
        'version',
        'kind',
        'status',
        'hypothesis',
        'metric',
        'windowStart',
        'windowEnd',
        'limitMinor',
        't0',
        't42',
        't72',
        't90',
        'conclusion',
        'decision',
        'decidedAt',
        'supersedesId',
      ]),
    );
  }

  @Post('products/:pid/experiments')
  @PubAllow('experiment.register')
  async registerExperiment(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ExperimentView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'experiment.register',
        opKey: body.opKey,
        scope: 'experiment.register',
        pathParams: { pid: p.id },
        body,
      },
      async (tx, step) => {
        const out = await this.experiments.register(
          tx,
          p,
          body,
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: await this.experiments.view(tx, out.row),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/experiments/:id/version')
  @PubAllow('experiment.register')
  async newVersion(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ExperimentView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'experiment.register',
        opKey: body.opKey,
        scope: 'experiment.version',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const out = await this.experiments.newVersion(
          tx,
          p,
          id,
          body,
          actorsOf(ctx.access),
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: await this.experiments.view(tx, out.row),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/experiments/:id/apply')
  @HttpCode(200)
  @PubAllow('experiment.register')
  async applyExperiment(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ExperimentView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'experiment.register',
        opKey: body.opKey,
        scope: 'experiment.apply',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const out = await this.experiments.apply(
          tx,
          p,
          id,
          actorsOf(ctx.access),
          step.now,
        );
        return {
          status: 200,
          body: await this.experiments.view(tx, out.row),
          audit: out.audit,
        };
      },
    );
    return r.body;
  }

  @Post('products/:pid/experiments/:id/conclude')
  @HttpCode(200)
  @PubAllow('experiment.conclude')
  async concludeExperiment(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ExperimentView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'experiment.conclude',
        opKey: body.opKey,
        scope: 'experiment.conclude',
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        const row = await this.experiments.get(tx, p, id);
        // Пилот судится порогами версии на t0 (новая версия после старта их
        // не меняет, аудит P-E S1-1); изменение — своими (зарегистрированы до
        // его окна).
        const canon =
          row.kind === 'pilot' ? await this.reports.pilotAtT0(tx, p) : row;
        const th = (canon ?? row).thresholds as unknown as FrozenThresholds;
        // Свежий расчёт выборки: пилот — когорта [t0, t42) с закрытием
        // max(t72, t42 + 30 дней); изменение — окно эксперимента с закрытием
        // через 30 дней после конца (одно правило с отчётом, S3-4).
        const pilot = row.kind === 'pilot' && row.t0 && row.t42 && row.t72;
        const inputs = await this.reports.buildInputs(tx, p, {
          kind: pilot ? 'd72' : 'ad_hoc',
          periodStart: pilot ? (row.t0 as Date) : row.windowStart,
          periodEnd: pilot ? (row.t42 as Date) : row.windowEnd,
          snapshotAt: step.now,
          experiment: row,
        });
        const c = computeReport(inputs);
        const leads = (c.metrics as { leads: { qualifiedUnique: number } })
          .leads;
        const windowClosed = pilot
          ? cohortWindowClosed(row.t42 as Date, step.now, row.t72)
          : cohortWindowClosed(row.windowEnd, step.now);
        const minSample =
          th?.d42?.minSampleForConclusion ?? Number.MAX_SAFE_INTEGER;
        const allowed = experimentConclusionAllowed({
          windowClosed,
          qualifiedUnique: leads.qualifiedUnique,
          minSample,
        });
        const out = await this.experiments.conclude(
          tx,
          p,
          row,
          body,
          {
            allowed,
            windowClosed,
            qualifiedUnique: leads.qualifiedUnique,
            minSample,
          },
          actorsOf(ctx.access),
          step.actor,
          step.now,
        );
        return {
          status: 200,
          body: await this.experiments.view(tx, out.row),
          audit: out.audit,
        };
      },
    );
    return r.body;
  }

  // ── Отчёты ──────────────────────────────────────────────────────────────

  @Post('products/:pid/reports')
  @PubAllow('report.manage')
  async createReport(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ReportView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'report.manage',
        opKey: body.opKey,
        scope: 'report.create',
        pathParams: { pid: p.id },
        body,
        // Снимок большой и неизменяемый: в ключе — только id, повтор читает строку.
        storeResponse: false,
        refOf: (v) => ({ id: v.id }),
        rebuild: async (tx, ref) => {
          const row = await this.reports.get(tx, p, String(ref?.id));
          return reportView(
            row,
            await this.reports.isSuperseded(tx, p, row.id),
          );
        },
      },
      async (tx, step) => {
        const out = await this.reports.create(
          tx,
          p,
          body,
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: reportView(out.row, false),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('products/:pid/reports')
  @PubAllow('product.read')
  async listReports(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const csv = formatOf(q.format) === 'csv';
    const page = await this.reports.list(this.tenant(ctx), product(ctx), q);
    if (!csv) return sendEnvelope(res, page);
    await this.exported(ctx, 'product.read', 'report', page.items.length);
    sendCsv(
      res,
      'reports',
      csvOf(page.items as unknown as Array<Record<string, unknown>>, [
        'id',
        'kind',
        'periodStart',
        'periodEnd',
        'snapshotAt',
        'experimentId',
        'inputsHash',
        'supersedesReportId',
        'recomputeReason',
        'decision',
        'superseded',
        'createdAt',
      ]),
    );
  }

  @Get('products/:pid/reports/:id')
  @PubAllow('product.read')
  async getReport(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    const tx = this.tenant(ctx);
    const p = product(ctx);
    const row = await this.reports.get(tx, p, id);
    return reportView(row, await this.reports.isSuperseded(tx, p, row.id));
  }

  @Post('products/:pid/reports/:id/decision')
  @PubAllow('report.manage')
  async reportDecision(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ReportView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'report.manage',
        opKey: body.opKey,
        scope: 'report.decision',
        pathParams: { pid: p.id, id },
        body,
        storeResponse: false,
        refOf: (v) => ({ id: v.id }),
        rebuild: async (tx, ref) =>
          reportView(await this.reports.get(tx, p, String(ref?.id)), false),
      },
      async (tx, step) => {
        const prev = await this.reports.get(tx, p, id);
        const out = await this.reports.decide(
          tx,
          p,
          prev,
          body.decision,
          step.actor,
        );
        return {
          status: 201,
          body: reportView(out.row, false),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/reports/:id/recompute')
  @PubAllow('report.manage')
  async recomputeReport(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const r = await this.ops.run<ReportView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'report.manage',
        opKey: body.opKey,
        scope: 'report.recompute',
        pathParams: { pid: p.id, id },
        body,
        storeResponse: false,
        refOf: (v) => ({ id: v.id }),
        rebuild: async (tx, ref) =>
          reportView(await this.reports.get(tx, p, String(ref?.id)), false),
      },
      async (tx, step) => {
        // Причины late_decision|late_payment|identity_change ставит только
        // задание `report-staleness` по найденным изменениям; человек
        // пересчитывает «вручную» (аудит P-E S3-10).
        if (body.reason !== undefined && body.reason !== 'manual')
          throw validationError([{ field: 'reason', code: 'system_only' }]);
        const prev = await this.reports.get(tx, p, id);
        const out = await this.reports.recompute(
          tx,
          p,
          prev,
          'manual',
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: reportView(out.row, false),
          audit: out.audit,
        };
      },
    );
    res.status(r.status);
    return r.body;
  }

  @Get('products/:pid/economics/preview')
  @PubAllow('report.manage')
  preview(@PubRequest() ctx: PubRequestCtx) {
    return this.reports.preview(this.tenant(ctx), product(ctx), new Date());
  }

  // ── Копии и восстановление ──────────────────────────────────────────────

  @Get('products/:pid/backups')
  @PubAllow('backup.manage')
  async listBackups(
    @PubRequest() ctx: PubRequestCtx,
    @Query() q: Record<string, unknown>,
    @Res() res: Response,
  ) {
    const csv = formatOf(q.format) === 'csv';
    const rows = await this.tenant(ctx).pubBackup.findMany({
      where: { productId: product(ctx).id },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
    });
    const items = rows.map(backupView);
    if (!csv) return sendEnvelope(res, { items });
    await this.exported(ctx, 'backup.manage', 'backup', items.length);
    sendCsv(
      res,
      'backups',
      csvOf(items as unknown as Array<Record<string, unknown>>, [
        'id',
        'kind',
        'status',
        'sha256',
        'sizeBytes',
        'keyVersion',
        'rotationUntil',
        'createdAt',
        'createdBy',
      ]),
    );
  }

  @Post('products/:pid/backups')
  @PubAllow('backup.manage')
  async createBackup(
    @PubRequest() ctx: PubRequestCtx,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    if (body.kind !== 'manual')
      throw validationError([{ field: 'kind', code: 'enum' }]);
    if (this.backup.disabled())
      throw new PubError('PUB_NOT_IMPLEMENTED', { reason: 'backup_disabled' });
    if (!can(ctx.access, 'backup.manage'))
      throw new PubError('PUB_ROLE_REQUIRED', { action: 'backup.manage' });
    // Экспорт и запись в хранилище — до транзакции операции (сеть вне транзакции, §8.1).
    const prepared = await this.backup.prepare(p, new Date());
    const r = await this.ops.run<BackupView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action: 'backup.manage',
        opKey: body.opKey,
        scope: 'backup.create',
        pathParams: { pid: p.id },
        body,
      },
      async (tx, step) => {
        const out = await this.backup.insertRow(
          tx,
          p,
          prepared,
          'manual',
          step.actor,
          step.now,
        );
        return { status: 201, body: backupView(out.row), audit: out.audit };
      },
    );
    // Повтор с тем же opKey: ответ прежний, только что записанный blob — сирота.
    if (r.replayed) await this.backup.discard(prepared);
    res.status(r.status);
    return r.body;
  }

  @Post('products/:pid/backups/:id/restore')
  @PubAllow('restore.dry_run', 'restore.apply')
  async restoreBackup(
    @PubRequest() ctx: PubRequestCtx,
    @Param('id') id: string,
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const body = bodyOf(raw);
    const p = product(ctx);
    const mode = body.mode;
    if (mode !== 'dry_run' && mode !== 'apply_new_product')
      throw validationError([{ field: 'mode', code: 'enum' }]);
    const action = mode === 'dry_run' ? 'restore.dry_run' : 'restore.apply';
    if (!can(ctx.access, action))
      throw new PubError('PUB_ROLE_REQUIRED', { action });
    const row = /^[A-Za-z0-9_-]{1,64}$/.test(id)
      ? await this.tenant(ctx).pubBackup.findFirst({
          where: { id, productId: p.id },
        })
      : null;
    if (!row) throw new PubError('PUB_NOT_FOUND');
    // Скачать, проверить sha256 и расшифровать — вне транзакции.
    const doc = await this.backup.load(row);
    const r = await this.ops.run<RestoreView>(
      {
        m: ctx.m,
        access: ctx.access,
        product: p,
        action,
        opKey: body.opKey,
        scope: action,
        pathParams: { pid: p.id, id },
        body,
      },
      async (tx, step) => {
        if (mode === 'dry_run') {
          const lists = await this.restore.currentLists(tx, p);
          const report = await this.restore.dryRunReport(doc, row, lists);
          const out = await this.restore.recordDryRun(
            tx,
            p,
            row,
            report,
            step.actor,
          );
          return {
            status: 201,
            body: restoreView(out.restore),
            audit: out.audit,
          };
        }
        const out = await this.restore.start(
          tx,
          p,
          row,
          body.targetSiteId,
          step.actor,
          step.now,
        );
        return {
          status: 201,
          body: restoreView(out.restore),
          audit: out.audit,
        };
      },
    );
    let view = r.body;
    if (mode === 'apply_new_product') {
      const cur = await this.restore.get(this.tenant(ctx), p, view.id);
      if (cur.status === 'running')
        view = restoreView(
          await this.restore.transfer(ctx.m.accountId, cur.id, doc),
        );
      else view = restoreView(cur);
    }
    res.status(r.status);
    return view;
  }

  @Get('products/:pid/restores/:id')
  @PubAllow('backup.manage', 'restore.apply')
  async getRestore(@PubRequest() ctx: PubRequestCtx, @Param('id') id: string) {
    return restoreView(
      await this.restore.get(this.tenant(ctx), product(ctx), id),
    );
  }
}
