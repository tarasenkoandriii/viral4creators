/**
 * GreetingSessionEditService — правка брифа и сценария ПОСЛЕ старта
 * сессии. Этап C ТЗ `docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md`
 * §3.6 (Г-3, Г-4).
 *
 * ## Что было не так
 *
 * Сессия работает с копией брифа (`greetingBriefSnapshot`), снятой при
 * старте. Визард же сохранял правки в бриф ПРОЕКТА — и они до сессии не
 * доходили: человек менял текст, видел «Сохранено» и получал ролик со
 * старым текстом (Г-3). Этап A временно закрыл бриф после старта;
 * этот сервис возвращает правку — уже с доставкой в сессию.
 *
 * Сценарий правился общим `PATCH /sessions/:id/prompt`, который меняет
 * промпт сцены и текст озвучки по отдельности. У поздравления это одна
 * реплика в двух видах, и правка одной половины разводила их: ведущий в
 * кадре говорил одно, озвучка — другое (Г-4). Здесь они собираются вместе
 * через `buildSceneDescription`.
 *
 * ## Порядок
 *
 * 1. Рендер идёт — 409 (`editModeOf`).
 * 2. Проверка правки — та же, что у брифа проекта (`resolveNext`): тон
 *    против регистра, тарифный гейт провайдера и качества.
 * 3. Несовместимое с новым регистром выбранное сбрасывается с перечнем.
 * 4. Смысл текста поменялся — собранный сценарий стирается.
 * 5. Ролик уже готов — правка уходит в новую сессию-версию, готовый
 *    ролик остаётся как был.
 */

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { SessionService } from '../../common/session.service';
import { Session } from '../../common/types/session.types';
import { SESSION_NOT_FOUND } from '../../common/user-facing-errors';
import { GreetingBriefService } from '../greeting-brief/greeting-brief.service';
import { UpdateGreetingBriefDto } from '../project/dto/update-greeting-brief.dto';
import { BlobService } from '../storage/blob.service';
import { PromptService } from '../prompt/prompt.service';
import {
  GREETING_PROMPT_IN_FLIGHT_MESSAGE,
  buildSceneDescription,
} from '../greeting-prompt/greeting-prompt.service';
import {
  GreetingBriefSnapshot,
  GreetingPresenterProvider,
  GreetingResolution,
} from '../../common/types/greeting.types';
import {
  nextUsesPersona,
  snapshotUsesPersona,
} from '../../common/greeting-persona';
import {
  GenerationPrompt,
  ModerationStatus,
} from '../../common/types/prompt.types';
import {
  ResettableField,
  contentTypeOf,
  editModeOf,
  rebaseSessionPath,
  reconcileSelections,
  scriptInputsChanged,
} from '../../common/greeting-session-edit';
import {
  celebrityLikenessMessage,
  findCelebrityLikeness,
} from '../../common/celebrity-likeness';
import { GREETING_OCCASION_SPECS } from '../../common/greeting-occasions';
import {
  registerOfBrief,
  textFitsRegister,
} from '../../common/greeting-policy';
import { normalizeVoiceMode } from '../../common/voice-mode';
import { SceneAsset } from '../../common/types/reference.types';
import {
  GREETING_PROMPT_LOCK_TTL_MS,
  assertNoRenderAfterWrite,
  editDuringRender,
  greetingScriptInputs,
} from '../greeting-prompt/script-inputs';
import {
  GREETING_ERROR_CODES,
  greetingError,
} from '../../common/greeting-errors';
import { PrismaService } from '../../prisma/prisma.service';
import { reconcileReferenceCaptions } from '../../common/greeting-scene-text';
import {
  applyGreetingSnapshotChange,
  diffGreetingSnapshot,
  updateGreetingSnapshot,
} from '../../common/greeting-snapshot-write';

