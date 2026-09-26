import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  NotEquals,
} from 'class-validator';
import {
  AdminSessionGuard,
  AdminAuthenticatedRequest,
} from '../admin-auth/admin-session.guard';
import { AdminPanelService, WorkflowWindow } from './admin-panel.service';
import {
  AdminReferralsService,
  type ReferralsWindow,
} from './admin-referrals.service';
import { LiteUnlockService } from '../invite/lite-unlock.service';
import { AdminUsersService } from './admin-users.service';
import { AdminBillingService } from './admin-billing.service';
import { AdminMarketingService } from './admin-marketing.service';
import { AdminCatalogBatchService } from './admin-catalog-batch.service';
import { AdminAbTestService } from './admin-ab-test.service';
import { AdminFeedImportService } from './admin-feed-import.service';
import { AdminVoiceoverSettingsService } from './admin-voiceover-settings.service';
import { AdminMusicCatalogService } from './admin-music-catalog.service';
import { ProviderBalancesService } from './provider-balances.service';
import { AdminWizardGuideService } from '../wizard-guide/admin-wizard-guide.service';
import { WizardTelemetryService } from '../wizard-guide/wizard-telemetry.service';
import { AdminExperienceService } from '../wizard-guide/admin-experience.service';
import { SiblingsService } from '../wizard-guide/siblings.service';
import { SUPPORTED_LOCALES } from '../../common/locale';
import { VOICEOVER_PROVIDER_KEYS } from '../tts/default-tts-provider';
import { AdminAnalysisSettingsService } from './admin-analysis-settings.service';
import { ANALYSIS_PROVIDER_KEYS } from '../analysis/default-analysis-provider';
import { AdminVideoProviderSettingsService } from './admin-video-provider-settings.service';
import { VIDEO_PROVIDER_KEYS } from '../generation/default-video-provider';
import { AdminGrokTransportSettingsService } from './admin-grok-transport-settings.service';
import { GROK_VIDEO_TRANSPORT_KEYS } from '../generation/grok-video-transport';
import { PlanId, PLAN_IDS, isPlanId } from '../../common/plans';
import { isVoiceMode } from '../../common/voice-mode';
import {
  isSessionSortKey,
  isSortDirection,
} from '../../common/session-summary';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { pricingTable, PRICING_VERSION } from '../../common/ai-pricing';
import {
  AdminTesterInvitesService,
  TesterInviteView,
} from './admin-tester-invites.service';
import {
  AdminTestTicketsService,
  TesterProgressView,
  TicketDetailView,
  TicketRowView,
} from './admin-test-tickets.service';
import { TICKET_STATUSES } from '../../common/test-ticket';

/** `undefined` — не задан; `null` — задан, но мусор (не портит, а просто
 * не фильтрует по нему, тот же принцип терпимости, что у `page`/`pageSize`
 * ниже: аналитический экран оператора не бросает 400 на кривой query). */
function parseDateParam(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Причина обязательна у обоих действий этапа 135 — и у снятия
 * приглашения, и у отзыва разблокировки. Не формальность: «почему у
 * меня пропал доступ» должно иметь ответ в базе, а пустая строка ответом
 * не является. Поэтому `@IsNotEmpty` рядом с `@MaxLength` — второе без
 * первого пропускает `""`.
 */
export class RevokeWithReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  reason!: string;
}

/** Смена статуса находки (этап 158). */
export class PatchTicketStatusDto {
  @IsIn(TICKET_STATUSES as unknown as string[])
  status!: string;

  /**
   * Причина. Обязательность проверяет СЕРВИС, а не декоратор: она
   * зависит от статуса («отклонено» и «дубль» без неё нельзя), а
   * class-validator такое условие выражает хуже, чем одна строка кода.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

/** Ответ тестировщику в личку (этап 158). */
export class ReplyToTicketDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(3000)
  text!: string;
}

