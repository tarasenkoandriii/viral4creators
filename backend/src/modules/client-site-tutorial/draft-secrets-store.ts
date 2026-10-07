/**
 * Где живут данные входа черновика обучалки (Э-С Ш2; аудит слияния §3.2,
 * план «Э-С», Ш2; решение владельца 02.10.2026).
 *
 * До Ш2 — две колонки черновика (`credentialsEnc` — поля формы входа,
 * `cookiesEnc` — куки сессии), ключ `SITE_TUTORIAL_TOKEN_KEY`. С Ш2 — в
 * хранилище `sites-backend` (AES-256-GCM с версией ключа и AAD, журнал
 * доступа, удаление), когда оно включено (`SITE_TUTORIAL_CREDENTIALS_STORE=
 * sites` и настроен внутренний API):
 *
 *  - **режим A** (сайт подтверждён в кабинете, где человек владелец или
 *    менеджер) — тестовая учётка в реестре сайта (`site_test_accounts`),
 *    общая с QA; секреты на каждый раунд — по АРЕНДЕ (одноразовой, 2 мин),
 *    хост — подтверждённый хост черновика;
 *  - **режим B** (сайт не подтверждён — метка, не ограничение) — личная
 *    запись пользователя (`user_site_sessions`), только обучалка, без аренды
 *    для QA. Пароль хранится, как раньше: обучалка в B работает для
 *    пользователя КАК ДО Ш2 (в том числе переигровка входа при `/undo`) —
 *    отступление от П-Т3 по решению владельца 02.10.2026.
 *
 * Хранилище не настроено (нет env, sites-backend ответил
 * `CREDENTIALS_NOT_CONFIGURED` или не ответил при ПЕРВОЙ записи) — данные
 * входа по-старому в колонках, с предупреждением в лог: обучалка не
 * ломается. Черновик, уже переехавший в хранилище, назад в колонки не
 * откатывается (данные разъехались бы) — недоступность тогда честный 503.
 */
import { Logger } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  CdpCookie,
  decryptCookieJar,
  encryptCookieJar,
  parseCookieJar,
  serializeCookieJar,
} from '../../common/cookie-jar';
import {
  SitesCredentialSecrets,
  SitesInternalClient,
  type SitesSecretFlags,
  SitesNotConfiguredError,
  SitesRejectedError,
  SitesUnavailableError,
  sitesTelegramId,
} from '../sites-internal/sites-internal.client';
import {
  DraftCredentialField,
  decryptCredentials,
  encryptCredentials,
  parseCredentials,
  serializeCredentials,
} from './draft-credentials';
import { looksLikeRegistryRef, parseRegistryRef } from './registry-login';

export const CREDENTIALS_STORE_ENV = 'SITE_TUTORIAL_CREDENTIALS_STORE';

/** `sites` — хранилище sites-backend; всё остальное (и пусто) — колонки. */
export function credentialsStoreMode(
  env: NodeJS.ProcessEnv = process.env,
): 'sites' | 'columns' {
  return env[CREDENTIALS_STORE_ENV]?.trim().toLowerCase() === 'sites'
    ? 'sites'
    : 'columns';
}

/** Поля черновика, которые знает хранилище. */
export interface DraftSecretsRow {
  id: string;
  projectId: string;
  baseUrl: string;
  credentialsEnc: string | null;
  cookiesEnc: string | null;
  siteMode?: string | null;
  siteHostId?: string | null;
  siteTestAccountId?: string | null;
  userSiteSessionId?: string | null;
  storeHasCredentials?: boolean;
}

export interface DraftSecretsUser {
  userId: string;
  /** Telegram-id (числовой) — нужен только режиму A; `null` — нет. */
  telegramId: string | null;
}

