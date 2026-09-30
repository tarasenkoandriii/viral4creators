/**
 * GreetingVoiceService — голос отправителя для озвучки поздравления
 * (фича №34 компаньон-ТЗ `TZ-Greeting-Video-Upgrade-40-Features.md`).
 *
 * Своей инфраструктуры клонирования не заводит: она уже в проде
 * (`UserVoicesService`, этап 73 — запись образца, согласие, лимит на
 * пользователя, обучение у Resemble, вебхук/poll статуса). Здесь
 * только ВЫБОР одного из уже готовых клонов для конкретной сессии и
 * проверка, что клон действительно свой и действительно готов.
 *
 * Почему отдельный модуль, а не поле в брифе: бриф правится до
 * создания сессии и общий для всех сессий проекта, а голос относится к
 * одному ролику (записал дед — озвучили дедом). Хранится поэтому в
 * `session.greetingBriefSnapshot.senderVoice` — снимок и так живёт
 * посессионно, и новая колонка в БД не нужна.
 *
 * Почему не через `PATCH /sessions/:id` (`applySnapshotEdit`,
 * `ttsVoiceId` в манифесте бренда): тот путь требует существующего
 * `brandManifestSnapshot` и 400-ит без него
 * (`ProjectSessionService.updateSnapshot`), а у бытового поздравления
 * манифеста нет — именно у таких пользователей фича и нужна.
 */

import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import {
  GreetingBriefSnapshot,
  GreetingSenderVoice,
  GreetingVoiceView,
} from '../../common/types/greeting.types';
import {
  GrokPresetVoice,
  GrokVideoService,
} from '../generation/grok-video.service';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';

/**
 * Идентификаторы роестра xAI — строчные слова («eve», «leo», «carina»).
 * Проверка не на «есть ли такой голос», а на «это вообще похоже на
 * идентификатор»: строка уходит в текст промпта.
 */
const PRESET_VOICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** Срок кеша роестра пресетов (аудит волны K2). */
export const PRESET_CACHE_TTL_MS = 10 * 60 * 1000;
/** Срок кеша ПУСТОГО роестра — сбой не должен прятать пресеты надолго. */
export const PRESET_EMPTY_TTL_MS = 60 * 1000;
/** Сколько голосовой разбор ждёт роестр, прежде чем идти без пресетов. */
export const PRESET_VOICE_PATH_TIMEOUT_MS = 2500;

function toView(snapshot: GreetingBriefSnapshot): GreetingVoiceView {
  return {
    senderVoice: snapshot.senderVoice ?? null,
    presetVoiceId: snapshot.presetVoiceId ?? null,
  };
}

type UserVoiceRow = {
  id: string;
  label: string;
  status: string;
  resembleVoiceId: string | null;
};

