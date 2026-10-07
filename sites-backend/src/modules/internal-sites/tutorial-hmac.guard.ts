/**
 * Гвард внутреннего API обучалки генератора (Э-С Ш1, П-С3).
 *
 * Секрет — `SITES_TUTORIAL_HMAC_SECRET` (≥ 32 символа), ОТДЕЛЬНЫЙ от
 * `SITES_INTERNAL_SECRET` вкладки «Помощник» админки (Э4):
 *  - разные полномочия: админка смотрит и правит тарифы кабинетов от имени
 *    оператора, обучалка действует от имени ЛЮБОГО telegramId (находит и
 *    создаёт кабинет, регистрирует хост) — утечка одного секрета не должна
 *    давать другое;
 *  - разные способы: здесь секрет по сети не ходит (HMAC тела с меткой
 *    времени и id), у админки — заголовок-токен; общий секрет сделал бы
 *    HMAC-канал не сильнее заголовочного: перехваченный заголовок админки
 *    подписывал бы и запросы обучалки;
 *  - ротация по отдельности (П-С3: «отдельный секрет на направление»).
 *
 * Нет секрета или он совпал с любым другим секретом процесса (аудит Н-2,
 * `config/internal-secrets-distinct.ts`) — маршруты ЗАКРЫТЫ (503), а не
 * открыты. Подпись не сошлась,
 * метка вне окна ±5 мин, id уже был — 401 с машинным кодом (генератор
 * переводит это в режим B, а не роняет обучалку).
 *
 * Тело приходит СТРОКОЙ (`app.setup.ts`: сырой текст на `/internal/sites`):
 * подпись считается по байтам, которые прислал генератор, а JSON
 * разбирается только ПОСЛЕ проверки — `req.internalBody`.
 */
import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  SITES_CALLER_TUTORIAL,
  isUsableSitesSecret,
  verifySitesRequest,
} from '../../shared/sites-internal-signature';
import { InternalRequestLedger } from './request-ledger';
import { internalSecretCollision } from '../../config/internal-secrets-distinct';

/** Совпадение секретов пишется в лог один раз на пару переменных (не на каждый запрос). */
const loggedCollisions = new Set<string>();

export type InternalRequest = Request & { internalBody?: unknown };

export const INTERNAL_SITES_BODY_LIMIT_BYTES = 8 * 1024;
/**
 * Э-С Ш2: маршруты хранилища учётных данных несут куки сессии (до 256 КБ
 * открытого текста, `CREDENTIAL_MAX_BYTES`) — свой потолок, остальные
 * маршруты остаются на 8 КБ.
 */
export const INTERNAL_CREDENTIALS_PATH = '/internal/sites/credentials';
export const INTERNAL_CREDENTIALS_BODY_LIMIT_BYTES = 320 * 1024;

/**
 * Э-С Ш4: карта интерфейса от Flow-QA — до 60 элементов с кандидатами
 * селектора (≈ 30–40 КБ) — свой потолок.
 */
export const INTERNAL_QA_UI_MAP_PATH = '/internal/sites/qa/ui-map';
export const INTERNAL_QA_UI_MAP_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * Ш5(5): полный набор роликов сайта от генератора — до 60 (10 шагов × 5
 * языков с запасом, `SYNC_VIDEOS_MAX`; ролик до ~650 байт ≈ 40 КБ) — свой
 * потолок.
 */
export const INTERNAL_SITE_VIDEOS_PATH = '/internal/sites/tutorial/site-videos';
export const INTERNAL_SITE_VIDEOS_BODY_LIMIT_BYTES = 64 * 1024;

