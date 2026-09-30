/**
 * HintAudioService — голос советника (ТЗ
 * docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §4А.4, этап K1).
 *
 * Озвучивает подсказку, которая УЖЕ лежит в кеше подсказок: голос —
 * второй канал того же советника, а не второй советник, и произносится
 * ровно тот текст, что на экране.
 *
 * ## Порядок проверок
 *
 * Тот же принцип, что у подсказки: бесплатное раньше платного.
 * Рубильник → владение и «голосом» → подсказка в кеше → регистр повода
 * («коротко» в траурном — `speechForRegister`, K4) →
 * аудиокеш → правила расхода → бюджет советника → потолок голоса (В-14)
 * → синтез. Аудиокеш стоит РАНЬШЕ потолков: повтор готового файла
 * ничего не стоит, и отказывать в нём человеку, у которого кончился
 * голос на сегодня, значило бы молчать бесплатно.
 *
 * ## Деградация
 *
 * Как у подсказки: любая неудача — `null` (маршрут отвечает 204), текст
 * остаётся на экране. Единственное, о чём говорят, — исчерпанный
 * потолок голоса самого человека: он его, и помощник сообщает об этом
 * один раз (§4А.7.5).
 */

import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlatformSettingsService } from '../../common/platform-settings.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PlanService } from '../plan/plan.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { BlobService } from '../storage/blob.service';
import { VoiceBudgetService } from '../voice-budget/voice-budget.service';
import { VoiceUploadService } from '../voice-upload/voice-upload.service';
import { scenarioOfProjectType } from '../../common/test-user-scenarios';
import { registerOfBrief } from '../../common/greeting-policy';
import type {
  GreetingOccasion,
  GreetingRegister,
} from '../../common/types/greeting.types';
import { PROJECT_NOT_FOUND } from '../../common/user-facing-errors';
import { WizardGuideService } from './wizard-guide.service';
import { guideSpentToday } from './guide-budget';
import {
  AI_GUIDE_BUDGET_KEY,
  DEFAULT_DAILY_BUDGET_MICRO_USD,
  numberSettingValue,
} from './guide-settings';
import {
  VOICE_ASSISTANT_VOICE_KEY,
  hintAudioKey,
  ephemeralSpeechPathname,
  hintAudioPathname,
  hintKeyBelongsTo,
  hintKeyLocale,
  parseAssistantVoice,
  speechForRegister,
} from './hint-audio';

/**
 * Причина молчания, которую клиент ОБЯЗАН отличать от прочих: о ней
 * помощник говорит один раз (словарь `wizardGuide.voiceBudgetExhausted`).
 * Код, а не фраза — мини-апп живёт на пяти языках.
 */
export const VOICE_BUDGET_EXHAUSTED = 'budget-exhausted';

/**
 * Ответ маршрута. `null` — 204: голос выключен, подсказки нет, реплика
 * не для этого регистра, синтез не удался.
 *
 * Исчерпанный потолок — 200 с `url: null` и причиной, а не 204 с
 * заголовком: бэкенд и мини-апп живут на разных доменах, и нестандартный
 * заголовок браузер отдал бы скрипту только через
 * `Access-Control-Expose-Headers`, а общая настройка CORS (`main.ts`)
 * его не выставляет. Тело же доходит всегда.
 */
export type HintAudioResult =
  | { url: string }
  | { url: null; reason: typeof VOICE_BUDGET_EXHAUSTED };

@Injectable()
export class HintAudioService {
  private readonly logger = new Logger(HintAudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly aiUsage: AiUsageService,
    private readonly guide: WizardGuideService,
    private readonly plan: PlanService,
    private readonly tts: TtsProviderResolverService,
    private readonly blob: BlobService,
    private readonly voiceBudget: VoiceBudgetService,
    private readonly voiceUploads: VoiceUploadService,
  ) {}

