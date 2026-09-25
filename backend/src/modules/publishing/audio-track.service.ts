/**
 * AudioTrackService — альтернативная звуковая дорожка ролика на другом
 * языке (этап 138, ТЗ TZ-Multilingual-YouTube.md §5).
 *
 * ## Что делает и чего НЕ делает
 *
 * Делает самое трудное: переводит реплику ПОД ХРОНОМЕТРАЖ, синтезирует
 * её тем же провайдером, что озвучивал оригинал, меряет получившуюся
 * длину по байтам и решает, укладывается ли она в ролик
 * (`common/audio-track-fit.ts`). Результат — карточка дорожки в базе:
 * голос в хранилище, измеренная длина, перебор, нужная подгонка темпа
 * и, если машина не справилась, причина на человеческом языке.
 *
 * НЕ делает сборку полного звука (музыка и атмосфера ролика плюс новый
 * голос) — это отдельный шаг тем же рецептом ffmpeg, что у оригинала,
 * с подменой одного входа. Там же применяется и `tempoRate`: сборка и
 * так задача ffmpeg, и `atempo` в ней — ещё один фильтр в том же
 * вызове, а не второй счёт. И НЕ делает загрузку на YouTube: API
 * дорожек не имеет вовсе, их заливает человек в Studio (§1, §9 — этап
 * 139).
 *
 * ## Почему перевод идёт сюда, а не в общий переводчик продукта
 *
 * Общий переводит текст. Этот — укладывает в хронометраж: требование
 * длины стоит в промпте первым, меряется в слогах, а при промахе идёт
 * второй заход с явным «на N процентов короче»
 * (`track-translation.ts`). Обычный перевод здесь дал бы фразу, которую
 * оборвёт на полуслове.
 *
 * ## Один повтор, а не цикл
 *
 * Порядок ходов задан ТЗ: сократить перевод (один раз), потом подгонять
 * темп, потом — человеку. Цикл «проси короче, пока не влезет» стоил бы
 * денег на каждом заходе и всё равно упёрся бы в предел: смысл реплики
 * не сжимается бесконечно.
 */

import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { BlobService } from '../storage/blob.service';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import { createGeminiClient, geminiApiKey } from '../../common/gemini-client';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { SupportedLocale, normalizeLocale } from '../../common/locale';
import { VIDEO_DURATION_SECONDS } from '../../common/veo-duration';
import { firstCueSeconds, speakableText } from '../../common/voiceover-script';
import { buildTrackSubtitles } from './track-subtitles';
import { SubtitleAlignment } from '../../common/subtitles';
import { GenerationStatus } from '../../common/types/generation.types';
import { planTrackFit, TrackFit } from '../../common/audio-track-fit';
import { planAudioTrackJob } from '../../common/postprod';
import { FfmpegApiService } from '../postprod/ffmpeg-api.service';
import {
  buildTrackTranslationPrompt,
  parseTrackTranslation,
  speechLines,
} from './track-translation';

/** Тот же предел, по той же причине, что у перевода описаний. */
const TRANSLATION_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_TOKENS = 600;

export interface AudioTrackResult {
  locale: SupportedLocale;
  status: 'READY' | 'HANDOVER' | 'FAILED';
  note?: string;
}

