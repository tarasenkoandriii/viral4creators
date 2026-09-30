/**
 * Маршруты советника («Тонкая красная линия» §3, §5.3).
 *
 *   GET   /projects/:projectId/wizard-guide
 *   PATCH /projects/:projectId/wizard-guide
 *   POST  /projects/:projectId/wizard-guide/hint
 *   POST  /projects/:projectId/wizard-guide/hint-audio  { key }
 *   POST  /projects/:projectId/wizard-guide/speak  { kind, locale, … } (K4)
 *
 * Та же конвенция, что у `GreetingBriefController`: `projectId` в пути,
 * `TelegramIdentityGuard` опознаёт звонящего, владение проверяет сервис.
 * `SessionOwnerGuard` здесь не подошёл бы — он читает `sessionId` только
 * из пути и строки запроса, а при его отсутствии пропускает запрос
 * молча.
 */

import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
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
import {
  AI_GUIDE_VOICE_NEEDS_GUIDE,
  WizardGuideService,
  WizardGuideState,
} from './wizard-guide.service';
import { WizardTelemetryService } from './wizard-telemetry.service';
import { HintAudioResult, HintAudioService } from './hint-audio.service';
import { ProactiveSpeechService } from './proactive-speech.service';
import {
  SPEAK_KINDS,
  VOICE_QUESTION_TOPICS,
  VOICE_REFUSAL_CODES,
  type SpeakRequest,
  type VoiceQuestionTopic,
  type VoiceRefusalCode,
} from './proactive-speech';
import { CANDIDATE_TEXT_MAX, ExperienceService } from './experience.service';
import { SiblingsService } from './siblings.service';
import {
  WIZARD_EVENT_BATCH_MAX,
  WIZARD_EVENT_DETAIL_MAX,
  WIZARD_EVENT_KINDS,
  type WizardEventKind,
} from './wizard-telemetry';

/**
 * Оба поля необязательны, но хотя бы одно обязано быть (проверка в
 * контроллере): `enabled` — галочка советника, `voice` — «голосом»
 * (ТЗ Greeting 2.0 §4А.5, В-10). Прежний клиент шлёт только `enabled`
 * и работает как работал.
 */
export class SetWizardGuideDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  voice?: boolean;
}

/**
 * Запрос озвучки подсказки (ТЗ Greeting 2.0 §4А.4, K1) — тело `POST`
 * (финальный аудит ветки K, изменение контракта 3).
 */
export class HintAudioRequestDto {
  /** Ключ кеша подсказки — тот, что пришёл с самой подсказкой. */
  @IsString()
  @MaxLength(500)
  key!: string;

  /**
   * Принимается ради совместимости и НЕ используется: язык озвучки
   * берётся из ключа подсказки — текст написан на нём (аудит волны 1:
   * иначе русский текст уходил бы в синтез как `en`, а одна подсказка
   * синтезировалась бы по разу на каждый язык).
   */
  @IsOptional()
  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  lang?: string;
}

/**
 * Запрос проактивной речи (ТЗ Greeting 2.0 §4А.2 п.1, п.5; K4).
 *
 * Только вид и коды — ТЕКСТА в запросе нет и быть не может: фразу
 * собирает сервер из шаблонов и фактов (`proactive-speech.ts`). Код,
 * которого нет в закрытом списке, — 400 валидацией, а не молчание:
 * это ошибка клиента, а не «нечего сказать».
 */
export class SpeakRequestDto {
  @IsIn(SPEAK_KINDS as unknown as string[])
  kind!: string;

  /** Язык фразы. У ответа на вопрос — язык реплики, как у `reply`. */
  @IsIn(SUPPORTED_LOCALES as unknown as string[])
  locale!: string;

  /** Только у `kind: 'refusal'`. */
  @IsOptional()
  @IsIn(VOICE_REFUSAL_CODES as unknown as string[])
  refusal?: string;

  /** Только у `kind: 'answer'`; нет — ответ «не знаю» (CONTRACT5). */
  @IsOptional()
  @IsIn(VOICE_QUESTION_TOPICS as unknown as string[])
  topic?: string;
}