// Общий срок замка 'prompt' поздравления: правка не должна считать
// протухшим замок ещё идущего старта ролика (CONTRACT6 п.5 аудита).
const EDIT_CLAIM_TTL_MS = GREETING_PROMPT_LOCK_TTL_MS;

export const MAX_GREETING_SPEECH_LENGTH = 2000;

export interface SessionBriefEditResult {
  /** Сессия, в которую ушла правка: та же или новая версия. */
  sessionId: string;
  newVersion: boolean;
  brief: GreetingBriefSnapshot;
  /** Что сброшено как несовместимое с новым регистром. */
  resetFields: ResettableField[];
  /** Собранный сценарий стёрт — его нужно собрать заново. */
  promptCleared: boolean;
}

export interface SessionScriptEditResult {
  sessionId: string;
  newVersion: boolean;
  prompt: GenerationPrompt;
  /**
   * Мягкое предупреждение §3.7: свой текст за стиль не блокируется — это
   * слова человека, — но если он звучит празднично при траурном поводе,
   * об этом стоит сказать. `registerMismatch` — для интерфейса (он
   * показывает своё, переведённое предупреждение), `registerWarning` — то
   * же по-русски, для прямых клиентов API.
   */
  registerMismatch: boolean;
  registerWarning: string | null;
}

@Injectable()
export class GreetingSessionEditService {
  private readonly logger = new Logger(GreetingSessionEditService.name);

  constructor(
    private readonly sessions: SessionService,
    private readonly briefs: GreetingBriefService,
    private readonly promptService: PromptService,
    private readonly blob: BlobService,
    private readonly prisma: PrismaService,
  ) {}

  // ── PATCH /sessions/:id/greeting-brief ──────────────────────────────

