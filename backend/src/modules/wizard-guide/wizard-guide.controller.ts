/**
 * Маршруты советника («Тонкая красная линия» §3, §5.3).
 *
 *   GET   /projects/:projectId/wizard-guide
 *   PATCH /projects/:projectId/wizard-guide
 *   POST  /projects/:projectId/wizard-guide/hint
 *
 * Та же конвенция, что у `GreetingBriefController`: `projectId` в пути,
 * `TelegramIdentityGuard` опознаёт звонящего, владение проверяет сервис.
 * `SessionOwnerGuard` здесь не подошёл бы — он читает `sessionId` только
 * из пути и строки запроса, а при его отсутствии пропускает запрос
 * молча.
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { RateLimit, RateLimitGuard } from '../../common/rate-limit';
import { SUPPORTED_LOCALES, SupportedLocale } from '../../common/locale';
import { HintResult, WizardHintService } from './wizard-hint.service';
import {
  IdentifiedRequest,
  TelegramIdentityGuard,
} from '../telegram-auth/telegram-identity.guard';
import { WizardGuideService, WizardGuideState } from './wizard-guide.service';
import { WizardTelemetryService } from './wizard-telemetry.service';
import { CANDIDATE_TEXT_MAX, ExperienceService } from './experience.service';
import { SiblingsService } from './siblings.service';
import {
  WIZARD_EVENT_BATCH_MAX,
  WIZARD_EVENT_DETAIL_MAX,
  WIZARD_EVENT_KINDS,
  type WizardEventKind,
} from './wizard-telemetry';

export class SetWizardGuideDto {
  @IsBoolean()
  enabled!: boolean;
}

export class WizardHintDto {
  /** Идентификатор шага, а не индекс: индексы поедут при первой вставке
   * шага, а ссылки на них останутся в корпусе и в статистике. */
  @IsString()
  @MaxLength(40)
  stepId!: string;

  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale!: string;
}

/**
 * Одно событие телеметрии (§8).
 *
 * Сценарий сюда НЕ принимается: его выводит сервер из типа проекта —
 * ровно по той же причине, что и у подсказки (§5.3 п.4). Иначе клиент
 * мог бы приписать событие чужому сценарию, и частоты, по которым потом
 * заводят записи опыта, поехали бы молча.
 */
export class WizardEventDto {
  @IsString()
  @MaxLength(40)
  stepId!: string;

  @IsIn(WIZARD_EVENT_KINDS as unknown as string[])
  kind!: string;

  /** Код, а не текст: пользовательский текст живёт в кандидатах (§9). */
  @IsOptional()
  @IsString()
  @MaxLength(WIZARD_EVENT_DETAIL_MAX)
  detail?: string;
}

export class WizardEventBatchDto {
  @IsArray()
  @ArrayMaxSize(WIZARD_EVENT_BATCH_MAX)
  @ValidateNested({ each: true })
  @Type(() => WizardEventDto)
  events!: WizardEventDto[];
}

/**
 * «Тут непонятно» (§6.3) — самый дешёвый и самый честный сигнал.
 *
 * Текст необязателен: без него остаётся событие телеметрии
 * `hint_useless`, и этого достаточно, чтобы увидеть шаг, на котором
 * людям неясно. Кандидат заводится только со словами — оператору
 * нужно, что именно непонятно.
 */
export class WizardComplaintDto {
  @IsString()
  @MaxLength(40)
  stepId!: string;

  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale!: string;

  @IsOptional()
  @IsString()
  @MaxLength(CANDIDATE_TEXT_MAX)
  text?: string;
}

@Controller('projects/:projectId/wizard-guide')
@UseGuards(TelegramIdentityGuard)
export class WizardGuideController {
  constructor(
    private readonly guide: WizardGuideService,
    private readonly hints: WizardHintService,
    private readonly telemetry: WizardTelemetryService,
    private readonly experience: ExperienceService,
    private readonly siblings: SiblingsService,
  ) {}

