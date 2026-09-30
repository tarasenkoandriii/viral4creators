/**
 * «Я в кадре» (ТЗ Greeting 2.0 §4.1–§4.6, §4.9) — чистые правила экранов
 * персоны: на каком шаге человек, как читать отказ проверки, возраст
 * образа, квота, какие образы показывать.
 *
 * Отдельно от React потому, что ошибка здесь дороже всего и не видна
 * глазами: ползунок, который пустил бы возраст 17, — это ровно то, что
 * ТЗ запрещает (§4.4: «сервис не создаёт несовершеннолетнюю версию
 * реального человека»), а неверный остаток квоты — кнопка, которая
 * обещает образ и получает 429. Проверяется тестом
 * (scripts/persona-flow.test.ts).
 *
 * Слов «личность подтверждена» здесь и в словаре нет намеренно (Т-16):
 * живость — заслон от «загрузил чужое фото», а не проверка личности.
 */

// ── Типы ответа сервера (контракт волны, /tmp/k/CONTRACT4.md «API») ──────

export interface PersonaInfo {
  id: string;
  consentGivenAt: string;
  verified: boolean;
  ageMin: number | null;
  ageMax: number | null;
  /** Селфи и ролик живости уже удалены (В-3) — источник образов теперь базовый образ. */
  sourcesPurgedAt: string | null;
  /** Причины последнего отказа проверки (сверх контракта, E): `under-18` — режим закрыт. */
  refusals?: string[] | null;
}

export type LookPreset =
  | 'business'
  | 'evening'
  | 'festive'
  | 'sport'
  | 'winter';

export interface PersonaLook {
  id: string;
  label: string;
  preset: LookPreset | string | null;
  targetAge: number | null;
  isBase: boolean;
  /** Сервер пишет свои коды статуса; клиент различает только «готов / в работе / сбой / удалён». */
  status: string;
  photoUrl: string | null;
  sketchUrl: string | null;
  createdAt: string;
  /** Причина `failed` — человеку (сверх контракта). */
  error?: string | null;
  /** Только в ответе создания: код `age-shift-likeness` — сдвиг возраста > 20 лет (§4.4). */
  warning?: string | null;
}

/** Код предупреждения сервера (persona-looks.rules.ts) — текст делает словарь. */
export const LOOK_WARNING_AGE_SHIFT = 'age-shift-likeness';

export interface PersonaQuota {
  dayLeft: number;
  monthLeft: number;
}

export interface PersonaMe {
  persona: PersonaInfo | null;
  looks: PersonaLook[];
  voice: { id: string; status: string } | null;
  quota: PersonaQuota;
  /**
   * Рубильник `PERSONA_ENABLED` (сверх контракта, E). Выключен, а
   * персона есть — сервер всё равно отдаёт её: право на удаление не
   * зависит от флага. Экран тогда показывает только «Удалить всё».
   */
  enabled?: boolean;
}

/** Режим выключен, но своя персона есть — только просмотр и удаление. */
export function personaDeleteOnly(me: PersonaMe | null): boolean {
  return !!me?.persona && me.enabled === false;
}

// ── Ошибки сервера ─────────────────────────────────────────────────────

/**
 * Разбор отказа из конверта фильтра исключений:
 * `{ success: false, error: { code, message, details: { code: 'PERSONA_…', quota } } }`.
 * Машинный код — только `PERSONA_…` (общий `error.code` вроде
 * `NOT_FOUND` клиенту ничего не говорит), квота — из `details.quota`.
 */
export function personaErrorInfo(body: unknown): {
  code: string | null;
  quota: PersonaQuota | null;
} {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<
    string,
    unknown
  >;
  const error = raw.error as Record<string, unknown> | undefined;
  const details = error?.details as Record<string, unknown> | undefined;
  let code: string | null = null;
  for (const o of [details, error, raw]) {
    const c = o?.code;
    if (typeof c === 'string' && c.startsWith('PERSONA_')) {
      code = c;
      break;
    }
  }
  const q = details?.quota as Record<string, unknown> | undefined;
  const quota =
    q && typeof q.dayLeft === 'number' && typeof q.monthLeft === 'number'
      ? { dayLeft: q.dayLeft, monthLeft: q.monthLeft }
      : null;
  return { code, quota };
}

