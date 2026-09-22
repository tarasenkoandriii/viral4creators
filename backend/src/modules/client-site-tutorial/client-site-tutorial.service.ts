/**
 * Визард обучалки по сайту заказчика — оркестрация раунда
 * (doc/CLIENT-SITE-TUTORIAL-SPEC.md §5, этап 111).
 *
 * Браузер сюда НЕ импортируется: работа с Chromium живёт за интерфейсом
 * `PageExplorer` (см. его доккомментарий). Здесь — всё остальное, и
 * порядок проверок в каждом мутирующем вызове одинаковый и намеренный:
 *
 *   1. владение проектом (§5.2) — чужой проект читается как 404, как и
 *      везде в этом проекте;
 *   2. тарифный признак `siteTutorial` (§9);
 *   3. дневной лимит раундов — слот занимается ДО дорогой операции и
 *      возвращается, если она не состоялась (§9);
 *   4. статус черновика: редактировать можно только `DRAFTING` (§14 п.2);
 *   5. оптимистичная блокировка по `version` (§14 п.1) — итоговая запись
 *      идёт через `updateMany ... where { id, version }`, ноль задетых
 *      строк означает «черновик изменился в другой вкладке» → 409;
 *   6. SSRF-проверка (§8.2) и доменный замок (§8.1) — ПЕРЕД переходом и
 *      ПОСЛЕ него, потому что редирект на чужом сайте мог увести куда
 *      угодно.
 */

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanService } from '../plan/plan.service';
import {
  UnsafeExternalUrlError,
  assertPubliclyRoutableUrl,
} from '../../common/external-url-guard';
import {
  CdpCookie,
  decryptCookieJar,
  encryptCookieJar,
} from '../../common/cookie-jar';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';
import {
  DomainLockError,
  DraftRoundsState,
  DraftStatus,
  DraftStatusError,
  DraftStepLimitError,
  UndoNotPossibleError,
  appendRound,
  assertEditable,
  assertRoundsConsistent,
  assertSameSite,
  replaceLastScreenshot,
  undoLastRound,
} from './draft-rounds';
import { PAGE_EXPLORER, PageExplorer, RoundAction } from './page-explorer';
import { PageExploration } from './page-exploration.types';
import { ClientSiteTutorialUsageService } from './client-site-tutorial-usage.service';
import {
  CredentialsTooLargeError,
  decryptCredentials,
  encryptCredentials,
} from './draft-credentials';
import {
  FrameDecodeError,
  decodeFrameDataUrl,
  draftFramePathname,
  draftFramePrefix,
} from './draft-frames';
import { BlobService } from '../storage/blob.service';
import {
  LiveLoginRelayClient,
  RelayNotConfiguredError,
  RelaySessionGoneError,
  RelayUnavailableError,
} from './live-login-relay.client';
import {
  LiveTicketError,
  issueLiveTicket,
  readLiveTicket,
} from './live-login-ticket';

/** Ключ шифрования cookie jar и кред черновика. Своя переменная, а НЕ
 * `CHANNEL_TOKEN_KEY`: схема БД фиксирует правило «разные секреты разной
 * чувствительности не должны делить один ключ шифрования», а здесь лежат
 * живые куки и тестовые креды к ЧУЖОМУ сайту — чувствительность иная,
 * чем у наших OAuth-токенов выгрузки. Отсутствие ключа не валит старт
 * приложения (как и у остальных опциональных интеграций) — проявляется
 * при первой же попытке сохранить раунд. */
function tutorialSecretKey(): string | undefined {
  return process.env.SITE_TUTORIAL_TOKEN_KEY;
}

/**
 * Готовый ролик обучалки — глазами ЕГО ВЛАДЕЛЬЦА.
 *
 * Появилось по находке Б-4 аудита
 * `docs-tz/AUDIT-Client-Site-Tutorial-Landing.md`: собранное видео
 * лежало в `TutorialVideoAsset`, а наружу этот тип отдавал только
 * админский контроллер (`admin/tutorial-video-assets`). Для
 * пользователя конечным состоянием визарда была строка «Одобрено —
 * ролик собирается», после которой не появлялось ничего: ни ссылки,
 * ни файла. То есть у целого вида проекта не было артефакта — человек
 * проходил сценарий по своему сайту и не получал на руки ничего.
 *
 * Почему гейтом служит `assemblyStatus`, а НЕ `reviewed`. `reviewed` —
 * это разрешение оператора ПОКАЗЫВАТЬ ролик посетителям (§4.6 TMA-
 * спеки), и для публичной витрины оно остаётся обязательным. Но
 * владелец проекта — не посетитель: это человек, чей сайт в кадре и
 * чей сценарий записан, а черновик к этому моменту УЖЕ прошёл
 * одобрение оператором (`APPROVED`, §8.3 — иначе сборка вообще не
 * запускается). Держать от него готовый файл за вторым одобрением
 * означало бы охранять его собственную запись от него самого.
 *
 * Текста ошибки сборки здесь нет намеренно: `assemblyError` — это
 * сообщение внешнего ffmpeg-api, адресованное оператору. Пользователю
 * оно ничего не объясняет и может содержать внутренние детали, так что
 * наружу идёт только сам факт неудачи.
 */
export interface TutorialVideoView {
  /** 'pending' — сборка идёт, 'complete' — есть `url`, 'failed' —
   * оператор увидит причину в админке. */
  status: 'pending' | 'complete' | 'failed';
  url: string | null;
  durationMs: number | null;
}

export interface DraftView {
  id: string;
  projectId: string;
  baseUrl: string;
  steps: ScenarioStep[];
  stepsPerRound: number[];
  roundScreenshots: string[];
  lastUrl: string | null;
  requiresLiveLoginReplay: boolean;
  status: DraftStatus;
  title: string | null;
  rejectionReason: string | null;
  previewFrameCount: number | null;
  version: number;
  hasCredentials: boolean;
  /** §15.8 контракта реле: у мягкой деградации обязан быть ЯВНЫЙ канал.
   * Фронтенд прячет кнопку живого входа по этому признаку, а не
   * догадывается по тексту ошибки после нажатия. */
  liveLoginAvailable: boolean;
  /** Заполняется только у одобренного черновика — до одобрения
   * собирать нечего, и строки `TutorialVideoAsset` ещё не существует. */
  video: TutorialVideoView | null;
}