  async audioFor(
    userId: string,
    projectId: string,
    hintKey: string,
  ): Promise<HintAudioResult | null> {
    const scenario = await this.voicedScenario(userId, projectId);
    if (!scenario || !hintKeyBelongsTo(hintKey, scenario)) return null;
    // Язык — из ключа, а не из запроса: текст написан именно на нём
    // (см. `hintKeyLocale`).
    const lang = hintKeyLocale(hintKey);
    if (!lang) return null;

    const row: { hint: string } | null =
      await this.prisma.wizardHintCache.findUnique({
        where: { key: hintKey },
        select: { hint: true },
      });
    const text = row?.hint?.trim();
    if (!text) return null;

    const spoken = speechForRegister(
      await this.registerOf(scenario, projectId),
      text,
    );
    if (!spoken) {
      this.logger.log(
        `подсказка не озвучена: не для регистра повода (проект ${projectId})`,
      );
      return null;
    }
    return this.synthesizeCached(userId, projectId, {
      cacheKey: hintKey,
      text: spoken,
      lang,
    });
  }

  /**
   * Сценарий проекта, если голос в нём сейчас возможен: рубильник
   * советника, владение (чужой — 404), советник и «голосом» включены.
   * `null` — голоса нет. Общий вход и для подсказки, и для проактивной
   * речи (K4, `ProactiveSpeechService`): у второго канала нет своего
   * права говорить там, где первый молчит.
   */
  async voicedScenario(
    userId: string,
    projectId: string,
  ): Promise<string | null> {
    if (!(await this.guide.available())) return null;

    const project: {
      type: string;
      aiGuideEnabled: boolean;
      aiGuideVoice: boolean;
    } | null = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { type: true, aiGuideEnabled: true, aiGuideVoice: true },
    });
    if (!project) throw new NotFoundException(PROJECT_NOT_FOUND);
    // Голос без советника не существует (В-10): столбец мог остаться
    // включённым у старой строки, но говорить без советника нечего.
    if (!project.aiGuideEnabled || !project.aiGuideVoice) return null;
    return scenarioOfProjectType(project.type) ?? null;
  }

  /**
   * Озвучить уже собранный СЕРВЕРОМ текст: аудиокеш → правила расхода →
   * бюджет советника → потолок голоса (В-14) → синтез → Blob.
   *
   * Текст сюда приходит только из кода сервера — из кеша подсказок или
   * из шаблонов проактивной речи (K4), — и уже пропущенный через
   * `speechForRegister`. `cacheKey` — ключ подсказки или речи
   * (`speak|…`): он входит в ключ файла вместе с голосом, языком и самим
   * текстом.
   *
   * `skipUserSpend` — только для фразы «суточный лимит исчерпан» (K4,
   * CONTRACT5): общий лимит расхода ей по определению отказал бы, и
   * отказ, о котором помощник обязан сказать, молчал бы именно тогда,
   * когда он случился. Фраза фиксированная и серверная, в общем кеше
   * синтезируется один раз на голос и язык; бюджет советника и потолок
   * голоса В-14 проверяются как всегда.
   */
  async synthesizeCached(
    userId: string,
    projectId: string,
    spec: { cacheKey: string; text: string; lang: string },
    opts: { skipUserSpend?: boolean } = {},
  ): Promise<HintAudioResult | null> {
    const { cacheKey, text, lang } = spec;
    const voice = await this.voice();
    if (!voice) return null;
    const { provider, voiceId } = voice;
    const audioKey = hintAudioKey({
      hintKey: cacheKey,
      provider: provider.providerKey,
      voiceId,
      lang,
      text,
    });

    const cached: { url: string } | null =
      await this.prisma.wizardHintAudio.findUnique({
        where: { key: audioKey },
        select: { url: true },
      });
    if (cached) {
      // Доля попаданий — то же число, что у кеша подсказок: по нему
      // видно, во что обходится голос и работает ли кеш вообще.
      await this.prisma.wizardHintAudio
        .update({
          where: { key: audioKey },
          // `lastUsedAt` — по нему уборка (`pruneWizardHintAudio`)
          // отличает живую озвучку от забытой.
          data: { hits: { increment: 1 }, lastUsedAt: new Date() },
        })
        .catch(() => undefined);
      return { url: cached.url };
    }

    const synth = await this.gateAndSynthesize(userId, projectId, voice, {
      text,
      lang,
      skipUserSpend: !!opts.skipUserSpend,
    });
    if (!synth || !('audio' in synth)) return synth;

    const pathname = hintAudioPathname(audioKey, synth.mimeType);
    try {
      const { url } = await this.blob.uploadBuffer(
        pathname,
        synth.audio,
        synth.mimeType,
      );
      await this.prisma.wizardHintAudio
        .upsert({
          where: { key: audioKey },
          create: {
            key: audioKey,
            hintKey: cacheKey,
            provider: provider.providerKey,
            voiceId: synth.voiceId,
            lang,
            pathname,
            url,
            characters: synth.characters,
          },
          // Гонка двух одновременных запросов: второй перезаписал тот
          // же путь тем же текстом — строка просто остаётся.
          update: {},
        })
        .catch((e: unknown) =>
          this.logger.warn(`аудиокеш советника не записан: ${String(e)}`),
        );
      return { url };
    } catch (e) {
      this.logger.warn(
        `озвучка подсказки не сохранена: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Озвучить реплику с ЛИЧНЫМИ данными (сводка перед согласием: имя
   * получателя) — мимо общего аудиокеша (K4, CONTRACT5).
   *
   * Общий кеш публичен по ссылке, живёт 30 дней и адресуется хешем
   * текста — для имени получателя это слишком долго и слишком общо.
   * Здесь файл кладётся под префикс проекта со СЛУЧАЙНЫМ именем (ни из
   * текста, ни из имени его не вывести), в кеш не пишется и заносится в
   * учёт транзитных записей (`VoiceUploadService.remember`): крон
   * `voice-uploads-sweep` удалит его в пределах часа (`VOICE_RECORDING_
   * MAX_AGE_MS`), как запись голоса. Каждая сводка синтезируется заново —
   * это одна фраза перед рендером, а не частая реплика.
   */
  async synthesizeEphemeral(
    userId: string,
    projectId: string,
    spec: { text: string; lang: string },
  ): Promise<HintAudioResult | null> {
    const voice = await this.voice();
    if (!voice) return null;
    const synth = await this.gateAndSynthesize(userId, projectId, voice, {
      ...spec,
      skipUserSpend: false,
    });
    if (!synth || !('audio' in synth)) return synth;
    const pathname = ephemeralSpeechPathname(projectId, synth.mimeType);
    try {
      // Учёт — ДО заливки: файл без строки учёта не удалил бы никто.
      await this.voiceUploads.remember(pathname);
      const { url } = await this.blob.uploadBuffer(
        pathname,
        synth.audio,
        synth.mimeType,
      );
      return { url };
    } catch (e) {
      this.logger.warn(
        `личная реплика не сохранена: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /** Голос помощника: провайдер и разрешённый голос; нет голоса — `null`. */
  private async voice(): Promise<{
    provider: ReturnType<TtsProviderResolverService['resolveByKey']>;
    voiceId: string;
  } | null> {
    const voice = parseAssistantVoice(
      await this.settings.get(VOICE_ASSISTANT_VOICE_KEY),
    );
    const provider = this.tts.resolveByKey(voice.provider);
    const voiceId = voice.voiceId ?? provider.defaultVoice?.() ?? null;
    // Голоса нет ни в настройке, ни на стенде (Resemble без
    // `RESEMBLE_VOICE_ID`) — синтез всё равно пропустился бы.
    return voiceId ? { provider, voiceId } : null;
  }

  /**
   * Потолки и синтез: правила расхода (кроме `skipUserSpend`) → бюджет
   * советника → потолок голоса В-14 → синтез → запись расхода. Итог —
   * аудио, либо ответ маршруту (`null` / исчерпанный потолок).
   */
  private async gateAndSynthesize(
    userId: string,
    projectId: string,
    voice: NonNullable<Awaited<ReturnType<HintAudioService['voice']>>>,
    spec: { text: string; lang: string; skipUserSpend: boolean },
  ): Promise<
    | {
        audio: Buffer;
        mimeType: string;
        characters: number;
        voiceId: string;
      }
    | HintAudioResult
    | null
  > {
    const { provider, voiceId } = voice;
    // Блокировка оператора и суточный потолок пользователя — общие для
    // всех платных вызовов (как у подсказки). Отказ молчит: человек уже
    // видит блокировку там, где она что-то решает.
    if (!spec.skipUserSpend && !(await this.canSpend(userId, projectId))) {
      return null;
    }
    if (!(await this.guideBudgetLeft())) return null;

    // Потолок голоса В-14 — последним перед синтезом и единственным,
    // о котором говорят вслух.
    try {
      await this.voiceBudget.assertCanSpendVoice(userId);
    } catch (e) {
      if (e instanceof ForbiddenException) {
        return { url: null, reason: VOICE_BUDGET_EXHAUSTED };
      }
      this.logger.warn(
        `потолок голоса не проверен: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }

    const outcome = await provider.synthesize({
      text: spec.text,
      voiceId,
      language: spec.lang,
    });
    if (!outcome.ok) {
      this.logger.warn(
        `голос советника: синтез ${provider.providerKey} не состоялся — ${outcome.reason}`,
      );
      return null;
    }

    // Расход пишется ДО заливки: деньги у провайдера уже потрачены, и
    // сорвавшаяся заливка не делает их бесплатными — иначе потолок
    // голоса считал бы меньше, чем списал провайдер.
    await this.aiUsage.record({
      operation: 'voice-assistant-tts',
      model: `${provider.providerKey}-tts`,
      userId,
      characters: outcome.characters,
    });
    return {
      audio: outcome.audio,
      mimeType: outcome.mimeType,
      characters: outcome.characters,
      voiceId: outcome.voiceId,
    };
  }

  /**
   * Регистр повода — только у поздравления, и только из брифа проекта:
   * это живой бриф, тот, что человек сейчас правит. Брифа ещё нет —
   * `null`, ограничений нет.
   */
  async registerOf(
    scenario: string,
    projectId: string,
  ): Promise<GreetingRegister | null> {
    if (scenario !== 'GREETING_VIDEO') return null;
    const brief: {
      occasion: string;
      occasionRegister: GreetingRegister | null;
    } | null = await this.prisma.greetingBrief.findUnique({
      where: { projectId },
      select: { occasion: true, occasionRegister: true },
    });
    if (!brief) return null;
    return registerOfBrief({
      occasion: brief.occasion as GreetingOccasion,
      occasionRegister: brief.occasionRegister,
    });
  }

  private async canSpend(userId: string, projectId: string): Promise<boolean> {
    try {
      await this.plan.assertCanSpendUser(userId, { projectId });
      return true;
    } catch (e) {
      this.logger.log(
        `голос советника: расход не разрешён (${e instanceof Error ? e.message : String(e)})`,
      );
      return false;
    }
  }

  /** «Суточный лимит — тот же рубильник, что у советника» (§4А.5). */
  private async guideBudgetLeft(): Promise<boolean> {
    const budget = numberSettingValue(
      await this.settings.get(AI_GUIDE_BUDGET_KEY),
      DEFAULT_DAILY_BUDGET_MICRO_USD,
    );
    const spent = await guideSpentToday(this.aiUsage);
    if (spent < budget) return true;
    this.logger.warn(
      `голос советника молчит: дневной бюджет советника исчерпан (${spent} мкд при потолке ${budget})`,
    );
    return false;
  }
}
