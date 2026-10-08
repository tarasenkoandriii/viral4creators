/**
 * Сессия сотрудника «Админки» (ТЗ §5.1 7b, §4-бис.8; приёмка Э7: «JWT с
 * чужой подписью / истёкший / с `aud` другого сайта — отказ»).
 *
 * `POST /assist-admin/v1/session { pk, jwt }`:
 *  - сайт — по публичному ключу (тот же `data-site`, что у виджета);
 *  - режим включён и способ `script|both`, секрет подписи выпущен;
 *  - JWT проверяется секретом ЭТОГО сайта (identity-jwt.ts: только HS256,
 *    подпись за постоянное время, `exp ≤ 15 мин`, `aud = siteId`);
 *  - выдаётся НАША сессия: случайный токен (в базе — SHA-256), срок — не
 *    дольше `exp` JWT. Сессия привязана к (сайт, `sub`): состояние
 *    сотрудника находится только по ней (§4-бис.8), смена сотрудника — новая
 *    сессия и другой диалог.
 *
 * Никаких visitor-token, `resumeKey` и CHIPS-cookie «Сайта» здесь нет и
 * быть не может (У-18; граф admin↛site): маршруты `/assist-admin/*` читают
 * только заголовок своей сессии.
 */
import { createHash, createHmac, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX } from '../../brand';
import { SitesDb } from '../../prisma/sites-db.service';
import { adminError } from '../assist-admin-mode/admin-errors';
import { AdminModeService } from '../assist-admin-mode/admin-mode.service';
import {
  IdentityJwtError,
  employeeRefOfSub,
  verifyEmployeeJwt,
} from '../assist-admin-mode/identity-jwt';
import { parseRoleMap } from '../assist-admin-mode/admin-mode.service';

export interface AdminSessionView {
  session: string;
  expiresAt: string;
  sub: string;
  employee: { name: string | null; role: string | null };
  /** Плашка прозрачности: владелец видит статистику по сотрудникам (§5-тер.13). */
  statsPerEmployee: boolean;
  /**
   * Аудит Э7 (г), Р-З9-17: сессия по тестовому ключу (`pk_test`, к нему
   * в frame-ancestors добавлен localhost). По умолчанию — только знания,
   * без коннекторов и действий (боевые API заказчика со стенда разработчика
   * не вызываются); владелец может включить `testKeyConnectors`.
   */
  testKey: boolean;
}

export interface ResolvedAdminSession {
  sessionId: string;
  accountId: string;
  siteId: string;
  sub: string;
  employeeRef: string;
  customerRole: string | null;
  name: string | null;
  /** Роль помощника по карте ролей; null — только знания (§5.1). */
  role: string | null;
  expiresAt: Date;
  /** Сессия по `pk_test` (Р-З9-17): без `testKeyConnectors` роль null. */
  testKey: boolean;
}

/** Формат ключа — тот же, что выдаёт кабинет виджета (префиксы — brand.ts). */
function isPk(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    [WIDGET_PK_LIVE_PREFIX, WIDGET_PK_TEST_PREFIX].some(
      (p) => v.startsWith(p) && /^[0-9A-Za-z]{8,64}$/.test(v.slice(p.length)),
    )
  );
}

/** Окно лимита обмена JWT с одного IP на сайт. */
export const SESSION_EXCHANGE_PER_MIN = 20;
/** Вопросов сотрудника в минуту / в час (на `sub`). */
export const ADMIN_QUESTIONS_PER_MIN = 10;
export const ADMIN_QUESTIONS_PER_HOUR = 120;

export function sessionTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Р-З9-17: метка сессии по тестовому ключу — в самом токене (колонки нет:
 * схему в этом заходе не трогаем). В базе — только SHA-256 токена, поэтому
 * клиент не может ни снять, ни поставить метку, не потеряв сессию; боевой
 * токен с такого начала не выдаётся (перевыпуск), старые случайные токены
 * (до захода 9, живут ≤ 15 мин) с тем же началом — лишь «только знания».
 */