export interface DraftSecrets {
  /**
   * Поля входа ДЛЯ ВВОДА: ссылки на учётку реестра (Ш2-хвост (3),
   * `registry-login.ts`) уже разрешены арендой; выпавшие (учётку
   * заморозили/удалили) — убраны.
   */
  fields: DraftCredentialField[];
  /**
   * Поля входа КАК ХРАНЯТСЯ (со ссылками, без паролей реестра) — для
   * слияния и записи обратно: разрешённый пароль учётки реестра в запись
   * черновика не копируется.
   */
  rawFields: DraftCredentialField[];
  /** Селекторы, куда идёт пароль учётки реестра — только в поле пароля. */
  passwordOnly: string[];
  cookies: CdpCookie[];
  /**
   * Прочитанное выдаёт ВХОД (аудит Э6, Д1 — липкий `loginUsedAt`
   * черновика): поля формы входа (колонка или `login-fields`) или пароль
   * учётки реестра (`password`, его задаёт кабинет). Куки сессии сами по
   * себе — нет: их пишет только сам черновик (в A — учётка по ключу его
   * проекта, в B — личная запись по ключу черновика), каждым раундом и на
   * публичных страницах; куки после входа — уже под флагом. Чужие/прежние
   * секреты записи ловит `write` при привязке (`loginUsedAt` в патче).
   */
  loginEvidence: boolean;
  /**
   * Данные были в хранилище, но больше не выдаются (учётку удалили или
   * заморозили в кабинете, подтверждение хоста истекло, личная запись
   * истекла) — как после срока хранения: раунд идёт без сессии, вход —
   * заново. Следующая запись заведёт новую запись (режим B).
   */
  lost: boolean;
}

/** Колонки черновика, которые надо записать вместе с раундом. */
export interface DraftSecretsPatch {
  credentialsEnc?: string | null;
  cookiesEnc?: string | null;
  siteTestAccountId?: string | null;
  userSiteSessionId?: string | null;
  storeHasCredentials?: boolean;
  /**
   * Аудит Э6, Д1: запись хранилища, к которой черновик привязался этим
   * раундом, УЖЕ несла секреты (сессию или поля входа прежнего черновика
   * того же проекта, пароль из кабинета) — это вход. Только ставится:
   * `null` здесь не появляется никогда (флаг не снимается).
   */
  loginUsedAt?: Date;
}

/** Черновик уже в хранилище, а оно сейчас не отвечает — 503 у вызывающего. */
export class DraftSecretsUnavailableError extends Error {
  constructor() {
    super(
      'хранилище данных входа сейчас недоступно — повторите шаг через минуту',
    );
    this.name = 'DraftSecretsUnavailableError';
  }
}

export type DraftSecretsLocation = 'site' | 'user' | 'columns';

export function draftSecretsLocation(d: DraftSecretsRow): DraftSecretsLocation {
  if (d.siteTestAccountId) return 'site';
  if (d.userSiteSessionId) return 'user';
  return 'columns';
}

export const ownerRefOf = (userId: string) => `gen:${userId}`;
export const clientRefOf = (projectId: string) => `project:${projectId}`;
/**
 * Ключ ЛИЧНОЙ записи B — черновик, а не проект (аудит Ш2): удалённый при
 * недоступном хранилище черновик оставляет запись до срока, и новый
 * черновик того же проекта на ДРУГОМ сайте упирался бы в
 * `USER_SESSION_ORIGIN_MISMATCH` (409) на каждом раунде до 30 дней.
 */
export const userClientRefOf = (draftId: string) => `draft:${draftId}`;
const runRefOf = (draftId: string) => `draft:${draftId}`;

function isGone(err: unknown): boolean {
  return err instanceof SitesRejectedError;
}

function isOffline(err: unknown): boolean {
  return (
    err instanceof SitesNotConfiguredError ||
    err instanceof SitesUnavailableError
  );
}

