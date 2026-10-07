/**
 * Раунд исследователя обучалки на изолированном браузерном воркере
 * (Ш3-хвост (3); `TUTORIAL_EXPLORER_VIA_WORKER`) — та же граница
 * `PageExplorer`, что у `ChromiumPageExplorer`, но чужой JS исполняется НЕ в
 * функции генератора со всеми её секретами (К-2), а в воркере (песочница
 * Chromium, egress только через фильтрующий прокси, замок хостов, стоп-лист,
 * потолки трафика).
 *
 * ## Режим сайта решает, можно ли откатиться в функцию (аудит захода 7)
 *
 * **Подтверждённый сайт (режим A)** — как раньше: на воркер уходят переход,
 * ≤ 1 клик и вход учёткой реестра; ввод руками и переигровка — в функции;
 * любой отказ ДО исполнения (`WorkerFallbackError`) — раунд в функции.
 *
 * **Неподтверждённый сайт (режим B) или режим неизвестен** — чужой сайт сам
 * не должен выбирать «пусть откроет функция» (К-2 «на открытие»): добавить
 * поле ввода, кнопку «Оплатить», длинный селектор или упереться в лимит —
 * и раньше всё это возвращало раунд в функцию. Теперь:
 *  - ввод руками и переигровка (`/undo`) — тоже на воркере: значения полей
 *    (и пароли) — конвертами под ключ воркера, по одному на поле;
 *  - откат в функцию — ТОЛЬКО «воркер выключен» (409
 *    `BROWSER_WORKER_DISABLED`, канал не настроен) или «не взял задание за
 *    `queueWaitMs` и оно отменено, пока ждало»;
 *  - всё прочее — ошибка человеку: стоп-лист — 409
 *    `SITE_TUTORIAL_CLICK_REFUSED`, лимит — 429 с тем же кодом, отказ
 *    разбора — 400, недоступность воркера — 503 «временно недоступно».
 *
 * Режим — по кабинету сайтов (`host-status` по telegramId ведущего
 * черновик); нет telegramId или кабинет не ответил — считается B
 * (безопасная сторона).
 *
 * ## Сессия и ответ
 *
 * cookie jar — конвертом под открытый ключ воркера (ключ — у sites-backend,
 * кэш 5 минут); ответ (полный адрес с query и новая сессия) — конвертом под
 * одноразовый ключ раунда, закрытая половина которого живёт только в
 * памяти этого вызова. AAD всех конвертов — nonce, ключ ответа и хосты замка.
 */
import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { CdpCookie, parseCookieJar } from '../../common/cookie-jar';
import {
  SitesNotConfiguredError,
  SitesRejectedError,
  sitesTelegramId,
  type SitesHostStatus,
} from '../sites-internal/sites-internal.client';
import {
  type ExploreElementDto,
  type ExploreRequestBody,
  type ExploreStatus,
  SitesTutorialWorkerClient,
} from '../sites-internal/sites-tutorial-frames.client';
import { dangerWarningFor } from './danger-words';
import { DomainLockError, assertSameSite } from './draft-rounds';
import { redirectWarningFor } from './foreign-frame-settle';
import { PageElement, PageExploration } from './page-exploration.types';
import {
  ExploreRoundRequest,
  ExploreRoundResult,
  PageExplorer,
  ReplayRequest,
} from './page-explorer';
import { LoginFieldsNotFoundError } from './registry-login';
import {
  type ExploreAadParts,
  ephemeralReplyKeys,
  exploreFillAad,
  exploreLockHosts,
  exploreReplyAad,
  exploreSessionAad,
  sealTo,
} from './worker-session-seal';

/** Раунд не исполнялся на воркере — выполнить его в функции, как раньше. */
export class WorkerFallbackError extends Error {
  constructor(readonly reason: string) {
    super(`раунд остаётся в функции: ${reason}`);
    this.name = 'WorkerFallbackError';
  }
}