export interface LiveLoginStart {
  sessionId: string;
  streamToken: string;
  relayWsUrl: string;
  /** Зашифрованная квитанция — её, а не `sessionId`, фронтенд вернёт в
   * `/live-login/complete` (см. `live-login-ticket.ts`). */
  ticket: string;
}

export interface RoundResult {
  draft: DraftView;
  exploration: PageExploration;
}

/** Строка черновика в том виде, в каком её отдаёт Prisma. Своё описание,
 * а не сгенерированный тип: в песочнице клиент Prisma не генерируется
 * (известное ограничение, `doc/CI.md`), и тесты не должны от него
 * зависеть. */
interface DraftRow {
  id: string;
  projectId: string;
  baseUrl: string;
  steps: unknown;
  stepsPerRound: number[];
  roundScreenshots: unknown;
  lastUrl: string | null;
  cookiesEnc: string | null;
  credentialsEnc: string | null;
  requiresLiveLoginReplay: boolean;
  status: DraftStatus;
  title: string | null;
  rejectionReason: string | null;
  previewFrameCount: number | null;
  version: number;
}

@Injectable()
export class ClientSiteTutorialService {
  private readonly logger = new Logger(ClientSiteTutorialService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly usage: ClientSiteTutorialUsageService,
    private readonly blob: BlobService,
    private readonly relay: LiveLoginRelayClient,
    @Inject(PAGE_EXPLORER) private readonly explorer: PageExplorer,
  ) {}

  /** Первый раунд: фиксирует `baseUrl`, открывает страницу, создаёт
   * черновик (§5.2 `/explore`). */
  async explore(
    userId: string,
    projectId: string,
    url: string,
  ): Promise<RoundResult> {
    await this.assertOwnProject(userId, projectId);
    await this.plans.assertUser(userId, 'siteTutorial');

    // Ключ проверяется ДО слота и ДО браузера (аудит этапа 116): без
    // него раунд всё равно не сохранить, а раньше отказ прилетал уже
    // ПОСЛЕ обхода сайта — слот потрачен, Chromium поднят, и так до
    // исчерпания суточного лимита.
    this.requireSecretKey();

    const existing = await this.findDraft(projectId);
    if (existing) {
      // Один черновик на проект — это инвариант БД (`@unique` на
      // projectId, §9). Молча перезаписать чужую работу нельзя.
      throw new ConflictException(
        'у этого проекта уже есть черновик обучалки — продолжите его или удалите',
      );
    }

    await this.assertSafeUrl(url);
    const origin = new URL(url).origin;

    await this.reserveRound(userId);
    let round;
    try {
      round = await this.explorer.runRound({
        url,
        cookies: [],
        actions: [],
        allowedOrigin: origin,
      });
    } catch (err) {
      await this.usage.releaseRound(userId);
      throw err;
    }
    await this.assertStillInside(origin, round.exploration.currentUrl);

    const state = appendRound(
      {
        steps: [],
        stepsPerRound: [],
        roundScreenshots: [],
        requiresLiveLoginReplay: false,
      },
      {
        steps: [{ kind: 'goto', route: url }],
        screenshot: round.exploration.screenshotDataUrl,
      },
    );

    const created = await this.createDraft({
      projectId,
      baseUrl: origin,
      steps: state.steps as object,
      stepsPerRound: state.stepsPerRound,
      roundScreenshots: state.roundScreenshots as object,
      lastUrl: round.exploration.currentUrl,
      cookiesEnc: this.encryptCookies(round.cookies),
    });

    return { draft: this.toView(created), exploration: round.exploration };
  }

  /** Обычный раунд: ноль или больше `fill` и не более одного `click`
   * (§5.2 `/step`). */
  async step(
    userId: string,
    projectId: string,
    input: {
      expectedVersion: number;
      fills: Array<{ selector: string; value: string }>;
      clickSelector?: string;
    },
  ): Promise<RoundResult> {
    const { draft } = await this.loadEditableDraft(userId, projectId);

    if (input.fills.length === 0 && !input.clickSelector) {
      throw new BadRequestException(
        'раунд должен что-то делать: заполните хотя бы одно поле или выберите кнопку',
      );
    }

    const actions: RoundAction[] = [
      ...input.fills.map((f) => ({
        kind: 'fill' as const,
        selector: f.selector,
        value: f.value,
      })),
      ...(input.clickSelector
        ? [{ kind: 'click' as const, selector: input.clickSelector }]
        : []),
    ];
    const steps: ScenarioStep[] = actions.map((a) =>
      a.kind === 'fill'
        ? { kind: 'fill', selector: a.selector, value: a.value }
        : { kind: 'click', selector: a.selector },
    );

    return this.runAndPersist(
      userId,
      draft,
      input.expectedVersion,
      actions,
      steps,
    );
  }

  /**
   * Вход по тестовым кредам (§5.2 `/login`). Отличие от `/step` ровно
   * одно, но принципиальное: значения полей с `sensitive: true`
   * сохраняются ЗАШИФРОВАННЫМИ в `credentialsEnc` — это единственный
   * секрет, который переживает черновик и проигрывается заново при
   * каждой пересборке видео (§7.3). Соответственно в `steps` такие поля
   * уходят БЕЗ значения — иначе пароль лежал бы открытым текстом в JSON
   * сценария, который видит оператор при модерации (§8.3).
   */
  async login(
    userId: string,
    projectId: string,
    input: {
      expectedVersion: number;
      submitSelector: string;
      fields: Array<{ selector: string; value: string; sensitive: boolean }>;
    },
  ): Promise<RoundResult> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    if (input.fields.length === 0) {
      throw new BadRequestException('форма входа без полей — нечего заполнять');
    }

    const actions: RoundAction[] = [
      ...input.fields.map((f) => ({
        kind: 'fill' as const,
        selector: f.selector,
        value: f.value,
      })),
      { kind: 'click' as const, selector: input.submitSelector },
    ];

    const sensitive = input.fields.filter((f) => f.sensitive);
    const steps: ScenarioStep[] = [
      ...input.fields.map((f) => ({
        kind: 'fill' as const,
        selector: f.selector,
        // Значение секретного поля в сценарий не попадает — оно живёт
        // только в credentialsEnc и подставляется при пересборке.
        value: f.sensitive ? '' : f.value,
      })),
      { kind: 'click', selector: input.submitSelector },
    ];