  async updateBrief(
    sessionId: string,
    dto: UpdateGreetingBriefDto,
  ): Promise<SessionBriefEditResult> {
    // Бренд — это снимок манифеста, отдельная сущность сессии со своим
    // путём правки (`PATCH /sessions/:id/brand-manifest`). Молча
    // поменять ссылку здесь значило бы разойтись с самим снимком.
    if (dto.brandManifestId !== undefined) {
      throw new BadRequestException(
        'Бренд сессии меняется через PATCH /sessions/:id/brand-manifest.',
      );
    }
    const first = await this.load(sessionId);
    if (editModeOf(first.generatedVideo) === 'busy') {
      throw editDuringRender();
    }

    // Замок — ДО проверок и записей, а решения — по сессии, перечитанной
    // уже под замком. Иначе сборка сценария, закончившаяся между первым
    // чтением и записью, оставила бы сценарий по старому брифу, а отказ
    // по замку приходил бы после того, как бриф проекта уже изменён.
    await this.claim(sessionId);
    try {
      const session = await this.load(sessionId);
      const mode = editModeOf(session.generatedVideo);
      if (mode === 'busy') throw editDuringRender();
      const userId = session.userId;
      if (!userId || !session.projectId) {
        throw new NotFoundException(SESSION_NOT_FOUND);
      }

      const before = session.greetingBriefSnapshot!;
      const next = await this.briefs.resolveNext(userId, baseOf(before), dto);
      // Этап G (§4.8): новый ведущий — новая копия образа в снимок; не
      // передан — прежняя копия остаётся как есть (образ мог быть удалён
      // после старта, и это не должно ломать правку имени получателя).
      const presenter =
        dto.presenter === undefined
          ? undefined
          : next.presenterLookId && next.presenterVariant
            ? await this.briefs.presenterSnapshot(
                userId,
                next.presenterLookId,
                next.presenterVariant,
              )
            : null;
      // Правка накладывается на снимок, а не собирает его заново: так её
      // можно повторить по свежему снимку, если между чтением и записью
      // его тронула наклейка, музыка или сцены (C2), — а платный
      // `resolveNext` (классификатор регистра) не зовётся второй раз.
      const compose = (current: GreetingBriefSnapshot) => {
        const merged: GreetingBriefSnapshot = {
          ...current,
          occasion: next.occasion,
          customOccasionText: next.customOccasionText,
          occasionRegister: next.occasionRegister,
          registerSource: next.registerSource,
          userOccasionRegister: next.userOccasionRegister,
          scriptLanguage: next.scriptLanguage,
          recipientName: next.recipientName,
          senderName: next.senderName,
          tone: next.tone,
          personalMessage: next.personalMessage,
          requestedPresenterProvider: next.presenterProvider,
          resolvedPresenterProvider: next.presenterProvider,
          requestedResolution: next.resolution,
          resolvedResolution: next.resolution,
          occasionDate: next.occasionDate
            ? next.occasionDate.toISOString()
            : null,
        };
        if (presenter !== undefined) merged.presenter = presenter;
        // CONTRACT5 п.5б: правка после готового ролика уходит в НОВУЮ
        // сессию-версию без ролика — там признак следует за выбором.
        // Правка на месте бывает и после упавшего рендера (в том числе
        // повторного поверх готового ролика с персоной) — там признак не
        // снимается.
        const computedPersona = snapshotUsesPersona({
          presenter: merged.presenter ?? null,
          manifestKind: session.brandManifestSnapshot?.kind ?? null,
          senderVoice: merged.senderVoice ?? null,
        });
        merged.usesPersona =
          mode === 'new-version'
            ? computedPersona
            : nextUsesPersona(
                current.usesPersona,
                computedPersona,
                session.generatedVideo,
              );
        return reconcileSelections(merged);
      };

      if (mode === 'new-version') {
        const { snapshot, resetFields } = compose(before);
        // Аудит захода 8: подписи фото — текст видео-промпта; праздничные
        // вне праздника сбрасываются вместе с остальным выбором.
        const captions = reconcileReferenceCaptions(
          snapshot,
          session.greetingReferenceImages,
        );
        if (captions.changed) resetFields.push('referenceCaptions');
        const meaningChanged =
          !!session.generationPrompt &&
          scriptInputsChanged(before, snapshot, session.locale);
        const created = await this.forkVersion(
          captions.changed
            ? { ...session, greetingReferenceImages: captions.images }
            : session,
          snapshot,
          { keepPrompt: !meaningChanged && !captions.changed },
        );
        // Бриф проекта — последним: версия уже есть, и следующая сессия
        // проекта начнётся с исправленного.
        await this.briefs.writeResolved(userId, session.projectId, next);
        return {
          sessionId: created.sessionId,
          newVersion: true,
          brief: created.greetingBriefSnapshot!,
          resetFields: [...resetFields, ...created.dropped],
          promptCleared: !!session.generationPrompt && !created.promptKept,
        };
      }

      // C2: пишутся только ключи, которые правка изменила, — с CAS по
      // снимку целиком (сброс несовместимого выбора решается по всему
      // снимку). Наклейка, выбранная в соседней вкладке, не пропадает:
      // запись промахнётся и правка ляжет поверх свежего снимка.
      let applied!: {
        snapshot: GreetingBriefSnapshot;
        base: GreetingBriefSnapshot;
      };
      let resetFields: ResettableField[] = [];
      let meaningChanged = false;
      let captionsChanged = false;
      await updateGreetingSnapshot(
        this.prisma,
        sessionId,
        before,
        (current) => {
          const result = compose(current);
          const captions = reconcileReferenceCaptions(
            result.snapshot,
            session.greetingReferenceImages,
          );
          captionsChanged = captions.changed;
          resetFields = captions.changed
            ? [...result.resetFields, 'referenceCaptions']
            : result.resetFields;
          meaningChanged =
            !!session.generationPrompt &&
            (captions.changed ||
              scriptInputsChanged(current, result.snapshot, session.locale));
          applied = { snapshot: result.snapshot, base: current };
          return {
            set: diffGreetingSnapshot(current, result.snapshot),
            expect: 'all',
            data: {
              ...(meaningChanged ? { generationPrompt: undefined } : {}),
              ...(captions.changed
                ? { greetingReferenceImages: captions.images }
                : {}),
            },
          };
        },
      );
      const { snapshot } = applied;
      // CONTRACT6 п.3: ролик, запущенный в то же мгновение (замок истёк),
      // считается по прежнему брифу — вернуть его и отказать. Бриф
      // проекта ещё не тронут. Возвращаются только ключи, которые правка
      // меняла, — точечно, как и писались.
      const changed = diffGreetingSnapshot(applied.base, snapshot);
      const restoreSet = Object.fromEntries(
        Object.keys(changed).map((k) => [
          k,
          (applied.base as unknown as Record<string, unknown>)[k],
        ]),
      ) as Partial<GreetingBriefSnapshot>;
      await assertNoRenderAfterWrite(
        {
          getSession: (id) => this.sessions.getSession(id),
          updateSession: (id, restore) =>
            applyGreetingSnapshotChange(this.prisma, id, null, {
              set: restoreSet,
              data: restore,
            }),
        },
        sessionId,
        {
          generationPrompt: session.generationPrompt,
          ...(captionsChanged
            ? { greetingReferenceImages: session.greetingReferenceImages }
            : {}),
        },
      );
      await this.briefs.writeResolved(userId, session.projectId, next);
      return {
        sessionId,
        newVersion: false,
        brief: snapshot,
        resetFields,
        promptCleared: meaningChanged,
      };
    } finally {
      await this.sessions.releaseWork(sessionId, 'prompt');
    }
  }

