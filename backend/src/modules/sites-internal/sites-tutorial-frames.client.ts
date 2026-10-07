/**
 * Клиент браузерного воркера Ш3 для обучалки генератора (Ш3-хвост (3)):
 * кадры (`/internal/sites/tutorial/frames/*`) и раунд исследователя
 * (`/internal/sites/credentials/tutorial-explore/*`) — канал обучалки, HMAC
 * `SITES_TUTORIAL_HMAC_SECRET` (подпись — общий код
 * `common/sites-internal-signature.ts`, адрес и типы ошибок — как у
 * `SitesInternalClient`, сам он не меняется).
 *
 * Ошибки — типами (решает вызывающий): `SitesNotConfiguredError` (канал не
 * настроен), `SitesUnavailableError` (сеть, таймаут, 5xx, 401),
 * `SitesRejectedError` (4xx с кодом: 409 `BROWSER_WORKER_DISABLED`,
 * `TUTORIAL_FRAMES_MODE_A`, `TUTORIAL_EXPLORE_HOST`, 429 лимиты…).
 * Вызывающий на любом отказе ДО исполнения откатывается на Chromium в
 * функции — как было до воркера.
 *
 * Скачивание кадров — по подписанной ссылке приватного Blob (≤ 15 мин),
 * без редиректов, с таймаутом и потолком размера.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SITES_CALLER_TUTORIAL,
  isUsableSitesSecret,
  sitesSignatureHeaders,
} from '../../common/sites-internal-signature';
import {
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
  sitesBackendOrigin,
} from './sites-internal.client';

const CALL_TIMEOUT_MS = 8_000;
/** Тело `request` раунда несёт конверт сессии (до 200 КБ) — чуть дольше. */
const REQUEST_TIMEOUT_MS = 12_000;
const ARTIFACT_TIMEOUT_MS = 15_000;
/** Потолок артефакта воркера (`WORKER_LIMITS.artifactBytes`) с запасом. */
export const ARTIFACT_MAX_BYTES = 1_600_000;

export type FrameImage = 'jpeg' | 'png2x';

export interface WorkerJobStatus {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | string;
  errorCode: string | null;
  expiresAt: string;
}

export interface FramesStatus extends WorkerJobStatus {
  frames: Array<{
    idx: number;
    scrollY: number;
    url: string;
    linkExpiresAt: string;
    width: number | null;
    height: number | null;
  }>;
}

export interface ExploreElementDto {
  selector: string;
  tag: 'input' | 'select' | 'textarea' | 'button' | 'a';
  type?: string;
  label?: string;
  visibleText?: string;
  name?: string;
  autocomplete?: string;
  options?: Array<{ value: string; label: string }>;
  /** Ш4(5)-хвост: кандидаты селектора для карты интерфейса. */
  candidates?: Array<{
    kind: 'id' | 'test-id' | 'attr' | 'aria';
    selector: string;
    name?: string;
  }>;
}

export interface ExploreResultDto {
  currentUrl: string;
  elements: ExploreElementDto[];
  looksLikeLogin: boolean;
  screenshot: number;
  videoFrame: number | null;
  /** Конверт ответа под ключ раунда: `{ url, cookies }`. */
  reply: string | null;
  sensitiveFill: boolean;
  autoLogin: {
    usernameSelector: string | null;
    passwordSelector: string;
    submitSelector: string;
  } | null;
}

export interface ExploreStatus extends WorkerJobStatus {
  /** Воркер брал задание (`null` — не брал: на сайте ничего не исполнялось). */
  startedAt: string | null;
  result: ExploreResultDto | null;
  artifacts: Array<{
    idx: number;
    url: string;
    contentType: string;
    linkExpiresAt: string;
  }>;
}

export interface ExploreRequestBody {
  subject: string;
  url: string;
  allowedOrigin: string;
  clicks: string[];
  /** Ввод: значения — конвертами под ключ воркера (`exploreFillAad`). */
  fills: Array<{ selector: string; value: string }>;
  /** Переигровка (`/undo`) или null; значения ввода — конвертами. */
  replay: Array<
    | { kind: 'goto'; url: string }
    | { kind: 'fill'; selector: string; value: string; passwordOnly: boolean }
    | { kind: 'click'; selector: string }
  > | null;
  session: string | null;
  replyKey: string;
  nonce: string;
  videoFrame: boolean;
  registry?: {
    telegramId: string;
    testAccountId: string;
    needUsername: boolean;
    pick: {
      usernameSelector: string | null;
      passwordSelector: string | null;
      submitSelector: string | null;
    } | null;
  };
}

const EXPLORE = '/internal/sites/credentials/tutorial-explore';
const FRAMES = '/internal/sites/tutorial/frames';

