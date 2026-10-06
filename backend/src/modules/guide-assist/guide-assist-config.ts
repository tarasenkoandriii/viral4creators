/**
 * Конфигурация гида мастера в режиме «Админка» помощника платформы
 * (Э-С Ш6, `docs-tz/AUDIT-Merge-Assistant-Tutorial-QA-2026-10-02.md` §Ш6).
 *
 * TMA генератора — «админка заказчика» для тенанта viral4creators в
 * собственной платформе помощника (`sites-backend`): сотрудник = пользователь
 * TMA, employee-JWT выписывает ЭТОТ бэкенд (HS256, `aud = siteId`, ≤ 15 мин),
 * секрет подписи — из кабинета «Помощник сотрудников» (показан один раз),
 * здесь — только из env.
 *
 * ## Флаг
 *
 * `WIZARD_GUIDE_ENGINE`:
 *  - `legacy` (умолчание) — старый гид (`modules/wizard-guide`), как до Ш6;
 *  - `pilot` — «Админка» только для перечисленных в
 *    `WIZARD_GUIDE_ASSIST_PILOT` (Telegram id или id пользователя), остальным
 *    старый гид;
 *  - `assist` — «Админка» всем вошедшим.
 * Любое неизвестное значение и любая неполная конфигурация — `legacy`
 * (с причиной в `problems`): включение «наполовину» не должно ломать прод.
 *
 * Чистый модуль: ни Nest, ни базы — только разбор переменных.
 */

export type GuideEngine = 'legacy' | 'assist';
export type GuideEngineMode = 'legacy' | 'pilot' | 'assist';

/** Потолок срока JWT сотрудника на стороне платформы (ТЗ §5.1). */
export const GUIDE_JWT_MAX_TTL_SEC = 15 * 60;
/** Умолчание — 10 мин: запас 5 мин до потолка на расхождение часов. */
export const GUIDE_JWT_DEFAULT_TTL_SEC = 10 * 60;
const GUIDE_JWT_MIN_TTL_SEC = 60;
/** Секрет подписи и ключ коннектора — не короче 32 знаков. */
export const GUIDE_SECRET_MIN_LEN = 32;
/** Роль сотрудника в JWT по умолчанию: владелец «Админки» маппит её на роль помощника. */
export const GUIDE_DEFAULT_ROLE = 'creator';

export interface GuideAssistConfig {
  mode: GuideEngineMode;
  /** `aud` JWT — id сайта viral4creators в платформе помощника. */
  siteId: string;
  /** Публичный ключ виджета (`pk_live_…`/`pk_test_…`) — атрибут `data-site`. */
  pk: string;
  /** Origin «Админки» (`https://wa.<домен>`) — откуда грузится загрузчик. */
  origin: string;
  /** Секрет подписи employee-JWT (кабинет «Помощник сотрудников»). */
  jwtSecret: string;
  /** Срок JWT, секунды (60…900). */
  ttlSec: number;
  /** Роль в JWT. */
  role: string;
  /** Пилот: Telegram id и/или id пользователей генератора. */
  pilot: ReadonlySet<string>;
}

/** Ключ коннектора фактов: API читает только платформа с этим ключом. */
export interface GuideFactsConfig {
  connectorKey: string;
  /** Тот же секрет, что у JWT: из него выводится ключ подписи `sub`. */
  jwtSecret: string;
}

export interface GuideAssistEnv {
  [key: string]: string | undefined;
  WIZARD_GUIDE_ENGINE?: string;
  WIZARD_GUIDE_ASSIST_SITE_ID?: string;
  WIZARD_GUIDE_ASSIST_PK?: string;
  WIZARD_GUIDE_ASSIST_ORIGIN?: string;
  WIZARD_GUIDE_ASSIST_JWT_SECRET?: string;
  WIZARD_GUIDE_ASSIST_JWT_TTL_SEC?: string;
  WIZARD_GUIDE_ASSIST_ROLE?: string;
  WIZARD_GUIDE_ASSIST_PILOT?: string;
  WIZARD_GUIDE_ASSIST_CONNECTOR_KEY?: string;
}

const SITE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PK_RE = /^pk_(live|test)_[A-Za-z0-9_]{1,70}$/;
/** Та же форма роли, что принимает платформа (`identity-jwt.ts` ROLE_RE). */
const ROLE_RE = /^[\p{L}\p{N}_.:-]{1,64}$/u;

/**
 * Origin «Админки»: только `https://хост` без пути, порта и логина; для
 * тестового ключа (`pk_test_`) ещё и `http://localhost:порт` (стенд).
 */
export function normalizeAssistOrigin(
  raw: string | undefined,
  pk: string,
): string | null {
  const v = (raw ?? '').trim();
  if (!v) return null;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.pathname !== '/' && u.pathname !== '') return null;
  if (u.protocol === 'https:' && u.port === '') return u.origin;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'http:' && local && pk.startsWith('pk_test_')) {
    return u.origin;
  }
  return null;
}

function modeOf(raw: string | undefined): GuideEngineMode | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'legacy') return 'legacy';
  if (v === 'pilot' || v === 'assist') return v;
  return null;
}

function ttlOf(raw: string | undefined): number {
  const n = Number((raw ?? '').trim());
  if (!raw?.trim() || !Number.isFinite(n)) return GUIDE_JWT_DEFAULT_TTL_SEC;
  return Math.min(
    GUIDE_JWT_MAX_TTL_SEC,
    Math.max(GUIDE_JWT_MIN_TTL_SEC, Math.floor(n)),
  );
}