/** Стоп-лист воркера: цель «никогда» на неподтверждённом сайте (409). */
export const CLICK_REFUSED = 'SITE_TUTORIAL_CLICK_REFUSED';
/** Воркер недоступен, а откатываться в функцию нельзя (режим B; 503). */
export const WORKER_UNAVAILABLE = 'SITE_TUTORIAL_WORKER_UNAVAILABLE';

/** Потолок конверта сессии в параметрах (`WORKER_LIMITS.sessionSealedChars`). */
export const SESSION_SEALED_MAX = 200_000;
/** Полей ввода за раунд и шагов переигровки (`WORKER_LIMITS`). */
export const FILLS_MAX = 10;
export const REPLAY_STEPS_MAX = 30;
const KEY_TTL_MS = 5 * 60_000;

export interface WorkerExplorerOptions {
  /** Сколько ждать, пока воркер возьмёт задание; дольше — отмена и функция. */
  queueWaitMs: number;
  /** Весь раунд у вызывающего (как `CLIENT_ROUND_BUDGET_MS` функции). */
  budgetMs: number;
  /** Переигровка (`/undo`): до 30 шагов подряд. */
  replayBudgetMs: number;
  pollMs: number;
}

export const DEFAULT_WORKER_EXPLORER_OPTIONS: WorkerExplorerOptions = {
  queueWaitMs: 8_000,
  budgetMs: 70_000,
  replayBudgetMs: 140_000,
  pollMs: 700,
};

/** Режим сайта для выбора «откат или ошибка» (только `host-status`). */
export interface HostModeSource {
  hostStatus(telegramId: string, url: string): Promise<SitesHostStatus>;
}

/** Ключ человека для лимитов воркера: telegramId или отпечаток сайта. */
export function exploreSubject(req: {
  requester?: { telegramId: string };
  allowedOrigin: string;
}): string {
  const tg = sitesTelegramId(req.requester?.telegramId ?? null);
  if (tg) return `tg-${tg}`;
  const h = createHash('sha256').update(req.allowedOrigin).digest('hex');
  return `o-${h.slice(0, 24)}`;
}

function withDanger(e: PageElement): PageElement {
  const danger = dangerWarningFor(e.visibleText ?? e.label);
  return danger ? { ...e, danger } : e;
}

const unavailable = (
  message = 'изолированный браузер временно недоступен — повторите шаг чуть позже',
) =>
  new ServiceUnavailableException({
    error: WORKER_UNAVAILABLE,
    code: WORKER_UNAVAILABLE,
    message,
  });

/** Что отправить воркеру: тело задания без конвертов значений и ответа. */
interface WorkerPlan {
  url: string;
  allowedOrigin: string;
  /** Адреса, чьи хосты — замок (для AAD; sites-backend считает тот же набор). */
  lockUrls: string[];
  cookies: CdpCookie[];
  clicks: string[];
  fills: Array<{ selector: string; value: string }>;
  replay: Array<
    | { kind: 'goto'; url: string }
    | { kind: 'fill'; selector: string; value: string; passwordOnly: boolean }
    | { kind: 'click'; selector: string }
  > | null;
  registry: ExploreRequestBody['registry'];
  requester?: { telegramId: string };
  /** Для результата: что нажато последним, откуда шли. */
  clicked: string | undefined;
  budgetMs: number;
}

export class WorkerPageExplorer implements PageExplorer {
  private readonly logger = new Logger(WorkerPageExplorer.name);
  private key: { value: string; until: number } | null = null;

  constructor(
    private readonly client: SitesTutorialWorkerClient,
    private readonly opts: WorkerExplorerOptions = DEFAULT_WORKER_EXPLORER_OPTIONS,
    private readonly modes: HostModeSource | null = null,
  ) {}