@Injectable()
export class SitesTutorialWorkerClient {
  private readonly logger = new Logger(SitesTutorialWorkerClient.name);
  /** Тесты подменяют сеть, env и часы. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  configured(): boolean {
    return (
      !!sitesBackendOrigin(this.env) &&
      isUsableSitesSecret(this.env.SITES_TUTORIAL_HMAC_SECRET)
    );
  }

  // ── кадры ───────────────────────────────────────────────────────────

  framesRequest(
    telegramId: string,
    url: string,
    opts: { frames?: number; image?: FrameImage } = {},
  ): Promise<{ jobId: string; status: string }> {
    return this.post(
      `${FRAMES}/request`,
      {
        telegramId,
        url,
        frames: opts.frames ?? 1,
        viewport: 'mobile',
        ...(opts.image ? { image: opts.image } : {}),
      },
      CALL_TIMEOUT_MS,
    );
  }

  framesStatus(telegramId: string, jobId: string): Promise<FramesStatus> {
    return this.post(
      `${FRAMES}/status`,
      { telegramId, jobId },
      CALL_TIMEOUT_MS,
    );
  }

  // ── раунд исследователя ─────────────────────────────────────────────

  exploreSealKey(): Promise<{ publicKey: string }> {
    return this.post(`${EXPLORE}/seal-key`, {}, CALL_TIMEOUT_MS);
  }

  exploreRequest(
    body: ExploreRequestBody,
  ): Promise<{ jobId: string; status: string; mode: 'A' | 'B' }> {
    return this.post(`${EXPLORE}/request`, body, REQUEST_TIMEOUT_MS);
  }

  exploreStatus(
    subject: string,
    jobId: string,
    telegramId?: string,
  ): Promise<ExploreStatus> {
    return this.post(
      `${EXPLORE}/status`,
      { subject, jobId, ...(telegramId ? { telegramId } : {}) },
      CALL_TIMEOUT_MS,
    );
  }

  /** Отменить раунд: по умолчанию — только ожидающий; `running` — и идущий. */
  exploreCancel(
    subject: string,
    jobId: string,
    telegramId?: string,
    running = false,
  ): Promise<{ jobId: string; status: string }> {
    return this.post(
      `${EXPLORE}/cancel`,
      {
        subject,
        jobId,
        ...(telegramId ? { telegramId } : {}),
        ...(running ? { running: true } : {}),
      },
      CALL_TIMEOUT_MS,
    );
  }

  /**
   * Скачать артефакт по подписанной ссылке: только https (или http на
   * localhost в разработке), без редиректов, ≤ `ARTIFACT_MAX_BYTES`,
   * сигнатура и тип — JPEG/PNG.
   */
  async fetchArtifact(
    url: string,
  ): Promise<{ buffer: Buffer; contentType: 'image/jpeg' | 'image/png' }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new SitesUnavailableError('ссылка на кадр воркера не разобралась');
    }
    if (
      u.protocol !== 'https:' &&
      !(u.protocol === 'http:' && u.hostname === 'localhost')
    ) {
      throw new SitesUnavailableError('ссылка на кадр воркера — не https');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ARTIFACT_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(u.toString(), {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new SitesUnavailableError(`кадр воркера: HTTP ${res.status}`);
      }
      const len = Number(res.headers.get('content-length') ?? '0');
      if (len > ARTIFACT_MAX_BYTES) {
        throw new SitesUnavailableError('кадр воркера больше потолка');
      }
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0 || buffer.length > ARTIFACT_MAX_BYTES) {
        throw new SitesUnavailableError('кадр воркера пуст или больше потолка');
      }
      if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
        return { buffer, contentType: 'image/jpeg' };
      }
      if (
        buffer
          .subarray(0, 8)
          .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ) {
        return { buffer, contentType: 'image/png' };
      }
      throw new SitesUnavailableError('кадр воркера — не JPEG и не PNG');
    } catch (err) {
      if (err instanceof SitesUnavailableError) throw err;
      throw new SitesUnavailableError('кадр воркера не скачался');
    } finally {
      clearTimeout(timer);
    }
  }

  /** Подписанный POST — тот же приём и те же типы ошибок, что у `SitesInternalClient`. */
  private async post<T>(
    path: string,
    payload: unknown,
    timeoutMs: number,
  ): Promise<T> {
    const base = sitesBackendOrigin(this.env);
    const secret = this.env.SITES_TUTORIAL_HMAC_SECRET?.trim();
    if (!base || !isUsableSitesSecret(secret)) {
      throw new SitesNotConfiguredError();
    }
    const body = JSON.stringify(payload);
    const headers = sitesSignatureHeaders(secret, {
      caller: SITES_CALLER_TUTORIAL,
      method: 'POST',
      path,
      body,
      unixSeconds: Math.floor(this.now().getTime() / 1000),
      requestId: randomUUID(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    let json: {
      data?: T;
      error?: { code?: string; message?: string };
    } | null;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method: 'POST',
        signal: controller.signal,
        // Подписанный запрос не переотправляется на чужой адрес.
        redirect: 'error',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body,
      });
      json = (await res.json().catch(() => null)) as typeof json;
    } catch (err) {
      this.logger.warn(
        `sites-backend не ответил на ${path}: ${(err as Error).name}`,
      );
      throw new SitesUnavailableError('кабинет сайтов сейчас не отвечает');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const code = json?.error?.code ?? 'SITES_BACKEND_ERROR';
      this.logger.warn(
        `sites-backend ответил ${res.status} ${code} на ${path}`,
      );
      if (res.status >= 400 && res.status < 500 && res.status !== 401) {
        throw new SitesRejectedError(
          res.status,
          code,
          json?.error?.message ?? 'запрос отклонён',
        );
      }
      throw new SitesUnavailableError(
        'кабинет сайтов сейчас не отвечает',
        res.status >= 500 ? code : null,
      );
    }
    if (!json || json.data === undefined) {
      throw new SitesUnavailableError('кабинет сайтов ответил без данных');
    }
    return json.data;
  }
}
