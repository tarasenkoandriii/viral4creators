import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  NotEquals,
} from 'class-validator';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService, WorkflowWindow } from './admin-panel.service';
import { AdminUsersService } from './admin-users.service';
import { AdminBillingService } from './admin-billing.service';
import { AdminMarketingService } from './admin-marketing.service';
import { AdminCatalogBatchService } from './admin-catalog-batch.service';
import { AdminAbTestService } from './admin-ab-test.service';
import { AdminFeedImportService } from './admin-feed-import.service';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';
import { VOICEOVER_PROVIDER_KEYS } from '../tts/default-tts-provider';
import { PlanId, PLAN_IDS } from '../../common/plans';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { pricingTable, PRICING_VERSION } from '../../common/ai-pricing';

export class PatchAdminUserDto {
  @IsOptional()
  @IsIn(PLAN_IDS as unknown as string[])
  plan?: PlanId;

  @IsOptional()
  @IsBoolean()
  isOperator?: boolean;

  @IsOptional()
  @IsBoolean()
  isBlocked?: boolean;

  /** Причина попадает в текст отказа пользователю — потому и ограничена. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  blockedReason?: string;
}

/** Е-1.5 шестого аудита — ручная правка баланса кредитов. Целое, не
 * ноль: положительное — компенсация, отрицательное — списание/исправление
 * ошибочного начисления. */
export class AdjustCreditDto {
  @IsInt()
  @NotEquals(0)
  delta!: number;
}

/** Доп. запрос владельца продукта: ручной селектор «Озвучка по
 * умолчанию» — три допустимых значения, см.
 * `../tts/default-tts-provider.ts`. */
export class SetVoiceoverProviderDto {
  @IsIn(VOICEOVER_PROVIDER_KEYS as unknown as string[])
  provider!: string;
}

const WORKFLOW_WINDOWS: WorkflowWindow[] = ['hour', 'day', 'week', 'month'];

/** Этап 78 — невалидный/отсутствующий `?window=` тихо откатывается на
 * `day` (тот же уровень строгости, что у `page`/`pageSize` выше —
 * список сессий тоже не бросает 400 на мусорный `page`), а не 400: это
 * аналитический экран для оператора, не форма с пользовательским вводом. */
function parseWorkflowWindow(value?: string): WorkflowWindow {
  return WORKFLOW_WINDOWS.includes(value as WorkflowWindow)
    ? (value as WorkflowWindow)
    : 'day';
}

/**
 * AdminPanelController
 *
 * `admin/sessions*`, `admin/telemetry` и `admin/settings` — MVP-объём
 * админки (см. doc/TELEGRAM-ADMIN.md). Все маршруты требуют валидную admin-сессию
 * (AdminSessionGuard) И isOperator (assertOperator внутри сервиса) —
 * две раздельные проверки: любой Telegram-пользователь может залогиниться
 * в /admin (см. AdminAuthController), но только оператор видит данные.
 */
@Controller('admin')
@UseGuards(AdminSessionGuard)
export class AdminPanelController {
  constructor(
    private readonly adminPanel: AdminPanelService,
    private readonly users: AdminUsersService,
    private readonly aiUsage: AiUsageService,
    private readonly billing: AdminBillingService,
    private readonly marketing: AdminMarketingService,
    private readonly catalogBatch: AdminCatalogBatchService,
    private readonly abTest: AdminAbTestService,
    private readonly feedImport: AdminFeedImportService,
    private readonly voiceoverSettings: AdminVoiceoverSettingsService,
  ) {}