@Injectable()
export class AudioTrackService {
  private readonly logger = new Logger(AudioTrackService.name);
  private readonly genai: GoogleGenAI | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly blob: BlobService,
    private readonly aiUsage: AiUsageService,
    private readonly tts: TtsProviderResolverService,
    private readonly ffmpeg: FfmpegApiService,
  ) {
    this.genai = geminiApiKey() ? createGeminiClient() : null;
  }

  /**
   * Собрать (или пересобрать) дорожку одного языка. Никогда не бросает
   * наружу: у оператора должна оставаться карточка с причиной, а не
   * пятисотка в логе.
   */
  async build(sessionId: string, localeRaw: string): Promise<AudioTrackResult> {
    const locale = normalizeLocale(localeRaw);
    try {
      return await this.run(sessionId, locale);
    } catch (e) {
      const note = e instanceof Error ? e.message : String(e);
      this.logger.warn(
        `дорожка ${locale} для ${sessionId} не собралась: ${note}`,
      );
      await this.save(sessionId, locale, { status: 'FAILED', note });
      return { locale, status: 'FAILED', note };
    }
  }

  private async run(
    sessionId: string,
    locale: SupportedLocale,
  ): Promise<AudioTrackResult> {
    const session = await this.sessions.getSession(sessionId);
    const video = session?.generatedVideo;
    if (!session || !video || video.status !== GenerationStatus.COMPLETE) {
      return this.fail(sessionId, locale, 'готового ролика в сессии нет');
    }

    // Отметку оператора «залито» не перебивает никто (аудит этапа 139).
    // Инвариант держится ЗДЕСЬ, а не только в экране админки: подменить
    // файл под отметкой — значит оставить человека в уверенности, что
    // залито именно то, что он скачивал, и узнать об этом будет неоткуда.
    const previous = (await this.prisma.videoAudioTrack.findUnique({
      where: { sessionId_locale: { sessionId, locale } },
    })) as { uploadedAt?: Date | null } | null;
    if (previous?.uploadedAt) {
      return {
        locale,
        status: 'READY',
        note: 'дорожка уже отмечена залитой — пересборка не делается',
      };
    }

    const source = normalizeLocale(session.locale);
    if (locale === source) {
      // Оригинальная дорожка уже есть в самом ролике — вторая копия на
      // том же языке YouTube не нужна и нам тоже.
      return this.fail(
        sessionId,
        locale,
        'это язык оригинала — отдельная дорожка не нужна',
      );
    }

    const script =
      session.generationPrompt?.finalVoiceoverScript ??
      session.generationPrompt?.voiceoverScript ??
      '';
    const speech = speakableText(script);
    if (!speech) {
      return this.fail(
        sessionId,
        locale,
        'в ролике нет реплик — переводить нечего',
      );
    }

    const videoSeconds =
      video.chainTargetDurationSeconds ?? VIDEO_DURATION_SECONDS;
    const speechStartSeconds = firstCueSeconds(script);

    // Ход первый: перевод под хронометраж и синтез.
    let text = await this.translate(
      { speech, source, target: locale },
      sessionId,
    );
    if (!text) {
      return this.fail(sessionId, locale, 'перевод реплики не удался');
    }
    let attempts = 1;
    let voice = await this.synthesize(text, locale, sessionId);
    if (!voice) {
      return this.fail(sessionId, locale, 'синтез речи не удался');
    }
    let fit = planTrackFit({
      voiceSeconds: voice.durationSeconds,
      videoSeconds,
      speechStartSeconds,
    });

    // Ход второй: перевод короче — ровно один раз.
    if (fit.action === 'retranslate') {
      const shorter = await this.translate(
        {
          speech,
          source,
          target: locale,
          shorterByPercent: fit.shorterByPercent,
          previous: text,
        },
        sessionId,
      );
      if (shorter) {
        attempts = 2;
        const second = await this.synthesize(shorter, locale, sessionId);
        if (second) {
          text = shorter;
          voice = second;
        }
      }
      // `retranslated: true` даже если второй перевод не удался: ход
      // израсходован, и повторять его на следующем прогоне значит
      // ходить по кругу за деньги.
      fit = planTrackFit({
        voiceSeconds: voice.durationSeconds,
        videoSeconds,
        speechStartSeconds,
        retranslated: true,
      });
    }

    const pathname = `sessions/${sessionId}/audio-tracks/${locale}.mp3`;
    const { url } = await this.blob.uploadBuffer(
      pathname,
      voice.audio,
      'audio/mpeg',
    );

    const status = fit.action === 'handover' ? 'HANDOVER' : 'READY';
    const tempoRate = fit.action === 'retempo' ? fit.rate : null;

    // Сборка полного звука запускается только у дорожки, которая
    // ВЛЕЗЛА. У той, что ушла человеку, сначала решение человека: он
    // может поправить реплику руками, и платить за сборку заранее
    // значило бы платить дважды.
    const mixJobId =
      status === 'READY'
        ? await this.submitMix({
            musicUrl: session.greetingBriefSnapshot?.musicTheme?.url ?? null,
            videoUrl: sourceRenderUrl(video),
            voiceUrl: url,
            tempoRate,
            videoSeconds,
            speechStartSeconds,
          })
        : null;

    await this.save(sessionId, locale, {
      status,
      generatedVideoId: video.generatedVideoId ?? null,
      speech: text,
      voicePathname: pathname,
      voiceUrl: url,
      voiceSeconds: voice.durationSeconds,
      overflowSeconds: fit.overflowSeconds,
      tempoRate,
      attempts,
      note: noteOf(fit),
      // Субтитры дорожки (этап 141): тайминг от оригинала, текст от
      // перевода. Считаются здесь, а не при чтении, — сценарий живёт в
      // сессии, а дорожка её переживает.
      subtitlesSrt: buildTrackSubtitles({
        speech: text,
        speechStartSeconds,
        videoSeconds,
        voiceSeconds: voice.durationSeconds,
        tempoRate,
        alignment: voice.alignment,
      }),
      mixJobId,
      // Прошлая сборка (если дорожку пересобирают) больше не описывает
      // эту речь — иначе оператор скачал бы файл от прежнего перевода.
      trackPathname: null,
      trackUrl: null,
      mixError: null,
    });
    return { locale, status, note: noteOf(fit) ?? undefined };
  }

  /**
   * Отдать сборку полного звука хостед-ffmpeg. Лучшая попытка: не
   * получилось — у дорожки остаётся голос и причина, а не пустая
   * карточка.
   */
  private async submitMix(input: {
    /** Подложка, если она была у оригинала: её берём из снимка брифа. */
    musicUrl: string | null;
    videoUrl: string | null;
    voiceUrl: string;
    tempoRate: number | null;
    videoSeconds: number;
    speechStartSeconds: number;
  }): Promise<string | null> {
    if (!input.videoUrl) return null;
    const musicUrl = input.musicUrl;
    try {
      const plan = planAudioTrackJob({
        voiceInputKey: 'voice',
        musicInputKey: musicUrl ? 'music' : null,
        mode: 'voiceover',
        tempoRate: input.tempoRate,
        voiceDelayMs: Math.round(input.speechStartSeconds * 1000),
        totalDurationSeconds: input.videoSeconds,
      });
      const job = await this.ffmpeg.submit({
        inputs: {
          source: input.videoUrl,
          voice: input.voiceUrl,
          ...(musicUrl ? { music: musicUrl } : {}),
        },
        outputs: [plan.outputName],
        commands: [plan.command],
      });
      return job.jobId;
    } catch (e) {
      this.logger.warn(
        `сборка дорожки не запустилась: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  /**
   * Дозабрать готовую сборку. Зовётся снаружи (экран оператора, крон) —
   * у хостед-ffmpeg задача асинхронная, как и у постобработки ролика.
   */
  async pollMix(sessionId: string, localeRaw: string): Promise<void> {
    const locale = normalizeLocale(localeRaw);
    const row = (await this.prisma.videoAudioTrack.findUnique({
      where: { sessionId_locale: { sessionId, locale } },
    })) as { mixJobId?: string | null; trackUrl?: string | null } | null;
    if (!row?.mixJobId || row.trackUrl) return;

    let status;
    try {
      status = await this.ffmpeg.status(row.mixJobId);
    } catch (e) {
      // Сетевая икота — следующий опрос повторит. Гасить задачу из-за
      // неё значило бы потерять уже оплаченную сборку.
      this.logger.warn(
        `статус сборки дорожки недоступен: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    if (status.status === 'pending') return;
    if (status.status === 'failed') {
      await this.save(sessionId, locale, {
        mixJobId: null,
        mixError: status.error ?? 'сервис сборки вернул ошибку',
      });
      return;
    }

    const url = status.outputs
      ? Object.values(status.outputs).find(Boolean)
      : undefined;
    if (!url) {
      await this.save(sessionId, locale, {
        mixJobId: null,
        mixError: 'задача завершилась, но файла в ответе нет',
      });
      return;
    }

    try {
      const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
      const pathname = `sessions/${sessionId}/audio-tracks/${locale}-track.m4a`;
      const stored = await this.blob.uploadBuffer(pathname, bytes, 'audio/mp4');
      await this.save(sessionId, locale, {
        mixJobId: null,
        trackPathname: pathname,
        trackUrl: stored.url,
        mixError: null,
      });
    } catch (e) {
      await this.save(sessionId, locale, {
        mixJobId: null,
        mixError: `готовый файл не забрался: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  /** Перевод под хронометраж. `null` — не получилось. */
  private async translate(
    input: Parameters<typeof buildTrackTranslationPrompt>[0],
    sessionId: string,
  ): Promise<string | null> {
    if (!this.genai) return null;
    try {
      const response = await this.genai.models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ text: buildTrackTranslationPrompt(input) }],
        config: {
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          abortSignal: AbortSignal.timeout(TRANSLATION_TIMEOUT_MS),
        },
      });
      await this.aiUsage.recordGemini(response, {
        operation: 'track-translate',
        model: GEMINI_MODEL,
        sessionId,
      });
      // Сколько строк ждём — столько же битов у оригинала (этап 141):
      // без них перевод не к чему привязать ни по звуку, ни в субтитре.
      return parseTrackTranslation(
        response?.text ?? '',
        speechLines(input.speech).length,
      );
    } catch (e) {
      this.logger.warn(
        `перевод реплики не удался: ${e instanceof Error ? e.message : String(e)}`,
      );
      return null;
    }
  }

  private async synthesize(
    text: string,
    locale: SupportedLocale,
    sessionId: string,
  ): Promise<{
    audio: Buffer;
    durationSeconds: number | null;
    /** Посимвольная разметка: приходит тем же вызовом, за который уже
     * заплачено, — на ней стоит тайминг субтитров дорожки (этап 141). */
    alignment?: SubtitleAlignment;
  } | null> {
    const provider = await this.tts.resolve();
    const outcome = await provider.synthesize({ text, language: locale });
    if (!outcome.ok) {
      this.logger.warn(`синтез дорожки ${locale}: ${outcome.reason}`);
      return null;
    }
    await this.aiUsage.record({
      operation: 'voiceover',
      model: `${provider.providerKey}-tts`,
      sessionId,
      characters: outcome.characters,
    });
    return {
      audio: outcome.audio,
      durationSeconds: outcome.durationSeconds,
      alignment: outcome.alignment,
    };
  }

  private async fail(
    sessionId: string,
    locale: SupportedLocale,
    note: string,
  ): Promise<AudioTrackResult> {
    await this.save(sessionId, locale, { status: 'FAILED', note });
    return { locale, status: 'FAILED', note };
  }

  /** Одна строка на язык — повторный прогон правит её, а не плодит вторую. */
  private async save(
    sessionId: string,
    locale: SupportedLocale,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.videoAudioTrack.upsert({
      where: { sessionId_locale: { sessionId, locale } },
      create: { sessionId, locale, ...data },
      update: data,
    });
  }
}

/**
 * Исходный рендер, а не готовый ролик: в готовом уже звучит
 * оригинальный голос, и новая дорожка легла бы поверх него. После
 * постобработки `renderedUrl` хранит именно исходник (см.
 * `PostProductionService`), до неё его роль играет `downloadUrl`.
 */
function sourceRenderUrl(video: {
  renderedUrl?: string | null;
  downloadUrl?: string | null;
}): string | null {
  return video.renderedUrl ?? video.downloadUrl ?? null;
}

/** Пояснение для карточки: у решения «отдать человеку» причина обязана быть. */
function noteOf(fit: TrackFit): string | null {
  if (fit.action === 'handover') return fit.reason;
  if (fit.action === 'retempo') {
    return `речь ускорена при сборке в ${fit.rate} раза — иначе не влезала`;
  }
  return null;
}
