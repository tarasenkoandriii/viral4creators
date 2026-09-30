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
  GreetingSonioxVoice,
  GreetingVoiceView,
} from '../../common/types/greeting.types';
import {
  GrokPresetVoice,
  GrokVideoService,
} from '../generation/grok-video.service';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import {
  PERSONA_DISABLED_CODE,
  PERSONA_DISABLED_MESSAGE,
  PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
  nextUsesPersona,
  personaVoiceNeedsPresenter,
  personaEnabled,
  snapshotUsesPersona,
} from '../../common/greeting-persona';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';
import { assertGreetingNotRendering } from '../../common/greeting-render-lock';
import { writeWithGreetingRestamp } from '../greeting-session-edit/restamp';
import { TtsProviderResolverService } from '../tts/tts-provider-resolver.service';
import type { VoiceOption } from '../tts/tts.types';
import {
  GREETING_SONIOX_UNAVAILABLE_MESSAGE,
  GREETING_SONIOX_VOICE_UNKNOWN_MESSAGE,
  SONIOX_VOICE_ID_PATTERN,
} from '../../common/greeting-soniox-voice';

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
    sonioxVoice: snapshot.sonioxVoice ?? null,
  };
}

/** Каталог Soniox одного языка: `null` — прочитать не удалось. */
type SonioxCatalog = VoiceOption[] | null;

type UserVoiceRow = {
  id: string;
  label: string;
  status: string;
  resembleVoiceId: string | null;
  personaId?: string | null;
};