  // ── PATCH /sessions/:id/greeting-script ─────────────────────────────

  /**
   * Бриф при этом НЕ меняется: правка живёт в сценарии. Смена смысла
   * брифа (тон, повод, язык) потом стирает сценарий вместе с правкой —
   * так и должно быть, правка писалась под прежний смысл. «Пересобрать
   * сценарий» тоже заменяет её свежим черновиком: запиши мы правку в
   * `personalMessage`, пересборка возвращала бы её же слово в слово.
   */
  async updateScript(
    sessionId: string,
    rawSpeech: string,
  ): Promise<SessionScriptEditResult> {
    const speech = (rawSpeech ?? '').trim();
    if (!speech) {
      throw new BadRequestException('Текст сообщения не может быть пустым.');
    }
    if (speech.length > MAX_GREETING_SPEECH_LENGTH) {
      throw new BadRequestException(
        `Текст сообщения длиннее ${MAX_GREETING_SPEECH_LENGTH} символов.`,
      );
    }
    // Фича №35 — та же проверка, что при сборке сценария: чужой образ
    // отклоняется отдельным понятным текстом.
    const likeness = findCelebrityLikeness(speech);
    if (likeness) {
      throw new BadRequestException(celebrityLikenessMessage(likeness));
    }
    const first = await this.load(sessionId);
    if (editModeOf(first.generatedVideo) === 'busy') {
      throw editDuringRender();
    }

    await this.claim(sessionId);
    try {
      const session = await this.load(sessionId);
      const mode = editModeOf(session.generatedVideo);
      if (mode === 'busy') throw editDuringRender();

      let target: Session = session;
      let newVersion = false;
      if (mode === 'new-version') {
        target = await this.forkVersion(
          session,
          session.greetingBriefSnapshot!,
          {
            keepPrompt: false,
          },
        );
        newVersion = true;
      }
      const brief = target.greetingBriefSnapshot!;
      const prompt = composeEditedPrompt(
        // У новой версии своя история: прежний сценарий остаётся у
        // готового ролика.
        newVersion ? null : (session.generationPrompt ?? null),
        brief,
        speech,
        target.greetingReferenceImages ?? [],
        normalizeVoiceMode(target.brandManifestSnapshot?.voiceMode),
        (text) => this.promptService.moderateText(text),
        // Этап G (Г-6): сцены и стиль бренд-бука — и в правленый сценарий,
        // тем же `buildSceneDescription`, что и при сборке.
        target.brandManifestSnapshot ?? null,
      );
      const stamped: GenerationPrompt = {
        ...prompt,
        // CONTRACT6 п.4: под какие фото, образ и голос собрана сцена.
        greetingScriptInputs: greetingScriptInputs(target),
      };
      await this.sessions.updateSession(target.sessionId, {
        generationPrompt: stamped,
      });
      if (!newVersion) {
        await assertNoRenderAfterWrite(this.sessions, sessionId, {
          generationPrompt: session.generationPrompt,
        });
      }
      const warning = registerWarningFor(brief, speech);
      return {
        sessionId: target.sessionId,
        newVersion,
        prompt: stamped,
        registerMismatch: warning !== null,
        registerWarning: warning,
      };
    } finally {
      await this.sessions.releaseWork(sessionId, 'prompt');
    }
  }

