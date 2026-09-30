/**
 * GreetingVoiceService — голосовая реплика в мастере поздравления → текст.
 * Этап K2 ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md` §4А.3.
 *
 * ## Что делает и чего НЕ делает
 *
 * Только распознаёт: запись → дословный текст. Ни поля брифа, ни команды
 * отсюда не применяются — это этап K3, и разделение взято у Devil's
 * Advocate сознательно: распознавание отдаёт текст, а разбор в поля — ОТДЕЛЬНЫЙ
 * вызов модели (квиз DA, `intake-classify` в `jsonMode`). Так человек
 * видит, что именно услышано, и может поправить это до того, как
 * услышанное что-то изменит. Одним вызовом «звук → поля» ошибку
 * распознавания было бы не отличить от ошибки понимания.
 *
 * ## Правила (§4А.3, сверены с DA)
 *
 * - подсказки языка — упорядоченно, с обоими кириллическими
 *   (`voiceLanguageHints`);
 * - имена из брифа — подсказкой, чтобы «Марина» не стала «Мариной» по
 *   ошибке распознавания, а не по падежу;
 * - смешанная речь не нормализуется;
 * - неречевые звуки в текст не попадают (`stripNonSpeech`);
 * - ответ латиницей на кириллическом языке — ОДИН повтор с явным
 *   требованием письменности; не помогло — текст как есть и флаг
 *   `scriptMismatch`, клиент переспрашивает. Третьей попытки нет: каждая
 *   платная, а запись, которую дважды услышали латиницей, скорее всего
 *   и правда латиница (название бренда, английская фраза);
 * - пустой результат — `not-heard`, а не выдуманный текст.
 *
 * ## Приватность
 *
 * Запись транзитная, как у описания товара: удаляется из Blob сразу после
 * чтения, при любом исходе. Звук уходит в Gemini только как `inlineData`
 * (`VoiceTranscriptionService.transcribeWith`) — Условия, пункт 3.4,
 * редакция 2026-09-29.
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { head } from '@vercel/blob';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import { SupportedLocale } from '../../common/locale';
import {
  GREETING_VOICE_MAX_BYTES,
  buildGreetingVoicePrompt,
  needsScriptRetry,
  stripNonSpeech,
  voiceLanguageHints,
} from '../../common/greeting-voice';
import { BlobService } from '../storage/blob.service';
import { PlanService } from '../plan/plan.service';
import { VoiceBudgetService } from '../voice-budget/voice-budget.service';
import {
  VoiceTranscriptionService,
  isSpeechlessReason,
} from './voice-transcription.service';
import { audioExtension, VoiceUploadUrl } from './voice.service';
import {
  GreetingVoiceTranscribeRequestDto,
  GreetingVoiceUploadUrlRequestDto,
} from './dto/greeting-voice.dto';

export type GreetingVoiceStatus = 'ok' | 'not-heard' | 'unavailable';

export interface GreetingVoiceResult {
  status: GreetingVoiceStatus;
  /** Дословная расшифровка; `null`, когда `status` не `ok`. */
  text: string | null;
  /**
   * Язык поздравления кириллический, а ответ дважды пришёл латиницей.
   * Текст отдан как есть — клиент показывает его и переспрашивает, а не
   * применяет молча.
   */
  scriptMismatch: boolean;
  /** Какие языки подсказаны распознаванию — для отладки и телеметрии. */
  hints: SupportedLocale[];
  /**
   * Язык, на котором человек ГОВОРИЛ, — определён провайдером по звуку
   * (Soniox, автоопределение по фрагментам). `null` — провайдер язык не
   * сообщает (Gemini) или речи не было.
   *
   * Запрос владельца 29.09.2026: помощник узнаёт язык человека из его
   * речи. Отсюда его берут разбор реплики (K3 — отвечать и
   * переспрашивать на том же языке) и голос помощника (K1 — озвучивать
   * ответ на нём же), а не из языка интерфейса, который мог выставить
   * кто-то другой.
   */
  language: string | null;
}

/** Ключ записи в Blob: по времени, чтобы новый дубль не гонялся со старым. Экспорт — для тестов. */
export function greetingVoicePathname(
  sessionId: string,
  mimeType: string,
  now: Date = new Date(),
): string {
  return `sessions/${sessionId}/voice-${now.getTime()}.${audioExtension(mimeType)}`;
}