    // Шифруем ДО запуска браузера: если креды не помещаются в потолок,
    // незачем тратить раунд из суточного лимита ради того, чтобы упасть
    // на записи.
    let credentialsEnc: string | undefined;
    if (sensitive.length) {
      try {
        // Креды ДОПИСЫВАЮТСЯ к уже сохранённым, а не заменяют их
        // (аудит этапа 116). Форма входа, разнесённая на два экрана —
        // сначала email, потом пароль, — это ровно тот случай, который
        // §14 п.8 объявляет поддержанным: раньше второй `/login` стирал
        // то, что сохранил первый, и черновик становился неотменяемым
        // (переигровка падала на поле без секрета) и непересобираемым.
        const merged = new Map<string, string>();
        for (const field of this.decryptSecretFields(draft.credentialsEnc)) {
          merged.set(field.selector, field.value);
        }
        for (const field of sensitive) merged.set(field.selector, field.value);
        credentialsEnc = encryptCredentials(
          [...merged].map(([selector, value]) => ({ selector, value })),
          this.requireSecretKey(),
        );
      } catch (err) {
        if (err instanceof CredentialsTooLargeError) {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }

    return this.runAndPersist(
      userId,
      draft,
      input.expectedVersion,
      actions,
      steps,
      { credentialsEnc },
    );
  }

  /**
   * Отмена последнего РАУНДА (§5.2 `/undo`).
   *
   * Дорогая операция, и это принято ТЗ явно (§14 п.6): куки хранятся
   * одним «последним слепком», истории по шагам нет — значит вернуться
   * на раунд назад нечем, только пройти оставшиеся шаги заново с
   * первого `goto`. Поэтому `/undo` тратит слот суточного лимита, как
   * обычный раунд: браузер поднимается ровно так же.
   *
   * Свежий кадр ЗАМЕЩАЕТ последний оставшийся, а не дописывается: после
   * отмены предпросмотр обязан показывать актуальное состояние
   * страницы, а не кадр, снятый при первом проходе через неё.
   */
  async undo(
    userId: string,
    projectId: string,
    expectedVersion: number,
  ): Promise<RoundResult> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    const state = this.toRoundsState(draft);
    assertRoundsConsistent(state);

    let undone;
    try {
      undone = undoLastRound(state, {
        // Смотрим именно на ПОСЛЕДНИЙ раунд, а не на флаг всего
        // черновика (аудит этапа 116). До этапа 114 флаг всегда был
        // false, и огрубление ничего не стоило; с появлением живого
        // входа оно стало запрещать отмену ЛЮБОГО раунда после него —
        // в том числе обычных, записанных уже за экраном логина, где
        // переигрывать капчу не нужно вовсе: сессия лежит в куках.
        lastRoundWasLive: lastRoundIsLiveMarker(state),
      });
    } catch (err) {
      if (err instanceof UndoNotPossibleError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }

    // Аудит этапа 116: здесь этой проверки НЕ БЫЛО, и это была дыра, а
    // не недосмотр стиля. `replay` открывает первый шаг сценария —
    // адрес, записанный раундом раньше, — а DNS за это время мог
    // смениться на внутренний. Доменный замок этого не ловит: он
    // сравнивает строку хоста, а не то, куда она теперь резолвится.
    const replayStart = firstGotoRoute(undone.next.steps);
    if (replayStart) await this.assertSafeUrl(replayStart);

    // Переигровка прогоняет ВСЕ оставшиеся шаги, включая клики, — то
    // есть повтор отмены нажимает их на сайте заказчика второй раз.
    // Занимаем версию до браузера, как и обычный раунд.
    const claimed = await this.claimRound(draft, expectedVersion);

    await this.reserveRound(userId);
    let replayed;
    try {
      replayed = await this.explorer.replay({
        steps: undone.next.steps,
        secrets: this.decryptSecrets(draft.credentialsEnc),
        allowedOrigin: draft.baseUrl,
      });
    } catch (err) {
      await this.usage.releaseRound(userId);
      throw err;
    }
    await this.assertStillInside(draft.baseUrl, replayed.exploration.currentUrl);

    const next = replaceLastScreenshot(
      undone.next,
      replayed.exploration.screenshotDataUrl,
    );

    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draft.id, version: claimed, status: 'DRAFTING' },
      data: {
        steps: next.steps as object,
        stepsPerRound: next.stepsPerRound,
        roundScreenshots: next.roundScreenshots as object,
        lastUrl: replayed.exploration.currentUrl,
        cookiesEnc: this.encryptCookies(replayed.cookies),
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) throw this.conflict();

    return {
      draft: this.toView(await this.requireDraft(projectId)),
      exploration: replayed.exploration,
    };
  }

  /**
   * Завершение записи (§5.2 `/finish`): заморозить черновик и залить
   * накопленные кадры в Blob для предпросмотра — пользователю на экране
   * 3 и оператору при модерации.
   *
   * Кадры берутся из `draft.roundScreenshots` (сервер снял их сам на
   * каждом раунде), а НЕ из тела запроса: доверять присланному клиентом
   * списку — лишний риск рассинхрона с тем, что было на самом деле
   * (§15 п.1).
   *
   * Заливка идёт ДО захвата строки, а не после. Если черновик успели
   * изменить в другой вкладке, мы отвечаем 409 и убираем только что
   * залитое — тогда как обратный порядок оставил бы замороженный
   * черновик с числом кадров, которых в Blob ещё нет.
   *
   * Сборку видео это НЕ запускает — её запускает одобрение оператора
   * (§8.3). Залить готовые JPEG дёшево, собрать ролик через внешний
   * ffmpeg-api дорого, и эти два шага разведены намеренно.
   */
  async finish(
    userId: string,
    projectId: string,
    input: { expectedVersion: number; title: string },
  ): Promise<DraftView> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    const state = this.toRoundsState(draft);
    assertRoundsConsistent(state);
    if (state.roundScreenshots.length === 0) {
      throw new BadRequestException(
        'в черновике нет ни одного кадра — записывать нечего',
      );
    }