  // ── перерендер готового ролика новой версией ────────────────────────

  /**
   * CONTRACT6 п.6: готовый ролик на месте не перерендеривается
   * (`GREETING_VIDEO_ALREADY_READY`). Кому нужен другой ролик тем же
   * брифом и сценарием (оператор фикстуры, `fixtureVideo({ rerender })`),
   * тот заводит новую версию сессии — ровно как правка после готового
   * ролика, только без правки. Сценарий переносится, если все фото
   * скопировались (`forkVersion`); иначе его нужно собрать заново, и
   * вызывающий узнаёт об этом по `promptKept`.
   *
   * Ролик не готов — версия не нужна: возвращается та же сессия.
   */
  async forkForRerender(
    sessionId: string,
  ): Promise<{ sessionId: string; newVersion: boolean; promptKept: boolean }> {
    await this.claim(sessionId);
    try {
      const session = await this.load(sessionId);
      const mode = editModeOf(session.generatedVideo);
      if (mode === 'busy') throw editDuringRender();
      if (mode !== 'new-version') {
        return {
          sessionId,
          newVersion: false,
          promptKept: !!session.generationPrompt,
        };
      }
      const created = await this.forkVersion(
        session,
        session.greetingBriefSnapshot!,
        { keepPrompt: true },
      );
      return {
        sessionId: created.sessionId,
        newVersion: true,
        promptKept: created.promptKept,
      };
    } finally {
      await this.sessions.releaseWork(sessionId, 'prompt');
    }
  }

  // ── общее ────────────────────────────────────────────────────────────