/** Приглашение тестировщика (этап 155). */
export class CreateTesterInviteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label!: string;

  @IsArray()
  @IsString({ each: true })
  freeScenarios!: string[];

  /** Операции вне проекта — своя галочка (этап 159, §4.1 ТЗ). */
  @IsOptional()
  @IsBoolean()
  freeOutsideProject?: boolean;

  /** Что проверять — текст брифа на экране `#/testing` (аудит 161). */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  brief?: string;

  /**
   * Свой суточный потолок в долларах; пусто — общий для тестовых.
   * Границы проверяет сервис: «ноль означает ноль» выражается там
   * понятнее, чем набором декораторов.
   */
  @IsOptional()
  @IsInt()
  dailyLimitUsd?: number;

  /** Дата или ISO-момент; пусто — бессрочно. */
  @IsOptional()
  @IsString()
  expiresAt?: string;
}

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

  /** Тестовый аккаунт (TODO §III п.37). */
  @IsOptional()
  @IsBoolean()
  isTestUser?: boolean;

  /**
   * Полный набор сценариев с бесплатным использованием — форма шлёт
   * его целиком, а не добавку: иначе снять галочку было бы нечем.
   * Значения проверяются в сервисе, где живёт их список.
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(16)
  freeScenarios?: string[];
}

/**
 * Настройки советника в мастере («Тонкая красная линия» §3.4, §5.8).
 *
 * Все поля необязательные: карточка правит их по одному, и сохранение
 * бюджета не должно заодно переписывать рубильник тем значением,
 * которое лежало на экране в момент загрузки.
 *
 * Верхние границы — не формальность. Бюджет задаётся в МИКРОдолларах, и
 * лишние три нуля в поле превращают $2 в $2000 молча; потолок делает
 * такую опечатку отказом, а не счётом.
 */
export class SetAiGuideDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  dailyBudgetMicroUsd?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  personalLimit?: number;
}

/** Текст совета на одном языке («Тонкая красная линия» §6.2). */
export class ExperienceTextDto {
  @IsString()
  @MaxLength(400)
  symptom!: string;

  @IsOptional()
  @IsString()
  @MaxLength(400)
  cause?: string;

  @IsString()
  @MaxLength(600)
  advice!: string;
}

export class PromoteCandidateDto extends ExperienceTextDto {}

export class AttachCandidateDto extends ExperienceTextDto {
  @IsString()
  experienceId!: string;
}

export class MergeCandidateDto {
  @IsString()
  experienceId!: string;
}

/** Пороги сведения дублей (§6.4). Доли, а не проценты. */
export class SiblingThresholdsDto {
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  auto?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  suggest?: number;
}

export class ExperienceStatusDto {
  @IsIn(['DRAFT', 'REJECTED'])
  status!: string;
}

/** Запись оператора без всякого сигнала — основной источник на старте. */
export class AdminCandidateDto {
  @IsString()
  @MaxLength(40)
  scenario!: string;

  @IsString()
  @MaxLength(40)
  stepId!: string;

  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale!: string;