export const TEST_SESSION_PREFIX = 't-';

export function newSessionToken(test: boolean): string {
  for (;;) {
    const t = randomBytes(32).toString('base64url');
    if (test)
      return `${TEST_SESSION_PREFIX}${t.slice(TEST_SESSION_PREFIX.length)}`;
    if (!t.startsWith(TEST_SESSION_PREFIX)) return t;
  }
}

export function isTestSessionToken(token: string): boolean {
  return token.startsWith(TEST_SESSION_PREFIX);
}

@Injectable()
export class AdminSessionService {
  constructor(
    private readonly db: SitesDb,
    private readonly mode: AdminModeService,
  ) {}

  /**
   * Окно лимита в assist_rate_buckets (тот же приём, что у виджета): один
   * UPSERT с условием; нет строки в ответе — лимит.
   */
  async rateHit(
    scope: string,
    key: string,
    limit: number,
    windowMs: number,
    now = new Date(),
  ): Promise<boolean> {
    const start = Math.floor(now.getTime() / windowMs) * windowMs;
    const rows = await this.db.system(
      'лимит частоты «Админки»: окно по хешу ключа, вне кабинета',
    ).$queryRaw<Array<{ count: number }>>`
        INSERT INTO "sites"."assist_rate_buckets" ("scope", "key", "bucket", "count", "expiresAt")
        VALUES (${scope}, ${key}, ${new Date(start).toISOString()}, 1, ${new Date(start + windowMs)})
        ON CONFLICT ("scope", "key", "bucket") DO UPDATE
          SET "count" = "assist_rate_buckets"."count" + 1
          WHERE "assist_rate_buckets"."count" < ${limit}
        RETURNING "count"`;
    return rows.length > 0;
  }