export class DraftSecretsStore {
  /** Тесты подменяют env. */
  env: NodeJS.ProcessEnv = process.env;
  private warned = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sites: SitesInternalClient,
    /** Ключ колонок (`SITE_TUTORIAL_TOKEN_KEY`) — бросает, если его нет. */
    private readonly columnKey: () => string,
    private readonly logger: Pick<Logger, 'log' | 'warn'> = new Logger(
      'DraftSecretsStore',
    ),
  ) {}

  /** Включено ли хранилище для НОВЫХ записей. */
  enabled(): boolean {
    return (
      credentialsStoreMode(this.env) === 'sites' && this.sites.configured()
    );
  }

  /** Telegram-id пользователя генератора (только числовой). */
  async userOf(userId: string): Promise<DraftSecretsUser> {
    const u = (await this.prisma.user.findUnique({
      where: { id: userId },
      select: { telegramId: true },
    })) as { telegramId: string | null } | null;
    return { userId, telegramId: sitesTelegramId(u?.telegramId) };
  }

  /** Данные входа черновика на раунд (аренда в A, чтение владельцем в B). */
  async read(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
  ): Promise<DraftSecrets> {
    const where = draftSecretsLocation(d);
    if (where === 'columns') {
      const cols = this.readColumns(d);
      return {
        ...cols,
        ...(await this.resolveRegistry(user, d, cols.fields)),
        loginEvidence: cols.fields.length > 0,
        lost: false,
      };
    }
    let secrets: SitesCredentialSecrets;
    try {
      if (where === 'site') {
        if (!user.telegramId || !d.siteHostId) {
          return { ...NOTHING, lost: true };
        }
        secrets = await this.sites.leaseSecrets(user.telegramId, {
          testAccountId: d.siteTestAccountId as string,
          hostId: d.siteHostId,
          runRef: runRefOf(d.id),
        });
      } else {
        secrets = await this.sites.readUserSession(
          ownerRefOf(user.userId),
          d.userSiteSessionId as string,
          runRefOf(d.id),
        );
      }
    } catch (err) {
      if (isGone(err)) {
        this.logger.warn(
          `черновик ${d.id}: данные входа в хранилище больше не выдаются (${(err as SitesRejectedError).code}) — вход заново`,
        );
        return { ...NOTHING, lost: true };
      }
      if (isOffline(err)) throw new DraftSecretsUnavailableError();
      throw err;
    }
    const parsed = this.parse(secrets);
    return {
      ...parsed,
      ...(await this.resolveRegistry(user, d, parsed.fields)),
      loginEvidence: !!secrets.password || !!secrets['login-fields'],
      lost: false,
    };
  }

  /**
   * Ш2-хвост (3): вход учёткой реестра — логин и пароль арендой на ОДИН
   * раунд (продукт `tutorial`, хост черновика). Только режим A с
   * подтверждённым хостом; отказ кабинета — `RegistryAccountRejectedError`
   * с его кодом, недоступность — `DraftSecretsUnavailableError`.
   */
  async leaseRegistry(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
    testAccountId: string,
  ): Promise<{ username: string | null; password: string | null }> {
    if (!user.telegramId || !d.siteHostId) {
      throw new RegistryAccountRejectedError('HOST_NOT_MANAGED');
    }
    try {
      const got = await this.sites.leaseAccount(user.telegramId, {
        testAccountId,
        hostId: d.siteHostId,
        runRef: runRefOf(d.id),
      });
      return {
        username: got.username,
        password: got.secrets.password ?? null,
      };
    } catch (err) {
      if (isGone(err)) {
        throw new RegistryAccountRejectedError(
          (err as SitesRejectedError).code,
        );
      }
      if (isOffline(err)) throw new DraftSecretsUnavailableError();
      throw err;
    }
  }

  /**
   * Ссылки на учётку реестра в полях входа (`registry-login.ts`) — в
   * значения, арендой на этот раунд. Одна аренда на учётку. Учётка больше
   * не выдаётся — её поля выпадают (переигровка честно попросит войти
   * заново); кривая ссылка — тоже. Значения в лог не пишутся.
   */
  private async resolveRegistry(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
    raw: DraftCredentialField[],
  ): Promise<Pick<DraftSecrets, 'fields' | 'rawFields' | 'passwordOnly'>> {
    if (!raw.some((f) => looksLikeRegistryRef(f.value))) {
      return { fields: raw, rawFields: raw, passwordOnly: [] };
    }
    const accounts = new Map<
      string,
      { username: string | null; password: string | null } | null
    >();
    const fields: DraftCredentialField[] = [];
    const passwordOnly: string[] = [];
    for (const f of raw) {
      if (!looksLikeRegistryRef(f.value)) {
        fields.push(f);
        continue;
      }
      const ref = parseRegistryRef(f.value);
      if (!ref) continue;
      if (!accounts.has(ref.testAccountId)) {
        let acc: { username: string | null; password: string | null } | null =
          null;
        try {
          acc = await this.leaseRegistry(user, d, ref.testAccountId);
        } catch (err) {
          if (!(err instanceof RegistryAccountRejectedError)) throw err;
          this.logger.warn(
            `черновик ${d.id}: учётка реестра для входа больше не выдаётся (${err.code}) — вход заново`,
          );
        }
        accounts.set(ref.testAccountId, acc);
      }
      const acc = accounts.get(ref.testAccountId);
      const value = ref.part === 'password' ? acc?.password : acc?.username;
      if (!value) continue;
      fields.push({ selector: f.selector, value });
      if (ref.part === 'password') passwordOnly.push(f.selector);
    }
    return { fields, rawFields: raw, passwordOnly };
  }

  /**
   * Записать данные входа раунда. `fields` — ПОЛНЫЙ набор (уже слитый с
   * сохранённым), `cookies` — только куки сайта заказчика; пустой список
   * кук — «не трогать» (как `encryptCookies` до Ш2). Возвращает колонки
   * черновика для той же записи, что сохраняет раунд.
   */
  async write(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
    change: { fields?: DraftCredentialField[]; cookies?: CdpCookie[] },
  ): Promise<DraftSecretsPatch> {
    const fields = change.fields;
    const cookies = change.cookies?.length ? change.cookies : undefined;
    if (!fields && !cookies) return {};
    // Потолки — до любой сети: слишком большой набор — ошибка вызывающего.
    const fieldsJson = fields ? serializeCredentials(fields) : undefined;
    const cookiesJson = cookies ? serializeCookieJar(cookies) : undefined;

    let where = draftSecretsLocation(d);
    let target: { kind: 'site' | 'user'; id: string } | null =
      where === 'site'
        ? { kind: 'site', id: d.siteTestAccountId as string }
        : where === 'user'
          ? { kind: 'user', id: d.userSiteSessionId as string }
          : null;
    // Переезд из колонок: то, чего нет в этом раунде, — из колонок.
    let carry: { fields?: string; cookies?: string } = {};
    // Привязка к записи, где уже лежали секреты, — вход (см. патч).
    let inherited = false;

    if (!target) {
      if (!this.enabled()) {
        this.warnColumns('хранилище sites-backend не включено');
        return this.columnsPatch(fieldsJson ? fields : undefined, cookies);
      }
      try {
        const created = await this.createTarget(user, d);
        target = created;
        inherited = created.hadSecrets;
      } catch (err) {
        if (isOffline(err)) {
          this.warnColumns(
            err instanceof SitesUnavailableError && err.code
              ? `sites-backend: ${err.code}`
              : 'sites-backend недоступен',
          );
          return this.columnsPatch(fieldsJson ? fields : undefined, cookies);
        }
        throw err;
      }
      const old = this.readColumnsQuietly(d);
      carry = {
        fields:
          !fieldsJson && old.fields.length
            ? serializeCredentials(old.fields)
            : undefined,
        cookies:
          !cookiesJson && old.cookies.length
            ? serializeCookieJar(old.cookies)
            : undefined,
      };
      where = target.kind;
    }

    const puts: Array<['login-fields' | 'session-cookies', string]> = [];
    const f = fieldsJson ?? carry.fields;
    const c = cookiesJson ?? carry.cookies;
    if (f !== undefined) puts.push(['login-fields', f]);
    if (c !== undefined) puts.push(['session-cookies', c]);

    try {
      await this.putAll(user, target, puts);
    } catch (err) {
      if (isGone(err) && where !== 'columns') {
        // Учётку удалили в кабинете / личная запись истекла — новая личная
        // запись (B): A сюда не возвращаемся, решение кабинета уважаем.
        this.logger.warn(
          `черновик ${d.id}: запись хранилища пропала (${(err as SitesRejectedError).code}) — заводится личная запись`,
        );
        try {
          const fresh = await this.createUser(user, d);
          target = fresh;
          inherited = inherited || fresh.hadSecrets;
          await this.putAll(user, target, puts);
        } catch (again) {
          if (isOffline(again)) throw new DraftSecretsUnavailableError();
          throw again;
        }
      } else if (isOffline(err)) {
        throw new DraftSecretsUnavailableError();
      } else {
        throw err;
      }
    }
    return {
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: target.kind === 'site' ? target.id : null,
      userSiteSessionId: target.kind === 'user' ? target.id : null,
      storeHasCredentials:
        f !== undefined ? true : (d.storeHasCredentials ?? false),
      ...(inherited ? { loginUsedAt: new Date() } : {}),
    };
  }

  /**
   * Стереть данные входа черновика («одноразово» после сборки, срок
   * хранения, удаление черновика): личная запись B удаляется целиком, у
   * учётки A стираются секреты. При УДАЛЕНИИ черновика (`deleteAccount`,
   * Ш2-хвост (7)) его учётка реестра удаляется целиком (`credentials/
   * forget`: только заведённая этим черновиком — `clientRef` проекта и
   * тот же автор); чужая не трогается вовсе. Недоступность — в лог:
   * истечёт по сроку хранилища.
   */
  async forget(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
    opts: { deleteAccount?: boolean } = {},
  ): Promise<DraftSecretsPatch> {
    const where = draftSecretsLocation(d);
    try {
      if (where === 'site' && user.telegramId && opts.deleteAccount) {
        await this.forgetOwnAccount(user.telegramId, d);
      } else if (where === 'site' && user.telegramId) {
        await this.sites.forgetTestAccountSecrets(
          user.telegramId,
          d.siteTestAccountId as string,
        );
      } else if (where === 'user') {
        await this.sites.deleteUserSession(
          ownerRefOf(user.userId),
          d.userSiteSessionId as string,
        );
      }
    } catch (err) {
      if (!isGone(err)) {
        this.logger.warn(
          `черновик ${d.id}: данные входа в хранилище не стёрлись (${err instanceof Error ? err.name : 'error'}) — истекут по сроку хранилища`,
        );
      }
    }
    return {
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: null,
      userSiteSessionId: null,
      storeHasCredentials: false,
    };
  }

  /**
   * Учётка реестра черновика при его удалении: своя — удалить целиком;
   * чужая (`TEST_ACCOUNT_NOT_OWN`) — не трогать; уже нет — готово. Старый
   * sites-backend без `credentials/forget` (404 без кода учётки) — как до
   * Ш2-хвоста (7): стереть секреты.
   */
  private async forgetOwnAccount(
    telegramId: string,
    d: DraftSecretsRow,
  ): Promise<void> {
    try {
      await this.sites.forgetTestAccount(
        telegramId,
        d.siteTestAccountId as string,
        clientRefOf(d.projectId),
      );
    } catch (err) {
      if (!(err instanceof SitesRejectedError)) throw err;
      if (err.code === 'TEST_ACCOUNT_NOT_OWN') {
        this.logger.warn(
          `черновик ${d.id}: учётка реестра заведена не им — не удаляется`,
        );
        return;
      }
      if (err.code === 'TEST_ACCOUNT_NOT_FOUND') return;
      if (err.status === 404) {
        await this.sites.forgetTestAccountSecrets(
          telegramId,
          d.siteTestAccountId as string,
        );
        return;
      }
      throw err;
    }
  }

  /** Перенос одного черновика из колонок (скрипт `move-client-site-credentials`). */
  async moveFromColumns(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
  ): Promise<
    DraftSecretsPatch & { moved: { fields: boolean; cookies: boolean } }
  > {
    const old = this.readColumns(d);
    const target = await this.createUser(user, d);
    const puts: Array<['login-fields' | 'session-cookies', string]> = [];
    if (old.fields.length) {
      puts.push(['login-fields', serializeCredentials(old.fields)]);
    }
    if (old.cookies.length) {
      puts.push(['session-cookies', serializeCookieJar(old.cookies)]);
    }
    await this.putAll(user, target, puts);
    return {
      credentialsEnc: null,
      cookiesEnc: null,
      siteTestAccountId: null,
      userSiteSessionId: target.id,
      storeHasCredentials: old.fields.length > 0,
      // Поля входа в колонках — вход был (страховка к backfill миграции).
      ...(old.fields.length ? { loginUsedAt: new Date() } : {}),
      moved: { fields: old.fields.length > 0, cookies: old.cookies.length > 0 },
    };
  }

  // ── внутреннее ──

  private async createTarget(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
  ): Promise<{ kind: 'site' | 'user'; id: string; hadSecrets: boolean }> {
    if (d.siteMode === 'A' && d.siteHostId && user.telegramId) {
      try {
        const acc = await this.sites.upsertTestAccount(user.telegramId, {
          hostId: d.siteHostId,
          clientRef: clientRefOf(d.projectId),
          account: {
            label: labelOf(d.baseUrl),
            hostIds: [d.siteHostId],
            products: ['tutorial'],
          },
        });
        return { kind: 'site', id: acc.id, hadSecrets: anySecret(acc) };
      } catch (err) {
        // Кабинет не дал завести учётку (роль, хост не его) — личная запись.
        if (!isGone(err)) throw err;
      }
    }
    return this.createUser(user, d);
  }

  private async createUser(
    user: DraftSecretsUser,
    d: DraftSecretsRow,
  ): Promise<{ kind: 'user'; id: string; hadSecrets: boolean }> {
    const s = await this.sites.upsertUserSession(ownerRefOf(user.userId), {
      origin: d.baseUrl,
      clientRef: userClientRefOf(d.id),
      label: labelOf(d.baseUrl),
    });
    return { kind: 'user', id: s.id, hadSecrets: anySecret(s) };
  }

  private async putAll(
    user: DraftSecretsUser,
    target: { kind: 'site' | 'user'; id: string },
    puts: Array<['login-fields' | 'session-cookies', string]>,
  ): Promise<void> {
    for (const [purpose, value] of puts) {
      if (target.kind === 'site') {
        if (!user.telegramId) {
          throw new SitesRejectedError(
            403,
            'ACCOUNT_REQUIRED',
            'нет Telegram-id',
          );
        }
        await this.sites.putTestAccountSecret(
          user.telegramId,
          target.id,
          purpose,
          value,
        );
      } else {
        await this.sites.putUserSessionSecret(
          ownerRefOf(user.userId),
          target.id,
          purpose,
          value,
        );
      }
    }
  }

  private parse(secrets: SitesCredentialSecrets): {
    fields: DraftCredentialField[];
    cookies: CdpCookie[];
  } {
    const fields = secrets['login-fields']
      ? parseCredentials(secrets['login-fields'])
      : [];
    let cookies: CdpCookie[] = [];
    if (secrets['session-cookies']) {
      let raw: unknown = null;
      try {
        raw = JSON.parse(secrets['session-cookies']);
      } catch {
        raw = null;
      }
      const parsed = parseCookieJar(raw);
      cookies = parsed.cookies;
      if (parsed.dropped > 0) {
        this.logger.warn(
          `черновик обучалки: ${parsed.dropped} кук отброшено при восстановлении`,
        );
      }
    }
    return { fields, cookies };
  }

  private readColumns(d: DraftSecretsRow): {
    fields: DraftCredentialField[];
    cookies: CdpCookie[];
  } {
    const fields = d.credentialsEnc
      ? decryptCredentials(d.credentialsEnc, this.columnKey())
      : [];
    let cookies: CdpCookie[] = [];
    if (d.cookiesEnc) {
      const parsed = decryptCookieJar(d.cookiesEnc, this.columnKey());
      cookies = parsed.cookies;
      if (parsed.dropped > 0) {
        this.logger.warn(
          `черновик обучалки: ${parsed.dropped} кук отброшено при восстановлении`,
        );
      }
    }
    return { fields, cookies };
  }

  /** Для переноса «по ходу раунда»: битые колонки — не повод ронять раунд. */
  private readColumnsQuietly(d: DraftSecretsRow): {
    fields: DraftCredentialField[];
    cookies: CdpCookie[];
  } {
    try {
      return this.readColumns(d);
    } catch {
      return { fields: [], cookies: [] };
    }
  }

  private columnsPatch(
    fields: DraftCredentialField[] | undefined,
    cookies: CdpCookie[] | undefined,
  ): DraftSecretsPatch {
    return {
      ...(fields
        ? { credentialsEnc: encryptCredentials(fields, this.columnKey()) }
        : {}),
      ...(cookies
        ? { cookiesEnc: encryptCookieJar(cookies, this.columnKey()) }
        : {}),
    };
  }

  private warnColumns(why: string): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      `обучалка: данные входа пишутся в колонки черновика (${why}) — для хранилища sites-backend задайте SITE_TUTORIAL_CREDENTIALS_STORE=sites и SITE_CREDENTIALS_KEYS (doc/DEPLOYMENT.md)`,
    );
  }
}