  @IsString()
  @MaxLength(1000)
  rawText!: string;
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

/** Доп. запрос владельца продукта: тот же селектор, что выше, но для
 * модели разбора референса (ТЗ §17). */
/**
 * Каталог музыкальных тем поздравлений (фича №4). Строка, а не
 * структура: оператор редактирует JSON целиком, и разбирать его на
 * поля DTO значило бы потерять его же форматирование и комментарии
 * при первом сохранении.
 */
export class SetMusicCatalogDto {
  @IsString()
  @MaxLength(65536)
  raw!: string;
}

export class SetAnalysisProviderDto {
  @IsIn(ANALYSIS_PROVIDER_KEYS as unknown as string[])
  provider!: string;
}

/** Доп. запрос владельца продукта: провайдер видео-генерации по
 * умолчанию (ТЗ §11.1/§20 — закрывает недостающую админскую половину
 * решения, найденную при аудите). */
export class SetVideoProviderDto {
  @IsIn(VIDEO_PROVIDER_KEYS as unknown as string[])
  provider!: string;
}

export class SetGrokTransportDto {
  @IsIn(GROK_VIDEO_TRANSPORT_KEYS as unknown as string[])
  transport!: string;
}

const WORKFLOW_WINDOWS: WorkflowWindow[] = ['hour', 'day', 'week', 'month'];

/** У приглашений часового окна нет: засчёт — событие редкое по замыслу. */
const REFERRALS_WINDOWS: ReferralsWindow[] = ['day', 'week', 'month'];

function parseReferralsWindow(value?: string): ReferralsWindow {
  return REFERRALS_WINDOWS.includes(value as ReferralsWindow)
    ? (value as ReferralsWindow)
    : 'week';
}

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
    private readonly testerInvitesService: AdminTesterInvitesService,
    private readonly testTicketsService: AdminTestTicketsService,
    private readonly users: AdminUsersService,
    private readonly aiUsage: AiUsageService,
    private readonly billing: AdminBillingService,
    private readonly marketing: AdminMarketingService,
    private readonly catalogBatch: AdminCatalogBatchService,
    private readonly abTest: AdminAbTestService,
    private readonly feedImport: AdminFeedImportService,
    private readonly voiceoverSettings: AdminVoiceoverSettingsService,
    private readonly musicCatalog: AdminMusicCatalogService,
    private readonly balances: ProviderBalancesService,
    private readonly aiGuide: AdminWizardGuideService,
    private readonly wizardTelemetry: WizardTelemetryService,
    private readonly wizardExperience: AdminExperienceService,
    private readonly siblings: SiblingsService,
    private readonly analysisSettings: AdminAnalysisSettingsService,
    private readonly videoProviderSettings: AdminVideoProviderSettingsService,
    private readonly grokTransportSettings: AdminGrokTransportSettingsService,
    private readonly referrals: AdminReferralsService,
    private readonly liteUnlock: LiteUnlockService,
  ) {}

  @Get('sessions')
  async listSessions(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('quality') quality?: string,
    @Query('voiceMode') voiceMode?: string,
    @Query('plan') plan?: string,
    @Query('createdFrom') createdFrom?: string,
    @Query('createdTo') createdTo?: string,
    @Query('search') search?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDir') sortDir?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.adminPanel.listSessions({
      status,
      // Мусорное/неизвестное значение фильтра — тот же принцип, что у
      // sortBy/sortDir ниже: тихо не фильтровать по нему, а не 400.
      quality: quality?.trim() || undefined,
      voiceMode: isVoiceMode(voiceMode) ? voiceMode : undefined,
      plan: isPlanId(plan) ? plan : undefined,
      createdFrom: parseDateParam(createdFrom),
      createdTo: parseDateParam(createdTo),
      search: search?.trim() || undefined,
      sortBy: isSessionSortKey(sortBy) ? sortBy : 'createdAt',
      sortDir: isSortDirection(sortDir) ? sortDir : 'desc',
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

  /**
   * Каталог музыкальных тем поздравлений (фича №4) — тот же принцип,
   * что у селекторов выше: правится без редеплоя.
   *
   * Отличие в ответе: вместе с сырым значением возвращается
   * РАЗОБРАННЫЙ каталог и число отброшенных записей. Разбор терпимый —
   * негодная запись пропускается молча, — и без этих чисел опечатка в
   * ссылке выглядела бы как «сохранилось, но тема не появилась».
   */
  /**
   * GET /admin/balances — «сколько у нас ОСТАЛОСЬ» (TODO §III п.36).
   *
   * Отдельно от `/admin/costs`: тот отвечает на «сколько потрачено».
   * `refresh=1` обходит кеш — кнопка «обновить» на экране; без него
   * ответ держится несколько минут, потому что ограничение частоты у
   * провайдера чужое, а доводит до него наш экран.
   */
  @Get('balances')
  async providerBalances(
    @Req() req: AdminAuthenticatedRequest,
    @Query('refresh') refresh?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return { items: await this.balances.list(refresh === '1') };
  }

  @Get('settings/music-catalog')
  async getMusicCatalog(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.musicCatalog.get();
  }

  @Patch('settings/music-catalog')
  async setMusicCatalog(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetMusicCatalogDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.musicCatalog.save(dto.raw, req.userId);
  }

  /**
   * «Разбор референса по умолчанию» — доп. запрос владельца продукта:
   * тот же принцип, что у селектора озвучки выше, для модели, которая
   * анализирует загруженное видео (ТЗ §17). ⚠️ `grok` — приближение
   * через отдельные кадры, не эквивалент разбора Gemini целиком (см.
   * доккомментарий `default-analysis-provider.ts`).
   */
  @Get('settings/analysis-provider')
  async getAnalysisProvider(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.analysisSettings.get();
  }

  @Patch('settings/analysis-provider')
  async setAnalysisProvider(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetAnalysisProviderDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.analysisSettings.setDefault(dto.provider, req.userId);
  }

  /**
   * «Провайдер видео-генерации по умолчанию» — доп. запрос владельца
   * продукта: закрывает недостающую админскую половину решения §11.1
   * (найдено при аудите §20) — экран генерации предзаполняется этим
   * значением, пользователь может переопределить на конкретной
   * генерации, тот же принцип, что уже есть у `quality`.
   */
  @Get('settings/video-provider')
  async getVideoProvider(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.videoProviderSettings.get();
  }

  @Patch('settings/video-provider')
  async setVideoProvider(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetVideoProviderDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.videoProviderSettings.setDefault(dto.provider, req.userId);
  }

  /**
   * Транспорт Grok для одиночных роликов — доп. запрос владельца
   * продукта (14.09.2026): синхронные вызовы или Batch API, на весь
   * стенд, без привязки к бренду (`grok-video-transport.ts`).
   */
  @Get('settings/grok-transport')
  async getGrokTransport(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.grokTransportSettings.get();
  }

  @Patch('settings/grok-transport')
  async setGrokTransport(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetGrokTransportDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.grokTransportSettings.set(dto.transport, req.userId);
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

  /**
   * Глобальный рубильник советника в мастере («Тонкая красная линия»
   * §3.4). Отдельно от ассистента: разные фичи, разные бюджеты, и
   * выключать их придётся по отдельности.
   */
  @Get('settings/ai-guide')
  async getAiGuide(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.aiGuide.get();
  }

  @Patch('settings/ai-guide')
  async setAiGuide(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SetAiGuideDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.aiGuide.set(dto, req.userId);
  }

  /**
   * Частоты по шагам мастера (§10): где чаще открывают совет, где жмут
   * «тут непонятно», где откатывают. Это и есть источник кандидатов
   * `ERRORS`/`UNDO` для §6.3 — оператор смотрит сюда, прежде чем
   * заводить запись опыта.
   */
  /** Доля попаданий в кеш и сводка по журналу подсказок (§10). */
  @Get('wizard-guide/stats')
  async wizardStats(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    return this.aiGuide.stats();
  }

  /** Лента подсказок с фильтрами (§10) — разбор «почему так». */
  @Get('wizard-guide/hints')
  async wizardHints(
    @Req() req: AdminAuthenticatedRequest,
    @Query('scenario') scenario?: string,
    @Query('stepId') stepId?: string,
    @Query('locale') locale?: string,
    @Query('source') source?: string,
    @Query('flagged') flagged?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.aiGuide.hints({
      scenario,
      stepId,
      locale,
      source,
      flagged: flagged === undefined ? undefined : flagged === 'true',
    });
  }

  @Get('wizard-guide/steps')
  async wizardSteps(
    @Req() req: AdminAuthenticatedRequest,
    @Query('days') days?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const parsed = Number(days);
    return this.wizardTelemetry.frequencies(
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 90) : 7,
    );
  }

  // ── Корпус опыта советника («Тонкая красная линия» §6, §10) ──────

  @Get('wizard-guide/experience')
  async listExperience(
    @Req() req: AdminAuthenticatedRequest,
    @Query('scenario') scenario?: string,
    @Query('stepId') stepId?: string,
    @Query('status') status?: string,
    @Query('unreviewedLocale') unreviewedLocale?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.list({
      scenario,
      stepId,
      status,
      unreviewedLocale,
    });
  }

  @Put('wizard-guide/experience/:id/texts/:locale')
  async saveExperienceText(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('locale') locale: string,
    @Body() dto: ExperienceTextDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.saveText(id, locale, dto);
  }

  @Post('wizard-guide/experience/:id/texts/:locale/reviewed')
  async markExperienceTextReviewed(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Param('locale') locale: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.markReviewed(id, locale);
  }

  /** Публикация — единственное место, где запись становится видимой. */
  @Post('wizard-guide/experience/:id/publish')
  async publishExperience(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.publish(id, req.userId);
  }

  @Patch('wizard-guide/experience/:id')
  async setExperienceStatus(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ExperienceStatusDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.setStatus(id, dto.status);
  }

  @Get('wizard-guide/candidates')
  async listCandidates(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('scenario') scenario?: string,
    @Query('stepId') stepId?: string,
    @Query('decision') decision?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.candidates({
      status,
      scenario,
      stepId,
      decision,
    });
  }

  @Post('wizard-guide/candidates')
  async addCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: AdminCandidateDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    const row = await this.wizardExperience.addCandidate(dto);
    await this.siblings.classify(row.id).catch(() => undefined);
    return row;
  }

  /**
   * Пороги сведения дублей и гистограмма последних решений (§10).
   *
   * Гистограмма рядом с порогами не для красоты: модель меняется, и
   * только по распределению видно, что 0.85 перестал значить то же,
   * что месяц назад.
   */
  @Get('wizard-guide/siblings')
  async siblingStats(@Req() req: AdminAuthenticatedRequest) {
    await this.adminPanel.assertOperator(req.userId);
    const [thresholds, histogram] = await Promise.all([
      this.siblings.thresholds(),
      this.siblings.histogram(),
    ]);
    return { ...thresholds, histogram };
  }

  @Patch('wizard-guide/siblings')
  async setSiblingThresholds(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: SiblingThresholdsDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.siblings.setThresholds(dto, req.userId);
  }

  /** Пересравнить кандидата — после правки порогов или новых ситуаций. */
  @Post('wizard-guide/candidates/:id/classify')
  async classifyCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return (await this.siblings.classify(id)) ?? { decision: 'NONE' };
  }

  @Post('wizard-guide/candidates/:id/promote')
  async promoteCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: PromoteCandidateDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.promote(id, dto, req.userId);
  }

  @Post('wizard-guide/candidates/:id/merge')
  async mergeCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: MergeCandidateDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.merge(id, dto.experienceId, req.userId);
  }

  /** «Это другое» — страховка от утонувшей в дублях новой проблемы. */
  @Post('wizard-guide/candidates/:id/unmerge')
  async unmergeCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.unmerge(id, req.userId);
  }

  @Post('wizard-guide/candidates/:id/attach')
  async attachCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: AttachCandidateDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.attachText(
      id,
      dto.experienceId,
      dto,
      req.userId,
    );
  }

  @Post('wizard-guide/candidates/:id/reject')
  async rejectCandidate(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.wizardExperience.reject(id, req.userId);
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
  /**
   * GET /api/admin/tester-invites — приглашения тестировщиков (этап
   * 155). Вкладка появится этапом 4 ТЗ; пока это то, без чего этапом
   * нечем пользоваться: приглашение надо чем-то завести и где-то взять
   * готовую ссылку.
   */
  @Get('tester-invites')
  async testerInvites(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<TesterInviteView[]> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testerInvitesService.list();
  }

  @Post('tester-invites')
  async createTesterInvite(
    @Req() req: AdminAuthenticatedRequest,
    @Body() dto: CreateTesterInviteDto,
  ): Promise<TesterInviteView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testerInvitesService.create(req.userId, dto);
  }

  @Post('tester-invites/:id/revoke')
  async revokeTesterInvite(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RevokeWithReasonDto,
  ): Promise<TesterInviteView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testerInvitesService.revoke(req.userId, id, dto.reason);
  }

  /**
   * GET /api/admin/test-tickets — очередь разбора (этап 158, §5.1 ТЗ).
   *
   * `status=OPEN` — не статус, а вопрос «что ждёт нас»; он и есть
   * рабочий вид вкладки. `envKey` — фильтр «покажи всё, что на
   * телефонах iOS», то есть ответ на вопрос «это у всех или у него
   * одного», который в разборе задают первым.
   */
  @Get('test-tickets')
  async testTickets(
    @Req() req: AdminAuthenticatedRequest,
    @Query('status') status?: string,
    @Query('userId') userId?: string,
    @Query('envKey') envKey?: string,
  ): Promise<TicketRowView[]> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testTicketsService.list({ status, userId, envKey });
  }

  /** GET /api/admin/test-tickets/progress — покрытие сценариев и сводка. */
  @Get('test-tickets/progress')
  async testTicketsProgress(
    @Req() req: AdminAuthenticatedRequest,
  ): Promise<TesterProgressView[]> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testTicketsService.progress();
  }

  @Get('test-tickets/:id')
  async testTicket(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<TicketDetailView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testTicketsService.get(id);
  }

  @Patch('test-tickets/:id/status')
  async patchTestTicketStatus(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: PatchTicketStatusDto,
  ): Promise<TicketDetailView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testTicketsService.setStatus(
      req.userId,
      id,
      dto.status,
      dto.note ?? null,
    );
  }

  @Post('test-tickets/:id/reply')
  async replyToTestTicket(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ReplyToTicketDto,
  ): Promise<TicketDetailView> {
    await this.adminPanel.assertOperator(req.userId);
    return this.testTicketsService.reply(req.userId, id, dto.text);
  }

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
   * GET /admin/referrals — вкладка «Приглашения» («Условно бесплатный
   * Lite» §11, этап 135): состояния за период, доля дошедших до ролика,
   * разблокировки, начисленное и потраченное в штуках и в деньгах, и
   * список тех, у кого засчёты пришли пачкой.
   */
  @Get('referrals')
  async referralsOverview(
    @Req() req: AdminAuthenticatedRequest,
    @Query('window') window?: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.referrals.overview(parseReferralsWindow(window));
  }

  /**
   * POST /admin/referrals/:id/revoke — снять засчитанное приглашение
   * (§5.4). Строка остаётся на месте со своей причиной: разбор накрутки
   * не на чем вести, если следы стирать. Уже начисленный кредит не
   * отбирается, разблокировка не отнимается — для неё отдельное
   * действие ниже.
   */
  @Post('referrals/:id/revoke')
  async revokeReferral(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RevokeWithReasonDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    return this.referrals.revokeReferral(id, dto.reason);
  }

  /**
   * POST /admin/users/:id/lite-revoke — отнять разблокировку (§5.4).
   *
   * Отдельное действие, а не следствие снятых приглашений: автоматика
   * не отнимает НИКОГДА (отнятое обиднее невыданного), человек — может,
   * и это видно в истории. `liteUnlockedAt` при этом не стирается.
   */
  @Post('users/:id/lite-revoke')
  async revokeUserLite(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: RevokeWithReasonDto,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.liteUnlock.revoke(id, dto.reason);
    return this.users.get(id);
  }

  /**
   * POST /admin/users/:id/lite-unlock — вернуть разблокировку после
   * отзыва.
   *
   * В §10 ТЗ этого маршрута не было, а приёмка этапа 135 требует, чтобы
   * «повторная разблокировка после отзыва работала»: автоматика её не
   * вернёт (иначе отзыв отменялся бы первым же следующим приглашением,
   * см. `LiteUnlockService`), значит возвращать должен тот же, кто
   * отнял. Новая дата ложится поверх, старые строки не правятся.
   */
  @Post('users/:id/lite-unlock')
  async unlockUserLite(
    @Req() req: AdminAuthenticatedRequest,
    @Param('id') id: string,
  ) {
    await this.adminPanel.assertOperator(req.userId);
    await this.liteUnlock.grantByOperator(id);
    return this.users.get(id);
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