  /** Тот же замок, что у сборки сценария: правка и сборка не идут разом. */
  private async claim(sessionId: string): Promise<void> {
    const claimed = await this.sessions.claimWork(
      sessionId,
      'prompt',
      EDIT_CLAIM_TTL_MS,
    );
    if (!claimed) {
      throw new ConflictException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_EDIT_IN_PROGRESS,
          GREETING_PROMPT_IN_FLIGHT_MESSAGE,
        ),
      );
    }
  }

  /**
   * Новая сессия-версия с копией выбранного. Файлы, лежащие в папке
   * сессии-источника (своя наклейка, своя музыка, свои фото), КОПИРУЮТСЯ:
   * уборка удалённой сессии чистит её папку целиком, и ссылка новой
   * версии на чужую папку однажды повисла бы. Не скопировалось — поле
   * сбрасывается и попадает в перечень, а не остаётся битой ссылкой.
   *
   * Сценарий переносится, только если смысл текста не менялся И все фото
   * на месте: сцена ссылается на фото метками `<IMAGE_n>`, и без одного
   * из них метки съехали бы.
   */
  private async forkVersion(
    source: Session,
    snapshot: GreetingBriefSnapshot,
    opts: { keepPrompt: boolean },
  ): Promise<Session & { dropped: ResettableField[]; promptKept: boolean }> {
    const created = await this.sessions.createSession(
      source.userId ?? undefined,
      {
        projectId: source.projectId!,
        greetingBriefSnapshot: {
          ...snapshot,
          sticker: null,
          musicTheme: null,
          // Галочка витрины относилась к странице прежней версии (§4.9) —
          // новая версия спрашивает заново.
          personaShowcaseConsentAt: null,
          addedAt: new Date().toISOString(),
        },
        ...(source.brandManifestSnapshot
          ? { brandManifestSnapshot: source.brandManifestSnapshot }
          : {}),
      },
      source.locale,
    );
    const to = created.sessionId;
    const from = source.sessionId;
    const dropped: ResettableField[] = [];

    let sticker = snapshot.sticker ?? null;
    if (sticker) {
      const path = rebaseSessionPath(sticker.pathname, from, to);
      if (path) {
        const url = await this.blob.copyBlob(
          sticker.pathname,
          path,
          contentTypeOf(path),
        );
        sticker = url ? { ...sticker, url, pathname: path } : null;
        if (!url) dropped.push('sticker');
      }
    }
    let musicTheme = snapshot.musicTheme ?? null;
    if (musicTheme?.pathname) {
      const path = rebaseSessionPath(musicTheme.pathname, from, to);
      if (path) {
        const url = await this.blob.copyBlob(
          musicTheme.pathname,
          path,
          contentTypeOf(path),
        );
        musicTheme = url ? { ...musicTheme, url, pathname: path } : null;
        if (!url) dropped.push('musicTheme');
      }
    }
    const images: SceneAsset[] = [];
    let imageLost = false;
    for (const img of source.greetingReferenceImages ?? []) {
      const path = rebaseSessionPath(img.photoPathname, from, to);
      if (!path) {
        images.push(img);
        continue;
      }
      const url = await this.blob.copyBlob(
        img.photoPathname,
        path,
        contentTypeOf(path),
      );
      if (url) {
        images.push({ ...img, photoUrl: url, photoPathname: path });
      } else {
        imageLost = true;
        this.logger.warn(
          `версия ${to}: фото ${img.id} не скопировалось, пропускаю`,
        );
      }
    }
    if (imageLost) dropped.push('referenceImages');

    const promptKept =
      opts.keepPrompt && !imageLost && !!source.generationPrompt;
    const greetingBriefSnapshot: GreetingBriefSnapshot = {
      ...created.greetingBriefSnapshot!,
      sticker,
      musicTheme,
    };
    const patch: Partial<Session> = {
      greetingBriefSnapshot,
      ...(images.length ? { greetingReferenceImages: images } : {}),
      // Платить за сборку снова незачем, если сценарий годен и версии.
      ...(promptKept ? { generationPrompt: source.generationPrompt } : {}),
    };
    await this.sessions.updateSession(to, patch);
    return {
      ...created,
      ...patch,
      greetingBriefSnapshot,
      dropped,
      promptKept,
    } as Session & {
      dropped: ResettableField[];
      promptKept: boolean;
    };
  }

  private async load(sessionId: string): Promise<Session> {
    const session = await this.sessions.getSession(sessionId);
    if (!session) throw new NotFoundException(SESSION_NOT_FOUND);
    if (!session.greetingBriefSnapshot) {
      throw new BadRequestException(
        greetingError(
          GREETING_ERROR_CODES.GREETING_NOT_GREETING_SESSION,
          'Это не сессия-поздравление.',
        ),
      );
    }
    return session;
  }
}