export function internalBodyLimit(path: string): number {
  if (path === INTERNAL_SITE_VIDEOS_PATH)
    return INTERNAL_SITE_VIDEOS_BODY_LIMIT_BYTES;
  if (
    path === INTERNAL_QA_UI_MAP_PATH ||
    path.startsWith(`${INTERNAL_QA_UI_MAP_PATH}/`)
  )
    return INTERNAL_QA_UI_MAP_BODY_LIMIT_BYTES;
  return path === INTERNAL_CREDENTIALS_PATH ||
    path.startsWith(`${INTERNAL_CREDENTIALS_PATH}/`)
    ? INTERNAL_CREDENTIALS_BODY_LIMIT_BYTES
    : INTERNAL_SITES_BODY_LIMIT_BYTES;
}

function err(
  Ctor: new (body: Record<string, unknown>) => HttpException,
  code: string,
  message: string,
): HttpException {
  return new Ctor({ error: code, code, message });
}

@Injectable()
export class TutorialHmacGuard implements CanActivate {
  /** Тесты подменяют env и часы. */
  env: NodeJS.ProcessEnv = process.env;
  now: () => Date = () => new Date();
  /**
   * Секрет и вызывающий направления (Э-С Ш4: Flow-QA — свой секрет и свой
   * вызывающий, `QaHmacGuard`; П-С3 «отдельный секрет на направление»).
   */
  protected readonly secretEnv: string = 'SITES_TUTORIAL_HMAC_SECRET';
  protected readonly caller: string = SITES_CALLER_TUTORIAL;
  protected readonly product: string = 'обучалки';
  private readonly logger = new Logger('InternalHmacGuard');
  constructor(private readonly ledger: InternalRequestLedger) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<InternalRequest>();
    const secret = this.env[this.secretEnv]?.trim();
    if (!isUsableSitesSecret(secret)) {
      throw err(
        ServiceUnavailableException,
        'INTERNAL_NOT_CONFIGURED',
        `${this.secretEnv} не задан (≥ 32 символа) — внутренний API ${this.product} закрыт`,
      );
    }
    // Аудит Н-2: секрет направления не должен совпадать НИ с одним другим
    // секретом процесса (секрет другого направления, кроны, KEK учёток,
    // ключ «Админки» и его старые версии, секрет воркера, …) — как у воркера
    // (`internal-secrets-distinct.ts`). Совпал — закрыто, как без секрета;
    // в лог и ответ — только имена переменных, не значение.
    const other = internalSecretCollision(this.env, this.secretEnv, secret);
    if (other) {
      const message = `${this.secretEnv} совпадает с ${other} — внутренний API ${this.product} закрыт`;
      const key = `${this.secretEnv}=${other}`;
      if (!loggedCollisions.has(key)) {
        loggedCollisions.add(key);
        this.logger.error(`${message} (нужен свой секрет на направление)`);
      }
      throw err(
        ServiceUnavailableException,
        'INTERNAL_NOT_CONFIGURED',
        message,
      );
    }
    const raw = typeof req.body === 'string' ? req.body : '';
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (Buffer.byteLength(raw, 'utf8') > internalBodyLimit(path)) {
      throw err(
        BadRequestException,
        'INTERNAL_BAD_BODY',
        'Тело слишком большое',
      );
    }
    const now = this.now();
    const check = verifySitesRequest(secret, {
      method: req.method,
      path,
      body: raw,
      headers: req.headers,
      nowSeconds: Math.floor(now.getTime() / 1000),
      expectedCaller: this.caller,
    });
    if (!check.ok) {
      throw err(
        UnauthorizedException,
        `INTERNAL_SIGNATURE_${check.reason.toUpperCase()}`,
        'Подпись внутреннего запроса не принята',
      );
    }
    if (!(await this.ledger.claim(check.requestId, check.caller, path, now))) {
      throw err(
        UnauthorizedException,
        'INTERNAL_REPLAY',
        'Этот подписанный запрос уже выполнялся',
      );
    }
    if (raw) {
      try {
        req.internalBody = JSON.parse(raw) as unknown;
      } catch {
        throw err(BadRequestException, 'INTERNAL_BAD_BODY', 'Ожидается JSON');
      }
    } else {
      req.internalBody = undefined;
    }
    return true;
  }
}