const NOTHING: Omit<DraftSecrets, 'lost'> = {
  fields: [],
  rawFields: [],
  passwordOnly: [],
  cookies: [],
  loginEvidence: false,
};

/**
 * Кабинет не выдал учётку реестра для входа (заморожена, истекла, удалена,
 * не разрешена обучалке, хост не подтверждён или не его) — код кабинета.
 */
export class RegistryAccountRejectedError extends Error {
  constructor(readonly code: string) {
    super(`учётка реестра не выдана (${code})`);
    this.name = 'RegistryAccountRejectedError';
  }
}

/**
 * Запись хранилища уже несёт секреты (флаги без значений). Нет флагов в
 * ответе (старый sites-backend) — сомнение, то есть «да».
 */
function anySecret(r: { secrets?: Partial<SitesSecretFlags> | null }): boolean {
  const f = r.secrets;
  if (!f || typeof f !== 'object') return true;
  return !!(f.password || f.loginFields || f.session);
}

/** Подпись записи — хост сайта (без пути: путь может нести данные). */
function labelOf(baseUrl: string): string {
  try {
    return `Обучалка: ${new URL(baseUrl).host}`.slice(0, 80);
  } catch {
    return 'Обучалка';
  }
}

/**
 * Хранилище с ключом колонок из env — для крона сроков и сборщика ролика
 * (им нужны только `forget`/`userOf`), и для сервиса без провайдера DI.
 */
export function defaultDraftSecretsStore(
  prisma: PrismaService,
  sites: SitesInternalClient = new SitesInternalClient(),
): DraftSecretsStore {
  return new DraftSecretsStore(prisma, sites, () => {
    const key = process.env.SITE_TUTORIAL_TOKEN_KEY;
    if (!key) {
      throw new Error(
        'SITE_TUTORIAL_TOKEN_KEY не настроен — данные входа в колонках не прочитать',
      );
    }
    return key;
  });
}
