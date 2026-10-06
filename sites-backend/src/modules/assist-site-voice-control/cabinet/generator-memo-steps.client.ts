/**
 * Клиент генератора: шаги одобренной обучалки для черновика мемо (Э6-тер (к),
 * ТЗ помощника §5-бис.17 п.6 «генератор отдаёт шаги через внутренний API»).
 *
 * Направление «sites-backend → генератор» — ТОЛЬКО чтение, по явному
 * действию владельца/менеджера в TMA («Из обучалки → создать черновик»):
 *   GET {GENERATOR_INTERNAL_URL}/api/internal/client-site-tutorial/memo-steps/:siteId/:draftId
 * Подпись — общий код `shared/sites-internal-signature.ts`, секрет тот же,
 * что у канала генератора (`SITES_TUTORIAL_HMAC_SECRET`), вызывающий свой
 * (`sites-memo`, часть подписи). Почему не «генератор присылает сам»: канал
 * генератора `internal-sites` — лист графа и не может дотянуться до мемо и
 * тарифа (правила `internal-sites-scope`/`-leaf`), а хранить присланные
 * шаги до нажатия в TMA негде без новой таблицы.
 *
 * Ответ разбирается СТРОГО (генератор — другая система): неизвестные виды
 * шагов, лишние поля и длинные строки — отказ, а не «как-нибудь».
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  SITES_CALLER_MEMO,
  isUsableSitesSecret,
  sitesSignatureHeaders,
} from '../../../shared/sites-internal-signature';

const TIMEOUT_MS = 8_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PATH = /^\/[A-Za-z0-9\-._~%!$&'(),;=:@/]{0,299}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
const MAX_STEPS = 30;
const SELECTOR_MAX = 200;

export type TutorialStepField = 'text' | 'email' | 'phone' | 'number';

export type TutorialMemoStep =
  | { kind: 'navigate'; path: string }
  | { kind: 'click'; selector: string }
  | { kind: 'fill'; selector: string; field: TutorialStepField };

export interface TutorialMemoSteps {
  draftId: string;
  siteId: string;
  title: string | null;
  host: string;
  startPath: string | null;
  endPath: string | null;
  view: 'mobile' | 'desktop';
  requiresLogin: boolean;
  steps: TutorialMemoStep[];
  dropped: { login: number; foreign: number; other: number };
}

export class GeneratorNotConfiguredError extends Error {
  constructor() {
    super('GENERATOR_INTERNAL_URL / SITES_TUTORIAL_HMAC_SECRET не заданы');
    this.name = 'GeneratorNotConfiguredError';
  }
}

/** Сеть, таймаут, 5xx, 401 (подпись не принята), мусор в ответе. */
export class GeneratorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeneratorUnavailableError';
  }
}

/** Генератор отказал по существу: 404 (не найдена) / 422 (`reason`). */
export class GeneratorRefusedError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`генератор отказал: ${status} ${reason}`);
    this.name = 'GeneratorRefusedError';
  }
}