  /** Ключ лимита по IP — HMAC (сырого IP в базе нет). */
  ipKey(ip: string | null | undefined, siteId: string): string {
    const secret = this.mode.env.ASSIST_SECRETS_KEY?.trim() || 'no-key';
    return createHmac('sha256', secret)
      .update(`assist-admin-ip:${siteId}:${ip ?? ''}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** Сайт и настройки «Админки» по публичному ключу (системное чтение). */
  async siteByPk(pk: string) {
    if (!isPk(pk)) return null;
    const site = await this.db
      .system(
        '«Админка»: сайт по публичному ключу — кабинета в запросе сотрудника ещё нет',
      )
      .assistSite.findFirst({
        where: { OR: [{ publicKey: pk }, { testKey: pk }] },
        select: { siteId: true, accountId: true, testKey: true },
      });
    if (!site) return null;
    const settings = await this.db
      .forAccount(site.accountId)
      .assistAdminSettings.findFirst({ where: { siteId: site.siteId } });
    return settings
      ? {
          siteId: site.siteId,
          accountId: site.accountId,
          // Тестовый ключ — тот, что совпал со столбцом `testKey` сайта.
          isTestKey: site.testKey === pk,
          settings,
        }
      : null;
  }

  async exchange(
    pk: string,
    jwt: string,
    ip: string | null,
    now = new Date(),
  ): Promise<AdminSessionView> {
    const found = await this.siteByPk(pk);
    const s = found?.settings;
    if (
      !found ||
      !s ||
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both')
    ) {
      throw adminError(
        403,
        'ADMIN_MODE_OFF',
        'Помощник сотрудника на этом сайте выключен',
      );
    }
    if (
      !(await this.rateHit(
        'admin-session-ip-min',
        this.ipKey(ip, found.siteId),
        SESSION_EXCHANGE_PER_MIN,
        60_000,
        now,
      ))
    ) {
      throw adminError(
        429,
        'ADMIN_RATE_LIMITED',
        'Слишком много попыток входа — подождите минуту',
      );
    }
    let secret: string | null;
    try {
      secret = this.mode.identitySecret(s);
    } catch {
      secret = null;
    }
    if (!secret) {
      throw adminError(
        403,
        'ADMIN_IDENTITY_NOT_SET',
        'Секрет подписи сотрудников не выпущен',
      );
    }
    let id;
    try {
      id = verifyEmployeeJwt(jwt, secret, found.siteId, now.getTime());
    } catch (e) {
      const code = e instanceof IdentityJwtError ? e.code : 'malformed';
      throw adminError(
        401,
        'ADMIN_IDENTITY_REJECTED',
        `Подпись сотрудника не принята (${code})`,
      );
    }
    secret = null;
    const token = newSessionToken(found.isTestKey);
    const expiresAt = new Date(id.exp * 1000);
    await this.db.forAccount(found.accountId).assistAdminSession.create({
      data: {
        accountId: found.accountId,
        siteId: found.siteId,
        tokenHash: sessionTokenHash(token),
        sub: id.sub,
        role: id.role,
        name: id.name,
        jwtIat: new Date(id.iat * 1000),
        expiresAt,
      },
    });
    return {
      session: token,
      expiresAt: expiresAt.toISOString(),
      sub: id.sub,
      employee: { name: id.name, role: id.role },
      statsPerEmployee: s.statsPerEmployee,
      testKey: found.isTestKey,
    };
  }

  /** Конец сессии (выход сотрудника из админки, §4-бис.8). */
  async revoke(tokenHash: string): Promise<void> {
    const row = await this.db
      .system(
        '«Админка»: сессия по хешу токена — кабинет берётся из строки сессии',
      )
      .assistAdminSession.findUnique({
        where: { tokenHash },
        select: { accountId: true },
      });
    if (!row) return;
    await this.db
      .forAccount(row.accountId)
      .assistAdminSession.deleteMany({ where: { tokenHash } });
  }

  /** Сессия из заголовка → сотрудник; истёкшая/чужая/выключенный режим — 401/403. */
  async resolve(
    token: string | undefined,
    now = new Date(),
  ): Promise<ResolvedAdminSession> {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw adminError(
        401,
        'ADMIN_SESSION_INVALID',
        'Сессия помощника истекла — обновите страницу',
      );
    }
    const row = await this.db
      .system(
        '«Админка»: сессия по хешу токена — кабинет берётся из строки сессии',
      )
      .assistAdminSession.findUnique({
        where: { tokenHash: sessionTokenHash(token) },
      });
    if (!row || row.expiresAt.getTime() <= now.getTime()) {
      throw adminError(
        401,
        'ADMIN_SESSION_INVALID',
        'Сессия помощника истекла — обновите страницу',
      );
    }
    const s = await this.db
      .forAccount(row.accountId)
      .assistAdminSettings.findFirst({ where: { siteId: row.siteId } });
    if (
      !s ||
      !s.adminModeEnabled ||
      (s.adminAccess !== 'script' && s.adminAccess !== 'both')
    ) {
      throw adminError(
        403,
        'ADMIN_MODE_OFF',
        'Помощник сотрудника на этом сайте выключен',
      );
    }
    const map = parseRoleMap(s.roleMap) ?? {};
    const testKey = isTestSessionToken(token);
    // Р-З9-17: тестовый ключ — только знания, пока владелец не включил
    // «тестовый ключ ходит в API» (`testKeyConnectors`).
    const knowledgeOnly = testKey && !s.testKeyConnectors;
    return {
      sessionId: row.id,
      accountId: row.accountId,
      siteId: row.siteId,
      sub: row.sub,
      employeeRef: employeeRefOfSub(row.sub),
      customerRole: row.role,
      name: row.name,
      // Только собственный ключ карты (аудит Э8): роль «constructor» из JWT
      // давала Function вместо строки — 500 на каталоге действий.
      // Р-З9-17: тестовый ключ — только знания (без коннекторов/действий).
      role:
        !knowledgeOnly &&
        row.role &&
        Object.prototype.hasOwnProperty.call(map, row.role)
          ? map[row.role]
          : null,
      expiresAt: row.expiresAt,
      testKey,
    };
  }
}