/** Снимок сессии → база правки в форме строки брифа. */
export function baseOf(s: GreetingBriefSnapshot) {
  return {
    occasion: s.occasion,
    customOccasionText: s.customOccasionText,
    occasionRegister: s.occasionRegister ?? null,
    registerSource: s.registerSource ?? null,
    // Снимок до этапа D поля не несёт — `resolveNext` тогда восстановит
    // ответ из `occasionRegister` при `registerSource === 'user'`.
    userOccasionRegister: s.userOccasionRegister ?? null,
    scriptLanguage: s.scriptLanguage ?? null,
    recipientName: s.recipientName,
    senderName: s.senderName,
    tone: s.tone,
    personalMessage: s.personalMessage,
    // Запрошенное, а не итоговое: тарифный гейт проверяет именно просьбу.
    presenterProvider:
      s.requestedPresenterProvider as GreetingPresenterProvider,
    resolution: s.requestedResolution as GreetingResolution,
    occasionDate: s.occasionDate ? new Date(s.occasionDate) : null,
    // Этап G: ведущий из снимка — чтобы смена провайдера на Hedra при
    // скетч-ведущем проверялась и при правке из сессии.
    presenterLookId: s.presenter?.lookId ?? null,
    presenterVariant: s.presenter?.variant ?? null,
  };
}

/**
 * Сценарий из правленого текста. Сцена и озвучка — из ОДНОЙ реплики,
 * как в `GreetingPromptService.generateGreetingPrompt`: `finalText` и
 * `finalVoiceoverScript` меняются только вместе (§3.6 п.3).
 *
 * Прежние `generatedText`/`voiceoverScript` сохраняются: сравнить, что
 * написала модель и что оставил человек, иногда единственный способ
 * понять, что пошло не так (тот же довод, что у трёх полей промпта).
 */
export function composeEditedPrompt(
  previous: GenerationPrompt | null,
  brief: GreetingBriefSnapshot,
  speech: string,
  referenceImages: SceneAsset[],
  voiceMode: ReturnType<typeof normalizeVoiceMode>,
  moderate: (text: string) => { status: ModerationStatus; flags: string[] },
  brand?: Parameters<typeof buildSceneDescription>[5],
): GenerationPrompt {
  const occasionText =
    brief.occasion === 'OTHER' && brief.customOccasionText
      ? brief.customOccasionText
      : GREETING_OCCASION_SPECS[brief.occasion].label;
  const scene = buildSceneDescription(
    brief,
    occasionText,
    speech,
    referenceImages,
    voiceMode,
    brand ?? null,
  );
  const moderation = moderate(scene);
  const flagged = moderation.status === ModerationStatus.FLAGGED;
  const now = new Date();
  return {
    promptId: previous?.promptId ?? uuidv4(),
    generatedText: previous?.generatedText ?? scene,
    userEditedText: scene,
    finalText: scene,
    characterCount: scene.length,
    generatedAt: previous?.generatedAt ?? now,
    moderationStatus: flagged
      ? ModerationStatus.FLAGGED
      : ModerationStatus.APPROVED,
    ...(moderation.flags.length ? { moderationFlags: moderation.flags } : {}),
    // Как при сборке: чистый текст одобрен сразу — у поздравления нет
    // экрана ручного одобрения; флаженный не одобряется, и `startVideo`
    // откажет с просьбой исправить текст.
    ...(flagged ? {} : { approvedAt: now }),
    voiceoverScript: previous?.voiceoverScript ?? speech,
    voiceoverScriptEdited: speech,
    finalVoiceoverScript: speech,
    voiceoverScriptSource: 'field',
  };
}

/** §3.7: мягкое предупреждение, не отказ. */
export function registerWarningFor(
  brief: GreetingBriefSnapshot,
  speech: string,
): string | null {
  const register = registerOfBrief(brief);
  if (textFitsRegister(register, speech)) return null;
  const label =
    brief.occasion === 'OTHER'
      ? 'повод деликатный'
      : `повод — «${GREETING_OCCASION_SPECS[brief.occasion].label.toLowerCase()}»`;
  return `Текст звучит празднично, а ${label}. Оставить как есть?`;
}