/**
 * Какой текст у 429 на образе: месяц или день — по остатку из ответа.
 * Без остатка — «на сегодня»: это частый случай, и он честно
 * обновится сам.
 */
export function quotaRefusalState(
  quota: PersonaQuota | null
): Exclude<PersonaQuotaState, 'ok'> {
  const st = personaQuotaState(quota);
  return st === 'month-over' ? 'month-over' : 'day-over';
}

// ── Голос ──────────────────────────────────────────────────────────────

export type PersonaVoiceState = 'ready' | 'training' | 'failed';

/**
 * Статус голоса терпимо к регистру: user-voices отдаёт нижний регистр,
 * Prisma-енум — верхний, и экран не должен зависеть от того, чья форма
 * пришла. Неизвестное — «обучается» (ждём, а не обещаем готовность).
 */
export function voiceState(
  status: string | null | undefined
): PersonaVoiceState {
  const s = (status ?? '').toLowerCase();
  if (s === 'ready') return 'ready';
  if (s === 'failed') return 'failed';
  return 'training';
}

// ── Шлюз PERSONA_ENABLED ────────────────────────────────────────────────

/** Код, которым сервер говорит «режим выключен флагом» (контракт волны). */
export const PERSONA_DISABLED_CODE = 'PERSONA_DISABLED';

/**
 * Выключен ли режим. Контракт: 404 с кодом `PERSONA_DISABLED`. Но и любой
 * другой 404 на `GET /personas/me` значит то же для человека: персоны
 * «нет» сервер отдаёт как 200 `{ persona: null }`, поэтому 404 бывает
 * только когда маршрута нет вовсе (флаг, или модуль не развёрнут на
 * стенде). Показать вход, который ведёт в «Не найдено», хуже, чем
 * спрятать его. Код возвращается отдельно — для отладки и теста.
 */
export function isPersonaDisabledResponse(
  status: number | undefined,
  body: unknown
): { disabled: boolean; flagged: boolean } {
  if (status !== 404) return { disabled: false, flagged: false };
  return {
    disabled: true,
    flagged: collectCodes(body).includes(PERSONA_DISABLED_CODE),
  };
}

function collectCodes(body: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || depth > 3) return;
    const o = v as Record<string, unknown>;
    for (const k of ['code', 'reason']) {
      if (typeof o[k] === 'string') out.push(o[k] as string);
    }
    for (const k of ['error', 'details', 'data']) visit(o[k], depth + 1);
  };
  visit(body, 0);
  return out;
}

// ── Шаг экрана ─────────────────────────────────────────────────────────

/**
 * - `intro` — персоны нет: экран «Создать себя» и согласие (§4.1 п.1);
 * - `unverified` — согласие дано, но проверка не пройдена или не
 *   запускалась (упала загрузка, закрыли вкладку): предлагаем проверить
 *   ещё раз или переснять;
 * - `base` — проверка пройдена, базового образа ещё нет или он в работе;
 * - `ready` — есть готовый базовый образ: галерея, голос, удаление.
 */
export type PersonaStage = 'intro' | 'unverified' | 'closed' | 'base' | 'ready';

/**
 * `closed` — последняя проверка отказала по возрасту (В-4): переснять
 * не предлагаем, только апелляцию через поддержку и удаление.
 */
export function personaStage(me: PersonaMe | null): PersonaStage {
  if (!me?.persona) return 'intro';
  if (!me.persona.verified) {
    return isUnderageRefusal({
      status: 'refused',
      reasons: me.persona.refusals,
      ageMin: me.persona.ageMin,
    })
      ? 'closed'
      : 'unverified';
  }
  const base = me.looks.find((l) => l.isBase && lookState(l) !== 'deleted');
  if (!base || lookState(base) !== 'ready') return 'base';
  return 'ready';
}