/**
 * Итог по ответам модели. Чистая функция — всё ветвление здесь, чтобы
 * проверять его без сети. `second` — `undefined`, если повтора не было.
 */
export function settleGreetingVoice(
  first: string | null,
  second: string | null | undefined,
  hints: SupportedLocale[],
  language: string | null = null,
): Omit<GreetingVoiceResult, 'status'> & { status: 'ok' | 'not-heard' } {
  const base = { hints, scriptMismatch: false, language };
  if (second === undefined) {
    return first
      ? { ...base, status: 'ok', text: first }
      : { ...base, status: 'not-heard', text: null };
  }
  // Повтор был: значит, первый ответ был латиницей.
  if (second && !needsScriptRetry(second, hints, language)) {
    return { ...base, status: 'ok', text: second };
  }
  const text = second ?? first;
  return text
    ? { ...base, status: 'ok', text, scriptMismatch: true }
    : { ...base, status: 'not-heard', text: null };
}

@Injectable()
export class GreetingVoiceService {
  private readonly logger = new Logger(GreetingVoiceService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly blobService: BlobService,
    private readonly transcription: VoiceTranscriptionService,
    private readonly plans: PlanService,
    private readonly voiceBudget: VoiceBudgetService,
  ) {}

  async createUploadUrl(
    sessionId: string,
    dto: GreetingVoiceUploadUrlRequestDto,
  ): Promise<VoiceUploadUrl> {
    await this.load(sessionId);
    const pathname = greetingVoicePathname(sessionId, dto.mimeType);
    const { uploadUrl } = await this.blobService.createUploadUrl(
      pathname,
      dto.mimeType,
      GREETING_VOICE_MAX_BYTES,
    );
    return { uploadUrl, pathname };
  }

  async transcribe(
    sessionId: string,
    dto: GreetingVoiceTranscribeRequestDto,
  ): Promise<GreetingVoiceResult> {
    const session = await this.load(sessionId);
    const prefix = `sessions/${sessionId}/`;
    if (!dto.pathname.startsWith(prefix)) {
      throw new BadRequestException(`pathname должен начинаться с «${prefix}»`);
    }
    try {
      // Каждая реплика — платный вызов, а при голосовом управлении их
      // десятки за сессию (§4А.7.5): потолок проверяется до вызова.
      // Внутри `try`: отказ по потолку тоже обязан убрать уже
      // загруженную запись, иначе она осталась бы в Blob сиротой — а
      // Условия обещают, что звук не хранится.
      await this.plans.assertCanSpendSession(sessionId);
      // Суточный потолок ГОЛОСА (В-14, этап K3) — поверх общего лимита:
      // тот про все деньги человека, этот ловит зависший микрофон
      // раньше, чем голос съест бюджет ролика.
      await this.voiceBudget.assertCanSpendVoice(session.userId ?? null);

      const snapshot = session.greetingBriefSnapshot!;
      return await this.recognizeRecording({
        pathname: dto.pathname,
        hints: voiceLanguageHints(snapshot.scriptLanguage, session.locale),
        names: [snapshot.recipientName, snapshot.senderName],
        owner: { sessionId },
        canSpendAgain: () =>
          this.plans
            .assertCanSpendSession(sessionId)
            .then(() =>
              this.voiceBudget.assertCanSpendVoice(session.userId ?? null),
            )
            .then(
              () => true,
              () => false,
            ),
      });
    } finally {
      // Транзитная копия: прочитана или нет — не храним. Не влияет на ответ.
      // С `await`: на Vercel работа, не дождавшаяся ответа, может не
      // выполниться вовсе (сквозной аудит голоса 29.09.2026).
      await this.blobService.deleteBlob(dto.pathname);
    }
  }