export interface GuideAssistConfigResult {
  /** Запрошенный режим (до проверки полноты). */
  requested: GuideEngineMode;
  /** `null` — работает старый гид. */
  config: GuideAssistConfig | null;
  /** Причины отката на `legacy` — для лога и карточки env в админке. */
  problems: string[];
}

/** Разбор env. Ничего не бросает: худший исход — старый гид. */
export function readGuideAssistConfig(
  env: GuideAssistEnv,
): GuideAssistConfigResult {
  const problems: string[] = [];
  const mode = modeOf(env.WIZARD_GUIDE_ENGINE);
  if (mode === null) {
    problems.push(
      'WIZARD_GUIDE_ENGINE: неизвестное значение — работает старый гид (legacy | pilot | assist)',
    );
    return { requested: 'legacy', config: null, problems };
  }
  if (mode === 'legacy') return { requested: mode, config: null, problems };

  const siteId = (env.WIZARD_GUIDE_ASSIST_SITE_ID ?? '').trim();
  const pk = (env.WIZARD_GUIDE_ASSIST_PK ?? '').trim();
  // Аудит P3: секреты — с trim(), как все соседние ключи. Хвостовой
  // перевод строки из панели Vercel иначе становится частью секрета, и
  // подпись расходится с той, что ждёт платформа.
  const jwtSecret = (env.WIZARD_GUIDE_ASSIST_JWT_SECRET ?? '').trim();
  const role =
    (env.WIZARD_GUIDE_ASSIST_ROLE ?? '').trim() || GUIDE_DEFAULT_ROLE;
  if (!SITE_ID_RE.test(siteId)) {
    problems.push('WIZARD_GUIDE_ASSIST_SITE_ID: не задан или не id сайта');
  }
  if (!PK_RE.test(pk)) {
    problems.push('WIZARD_GUIDE_ASSIST_PK: не задан или не pk_live_/pk_test_');
  }
  const origin = normalizeAssistOrigin(env.WIZARD_GUIDE_ASSIST_ORIGIN, pk);
  if (!origin) {
    problems.push(
      'WIZARD_GUIDE_ASSIST_ORIGIN: не задан или не https-origin без пути',
    );
  }
  if (jwtSecret.length < GUIDE_SECRET_MIN_LEN) {
    problems.push(
      `WIZARD_GUIDE_ASSIST_JWT_SECRET: не задан или короче ${GUIDE_SECRET_MIN_LEN} знаков`,
    );
  }
  if (!ROLE_RE.test(role)) {
    problems.push('WIZARD_GUIDE_ASSIST_ROLE: недопустимые символы');
  }
  const pilot = new Set(
    (env.WIZARD_GUIDE_ASSIST_PILOT ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (mode === 'pilot' && pilot.size === 0) {
    problems.push(
      'WIZARD_GUIDE_ASSIST_PILOT: пуст при WIZARD_GUIDE_ENGINE=pilot — «Админка» не достанется никому',
    );
  }
  if (problems.length > 0 || !origin) {
    return { requested: mode, config: null, problems };
  }
  return {
    requested: mode,
    config: {
      mode,
      siteId,
      pk,
      origin,
      jwtSecret,
      ttlSec: ttlOf(env.WIZARD_GUIDE_ASSIST_JWT_TTL_SEC),
      role,
      pilot,
    },
    problems,
  };
}

/**
 * Ключи API фактов. Не зависят от флага: владелец импортирует OpenAPI и
 * проверяет коннектор в кабинете ДО того, как включит «Админку» людям.
 */
export function readGuideFactsConfig(
  env: GuideAssistEnv,
): GuideFactsConfig | null {
  const connectorKey = (env.WIZARD_GUIDE_ASSIST_CONNECTOR_KEY ?? '').trim();
  const jwtSecret = (env.WIZARD_GUIDE_ASSIST_JWT_SECRET ?? '').trim();
  if (
    connectorKey.length < GUIDE_SECRET_MIN_LEN ||
    jwtSecret.length < GUIDE_SECRET_MIN_LEN ||
    connectorKey === jwtSecret
  ) {
    return null;
  }
  return { connectorKey, jwtSecret };
}

/**
 * Каким гидом пользуется этот человек. Аноним — всегда старый (JWT
 * сотрудника без личности не выписать).
 */
export function engineFor(
  config: GuideAssistConfig | null,
  user: { id: string; telegramId: string | null } | null,
): GuideEngine {
  if (!config || !user) return 'legacy';
  if (config.mode === 'assist') return 'assist';
  if (config.mode === 'pilot') {
    return config.pilot.has(user.id) ||
      (!!user.telegramId && config.pilot.has(user.telegramId))
      ? 'assist'
      : 'legacy';
  }
  return 'legacy';
}

/**
 * То же, что `engineFor`, но с чтением пользователя только когда оно нужно
 * (режим `pilot`). Общая точка для `GuideAssistService` и состояния
 * старого гида (`WizardGuideService.stateOf`): оба обязаны отвечать
 * одинаково, иначе человек увидит оба гида сразу или ни одного.
 */
export async function resolveGuideEngine(
  config: GuideAssistConfig | null,
  userId: string | null | undefined,
  findUser: (
    id: string,
  ) => Promise<{ id: string; telegramId: string | null } | null>,
): Promise<GuideEngine> {
  if (!config || !userId) return 'legacy';
  if (config.mode === 'assist') return 'assist';
  if (config.mode !== 'pilot') return 'legacy';
  return engineFor(config, await findUser(userId));
}