// ── Образы ─────────────────────────────────────────────────────────────

export type LookState = 'ready' | 'pending' | 'failed' | 'deleted';

/**
 * Статус образа в четыре состояния. Готов — только с картинкой: образ
 * «ready» без URL показать нечем, и кнопка «Скетч» на нём упала бы.
 */
export function lookState(
  look: Pick<PersonaLook, 'status' | 'photoUrl'>
): LookState {
  const s = (look.status || '').toLowerCase();
  if (s === 'deleted') return 'deleted';
  if (s === 'failed' || s === 'refused' || s === 'error') return 'failed';
  if (
    look.photoUrl &&
    (s === 'ready' || s === 'active' || s === 'done' || s === '')
  )
    return 'ready';
  return 'pending';
}

/**
 * Что показывать в галерее: без удалённых, базовый — первым (от него
 * считается сходство, §4.9), остальные — новые сверху.
 */
export function galleryLooks(looks: PersonaLook[]): PersonaLook[] {
  return looks
    .filter((l) => lookState(l) !== 'deleted')
    .slice()
    .sort((a, b) => {
      if (a.isBase !== b.isBase) return a.isBase ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

/** Часть словаря `persona`, нужная для подписи образа. */
export interface LookLabelDict {
  baseLabel: string;
  lookUntitled: string;
  presets: Record<LookPreset, string>;
}

/**
 * Подпись образа на экране — одна на все места (галерея «Я в кадре»,
 * «Кто в кадре» в брифе, образ по умолчанию в личном бренд-буке).
 * Базовый образ сервер заводит с пустой подписью (название на языке
 * интерфейса даёт клиент), и без общей функции каждое место придумывало
 * бы своё «пустое» название. Порядок: своя подпись человека → «Базовый
 * образ» → название пресета → «Образ без названия».
 */
export function lookDisplayLabel(
  look: Pick<PersonaLook, 'label' | 'isBase' | 'preset'>,
  dict: LookLabelDict
): string {
  const own = (look.label ?? '').trim();
  if (own) return own;
  if (look.isBase) return dict.baseLabel;
  const preset = look.preset
    ? (dict.presets as Record<string, string>)[look.preset]
    : undefined;
  return preset || dict.lookUntitled;
}

/**
 * Из чего строить новый образ. Пока селфи хранится — выбор «из селфи»
 * (пустой `sourceLookId`). После срока хранения (В-3) селфи нет, и
 * вариант «из селфи» был бы обманом: источником по умолчанию становится
 * базовый образ.
 */
export function lookSourceChoice(
  persona: Pick<PersonaInfo, 'sourcesPurgedAt'> | null,
  looks: PersonaLook[]
): { selfieOption: boolean; defaultSourceId: string } {
  if (!persona?.sourcesPurgedAt)
    return { selfieOption: true, defaultSourceId: '' };
  const base = looks.find((l) => l.isBase && lookState(l) === 'ready');
  const first = looks.find((l) => lookState(l) === 'ready');
  return { selfieOption: false, defaultSourceId: (base ?? first)?.id ?? '' };
}

/** Порядок пилюль пресетов — как в ТЗ §4.1 п.5. */
export const LOOK_PRESETS: LookPreset[] = [
  'business',
  'evening',
  'festive',
  'sport',
  'winter',
];

/** Те же границы, что `@Length(2, 500)` в DTO образа. */
export const LOOK_DESCRIPTION_MIN = 2;
export const LOOK_DESCRIPTION_MAX = 500;
export const LOOK_LABEL_MAX = 80;

// ── Возраст (§4.4) ──────────────────────────────────────────────────────

/** Нижняя граница — всегда 18, независимо от оценки по селфи (§4.4). */
export const TARGET_AGE_MIN = 18;
export const TARGET_AGE_MAX = 90;
/** Сдвиг, после которого сходство может заметно упасть (§4.4). */
export const AGE_SHIFT_WARN_YEARS = 20;

export function clampTargetAge(age: number): number {
  if (!Number.isFinite(age)) return TARGET_AGE_MIN;
  return Math.min(TARGET_AGE_MAX, Math.max(TARGET_AGE_MIN, Math.round(age)));
}

/**
 * Возраст, от которого считается сдвиг — зеркало `referenceLookAge`
 * сервера (persona-looks.rules.ts): у образа-источника — его желаемый
 * возраст, иначе середина оценки по селфи, без оценки — 30; всегда в
 * 18…90. Одна формула на обеих сторонах, иначе экран предупреждал бы
 * там, где сервер молчит, и наоборот.
 */
export function referenceAge(
  persona: Pick<PersonaInfo, 'ageMin' | 'ageMax'> | null,
  source?: Pick<PersonaLook, 'targetAge'> | null
): number {
  if (typeof source?.targetAge === 'number')
    return clampTargetAge(source.targetAge);
  const lo = persona?.ageMin ?? persona?.ageMax;
  const hi = persona?.ageMax ?? persona?.ageMin;
  if (typeof lo === 'number' && typeof hi === 'number')
    return clampTargetAge((lo + hi) / 2);
  return clampTargetAge(30);
}

/** Начальное значение ползунка — «как у источника». */
export function defaultTargetAge(reference: number): number {
  return clampTargetAge(reference);
}

/** Сдвиг больше 20 лет — предупредить ДО нажатия (строго больше, как в ТЗ). */
export function ageShiftWarns(target: number, reference: number): boolean {
  return Math.abs(clampTargetAge(target) - reference) > AGE_SHIFT_WARN_YEARS;
}

/** «ИИ оценил возраст на фото как 28–34» — подстановка в шаблон словаря. */
export function ageRangeLine(
  template: string,
  ageMin: number | null | undefined,
  ageMax: number | null | undefined
): string | null {
  if (ageMin == null || ageMax == null) return null;
  const range = ageMin === ageMax ? String(ageMin) : `${ageMin}–${ageMax}`;
  return template.replace('{{range}}', range);
}

// ── Квота (В-7) ─────────────────────────────────────────────────────────

export type PersonaQuotaState = 'ok' | 'day-over' | 'month-over';

/** Месяц важнее дня: день обновится сам, месяц — повод сменить режим. */
export function personaQuotaState(
  q: PersonaQuota | null | undefined
): PersonaQuotaState {
  if (!q) return 'ok';
  if (q.monthLeft <= 0) return 'month-over';
  if (q.dayLeft <= 0) return 'day-over';
  return 'ok';
}

export function quotaLine(q: PersonaQuota, template: string): string {
  return template
    .replace('{{day}}', String(Math.max(0, q.dayLeft)))
    .replace('{{month}}', String(Math.max(0, q.monthLeft)));
}

/**
 * Можно ли жать «Создать образ»: нужен пресет или описание (иначе
 * модели нечего менять — выйдет копия базового за деньги), и квота.
 */
export function canCreateLook(input: {
  preset: LookPreset | null;
  description: string;
  quota: PersonaQuota | null | undefined;
}): boolean {
  if (personaQuotaState(input.quota) !== 'ok') return false;
  const len = input.description.trim().length;
  if (len > LOOK_DESCRIPTION_MAX) return false;
  if (input.preset) return len === 0 || len >= LOOK_DESCRIPTION_MIN;
  return len >= LOOK_DESCRIPTION_MIN;
}

/** Тело `POST /personas/me/looks` — только заполненное. */
export function lookCreateBody(input: {
  preset: LookPreset | null;
  description: string;
  targetAge: number | null;
  sourceLookId: string | null;
}): {
  preset?: LookPreset;
  description?: string;
  targetAge?: number;
  sourceLookId?: string;
} {
  const body: ReturnType<typeof lookCreateBody> = {};
  if (input.preset) body.preset = input.preset;
  const d = input.description.trim();
  if (d) body.description = d;
  if (input.targetAge != null) body.targetAge = clampTargetAge(input.targetAge);
  if (input.sourceLookId) body.sourceLookId = input.sourceLookId;
  return body;
}

// ── Отказ проверки (§4.3, §4.4) ─────────────────────────────────────────

/**
 * Коды причин отказа — зеркало `PERSONA_REFUSALS` сервера
 * (backend/src/modules/persona/persona-rules.ts; синхронность держит
 * scripts/persona-flow.test.ts). Сервер может прислать и готовую фразу —
 * она показывается как есть; неизвестный машинный код
 * (`some-new-check`) заменяется общей фразой, а не показывается сырьём.
 */
export const REFUSAL_REASONS = [
  'check-unavailable',
  'no-face',
  'multiple-faces',
  'not-frontal',
  'poor-quality',
  'screen-or-print',
  'not-same-person',
  'no-live-motion',
  'age-unknown',
  'under-18',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

const KNOWN_REASONS = new Set<string>(REFUSAL_REASONS);

export type RefusalLine =
  | { kind: 'known'; reason: RefusalReason }
  | { kind: 'text'; text: string }
  | { kind: 'generic' };

export function refusalLines(
  reasons: string[] | undefined | null
): RefusalLine[] {
  const out: RefusalLine[] = [];
  const seen = new Set<string>();
  for (const raw of reasons ?? []) {
    const r = (raw ?? '').trim();
    if (!r) continue;
    const code = r.toLowerCase();
    const line: RefusalLine = KNOWN_REASONS.has(code)
      ? { kind: 'known', reason: code as RefusalReason }
      : /^[a-z0-9_-]+$/.test(r)
        ? { kind: 'generic' }
        : { kind: 'text', text: r };
    const key =
      line.kind === 'known'
        ? line.reason
        : line.kind === 'text'
          ? line.text
          : '#';
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  if (out.length === 0) out.push({ kind: 'generic' });
  return out;
}

/**
 * Отказ из-за возраста — отдельный экран (§4.4, В-4): переснять тут не
 * поможет, дорога одна — апелляция через поддержку. Считается и по коду,
 * и по нижней границе оценки: сервер обязан прислать код, но если
 * пришла только оценка младше 18, экран не должен предлагать «ещё раз».
 */
export function isUnderageRefusal(result: {
  status: string;
  reasons?: string[] | null;
  ageMin?: number | null;
}): boolean {
  if (result.status !== 'refused') return false;
  if (result.ageMin != null && result.ageMin < TARGET_AGE_MIN) return true;
  return refusalLines(result.reasons).some(
    (l) => l.kind === 'known' && l.reason === 'under-18'
  );
}

/**
 * Проверка не состоялась (модель недоступна) — снимки на сервере целы,
 * и честный следующий шаг — «Проверить ещё раз», а не пересъёмка.
 */
export function verifyRetryable(reasons: string[] | null | undefined): boolean {
  return (reasons ?? []).some(
    (r) => r.trim().toLowerCase() === 'check-unavailable'
  );
}

// ── Удаление (§4.9) ─────────────────────────────────────────────────────

export interface PublishedShare {
  id: string;
  url: string;
  /**
   * Для `DELETE /sessions/:sessionId/shared-video/:id` — сервер (E)
   * отдаёт его у каждой страницы. Необязательный только в типе: без него
   * (старый сервер) экран даёт ссылку, а не ломает удаление.
   */
  sessionId?: string | null;
}

/** Какие страницы экран может снять сам, а какие — только открыть. */
export function splitShares(shares: PublishedShare[]): {
  removable: PublishedShare[];
  linkOnly: PublishedShare[];
} {
  const removable: PublishedShare[] = [];
  const linkOnly: PublishedShare[] = [];
  for (const s of shares) (s.sessionId ? removable : linkOnly).push(s);
  return { removable, linkOnly };
}