  /** Часы и сон — методами (тесты). */
  protected now(): number {
    return Date.now();
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Почему раунд режима A не для воркера (или `null` — для воркера). */
  static ineligible(req: ExploreRoundRequest): string | null {
    if (req.actions.some((a) => a.kind === 'fill')) return 'ввод руками';
    if (req.actions.length > 1) return 'больше одного действия';
    if (req.autoLogin && !req.autoLogin.registry)
      return 'вход без учётки реестра';
    if (req.autoLogin && req.actions.length) return 'вход с действиями';
    return null;
  }

  /**
   * Подтверждён ли сайт (режим A) — по кабинету сайтов. Нет telegramId,
   * кабинет не настроен или не ответил — «нет» (строгий путь).
   */
  private async confirmed(
    telegramId: string | undefined,
    url: string,
  ): Promise<boolean> {
    const tg = sitesTelegramId(telegramId ?? null);
    if (!tg || !this.modes) return false;
    try {
      return (await this.modes.hostStatus(tg, url)).mode === 'A';
    } catch {
      return false;
    }
  }

  private async sealKey(): Promise<string> {
    if (this.key && this.key.until > this.now()) return this.key.value;
    const { publicKey } = await this.client.exploreSealKey();
    this.key = { value: publicKey, until: this.now() + KEY_TTL_MS };
    return publicKey;
  }

  async runRound(request: ExploreRoundRequest): Promise<ExploreRoundResult> {
    const tg =
      request.requester?.telegramId ?? request.autoLogin?.registry?.telegramId;
    const strict = !(await this.confirmed(tg, request.allowedOrigin));
    if (!strict) {
      const why = WorkerPageExplorer.ineligible(request);
      if (why) throw new WorkerFallbackError(why);
    } else if (request.autoLogin && !request.autoLogin.registry) {
      throw new ConflictException(
        'вход учёткой — только для подтверждённого сайта',
      );
    }
    const fills = request.actions.filter((a) => a.kind === 'fill');
    const clicks = request.actions.filter((a) => a.kind === 'click');
    if (clicks.length > 1 || fills.length > FILLS_MAX) {
      throw new BadRequestException(
        'слишком много действий за шаг для изолированного браузера',
      );
    }
    const last = request.actions[request.actions.length - 1];
    const reg = request.autoLogin?.registry;
    const pick = request.autoLogin?.pick;
    return this.execute(
      {
        url: request.url,
        allowedOrigin: request.allowedOrigin,
        lockUrls: [request.url, request.allowedOrigin],
        cookies: request.cookies,
        clicks: clicks.map((a) => a.selector),
        fills: fills.map((a) => ({
          selector: a.selector,
          value: (a as { value: string }).value,
        })),
        replay: null,
        registry: reg
          ? {
              telegramId: reg.telegramId,
              testAccountId: reg.testAccountId,
              needUsername: !!request.autoLogin?.username,
              pick: pick
                ? {
                    usernameSelector: pick.usernameSelector ?? null,
                    passwordSelector: pick.passwordSelector ?? null,
                    submitSelector: pick.submitSelector ?? null,
                  }
                : null,
            }
          : undefined,
        requester: request.requester,
        clicked: last?.kind === 'click' ? last.selector : undefined,
        budgetMs: this.opts.budgetMs,
      },
      strict,
      request.url,
    );
  }

  /**
   * Переигровка (`/undo`): в режиме A — в функции, как раньше; в B (или
   * режим неизвестен) — на воркере, значения шагов (и пароли) — конвертами.
   * Вызывающий режим не сообщает (переигровке `requester` не передаётся) —
   * значит строгий путь.
   */
  async replay(request: ReplayRequest): Promise<ExploreRoundResult> {
    const tg = request.requester?.telegramId;
    if (await this.confirmed(tg, request.allowedOrigin)) {
      throw new WorkerFallbackError('переигровка подтверждённого сайта');
    }
    const [first] = request.steps;
    if (!first || first.kind !== 'goto') {
      throw new BadRequestException(
        'сценарий черновика повреждён: первый шаг обязан быть переходом на исходную страницу',
      );
    }
    const steps: NonNullable<WorkerPlan['replay']> = [];
    const lockUrls = [request.allowedOrigin];
    let clicked: string | undefined;
    for (const st of request.steps) {
      if (st.kind === 'goto') {
        const url = new URL(st.route, request.allowedOrigin).toString();
        lockUrls.push(url);
        steps.push({ kind: 'goto', url });
      } else if (st.kind === 'fill') {
        const secret = request.secrets[st.selector];
        if (st.value === '' && secret === undefined) {
          throw new BadRequestException(
            `для поля ${st.selector} не сохранены учётные данные — переиграть вход нечем`,
          );
        }
        steps.push({
          kind: 'fill',
          selector: st.selector,
          value: st.value === '' ? secret! : st.value,
          passwordOnly:
            st.value === '' && !!request.passwordOnly?.includes(st.selector),
        });
      } else if (st.kind === 'click') {
        steps.push({ kind: 'click', selector: st.selector });
        clicked = st.selector;
      }
      // Прочие виды шагов визард не исполняет (как в функции).
    }
    if (steps.length > REPLAY_STEPS_MAX) {
      throw new BadRequestException(
        'сценарий длиннее, чем переигрывает изолированный браузер',
      );
    }
    const url = (steps[0] as { url: string }).url;
    return this.execute(
      {
        url,
        allowedOrigin: request.allowedOrigin,
        lockUrls,
        cookies: [],
        clicks: [],
        fills: [],
        replay: steps,
        registry: undefined,
        clicked,
        budgetMs: this.opts.replayBudgetMs,
      },
      true,
      url,
    );
  }

  /** Отказ при постановке: откат только «воркер выключен/не настроен». */
  private setupFailure(err: unknown, strict: boolean): Error {
    if (err instanceof WorkerFallbackError) return err;
    if (err instanceof HttpException) return err;
    if (err instanceof SitesNotConfiguredError) {
      return new WorkerFallbackError('канал воркера не настроен');
    }
    if (err instanceof SitesRejectedError) {
      if (err.code === 'BROWSER_WORKER_DISABLED') {
        return new WorkerFallbackError(err.code);
      }
      if (!strict) return new WorkerFallbackError(err.code);
      if (err.status === 429) {
        return new HttpException(
          { error: err.code, code: err.code, message: err.message },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (err.status === 400 || err.status === 409) {
        return new BadRequestException({
          error: err.code,
          code: err.code,
          message: 'изолированный браузер не принял этот шаг',
        });
      }
      return unavailable();
    }
    return strict
      ? unavailable()
      : new WorkerFallbackError('постановка не удалась');
  }

  private async execute(
    plan: WorkerPlan,
    strict: boolean,
    requestedUrl: string,
  ): Promise<ExploreRoundResult> {
    const startedAt = this.now();
    const reply = ephemeralReplyKeys();
    const nonce = randomBytes(24).toString('base64url');
    const subject = exploreSubject({
      requester: plan.requester,
      allowedOrigin: plan.allowedOrigin,
    });
    const telegramId = plan.registry?.telegramId;
    let parts: ExploreAadParts;
    let jobId: string;
    try {
      parts = {
        nonce,
        replyKey: reply.publicKey,
        allowedHosts: exploreLockHosts(plan.lockUrls),
      };
      const pub = await this.sealKey();
      const seal = (value: string, aad: string): string => {
        const buf = Buffer.from(value, 'utf8');
        try {
          return sealTo(pub, buf, aad);
        } finally {
          buf.fill(0);
        }
      };
      let session: string | null = null;
      if (plan.cookies.length) {
        session = seal(JSON.stringify(plan.cookies), exploreSessionAad(parts));
        if (session.length > SESSION_SEALED_MAX) {
          if (!strict)
            throw new WorkerFallbackError('сессия больше потолка очереди');
          throw new BadRequestException(
            'сессия сайта слишком большая для изолированного браузера — войдите заново',
          );
        }
      }
      const body: ExploreRequestBody = {
        subject,
        url: plan.url,
        allowedOrigin: new URL(plan.allowedOrigin).origin,
        clicks: plan.clicks,
        fills: plan.fills.map((f, i) => ({
          selector: f.selector,
          value: seal(f.value, exploreFillAad(parts, i)),
        })),
        replay: plan.replay
          ? plan.replay.map((st, i) =>
              st.kind === 'fill'
                ? { ...st, value: seal(st.value, exploreFillAad(parts, i)) }
                : st,
            )
          : null,
        session,
        replyKey: reply.publicKey,
        nonce,
        videoFrame: true,
        ...(plan.registry ? { registry: plan.registry } : {}),
      };
      jobId = (await this.client.exploreRequest(body)).jobId;
    } catch (err) {
      throw this.setupFailure(err, strict);
    }
    const st = await this.waitDone(
      subject,
      jobId,
      telegramId,
      startedAt,
      strict,
      plan.budgetMs,
    );
    return this.toResult(plan, requestedUrl, st, reply.open, parts);
  }

  /**
   * Опрос до итога. Не взято воркером за `queueWaitMs` — отмена ожидающего
   * и функция (ничего не исполнялось); взято — ждём до бюджета, потом
   * отмена и 504 (повторять в функции нельзя: клик мог случиться).
   */
  private async waitDone(
    subject: string,
    jobId: string,
    telegramId: string | undefined,
    startedAt: number,
    strict: boolean,
    budgetMs: number,
  ): Promise<ExploreStatus> {
    let cancelTried = false;
    for (;;) {
      let st: ExploreStatus | null = null;
      try {
        st = await this.client.exploreStatus(subject, jobId, telegramId);
      } catch (err) {
        // Сбой опроса — не повод бросать раунд: следующий тик.
        this.logger.warn(
          `статус раунда на воркере не получен: ${(err as Error).name}`,
        );
      }
      if (st?.status === 'done') return st;
      if (st && (st.status === 'failed' || st.status === 'cancelled')) {
        throw this.failure(st.errorCode, st.startedAt !== null, strict);
      }
      const elapsed = this.now() - startedAt;
      if (elapsed > budgetMs) {
        await this.client
          .exploreCancel(subject, jobId, telegramId, true)
          .catch(() => null);
        throw new GatewayTimeoutException(
          'раунд на браузерном воркере не уложился в срок — сайт заказчика отвечает слишком медленно',
        );
      }
      if (
        st?.status === 'queued' &&
        st.startedAt === null &&
        elapsed > this.opts.queueWaitMs &&
        !cancelTried
      ) {
        cancelTried = true;
        const c = await this.client
          .exploreCancel(subject, jobId, telegramId)
          .catch(() => null);
        // Отменено, пока ждало, — воркер его не получит.
        if (c?.status === 'cancelled') {
          throw new WorkerFallbackError('воркер не взял раунд вовремя');
        }
        // Иначе воркер успел взять (или отмена не дошла) — ждём итога.
      }
      await this.sleep(this.opts.pollMs);
    }
  }

  /**
   * Код отказа воркера → откат (ничего не исполнено) или ошибка человеку.
   * В строгом режиме откат — только «воркер выключен / не брал задание».
   */
  private failure(
    code: string | null,
    started: boolean,
    strict: boolean,
  ): Error {
    if (!started && (code === 'worker_disabled' || code === 'cancelled')) {
      return new WorkerFallbackError(code);
    }
    switch (code) {
      case 'click_refused':
        return strict
          ? new ConflictException({
              error: CLICK_REFUSED,
              code: CLICK_REFUSED,
              message:
                'изолированный браузер не нажимает оплату, удаление и оформление заказа на неподтверждённом сайте — подтвердите сайт («Это мой сайт») или пропустите этот шаг',
            })
          : new WorkerFallbackError(code);
      case 'credentials_unavailable':
        return strict ? unavailable() : new WorkerFallbackError(code);
      case 'worker_disabled':
      case 'host_not_verified':
      case 'cancelled':
        return new ServiceUnavailableException(
          'браузерный воркер прервал раунд — повторите шаг',
        );
      case 'offhost_redirect':
        return new BadRequestException(
          'сайт увёл на другой адрес — шаг остановлен доменным замком',
        );
      case 'egress_blocked':
        return new BadRequestException(
          'страница обратилась к служебному адресу — открыть её нельзя',
        );
      case 'target_missing':
        return new BadRequestException(
          'кнопка не найдена или не кликается — выберите другой элемент',
        );
      case 'login_form_missing':
        return new LoginFieldsNotFoundError(['password']);
      case 'nav_timeout':
      case 'job_timeout':
        return new GatewayTimeoutException(
          'страница не открылась вовремя — сайт заказчика отвечает слишком медленно',
        );
      case 'traffic_limit':
      case 'too_large':
        return new ServiceUnavailableException(
          'страница слишком тяжёлая для обучалки',
        );
      default:
        return new ServiceUnavailableException(
          'не удалось открыть страницу сайта заказчика на браузерном воркере',
        );
    }
  }

  private async toResult(
    plan: WorkerPlan,
    requestedUrl: string,
    st: ExploreStatus,
    open: (sealed: string, aad: string) => Buffer,
    parts: ExploreAadParts,
  ): Promise<ExploreRoundResult> {
    const r = st.result;
    if (!r) {
      throw new ServiceUnavailableException(
        'браузерный воркер не вернул результат раунда',
      );
    }
    // Ответ: полный адрес (query — только здесь) и новая сессия.
    let currentUrl = r.currentUrl;
    let cookies: CdpCookie[] = [];
    let gotSession = false;
    if (r.reply) {
      try {
        const plain = open(r.reply, exploreReplyAad(parts));
        try {
          const ans = JSON.parse(plain.toString('utf8')) as {
            url?: unknown;
            cookies?: unknown;
          };
          if (typeof ans.url === 'string') {
            const u = new URL(ans.url);
            // Адрес ответа — тот же экран, что видел sites-backend.
            if (`${u.origin}${u.pathname}` === r.currentUrl)
              currentUrl = ans.url;
          }
          if (Array.isArray(ans.cookies)) {
            cookies = parseCookieJar(ans.cookies).cookies;
            gotSession = true;
          }
        } finally {
          plain.fill(0);
        }
      } catch (err) {
        this.logger.warn(`ответ воркера не открылся: ${(err as Error).name}`);
      }
    }
    if (!gotSession) {
      this.logger.warn(
        'воркер не сдал сессию раунда — следующий начнётся без неё',
      );
    }
    // Замок генератора — и здесь (воркер держит точные хосты, мы — сайт).
    try {
      assertSameSite(plan.allowedOrigin, currentUrl);
    } catch (err) {
      if (err instanceof DomainLockError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
    const link = (idx: number | null) =>
      idx === null ? undefined : st.artifacts.find((a) => a.idx === idx);
    const shot = link(r.screenshot);
    if (!shot) {
      throw new ServiceUnavailableException('кадр раунда не загрузился');
    }
    const preview = await this.client.fetchArtifact(shot.url);
    let videoFrameDataUrl: string | undefined;
    const vf = link(r.videoFrame);
    if (vf) {
      try {
        const png = await this.client.fetchArtifact(vf.url);
        if (png.contentType === 'image/png') {
          videoFrameDataUrl = `data:image/png;base64,${png.buffer.toString('base64')}`;
        }
      } catch (err) {
        // Как в функции: съёмочный кадр необязателен — ролик мягче на кадр.
        this.logger.warn(
          `съёмочный кадр с воркера не скачался: ${(err as Error).message}`,
        );
      }
    }
    const elements = r.elements.map((e: ExploreElementDto) =>
      withDanger(e as PageElement),
    );
    const clicked = plan.clicked ?? r.autoLogin?.submitSelector;
    let dangerWarning: string | undefined;
    if (clicked) {
      const still = elements.find((e) => e.selector === clicked);
      dangerWarning =
        dangerWarningFor(still?.visibleText) ?? dangerWarningFor(clicked);
    }
    const redirectWarning = redirectWarningFor(requestedUrl, currentUrl);
    const exploration: PageExploration = {
      currentUrl,
      screenshotDataUrl: `data:${preview.contentType};base64,${preview.buffer.toString('base64')}`,
      ...(videoFrameDataUrl ? { videoFrameDataUrl } : {}),
      elements,
      looksLikeLogin: r.looksLikeLogin,
      ...(dangerWarning ? { dangerWarning } : {}),
      ...(redirectWarning ? { redirectWarning } : {}),
    };
    return {
      exploration,
      cookies,
      sensitiveFill: r.sensitiveFill,
      ...(r.autoLogin ? { autoLogin: r.autoLogin } : {}),
    };
  }
}