    // Стереть прошлый префикс ПЕРЕД заливкой (§15 п.4): повторный
    // `/finish` после `resume` + `/undo` короче прошлого оставил бы
    // «хвостовые» файлы с номерами ≥ нового previewFrameCount навсегда.
    await this.wipeFrames(draft.id);
    let uploaded: number;
    try {
      uploaded = await this.uploadFrames(draft.id, state.roundScreenshots);
    } catch (err) {
      // Сбой на середине заливки оставлял файлы в хранилище при пустом
      // `previewFrameCount` — то есть невидимыми для любой уборки
      // (аудит этапа 116). Убираем сразу и называем причину: раньше
      // сюда прилетала generic 500 без текста, и повторное «Готово»
      // давало ровно то же самое.
      await this.wipeFrames(draft.id).catch(() => undefined);
      if (err instanceof FrameDecodeError) {
        throw new BadRequestException(
          `кадр предпросмотра не читается (${err.message}) — отмените последний шаг и повторите его`,
        );
      }
      throw new ServiceUnavailableException(
        'не удалось сохранить кадры предпросмотра — попробуйте ещё раз через минуту',
      );
    }

    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: {
        id: draft.id,
        version: input.expectedVersion,
        status: 'DRAFTING',
      },
      data: {
        status: 'PENDING_REVIEW',
        title: input.title.trim(),
        previewFrameCount: uploaded,
        rejectionReason: null,
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) {
      // Кадры уже в Blob, а строка не наша — убираем за собой, иначе
      // осиротевший префикс останется навсегда.
      await this.wipeFrames(draft.id);
      throw this.conflict();
    }