@Injectable()
export class GreetingVoiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly grokVideo: GrokVideoService,
    private readonly ttsResolver: TtsProviderResolverService,
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
    assertGreetingNotRendering(session);
    const snapshot = session.greetingBriefSnapshot!;
    const next = resembleVoiceId
      ? await this.resolveOwnClone(session.userId, resembleVoiceId)
      : null;
    if (personaVoiceNeedsPresenter(snapshot, next)) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_PERSONA_VOICE_NEEDS_PRESENTER,
          PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
        ),
      );
    }
    // Свой клон гасит пресетный голос: произносить реплику может
    // кто-то ОДИН — либо модель в кадре, либо наш синтез поверх.
    return this.write(sessionId, (fresh) => {
      // Под замком — по перечитанному снимку: образ могли снять между
      // чтениями, и проверка выше тогда устарела бы.
      if (personaVoiceNeedsPresenter(fresh, next)) {
        throw new BadRequestException(
          greetingError(
            GREETING_ERROR_CODES.GREETING_PERSONA_VOICE_NEEDS_PRESENTER,
            PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
          ),
        );
      }
      return {
        ...fresh,
        senderVoice: next,
        ...(next ? { presetVoiceId: null, sonioxVoice: null } : {}),
      };
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
    assertGreetingNotRendering(session);
    const next = presetVoiceId?.trim().toLowerCase() || null;
    if (next && !PRESET_VOICE_ID_PATTERN.test(next)) {
      throw new BadRequestException('Неверный идентификатор голоса');
    }
    return this.write(sessionId, (fresh) => ({
      ...fresh,
      presetVoiceId: next,
      ...(next ? { senderVoice: null, sonioxVoice: null } : {}),
    }));
  }

  /**
   * Голос Soniox (S2): реплику произносит наш синтез поверх немого
   * рендера, как у клона, только провайдером Soniox. `voiceId: null` —
   * голос Soniox по умолчанию; `choice: null` — снять выбор.
   *
   * Сверка с каталогом, в отличие от пресетов xAI: каталог Soniox —
   * справочник моделей того же провайдера, что потом синтезирует, и
   * читается он дёшево (кеш ниже), так что неизвестный голос можно
   * отклонить сразу и вслух, а не узнать о нём по немому ролику. Сбой
   * чтения каталога — мягко: принимаем голос по форме id, как пресет,
   * чтобы минутный сбой не прятал рабочие голоса; неверный id тогда
   * штатно провалит синтез (`outcome.ok === false`).
   *
   * Ограничений клона здесь нет сознательно: это не голос человека
   * (согласие, тариф клонирования, персона — не про него), а каталог
   * провайдера, как пресеты, — доступен на всех тарифах.
   */
  async selectSoniox(
    sessionId: string,
    choice: { voiceId?: string | null } | null,
  ): Promise<GreetingVoiceView> {
    const session = await this.load(sessionId);
    assertGreetingNotRendering(session);
    const next = choice ? await this.resolveSonioxVoice(choice.voiceId) : null;
    return this.write(sessionId, (fresh) => ({
      ...fresh,
      sonioxVoice: next,
      ...(next ? { senderVoice: null, presetVoiceId: null } : {}),
    }));
  }

  private async resolveSonioxVoice(
    raw: string | null | undefined,
  ): Promise<GreetingSonioxVoice> {
    const tts = this.ttsResolver.resolveByKey('soniox');
    // Без ключа синтеза не будет вовсе: голос, выбранный сейчас, дал бы
    // ролик без озвучки — отказываем до записи.
    if (!tts.configured()) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_SONIOX_UNAVAILABLE,
          GREETING_SONIOX_UNAVAILABLE_MESSAGE,
        ),
      );
    }
    const voiceId = raw?.trim() || null;
    if (!voiceId) return { voiceId: null, label: null };
    const unknown = () =>
      new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_SONIOX_VOICE_UNKNOWN,
          GREETING_SONIOX_VOICE_UNKNOWN_MESSAGE,
        ),
      );
    if (!SONIOX_VOICE_ID_PATTERN.test(voiceId)) throw unknown();
    const catalog = await this.listSonioxVoices();
    if (!catalog) return { voiceId, label: voiceId };
    const found = catalog.find((v) => v.voiceId === voiceId);
    if (!found) throw unknown();
    return { voiceId: found.voiceId, label: found.name || found.voiceId };
  }

  /**
   * Каталог голосов Soniox — для сверки выбора и для голосового
   * помощника (K5), с кешем по языку тем же доводом, что у роестра
   * пресетов: помощник сверяет выбор на КАЖДОЙ реплике. Язык — тот же
   * фильтр, что у экрана (`GET /tts/voices?provider=soniox&language=`):
   * язык, которого модель не знает, даёт пустой список и на экране, и
   * здесь. `null` в ответе — каталог не прочитан (сбой, нет ключа);
   * такой ответ кешируется коротко.
   */
  listSonioxVoices(language?: string | null): Promise<SonioxCatalog> {
    const key = language?.trim().toLowerCase() || '';
    const now = this.now();
    const cached = this.sonioxCache.get(key);
    if (cached && cached.expiresAt > now) {
      return Promise.resolve(cached.voices);
    }
    let inFlight = this.sonioxInFlight.get(key);
    if (!inFlight) {
      inFlight = this.ttsResolver
        .resolveByKey('soniox')
        .voices(key || undefined)
        .then(({ voices, error }): SonioxCatalog => {
          // Пустой список с пояснением — это «язык не поддержан» или сбой;
          // отличить их по тексту нельзя, и для сверки выбора оба значат
          // одно: сверить не с чем.
          const result = error && !voices.length ? null : voices;
          this.sonioxCache.set(key, {
            voices: result,
            expiresAt:
              this.now() +
              (result?.length ? PRESET_CACHE_TTL_MS : PRESET_EMPTY_TTL_MS),
          });
          return result;
        })
        .finally(() => {
          this.sonioxInFlight.delete(key);
        });
      this.sonioxInFlight.set(key, inFlight);
    }
    return inFlight;
  }

  /**
   * Тот же каталог для голосового разбора — не дольше `timeoutMs`; сбой и
   * таймаут — пустой список (экран в этом случае раздела не покажет).
   */
  async listSonioxVoicesQuick(
    language?: string | null,
    timeoutMs = PRESET_VOICE_PATH_TIMEOUT_MS,
  ): Promise<VoiceOption[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<VoiceOption[]>((resolve) => {
      timer = setTimeout(() => resolve([]), timeoutMs);
    });
    try {
      return await Promise.race([
        this.listSonioxVoices(language)
          .then((v) => v ?? [])
          .catch(() => [] as VoiceOption[]),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private sonioxCache = new Map<
    string,
    { voices: SonioxCatalog; expiresAt: number }
  >();
  private sonioxInFlight = new Map<string, Promise<SonioxCatalog>>();

  /**
   * CONTRACT6 (регрессия аудита): смена голоса пишется под замком
   * 'prompt' по перечитанной сессии, и собранный сценарий
   * перештамповывается под новый голос той же записью
   * (`writeWithGreetingRestamp`). Иначе карточка голоса, стоящая ПОСЛЕ
   * сценария, делала рендер невозможным: отпечаток сценария включает
   * голос, и старт отвечал «сценарий устарел».
   */
  private async write(
    sessionId: string,
    change: (current: GreetingBriefSnapshot) => GreetingBriefSnapshot,
  ): Promise<GreetingVoiceView> {
    let snapshot!: GreetingBriefSnapshot;
    await writeWithGreetingRestamp(this.sessions, sessionId, (session) => {
      const draft = change(session.greetingBriefSnapshot!);
      // Этап G (§4.7): признак персоны пересчитывается при каждой смене
      // голоса — выбрали клон персоны — ролик с персоной; сняли — признак
      // остаётся, только если персона есть в кадре или в бренд-буке.
      // После готового ролика признак не снимается (CONTRACT5 п.5б).
      snapshot = {
        ...draft,
        usesPersona: nextUsesPersona(
          draft.usesPersona,
          snapshotUsesPersona({
            presenter: draft.presenter ?? null,
            manifestKind: session.brandManifestSnapshot?.kind ?? null,
            senderVoice: draft.senderVoice ?? null,
          }),
          session.generatedVideo,
        ),
      };
      return { greetingBriefSnapshot: snapshot };
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
            personaId: true,
          },
        })) as UserVoiceRow | null)
      : null;
    if (!row) {
      throw new NotFoundException('Такого своего голоса нет');
    }
    if (row.status !== 'READY' || !row.resembleVoiceId) {
      throw new NotFoundException('Голос ещё не готов');
    }
    // Голос персоны — часть режима «Я в кадре»: при выключенном режиме
    // его не назначить (CONTRACT5, всё про персону — только за флагом).
    if (row.personaId && !personaEnabled()) {
      throw new NotFoundException({
        code: PERSONA_DISABLED_CODE,
        message: PERSONA_DISABLED_MESSAGE,
      });
    }
    return {
      userVoiceId: row.id,
      resembleVoiceId: row.resembleVoiceId,
      label: row.label,
      // Этап G (§4.7): клон голоса персоны делает ролик роликом с персоной.
      ...(row.personaId ? { personaVoice: true } : {}),
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