  /**
   * Распознавание загруженной записи по правилам §4А.3 — общая часть
   * расшифровки (K2) и разбора реплики (K3, `GreetingVoiceUnderstandService`).
   *
   * Вынесено, а не скопировано: правила (подсказки, имена, один повтор
   * при латинице с проверкой лимита перед ним, «не расслышал» против
   * «недоступно») — одни на оба маршрута, и две копии однажды
   * разошлись бы. Запись здесь НЕ удаляется: владелец записи — вызывающий
   * маршрут, и удаление стоит в его `finally` (шов check-docs «голос не
   * остаётся у провайдера» проверяет это в каждом файле модуля). Потолки
   * перед ПЕРВОЙ попыткой проверяет тоже вызывающий; перед повтором —
   * `canSpendAgain`.
   */
  async recognizeRecording(input: {
    pathname: string;
    hints: SupportedLocale[];
    names: ReadonlyArray<string | null | undefined>;
    /** Чей расход: у сессии — `sessionId`, у брифа до сессии — `userId`. */
    owner: { userId?: string | null; sessionId?: string | null };
    /** Можно ли тратить на повтор — те же потолки, что перед первой попыткой. */
    canSpendAgain: () => Promise<boolean>;
  }): Promise<GreetingVoiceResult> {
    const { hints, names } = input;
    let audio: Buffer;
    let mimeType: string;
    try {
      const meta = await head(input.pathname);
      mimeType = meta.contentType || 'audio/webm';
      audio = await this.blobService.downloadBuffer(input.pathname);
    } catch (e) {
      throw new BadRequestException(
        `Запись не найдена в хранилище — сначала загрузите её через upload-url (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    // Подписанный PUT уже ограничен размером, но проверка здесь — не
    // перестраховка: платный вызов не должен зависеть от того, чей
    // клиент и чья ссылка положили файл.
    if (audio.length > GREETING_VOICE_MAX_BYTES) {
      throw new BadRequestException('Запись слишком длинная для реплики');
    }

    const run = async (strictScript: boolean) => {
      // Провайдер — из админки (Gemini или Soniox). Одни и те же
      // правила §4А.3 доезжают до обоих: Gemini — строками инструкции,
      // Soniox — параметрами (`language_hints`, `_strict`,
      // `context.terms`).
      const r = await this.transcription.recognize(audio, mimeType, {
        geminiPrompt: buildGreetingVoicePrompt({
          hints,
          names,
          strictScript,
        }),
        languageHints: hints,
        terms: names,
        strictLanguage: strictScript,
        operation: 'voice-assistant-stt',
        ...(input.owner.sessionId
          ? { sessionId: input.owner.sessionId }
          : { userId: input.owner.userId ?? null }),
      });
      return {
        text: stripNonSpeech(r.text),
        reason: r.reason,
        language: r.language ?? null,
      };
    };

    const first = await run(false);
    if (!first.text && isUnavailable(first.reason)) {
      return {
        status: 'unavailable',
        text: null,
        scriptMismatch: false,
        hints,
        language: null,
      };
    }
    const needRetry =
      !!first.text && needsScriptRetry(first.text, hints, first.language);
    // Повтор — ещё один платный вызов, и потолок проверяется перед ним
    // так же, как перед первым (аудит 29.09.2026): между двумя вызовами
    // лимит мог кончиться. Не пустили — отдаём первый ответ с флагом
    // «переспросить», а не ошибку: текст у нас уже есть.
    const allowed = needRetry && (await input.canSpendAgain());
    const retried = allowed
      ? await run(true)
      : needRetry
        ? { text: null, reason: undefined, language: null }
        : undefined;
    // Язык речи — по ПЕРВОЙ попытке: повтор идёт со строгими
    // подсказками (`language_hints_strict`) и тянет определение к ним,
    // а первая слушала свободно. Повтор — только если первая языка не
    // сообщила.
    const language = first.language ?? retried?.language ?? null;
    return settleGreetingVoice(first.text, retried?.text, hints, language);
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    if (!session.greetingBriefSnapshot) {
      throw new NotFoundException('это не поздравительная сессия');
    }
    return session;
  }
}

/**
 * «Не расслышал» и «распознавание недоступно» — разные ответы человеку:
 * на первое он повторяет, на второе печатает. Недоступность — это нет
 * ключа или упал вызов; пустая запись и «речи не найдено» — это
 * «не расслышал».
 */
function isUnavailable(reason: string | undefined): boolean {
  return !!reason && !isSpeechlessReason(reason);
}