    return this.toView(await this.requireDraft(projectId));
  }

  /**
   * Старт живой сессии входа (§7.4.4). Возвращает всё, что нужно
   * фронтенду, чтобы соединиться с реле НАПРЯМУЮ: постоянный видеопоток
   * через serverless-функцию не имеет смысла ни по архитектуре, ни по
   * биллингу.
   *
   * `sessionId` уезжает клиенту ещё и внутри зашифрованной квитанции —
   * см. доккомментарий `live-login-ticket.ts`: без неё `complete` брал
   * бы идентификатор сессии из тела запроса, и сосед, подставив чужой,
   * записал бы ЧУЖУЮ живую сессию к чужому кабинету в свой черновик.
   */
  async startLiveLogin(
    userId: string,
    projectId: string,
  ): Promise<LiveLoginStart> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    if (!this.relay.configured()) {
      throw new ServiceUnavailableException(
        'живой вход не настроен на этом стенде — воспользуйтесь входом по тестовым учётным данным',
      );
    }

    const startUrl = draft.lastUrl ?? draft.baseUrl;
    await this.assertSafeUrl(startUrl);
    assertSameSite(draft.baseUrl, startUrl);
    // Квитанцию выдаём этим же ключом уже ПОСЛЕ того, как реле подняло
    // браузер, — значит отсутствие ключа обязано выясниться здесь
    // (аудит этапа 116): иначе слот живого входа списан, сессия на реле
    // висит до трёхминутной стены, а пользователь получает 400.
    const secretKey = this.requireSecretKey();

    // §15.7: дневной лимит именно на live-сессии — отдельный, более
    // дорогой ресурс: каждая держит чужой браузер минутами и занимает
    // место под общим потолком реле. Реле про пользователей не знает и
    // знать не должно, поэтому счёт — только здесь.
    if (!(await this.usage.reserveLiveSession(userId))) {
      throw new ForbiddenException(
        `дневной лимит живых входов исчерпан (${this.usage.liveSessionsLimit} в сутки) — продолжите завтра`,
      );
    }

    let session;
    try {
      session = await this.relay.createSession({
        startUrl,
        allowedOrigin: draft.baseUrl,
      });
    } catch (err) {
      await this.usage.releaseLiveSession(userId);
      throw this.relayError(err);
    }

    return {
      sessionId: session.sessionId,
      streamToken: session.streamToken,
      relayWsUrl: session.relayWsUrl,
      ticket: issueLiveTicket(
        { sessionId: session.sessionId, draftId: draft.id },
        secretKey,
      ),
    };
  }

  /**
   * Завершение живой сессии (§7.4.5) — и сразу ОБЫЧНЫЙ раунд поверх
   * добытых кук.
   *
   * Второе здесь не украшение: без него ответ не содержал бы никакого
   * `PageExploration`, и визарду нечем было бы продолжить — экран не
   * может отрисовать форму следующей страницы без свежих `elements`, а
   * лента предпросмотра осталась бы без кадра (§15 п.2 аудита ТЗ). Так
   * живой вход становится полноценным раундом наравне с
   * `/explore`/`/step`, а не исключением из модели «раунд ↔ кадр».
   */
  async completeLiveLogin(
    userId: string,
    projectId: string,
    input: { ticket: string; expectedVersion: number },
  ): Promise<RoundResult> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    const state = this.toRoundsState(draft);
    assertRoundsConsistent(state);

    let sessionId: string;
    try {
      sessionId = readLiveTicket(
        input.ticket,
        { draftId: draft.id },
        this.requireSecretKey(),
      );
    } catch (err) {
      if (err instanceof LiveTicketError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    let result;
    try {
      result = await this.relay.fetchResult(sessionId);
    } catch (err) {
      throw this.relayError(err);
    }

    // §7.4.4 п.4 / §15.2: успешный ответ реле НЕ означает, что человек
    // довёл вход до конца — куки снимаются и по таймауту тоже.
    // Единственная проверка «вошёл или нет» — та же, что и была: сессия
    // обязана закончиться ТАМ, откуда начиналась. Временный визит на
    // чужой SSO-домен внутри сессии законен, выход с него — нет.
    try {
      assertSameSite(draft.baseUrl, result.finalUrl);
    } catch {
      await this.relay.cancelQuietly(sessionId);
      throw new BadRequestException(
        'похоже, вход не завершён: сессия закончилась на стороннем сайте. Войдите до конца и нажмите «Готово» на странице заказчика',
      );
    }

    // Тот же пропуск, что и в `/undo` (аудит этапа 116): `finalUrl`
    // приходит из ВНЕШНЕГО сервиса и открывается нашим браузером —
    // совпадение origin с `baseUrl` не говорит ничего о том, куда этот
    // хост резолвится сейчас.
    await this.assertSafeUrl(result.finalUrl);

    const cookiesEnc = this.encryptCookies(result.cookies);

    // Обычный раунд поверх только что добытой сессии — никаких
    // действий, только открыть авторизованную страницу и посмотреть.
    await this.reserveRound(userId);
    let round;
    try {
      round = await this.explorer.runRound({
        url: result.finalUrl,
        cookies: result.cookies,
        actions: [],
        allowedOrigin: draft.baseUrl,
      });
    } catch (err) {
      await this.usage.releaseRound(userId);
      throw err;
    }
    await this.assertStillInside(draft.baseUrl, round.exploration.currentUrl);

    // Маркерный шаг вместо буквальной последовательности: интерактивно
    // пройденную капчу или 2FA воспроизвести нельзя в принципе (§7.4.5),
    // и записывать «нажми сюда, потом сюда» было бы враньём. Селектор —
    // догадка по авторизованной странице, и это честно: сценарий всё
    // равно помечен `requiresLiveLoginReplay`, то есть автоматически
    // непересобираемым. Маркер нужен как подсказка «мы за экраном
    // входа», а не как контракт.
    const marker: ScenarioStep = {
      kind: 'assertVisible',
      selector: pickLoginProofSelector(round.exploration),
    };

    const next = appendRound(state, {
      steps: [marker],
      screenshot: round.exploration.screenshotDataUrl,
      live: true,
    });

    // Версия в `where` (аудит этапа 116). Без неё этот путь был
    // единственной мутацией модуля без оптимистичной блокировки, а он
    // же и самый долгий: между чтением черновика и записью проходят
    // поход в реле и полный раунд браузера. Раунд, сделанный в другой
    // вкладке за это время, затирался молча — вместе со своим кадром и
    // потраченным слотом лимита.
    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: {
        id: draft.id,
        version: input.expectedVersion,
        status: 'DRAFTING',
      },
      data: {
        steps: next.steps as object,
        stepsPerRound: next.stepsPerRound,
        roundScreenshots: next.roundScreenshots as object,
        lastUrl: round.exploration.currentUrl,
        requiresLiveLoginReplay: true,
        ...(cookiesEnc ? { cookiesEnc } : {}),
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) throw this.conflict();

    return {
      draft: this.toView(await this.requireDraft(projectId)),
      exploration: round.exploration,
    };
  }

  /** Текущее состояние черновика (§5.2 `GET`). Свежий
   * `PageExploration` здесь НЕ снимается — это сделает браузерная часть
   * этапа 112; пока отдаём накопленное состояние, которого достаточно
   * для восстановления ленты кадров после перезагрузки вкладки. */
  async getState(userId: string, projectId: string): Promise<DraftView | null> {
    await this.assertOwnProject(userId, projectId);
    const draft = await this.findDraft(projectId);
    return draft ? this.attachVideo(this.toView(draft)) : null;
  }

  /**
   * Свежий снимок ТЕКУЩЕЙ страницы черновика, без записи чего-либо
   * (§5.2, абзац про `GET`).
   *
   * Зачем отдельный вызов, а не часть `GET`. Визард живёт кадром: без
   * свежего `PageExploration` нечего показать и не из чего собрать
   * форму следующего шага. Но снять его — это поднять Chromium, то есть
   * секунды и деньги, а `GET` зовётся на каждом открытии экрана, в том
   * числе чтобы просто посмотреть статус. Поэтому чтение состояния
   * осталось дешёвым, а снимок — отдельной, явной и осознанной
   * операцией, которая честно тратит слот суточного лимита, как любой
   * другой раунд.
   *
   * Ничего не пишет: ни шага, ни кадра, ни версии. Это именно
   * «посмотреть заново», а не раунд визарда — иначе перезагрузка
   * вкладки дописывала бы в сценарий пустые шаги.
   */
  async refresh(userId: string, projectId: string): Promise<RoundResult> {
    const { draft } = await this.loadEditableDraft(userId, projectId);
    const url = draft.lastUrl ?? draft.baseUrl;
    await this.assertSafeUrl(url);
    assertSameSite(draft.baseUrl, url);

    await this.reserveRound(userId);
    let round;
    try {
      round = await this.explorer.runRound({
        url,
        cookies: this.decryptCookies(draft.cookiesEnc),
        actions: [],
        allowedOrigin: draft.baseUrl,
      });
    } catch (err) {
      await this.usage.releaseRound(userId);
      throw err;
    }
    await this.assertStillInside(draft.baseUrl, round.exploration.currentUrl);

    return { draft: this.toView(draft), exploration: round.exploration };
  }

  /** Возврат отклонённого черновика в работу (§5.2 `/resume`, §14 п.10). */
  async resume(userId: string, projectId: string): Promise<DraftView> {
    await this.assertOwnProject(userId, projectId);
    const draft = await this.requireDraft(projectId);
    if (draft.status !== 'REJECTED') {
      throw new ConflictException(
        'вернуть в работу можно только черновик, отклонённый оператором',
      );
    }
    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draft.id, version: draft.version, status: 'REJECTED' },
      data: {
        status: 'DRAFTING',
        rejectionReason: null,
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) throw this.conflict();
    return this.toView(await this.requireDraft(projectId));
  }

  /** Удаление черновика целиком (§5.2 `DELETE`) — единственный способ
   * сменить сайт: `baseUrl` фиксируется навсегда первым `/explore`. */
  async remove(userId: string, projectId: string): Promise<void> {
    await this.assertOwnProject(userId, projectId);
    const draft = await this.findDraft(projectId);
    if (!draft) return;
    // Кадры стираются ДО строки БД (§15 п.4): после удаления строки
    // `draftId` больше неоткуда взять, и префикс в Blob осиротеет
    // навсегда — ровно то, чего требование §9 «не копить брошенные
    // файлы» и хотело избежать.
    //
    // ВСЕГДА, а не только при `previewFrameCount !== null` (аудит этапа
    // 116): счётчик проставляется последним, уже после заливки, и
    // оборвавшийся на середине `/finish` оставляет файлы при пустом
    // счётчике. Лишний вызов по пустому префиксу стоит одного запроса
    // к хранилищу, потерянные навсегда кадры авторизованного кабинета
    // — заметно дороже.
    await this.wipeFrames(draft.id);
    await this.prisma.clientSiteTutorialDraft.deleteMany({
      where: { projectId },
    });
  }

  // ── внутреннее ──────────────────────────────────────────────────────

  /** Общая часть `/step` и `/login`: выполнить раунд в браузере и
   * записать результат под оптимистичной блокировкой. */
  private async runAndPersist(
    userId: string,
    draft: DraftRow,
    expectedVersion: number,
    actions: RoundAction[],
    steps: ScenarioStep[],
    extra: { credentialsEnc?: string } = {},
  ): Promise<RoundResult> {
    const state = this.toRoundsState(draft);
    assertRoundsConsistent(state);

    const url = draft.lastUrl ?? draft.baseUrl;
    await this.assertSafeUrl(url);
    assertSameSite(draft.baseUrl, url);

    // Версия занимается ДО браузера — см. `claimRound`. Повтор того же
    // запроса (оборвалась связь, клиент сдался по таймауту) иначе
    // нажимал бы кнопку на сайте заказчика ВТОРОЙ раз.
    const claimed = await this.claimRound(draft, expectedVersion);

    await this.reserveRound(userId);
    let round;
    try {
      round = await this.explorer.runRound({
        url,
        cookies: this.decryptCookies(draft.cookiesEnc),
        actions,
        allowedOrigin: draft.baseUrl,
      });
    } catch (err) {
      await this.usage.releaseRound(userId);
      throw err;
    }
    await this.assertStillInside(draft.baseUrl, round.exploration.currentUrl);

    let next: DraftRoundsState;
    try {
      next = appendRound(state, {
        steps,
        screenshot: round.exploration.screenshotDataUrl,
      });
    } catch (err) {
      if (err instanceof DraftStepLimitError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draft.id, version: claimed, status: 'DRAFTING' },
      data: {
        steps: next.steps as object,
        stepsPerRound: next.stepsPerRound,
        roundScreenshots: next.roundScreenshots as object,
        lastUrl: round.exploration.currentUrl,
        cookiesEnc: this.encryptCookies(round.cookies),
        ...(extra.credentialsEnc
          ? { credentialsEnc: extra.credentialsEnc }
          : {}),
        version: { increment: 1 },
      },
    });
    if (claim.count === 0) throw this.conflict();

    return {
      draft: this.toView(await this.requireDraft(draft.projectId)),
      exploration: round.exploration,
    };
  }

  private async loadEditableDraft(
    userId: string,
    projectId: string,
  ): Promise<{ draft: DraftRow }> {
    await this.assertOwnProject(userId, projectId);
    await this.plans.assertUser(userId, 'siteTutorial');
    // См. `explore`: без ключа шифрования раунд не сохранить, и узнать
    // об этом надо до слота лимита и до запуска браузера.
    this.requireSecretKey();
    const draft = await this.requireDraft(projectId);
    try {
      assertEditable(draft.status);
    } catch (err) {
      if (err instanceof DraftStatusError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
    return { draft };
  }

  /** Владение проектом — тот же инлайн-запрос и тот же 404 вместо 403,
   * что у соседних модулей (`catalog-batch.service.ts`): чужой проект не
   * должен отличаться от несуществующего. `deletedAt: null` обязателен —
   * софт-delete, этап 89. */
  private async assertOwnProject(
    userId: string,
    projectId: string,
  ): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, userId, deletedAt: null },
      select: { id: true, type: true },
    });
    if (!project) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if (project.type !== 'CLIENT_SITE') {
      throw new BadRequestException(
        'обучалка по сайту доступна только в проектах типа «сайт заказчика»',
      );
    }
  }

  /**
   * Создание первого черновика. Уникальность `projectId` держит индекс
   * БД, а не проверка выше: между «черновика нет» и `create` помещается
   * второй запрос (двойное нажатие, ретрай по таймауту). Раньше такая
   * гонка отдавала generic 500 от Prisma вместо заготовленного 409 —
   * найдено аудитом этапа 116.
   */
  private async createDraft(
    data: Prisma.ClientSiteTutorialDraftUncheckedCreateInput,
  ): Promise<DraftRow> {
    try {
      return (await this.prisma.clientSiteTutorialDraft.create({
        data,
      })) as DraftRow;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException(
          'у этого проекта уже есть черновик обучалки — продолжите его или удалите',
        );
      }
      throw err;
    }
  }

  private async findDraft(projectId: string): Promise<DraftRow | null> {
    return (await this.prisma.clientSiteTutorialDraft.findUnique({
      where: { projectId },
    })) as DraftRow | null;
  }

  private async requireDraft(projectId: string): Promise<DraftRow> {
    const draft = await this.findDraft(projectId);
    if (!draft) {
      throw new NotFoundException('черновик обучалки ещё не начат');
    }
    return draft;
  }

  private async reserveRound(userId: string): Promise<void> {
    const ok = await this.usage.reserveRound(userId);
    if (!ok) {
      throw new ForbiddenException(
        `дневной лимит шагов визарда исчерпан (${this.usage.roundsLimit} в сутки) — продолжите завтра`,
      );
    }
  }

  /** §8.2 ТЗ: обязательный вызов перед КАЖДЫМ переходом, не только
   * первым. Сообщение guard'а написано под импорт фида, поэтому своё. */
  private async assertSafeUrl(url: string): Promise<void> {
    // Адрес с встроенными кредами (`https://qa:pass@staging.shop.com`)
    // — не экзотика, а обычный способ зайти на стенд за Basic-auth.
    // Такой адрес уезжает в `steps` как `goto` и оттуда — в ответы API
    // и на экран оператора, то есть пароль от чужого сайта оказался бы
    // в открытом виде в обход всего механизма `credentialsEnc`. Найдено
    // аудитом этапа 116; отказываем явно, а не вычищаем молча, — иначе
    // человек не поймёт, почему стенд не открывается.
    try {
      const parsed = new URL(url);
      if (parsed.username || parsed.password) {
        throw new BadRequestException(
          'уберите логин и пароль из самой ссылки: они сохранились бы в сценарии открытым текстом. Откройте страницу входа и введите данные на шаге входа',
        );
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Неразбираемый адрес — забота проверки ниже, у неё свой текст.
    }

    try {
      await assertPubliclyRoutableUrl(url);
    } catch (err) {
      if (err instanceof UnsafeExternalUrlError) {
        throw new BadRequestException(
          'этот адрес нельзя открыть: укажите публичную ссылку на сайт заказчика',
        );
      }
      throw err;
    }
  }

  /**
   * §8.1/§8.2: проверка ПОСЛЕ перехода — редирект мог увести за
   * пределы сайта заказчика.
   *
   * Вторая половина проверки появилась вместе с расширением замка до
   * регистрируемого домена (находка Т-4 аудита) и без неё расширение
   * было бы дырой, а не улучшением.
   *
   * Пока замок сравнивал origin точно, ЛЮБОЙ редирект на другой хост
   * отклонялся — и адрес, на который он вёл, до браузера как цель
   * раунда не доходил. Теперь редирект на соседний поддомен того же
   * сайта разрешён, а проверка «этот адрес вообще можно открывать с
   * нашего сервера» (§8.2, резолв DNS) делалась только для АДРЕСА,
   * который мы запрашивали сами. То есть владелец домена мог завести
   * `internal.example.com` → 10.0.0.5, увести туда редиректом и
   * получить раунд против нашей внутренней сети.
   *
   * Поэтому: сменился хост — адрес проверяется заново, как если бы его
   * ввели руками. Для обычного пути (`shop.` → `checkout.`) это один
   * лишний резолв на раунд, где и так поднимается Chromium.
   */
  private async assertStillInside(
    baseUrl: string,
    currentUrl: string,
  ): Promise<void> {
    try {
      assertSameSite(baseUrl, currentUrl);
    } catch (err) {
      if (err instanceof DomainLockError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    if (new URL(baseUrl).hostname !== new URL(currentUrl).hostname) {
      await this.assertSafeUrl(currentUrl);
    }
  }

  /**
   * Занимает раунд, СДВИГАЯ версию, — и делает это ДО того, как браузер
   * что-либо нажмёт на сайте заказчика.
   *
   * Зачем. Раньше версия проверялась только при записи результата, то
   * есть уже ПОСЛЕ клика. Клиент, у которого оборвалась связь или
   * истёк собственный таймаут (а серверная функция живёт дольше),
   * показывал ошибку и предлагал повторить — и повтор нажимал ту же
   * кнопку второй раз. Для «Оформить заказ» это второй настоящий заказ
   * на сайте заказчика, и ни ответ API, ни черновик этого не
   * показывали. Найдено аудитом этапа 116, отложено там же как
   * требующее отдельной работы; вот она.
   *
   * Отдельного идемпотентного ключа не заводится: версия УЖЕ есть в
   * контракте и уже обязательна во всех этих вызовах. Сдвинув её
   * первой, мы получаем ровно нужное поведение — повтор с тем же
   * `expectedVersion` получает 409 «шаг уже выполнялся», а не тихо
   * повторяет действие. Цена — неудачный раунд тоже сдвигает версию,
   * и клиент обязан перечитать состояние перед повтором; он это и так
   * делает с этапа 116.
   *
   * Возвращает новую версию: именно по ней пишется результат, иначе
   * запись не найдёт собственную строку.
   */
  private async claimRound(
    draft: DraftRow,
    expectedVersion: number,
  ): Promise<number> {
    const claim = await this.prisma.clientSiteTutorialDraft.updateMany({
      where: { id: draft.id, version: expectedVersion, status: 'DRAFTING' },
      data: { version: { increment: 1 } },
    });
    if (claim.count === 0) {
      throw new ConflictException(
        'этот шаг уже выполнялся — обновите экран и посмотрите, что получилось, прежде чем повторять: действие на сайте заказчика могло состояться',
      );
    }
    return expectedVersion + 1;
  }

  /** Ошибки реле — это «сейчас не получилось» и «начните заново», а не
   * 500: у каждой есть текст, который можно показать человеку. */
  private relayError(err: unknown): Error {
    if (err instanceof RelayNotConfiguredError) {
      return new ServiceUnavailableException(err.message);
    }
    if (err instanceof RelaySessionGoneError) {
      return new ConflictException(err.message);
    }
    if (err instanceof RelayUnavailableError) {
      return new ServiceUnavailableException(err.message);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  private conflict(): ConflictException {
    return new ConflictException(
      'черновик изменился в другой вкладке, обновите экран',
    );
  }

  private requireSecretKey(): string {
    const key = tutorialSecretKey();
    if (!key) {
      throw new BadRequestException(
        'SITE_TUTORIAL_TOKEN_KEY не настроен — сохранять тестовые креды некуда',
      );
    }
    return key;
  }

  /** Стирает ВЕСЬ префикс кадров черновика, а не файлы 0..n-1 по
   * известному счётчику: счётчик мог быть меньше, чем лежит на самом
   * деле (прошлый, более длинный прогон), и разница осталась бы
   * навсегда. */
  private async wipeFrames(draftId: string): Promise<void> {
    const prefix = draftFramePrefix(draftId);
    let cursor: string | undefined;
    do {
      const page = await this.blob.listByPrefix(prefix, { cursor });
      if (page.blobs.length > 0) {
        await this.blob.deleteMany(page.blobs.map((b) => b.pathname));
      }
      cursor = page.cursor ?? undefined;
    } while (cursor);
  }

  private async uploadFrames(
    draftId: string,
    frames: string[],
  ): Promise<number> {
    for (let i = 0; i < frames.length; i++) {
      const { buffer, contentType } = decodeFrameDataUrl(frames[i]);
      await this.blob.uploadBuffer(
        draftFramePathname(draftId, i),
        buffer,
        contentType,
      );
    }
    return frames.length;
  }

  /** Секретные значения полей входа по селектору — для переигровки
   * (§7.3). Нечитаемая запись не гасится пустым списком: молча войти
   * «наполовину» хуже, чем честно сказать, что креды потеряны. */
  private decryptSecretFields(
    enc: string | null,
  ): Array<{ selector: string; value: string }> {
    if (!enc) return [];
    return decryptCredentials(enc, this.requireSecretKey());
  }

  private decryptSecrets(enc: string | null): Record<string, string> {
    const map: Record<string, string> = {};
    for (const field of this.decryptSecretFields(enc)) {
      map[field.selector] = field.value;
    }
    return map;
  }

  private encryptCookies(cookies: CdpCookie[]): string | undefined {
    if (cookies.length === 0) return undefined;
    return encryptCookieJar(cookies, this.requireSecretKey());
  }

  private decryptCookies(enc: string | null): CdpCookie[] {
    if (!enc) return [];
    const { cookies, dropped } = decryptCookieJar(enc, this.requireSecretKey());
    if (dropped > 0) {
      this.logger.warn(
        `черновик обучалки: ${dropped} кук отброшено при восстановлении`,
      );
    }
    return cookies;
  }

  private toRoundsState(draft: DraftRow): DraftRoundsState {
    return {
      steps: Array.isArray(draft.steps) ? (draft.steps as ScenarioStep[]) : [],
      stepsPerRound: draft.stepsPerRound ?? [],
      roundScreenshots: Array.isArray(draft.roundScreenshots)
        ? (draft.roundScreenshots as string[])
        : [],
      requiresLiveLoginReplay: draft.requiresLiveLoginReplay,
    };
  }

  /** Наружу НИКОГДА не уходят `cookiesEnc`/`credentialsEnc` — даже
   * зашифрованными: у фронтенда нет ни одной причины их видеть, а
   * случайно залогировать ответ API проще, чем строку БД. */
  private toView(draft: DraftRow): DraftView {
    const state = this.toRoundsState(draft);
    return {
      id: draft.id,
      projectId: draft.projectId,
      baseUrl: draft.baseUrl,
      steps: state.steps,
      stepsPerRound: state.stepsPerRound,
      roundScreenshots: state.roundScreenshots,
      lastUrl: draft.lastUrl,
      requiresLiveLoginReplay: draft.requiresLiveLoginReplay,
      status: draft.status,
      title: draft.title,
      rejectionReason: draft.rejectionReason,
      previewFrameCount: draft.previewFrameCount,
      version: draft.version,
      hasCredentials: draft.credentialsEnc !== null,
      liveLoginAvailable: this.relay.configured(),
      // Дешёвое чтение состояния остаётся дешёвым: строку ролика
      // подбирает `attachVideo` и только там, где её реально покажут
      // (`GET`), — раунды визарда о готовом видео ничего не знают и
      // знать не могут, они работают с ещё не одобренным черновиком.
      video: null,
    };
  }

  /**
   * Подклеить к состоянию готовый ролик, если он уже есть.
   *
   * Отдельным запросом, а не `include`: связь `clientSiteDraftId` —
   * мягкая, не Prisma-связь (§6.2), и это осознанное решение спеки, а
   * не недоработка. Индекс под этот запрос заведён там же.
   *
   * `findFirst` + сортировка по убыванию даты, а не `findUnique`:
   * отклонённый черновик можно вернуть в работу и отправить на
   * одобрение заново (`/resume` → `/finish` → `approve`), и тогда строк
   * с одним `clientSiteDraftId` станет больше одной. Актуальна
   * последняя — она собрана из последней версии кадров.
   */
  private async attachVideo(view: DraftView): Promise<DraftView> {
    if (view.status !== 'APPROVED') return view;
    const asset = (await this.prisma.tutorialVideoAsset.findFirst({
      where: { clientSiteDraftId: view.id },
      orderBy: { createdAt: 'desc' },
      select: { assemblyStatus: true, blobUrl: true, durationMs: true },
    })) as {
      assemblyStatus: string;
      blobUrl: string | null;
      durationMs: number | null;
    } | null;
    if (!asset) return view;
    // `assemblyStatus` в схеме — свободная строка (тот же приём, что
    // `jobKey` у CronRunLog), поэтому неизвестное значение трактуется
    // как «ещё идёт», а не роняет ответ: пользователю «собирается»
    // безвреднее, чем ошибка на экране состояния.
    const status: TutorialVideoView['status'] =
      asset.assemblyStatus === 'complete' && asset.blobUrl
        ? 'complete'
        : asset.assemblyStatus === 'failed'
          ? 'failed'
          : 'pending';
    return {
      ...view,
      video: {
        status,
        // Ссылка отдаётся ТОЛЬКО в завершённом состоянии: у
        // `assemblyStatus='pending'` поле `blobUrl` пусто, а у
        // 'failed' может содержать частичный результат прошлой
        // попытки — отдать такую ссылку значит показать человеку
        // битый файл как готовый.
        url: status === 'complete' ? asset.blobUrl : null,
        durationMs: status === 'complete' ? asset.durationMs : null,
      },
    };
  }
}

/**
 * Селектор «мы за экраном входа» для маркерного шага. Берётся самый
 * устойчивый из того, что видно на авторизованной странице: элемент с
 * `id`/`data-testid` предпочтительнее пути по тегам, а поля ввода
 * предпочтительнее ссылок — навигация есть и на странице логина, а
 * форма кабинета обычно нет.
 *
 * Это ЭВРИСТИКА, и она такой и заявлена: черновик после живого входа
 * всё равно помечен `requiresLiveLoginReplay`, то есть автоматически
 * непересобираемым. Пустая страница — `body`: бессмысленно, но честно,
 * и лучше, чем шаг с пустым селектором.
 */
/**
 * Был ли последний раунд живым входом. Отдельной колонки под это нет и
 * не заводится: живой вход записывает РОВНО один шаг — маркер
 * `assertVisible` (§7.4.5), и раунд из одного такого шага ничем другим
 * быть не может. Обычные раунды пишут `fill`/`click`, `/explore` — `goto`.
 */
function lastRoundIsLiveMarker(state: {
  steps: ScenarioStep[];
  stepsPerRound: number[];
}): boolean {
  const size = state.stepsPerRound[state.stepsPerRound.length - 1];
  if (size !== 1) return false;
  const last = state.steps[state.steps.length - 1];
  return last?.kind === 'assertVisible';
}

/** Адрес первого шага сценария — с него начинается любая переигровка. */
function firstGotoRoute(steps: ScenarioStep[]): string | undefined {
  const first = steps[0];
  return first && first.kind === 'goto' ? first.route : undefined;
}

export function pickLoginProofSelector(exploration: PageExploration): string {
  const stable = exploration.elements.filter(
    (e) => !e.selector.includes(':nth-of-type('),
  );
  const pool = stable.length > 0 ? stable : exploration.elements;
  const byTag =
    pool.find((e) => e.tag === 'input' || e.tag === 'select') ??
    pool.find((e) => e.tag === 'button') ??
    pool[0];
  return byTag?.selector ?? 'body';
}

/** Реэкспорт для тестов/контроллера — чтобы не тянуть `draft-rounds`
 * напрямую туда, где нужна только ошибка отмены. */
export { UndoNotPossibleError };