/** DTO → запрос речи; нет обязательного кода вида — `null` (400). */
export function speakRequestOf(dto: SpeakRequestDto): SpeakRequest | null {
  const locale = dto.locale as SupportedLocale;
  switch (dto.kind) {
    case 'refusal':
      return dto.refusal
        ? { kind: 'refusal', refusal: dto.refusal as VoiceRefusalCode, locale }
        : null;
    case 'answer':
      // Без темы — вопрос без факта: «не знаю, посмотрите справку» вслух.
      return {
        kind: 'answer',
        topic: (dto.topic as VoiceQuestionTopic | undefined) ?? null,
        locale,
      };
    case 'video-ready':
      return { kind: 'video-ready', locale };
    case 'consent-summary':
      return { kind: 'consent-summary', locale };
    default:
      return null;
  }
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
    private readonly audio: HintAudioService,
    private readonly speech: ProactiveSpeechService,
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
  // По человеку (финальный аудит ветки K): за одним адресом в мини-аппе
  // сидит весь оператор связи, и окно по адресу делили бы чужие люди.
  // Анонимного здесь нет — маршрут под `TelegramIdentityGuard`.
  @RateLimit([
    { name: 'wizard-hint', limit: 20, windowSec: 60, by: 'user' },
    { name: 'wizard-hint-hour', limit: 120, windowSec: 3600, by: 'user' },
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
   * Озвучка подсказки (ТЗ Greeting 2.0 §4А.4, этап K1).
   *
   * 200 `{ url }` — файл в Blob; 204 — сказать вслух нечего (голос
   * выключен, подсказки нет, реплика не для регистра повода, синтез не
   * удался); 200 `{ url: null, reason: 'budget-exhausted' }` — кончился
   * потолок голоса этого человека (В-14), о чём помощник говорит один
   * раз. Почему причина в теле, а не в заголовке, — у `HintAudioResult`.
   *
   * `POST` с ключом в теле (финальный аудит ветки K, изменение
   * контракта 3): первый вызов платный, а `GET` с ключом в строке
   * запроса мог повторить предзагрузчик, кеш или прокси — и ключ
   * подсказки оседал бы в журналах доступа. Ответ по-прежнему
   * идемпотентен ровно как кеш: второй раз тот же файл, без синтеза.
   * Лимит частоты — как у подсказки (озвучка бывает не чаще самой
   * подсказки) и так же по человеку.
   */
  @Post('hint-audio')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit([
    { name: 'wizard-hint-audio', limit: 20, windowSec: 60, by: 'user' },
    {
      name: 'wizard-hint-audio-hour',
      limit: 120,
      windowSec: 3600,
      by: 'user',
    },
  ])
  async hintAudio(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: HintAudioRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HintAudioResult | undefined> {
    const result = await this.audio.audioFor(
      req.telegramUserId,
      projectId,
      dto.key,
    );
    if (result) return result;
    res.status(204);
    return undefined;
  }

  /**
   * Проактивная речь помощника (ТЗ Greeting 2.0 §4А.2 п.1, п.5; K4):
   * отказ сервера, готовый ролик, сводка перед согласием, ответ на
   * вопрос о шаге.
   *
   * Ответы — как у озвучки подсказки: 200 `{ url }`, 204 — сказать нечего
   * (голос выключен, повода на самом деле нет, реплика не для регистра,
   * синтез не удался), 200 `{ url: null, reason: 'budget-exhausted' }` —
   * потолок голоса. Лимит частоты — своё окно по человеку, того же
   * размера, что у озвучки подсказки: реплик проактивной речи на шаге не
   * больше, чем подсказок.
   */
  @Post('speak')
  @HttpCode(200)
  @UseGuards(RateLimitGuard)
  @RateLimit([
    { name: 'wizard-speak', limit: 20, windowSec: 60, by: 'user' },
    { name: 'wizard-speak-hour', limit: 120, windowSec: 3600, by: 'user' },
  ])
  async speak(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: SpeakRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HintAudioResult | undefined> {
    const request = speakRequestOf(dto);
    if (!request) {
      throw new BadRequestException('Нужен код отказа: refusal');
    }
    const result = await this.speech.speak(
      req.telegramUserId,
      projectId,
      request,
    );
    if (result) return result;
    res.status(204);
    return undefined;
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
  async set(
    @Req() req: IdentifiedRequest,
    @Param('projectId') projectId: string,
    @Body() dto: SetWizardGuideDto,
  ): Promise<WizardGuideState> {
    if (dto.enabled === undefined && dto.voice === undefined) {
      throw new BadRequestException('Нужно поле enabled или voice');
    }
    // Противоречивое сочетание отвергается ДО любой записи: иначе
    // советник успел бы выключиться, а ответ пришёл бы 409 — человек
    // видел бы ошибку при уже изменённом состоянии (аудит волны 1).
    if (dto.voice === true && dto.enabled === false) {
      throw new ConflictException(AI_GUIDE_VOICE_NEEDS_GUIDE);
    }
    let state: WizardGuideState | null = null;
    // Сначала советник, потом голос: `{ enabled: true, voice: true }`
    // одним запросом должен включить оба, а голос без включённого
    // советника отвергается (409).
    if (dto.enabled !== undefined) {
      state = await this.guide.setEnabled(
        req.telegramUserId,
        projectId,
        dto.enabled,
      );
    }
    if (dto.voice !== undefined) {
      state = await this.guide.setVoice(
        req.telegramUserId,
        projectId,
        dto.voice,
      );
    }
    return state as WizardGuideState;
  }
}