  @Get()
  state(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
  ): Promise<WizardGuideState> {
    return this.guide.stateOf(req.telegramUserId, projectId);
  }

  /**
   * Подсказка на шаге. `POST`, а не `GET`, потому что вызов платный и
   * не обязан кешироваться промежуточными узлами; ответ при этом
   * идемпотентен ровно настолько, насколько идемпотентен кеш §5.5.
   *
   * Лимиты частоты — два окна, как у ассистента: минутное спасает от
   * дребезга интерфейса, часовое — от открытого на весь день мастера.
   */
  @Post('hint')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit([
    { name: 'wizard-hint', limit: 20, windowSec: 60 },
    { name: 'wizard-hint-hour', limit: 120, windowSec: 3600 },
  ])
  hint(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: WizardHintDto,
  ): Promise<HintResult> {
    return this.hints.hint(
      req.telegramUserId,
      projectId,
      dto.stepId,
      dto.locale as SupportedLocale,
    );
  }

  /**
   * Телеметрия шагов (§8). Ответ всегда 200: наблюдение за продуктом не
   * должно превращаться в ошибку на экране мастера.
   *
   * Маршрут за той же личностью, что и подсказка, но в таблицу
   * идентичность НЕ попадает: опознание нужно, чтобы событие нельзя
   * было слать кому угодно про чужой проект, а хранить его незачем —
   * считаются частоты по шагам, а не люди.
   */
  @Post('events')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  // 20 запросов в минуту по 20 событий — потолок роста таблицы, а не
  // удобства: живой мастер даёт единицы событий в минуту, а маршрут
  // умеет звать посторонний человек (аудит волны C).
  @RateLimit([{ name: 'wizard-event', limit: 20, windowSec: 60 }])
  async events(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: WizardEventBatchDto,
  ): Promise<{ recorded: number }> {
    const scenario = await this.guide.scenarioOf(req.telegramUserId, projectId);
    if (!scenario) return { recorded: 0 };
    const recorded = await this.telemetry.record(
      dto.events.map((e) => ({
        scenario,
        stepId: e.stepId,
        kind: e.kind as WizardEventKind,
        detail: e.detail ?? null,
      })),
    );
    return { recorded };
  }

  /**
   * Жалоба на подсказку. Ответ всегда 200 и всегда без подробностей:
   * человек нажал «непонятно» — ему нечего сообщать, кроме «спасибо».
   *
   * Частотный лимит жёстче, чем у подсказки: это кнопка, а не фоновый
   * запрос, и десяти нажатий в минуту хватает любому живому человеку.
   */
  @Post('complaint')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit([{ name: 'wizard-complaint', limit: 10, windowSec: 60 }])
  async complaint(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: WizardComplaintDto,
  ): Promise<{ accepted: boolean }> {
    const scenario = await this.guide.scenarioOf(req.telegramUserId, projectId);
    if (!scenario) return { accepted: false };
    await this.telemetry.record([
      { scenario, stepId: dto.stepId, kind: 'hint_useless' },
    ]);
    if (!dto.text?.trim()) return { accepted: true };
    const row = await this.experience.addCandidate({
      scenario,
      stepId: dto.stepId,
      locale: dto.locale,
      rawText: dto.text,
      origin: 'COMPLAINT',
    });
    if (row) {
      // Сведение дублей (§6.4) — здесь же, а не фоном: у serverless
      // фона нет, обещанная «потом разберём» задача умрёт вместе с
      // ответом. Клиент ответа не ждёт (жалоба отправляется без
      // `await`), поэтому лишняя секунда никому не видна, а отказ
      // модели оставляет кандидата в очереди без процента — оператор
      // разберёт руками.
      await this.siblings.classify(row.id).catch(() => undefined);
    }
    return { accepted: !!row };
  }

  @Patch()
  set(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: SetWizardGuideDto,
  ): Promise<WizardGuideState> {
    return this.guide.setEnabled(req.telegramUserId, projectId, dto.enabled);
  }
}