  @Get('sessions')
  async listSessions(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.listSessions({
      status,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Get('sessions/:id')
  async getSession(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.getSession(id);
  }

  @Delete('sessions/:id')
  async deleteSession(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.deleteSession(id);
  }

  @Get('telemetry')
  async telemetry(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.getTelemetry();
  }

  /**
   * GET /admin/settings — статус переменных окружения бэкенда: задана
   * ли, и, если задана, похожа ли на корректное значение (не только
   * "пусто/не пусто" — см. env-settings.ts). Секретные значения
   * (ключи, токены, строки подключения к БД) в ответе никогда не
   * присутствуют, только булевы/текстовые вердикты.
   */
  @Get('settings')
  async settings(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.getEnvSettings();
  }

  /**
   * «Озвучка по умолчанию» — доп. запрос владельца продукта: ручной
   * селектор elevenlabs/resemble/veo на той же вкладке «Настройки»,
   * рядом со статусом переменных окружения выше. В отличие от
   * `GET /admin/settings`, это не диагностика, а РЕДАКТИРУЕМАЯ
   * настройка: `PATCH` меняет активного провайдера немедленно, без
   * передеплоя (см. `PlatformSettingsService`/
   * `TtsProviderResolverService`).
   */
  @Get('settings/voiceover-provider')
  async getVoiceoverProvider(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.voiceoverSettings.get();
  }

  @Patch('settings/voiceover-provider')
  async setVoiceoverProvider(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetVoiceoverProviderDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.voiceoverSettings.setDefault(dto.provider, req.userId);
  }

  // ── Воронка движения по воркфлоу (этап 78, doc/WORKFLOW-FUNNEL-SPEC.md,
  // doc/WORKFLOW-FUNNEL-COHORT-CONVERSION-SPEC.md) ─────────────────────

  @Get('workflow-funnel')
  async workflowFunnel(
    @Req() req: AdminAuthenticatedRequest,
    @Query('window') window?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.getWorkflowFunnel(parseWorkflowWindow(window));
  }

  @Get('workflow-funnel/cohort-conversion')
  async workflowFunnelCohortConversion(
    @Req() req: AdminAuthenticatedRequest,
    @Query('window') window?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.getWorkflowCohortConversion(
      parseWorkflowWindow(window),
    );
  }

  // ── Пользователи (ТЗ §25, этап 30) ───────────────────────────────────

  @Get('users')
  async listUsers(
    @Req() req: AdminAuthenticatedRequest,
    @Query('q') q?: string,
    @Query('plan') plan?: string,
    @Query('operators') operators?: string,
    @Query('blocked') blocked?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.users.list({
      q,
      plan,
      operatorsOnly: operators === '1' || operators === 'true',
      blockedOnly: blocked === '1' || blocked === 'true',
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  @Get('users/:id')
  async getUser(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.users.get(id);
  }

  /**
   * PATCH /admin/users/:id — режим и флаг оператора. `req.userId`
   * передаётся в сервис не для проверки прав (она уже сделана выше), а
   * ради одного правила: снять оператора с самого себя нельзя.
   */
  @Patch('users/:id')
  async patchUser(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: PatchAdminUserDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.users.patch(req.userId, id, dto);
  }

  /**
   * POST /admin/users/:id/cancel-subscription — отмена подписки как
   * саппорт-действие (ТЗ §41, этап 62). Без возврата денег — доступ
   * остаётся до конца уже оплаченного периода, дальше решает крон
   * продления (`billing-renewal`).
   */
  @Post('users/:id/cancel-subscription')
  async cancelUserSubscription(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.users.cancelSubscription(req.userId, id);
    return this.users.get(id);
  }

  /**
   * POST /admin/users/:id/credit-adjust — Е-1.5 шестого аудита.
   * `CreditLedgerService.adminAdjust()` был реализован с этапа 62, но не
   * вызывался ниоткуда — оператор структурно не мог вручную поправить
   * баланс. Тот же формат ответа, что у остальных действий над
   * пользователем (свежая карточка целиком), — фронту не нужен отдельный
   * тип ответа для одного поля.
   */
  @Post('users/:id/credit-adjust')
  async adjustUserCredit(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AdjustCreditDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.users.adjustCredit(req.userId, id, dto.delta);
    return this.users.get(id);
  }

  // ── Расходы (ТЗ §26, этап 31) ────────────────────────────────────────

  /**
   * GET /admin/costs — интегральные показатели расхода и топ по тратам.
   * Прайс отдаётся вместе с цифрами намеренно: сумма без ставок, по
   * которым она посчитана, — это число без единиц измерения.
   */
  @Get('costs')
  async costs(
    @Req() req: AdminAuthenticatedRequest,
    @Query('top') top?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const report = await this.aiUsage.report(
      Math.min(Math.max(parseInt(top ?? '10', 10) || 10, 1), 100),
    );
    return {
      ...report,
      currentPricingVersion: PRICING_VERSION,
      pricing: pricingTable(),
    };
  }

  // ── Оплата (ТЗ §41, этап 62) ─────────────────────────────────────────

  @Get('payments')
  async listPayments(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('method') method?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.billing.listPayments({
      status,
      method,
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  /**
   * POST /admin/payments/:id/refund — возврат. У Stars реальный API
   * (`refundStarPayment`), у WayForPay в этом этапе только пометка
   * REFUNDED (см. `AdminBillingService.refund` — деньги возвращаются
   * оператором вручную в личном кабинете WayForPay).
   */
  @Post('payments/:id/refund')
  async refundPayment(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.billing.refund(req.userId, id);
  }

  // ── Рекламный канал (ТЗ §42, этап 63) ────────────────────────────────

  /**
   * GET /admin/marketing/broadcasts — история выпусков рассылки со
   * сводкой доставки по каждому и текущим числом подписчиков. Read-only:
   * отбор контента для выпуска автоматический, оператору здесь нечего
   * нажимать (см. AdminMarketingService).
   */
  @Get('marketing/broadcasts')
  async listMarketingBroadcasts(
    @Req() req: AdminAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.marketing.listBroadcasts({
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // ── Пакетная генерация по каталогу (ТЗ §44, этап 65) ──────────────────

  /**
   * GET /admin/catalog-batches — история партий пакетной генерации со
   * сводкой статусов по каждой. Read-only: партия либо идёт, либо
   * завершилась, вмешиваться оператору нечем (см. AdminCatalogBatchService).
   */
  @Get('catalog-batches')
  async listCatalogBatches(
    @Req() req: AdminAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.catalogBatch.listBatches({
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // ── A/B-варианты одного ролика (TODO §III.6, этап 66) ─────────────────

  /**
   * GET /admin/ab-tests — история запусков A/B-вариантов со сводкой
   * статусов по каждому. Read-only: запуск либо идёт, либо завершился,
   * вмешиваться оператору нечем (см. AdminAbTestService).
   */
  @Get('ab-tests')
  async listAbTests(
    @Req() req: AdminAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.abTest.listRuns({
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }

  // ── Импорт товарного фида по ссылке (TODO §Уровень 2 п.8, этап 68) ────

  /**
   * GET /admin/feed-imports — история запусков импорта товарного фида со
   * сводкой статусов по каждому. Read-only: запуск либо идёт, либо
   * завершился, вмешиваться оператору нечем (см. AdminFeedImportService).
   */
  @Get('feed-imports')
  async listFeedImports(
    @Req() req: AdminAuthenticatedRequest,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.feedImport.listRuns({
      page: Math.max(parseInt(page ?? '1', 10) || 1, 1),
      pageSize: Math.min(
        Math.max(parseInt(pageSize ?? '20', 10) || 20, 1),
        100,
      ),
    });
  }
}