/** Адрес генератора: https (или localhost/имя сервиса compose). */
export function generatorOrigin(env: NodeJS.ProcessEnv): string | null {
  const raw = env.GENERATOR_INTERNAL_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' &&
      u.hostname !== 'localhost' &&
      u.hostname !== 'backend'
    )
      return null;
    return u.origin;
  } catch {
    return null;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

function only(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

const count = (v: unknown): number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1000 ? v : 0;

/** Строгий разбор ответа генератора; не годится — null. */
export function parseTutorialMemoSteps(
  raw: unknown,
  expect: { siteId: string; draftId: string },
): TutorialMemoSteps | null {
  if (!isObj(raw)) return null;
  if (raw.siteId !== expect.siteId || raw.draftId !== expect.draftId)
    return null;
  if (typeof raw.host !== 'string' || !HOST.test(raw.host)) return null;
  const path = (v: unknown): string | null | undefined =>
    v === null ? null : typeof v === 'string' && PATH.test(v) ? v : undefined;
  const startPath = path(raw.startPath);
  const endPath = path(raw.endPath);
  if (startPath === undefined || endPath === undefined) return null;
  if (raw.view !== 'mobile' && raw.view !== 'desktop') return null;
  if (typeof raw.requiresLogin !== 'boolean') return null;
  if (!Array.isArray(raw.steps) || raw.steps.length > MAX_STEPS) return null;
  const steps: TutorialMemoStep[] = [];
  for (const s of raw.steps) {
    if (!isObj(s)) return null;
    const sel =
      typeof s.selector === 'string' &&
      s.selector.length > 0 &&
      s.selector.length <= SELECTOR_MAX
        ? s.selector
        : null;
    if (s.kind === 'navigate' && only(s, ['kind', 'path'])) {
      const p = path(s.path);
      if (!p) return null;
      steps.push({ kind: 'navigate', path: p });
    } else if (s.kind === 'click' && sel && only(s, ['kind', 'selector'])) {
      steps.push({ kind: 'click', selector: sel });
    } else if (
      s.kind === 'fill' &&
      sel &&
      // Значения у шага нет и быть не может: поле `value` — отказ целиком.
      only(s, ['kind', 'selector', 'field']) &&
      (s.field === 'text' ||
        s.field === 'email' ||
        s.field === 'phone' ||
        s.field === 'number')
    ) {
      steps.push({ kind: 'fill', selector: sel, field: s.field });
    } else return null;
  }
  const d = isObj(raw.dropped) ? raw.dropped : {};
  return {
    draftId: expect.draftId,
    siteId: expect.siteId,
    title:
      typeof raw.title === 'string' && raw.title.length <= 200
        ? raw.title
        : null,
    host: raw.host,
    startPath,
    endPath,
    view: raw.view,
    requiresLogin: raw.requiresLogin,
    steps,
    dropped: {
      login: count(d.login),
      foreign: count(d.foreign),
      other: count(d.other),
    },
  };
}

@Injectable()
export class GeneratorMemoStepsClient {
  private readonly logger = new Logger(GeneratorMemoStepsClient.name);
  /** Тесты подменяют сеть, env и часы. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();

  configured(): boolean {
    return (
      !!generatorOrigin(this.env) &&
      isUsableSitesSecret(this.env.SITES_TUTORIAL_HMAC_SECRET)
    );
  }

  async memoSteps(siteId: string, draftId: string): Promise<TutorialMemoSteps> {
    const base = generatorOrigin(this.env);
    const secret = this.env.SITES_TUTORIAL_HMAC_SECRET?.trim();
    if (!base || !isUsableSitesSecret(secret))
      throw new GeneratorNotConfiguredError();
    if (!ID.test(siteId) || !ID.test(draftId))
      throw new GeneratorRefusedError(404, 'not_found');
    const path = `/api/internal/client-site-tutorial/memo-steps/${siteId}/${draftId}`;
    const headers = sitesSignatureHeaders(secret, {
      caller: SITES_CALLER_MEMO,
      method: 'GET',
      path,
      body: '',
      unixSeconds: Math.floor(this.now().getTime() / 1000),
      requestId: randomUUID(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res: Response;
    let json: {
      data?: unknown;
      error?: { code?: string; details?: { reason?: unknown } };
    } | null;
    try {
      res = await this.fetchImpl(`${base}${path}`, {
        method: 'GET',
        signal: controller.signal,
        headers,
        redirect: 'error',
      });
      json = (await res.json().catch(() => null)) as typeof json;
    } catch (e) {
      this.logger.warn(
        `генератор не ответил на memo-steps: ${(e as Error).name}`,
      );
      throw new GeneratorUnavailableError('генератор сейчас не отвечает');
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 404 || res.status === 422) {
      const reason = json?.error?.details?.reason;
      throw new GeneratorRefusedError(
        res.status,
        typeof reason === 'string' && /^[a-z_]{1,30}$/.test(reason)
          ? reason
          : 'not_found',
      );
    }
    if (!res.ok) {
      this.logger.warn(
        `генератор ответил ${res.status} ${json?.error?.code ?? ''} на memo-steps`,
      );
      throw new GeneratorUnavailableError('генератор вернул ошибку');
    }
    const parsed = parseTutorialMemoSteps(json?.data, { siteId, draftId });
    if (!parsed)
      throw new GeneratorUnavailableError('ответ генератора не разобран');
    return parsed;
  }
}