@Injectable()
export class GreetingVoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly grokVideo: GrokVideoService,
  ) {}

  async get(sessionId: string): Promise<GreetingVoiceView> {
    const session = await this.load(sessionId);
    return toView(session.greetingBriefSnapshot!);
  }

  /**
   * Роестр пресетных голосов xAI — для экрана выбора и для голосового
   * помощника (K5).
   *
   * Кеш в памяти экземпляра (аудит волны K2): разбор КАЖДОЙ реплики в
   * сессии со сценарием сверяет выбор голоса с роестром, и живой GET к
   * xAI с тридцатисекундным потолком на каждой реплике — это и задержка,
   * и лишний трафик. Роестр пополняется у провайдера
   * медленно (см. `GrokVideoService.listPresetVoices`), десять минут
   * устаревания ему не вредят. Пустой ответ (нет ключа, HTTP-ошибка)
   * кешируется коротко: минутный сбой не должен прятать пресеты на
   * десять минут. Исключение не кешируется вовсе.
   *
   * Одновременные промахи делят один запрос.
   */
  listPresetVoices(): Promise<GrokPresetVoice[]> {
    const now = this.now();
    if (this.presetCache && this.presetCache.expiresAt > now) {
      return Promise.resolve(this.presetCache.voices);
    }
    if (!this.presetInFlight) {
      this.presetInFlight = this.grokVideo
        .listPresetVoices()
        .then((voices) => {
          this.presetCache = {
            voices,
            expiresAt:
              this.now() +
              (voices.length ? PRESET_CACHE_TTL_MS : PRESET_EMPTY_TTL_MS),
          };
          return voices;
        })
        .finally(() => {
          this.presetInFlight = null;
        });
    }
    return this.presetInFlight;
  }

  /**
   * Тот же роестр для голосового разбора: не дольше `timeoutMs`, сбой и
   * таймаут — пустой список (как у экрана, который прячет блок пресетов).
   * Опоздавший ответ всё равно ляжет в кеш — следующая реплика его увидит.
   */
  async listPresetVoicesQuick(
    timeoutMs = PRESET_VOICE_PATH_TIMEOUT_MS,
  ): Promise<GrokPresetVoice[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<GrokPresetVoice[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
    });
    try {
      return await Promise.race([
        this.listPresetVoices().catch(() => [] as GrokPresetVoice[]),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private presetCache: { voices: GrokPresetVoice[]; expiresAt: number } | null =
    null;
  private presetInFlight: Promise<GrokPresetVoice[]> | null = null;
  /** Часы — полем, чтобы спек проверял срок кеша без ожидания. */
  now: () => number = () => Date.now();

  /**
   * `null` снимает выбор — озвучка возвращается к голосу по умолчанию
   * (активный на стенде провайдер), а не молчит: это именно снятие
   * выбора, а не выключение звука.
   */
  async select(
    sessionId: string,
    resembleVoiceId: string | null,
  ): Promise<GreetingVoiceView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    const next = resembleVoiceId
      ? await this.resolveOwnClone(session.userId, resembleVoiceId)
      : null;
    // Свой клон гасит пресетный голос: произносить реплику может
    // кто-то ОДИН — либо модель в кадре, либо наш синтез поверх.
    return this.write(sessionId, {
      ...snapshot,
      senderVoice: next,
      ...(next ? { presetVoiceId: null } : {}),
    });
  }

  /**
   * Пресетный голос xAI — реплику произносит сама модель, с настоящим
   * липсинком, и наш синтез для этой сессии выключается.
   *
   * Идентификатор не сверяем с роестром: роестр живёт у провайдера и
   * пополняется без нас (см. `GrokVideoService.listPresetVoices`), а
   * список у себя устареет в первый же день и начнёт отклонять
   * рабочие голоса. Неизвестный `voice_id` отвергнет сам xAI при
   * генерации — там это видно, а здесь было бы только догадкой.
   * Ограничиваем длину и алфавит: идентификатор уходит в текст
   * промпта, и произвольная строка там — чужой ввод в чужой текст.
   */
  async selectPreset(
    sessionId: string,
    presetVoiceId: string | null,
  ): Promise<GreetingVoiceView> {
    const session = await this.load(sessionId);
    const snapshot = session.greetingBriefSnapshot!;
    const next = presetVoiceId?.trim().toLowerCase() || null;
    if (next && !PRESET_VOICE_ID_PATTERN.test(next)) {
      throw new BadRequestException('Неверный идентификатор голоса');
    }
    return this.write(sessionId, {
      ...snapshot,
      presetVoiceId: next,
      ...(next ? { senderVoice: null } : {}),
    });
  }

  private async write(
    sessionId: string,
    snapshot: GreetingBriefSnapshot,
  ): Promise<GreetingVoiceView> {
    await this.sessions.updateSession(sessionId, {
      greetingBriefSnapshot: snapshot,
    });
    return toView(snapshot);
  }

  /**
   * Клон обязан быть СВОИМ и ГОТОВЫМ.
   *
   * «Свой» — потому что `resembleVoiceId` приходит от клиента, а на
   * аккаунте Resemble у продукта один ключ на всех пользователей
   * (см. `UserVoicesService`, MAX_USER_VOICES): без проверки владельца
   * чужой идентификатор озвучил бы поздравление чужим голосом.
   *
   * «Готовый» — потому что у `TRAINING` голоса синтез гарантированно
   * провалится, и узнать об этом человек успеет только после рендера.
   * Отказываем сразу и вслух.
   */
  private async resolveOwnClone(
    userId: string | null | undefined,
    resembleVoiceId: string,
  ): Promise<GreetingSenderVoice> {
    const row: UserVoiceRow | null = userId
      ? ((await this.prisma.userVoice.findFirst({
          where: { userId, resembleVoiceId },
          select: {
            id: true,
            label: true,
            status: true,
            resembleVoiceId: true,
          },
        })) as UserVoiceRow | null)
      : null;
    if (!row) {
      throw new NotFoundException('Такого своего голоса нет');
    }
    if (row.status !== 'READY' || !row.resembleVoiceId) {
      throw new NotFoundException('Голос ещё не готов');
    }
    return {
      userVoiceId: row.id,
      resembleVoiceId: row.resembleVoiceId,
      label: row.label,
    };
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
