/**
 * «Админка: действия» — ЧИСТАЯ часть Э8 (ТЗ §5.2–5.7, §4-бис.5, §5-бис.15
 * п.14; приёмка Э8 п.1–6): хеш параметров предложения, строки карточки
 * «было → станет», слово подтверждения danger, сумма для денежного потолка,
 * признак «без вашей просьбы», ссылки `$.request`/`$.preview` компенсации и
 * предпросмотра, подпись изменяющего запроса и тексты, которые пишет КОД.
 *
 * Модель здесь ничего не решает: она только предлагает операцию и аргументы
 * (проверка — `validateArgs` по схеме OpenAPI); исполнение — отдельное «Да».
 */
import { createHash, createHmac } from 'crypto';
import { dangerKindsFor } from '../../shared/danger-words';
import { canonicalJson } from '../assist-admin-mode/action-log.service';
import {
  VALUE_REF_RE,
  type LinkedOperation,
  type OperationKind,
  type OperationParam,
} from '../assist-admin-mode/openapi-import';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type ActionLang = 'uk' | 'ru' | 'en';

/** Сроки и потолки действий (§5.4 п.5, §7.3; решения Э8 — план «Э8 — сделано»). */
export const ACTION_LIMITS = {
  /** Предложение живёт 10 мин (§5.4 п.5, §4-бис.5). */
  proposalTtlMs: 10 * MINUTE,
  /** Незавершённых карточек у сотрудника одновременно. */
  pendingPerActor: 5,
  /** Исполнений («Да») сотрудника за час. */
  confirmsPerActorHour: 30,
  /** Компенсацию по `x-assist-compensation` можно предложить 7 дней. */
  compensationWindowMs: 7 * DAY,
  /** Параметры и снимок «было» стираются после окна компенсации (+1 день). */
  paramsKeepMs: 8 * DAY,
  /** Снимок `preview` для карточки и `$.preview.*`. */
  previewMaxBytes: 8 * 1024,
  /**
   * Значение строки карточки — целиком: не меньше предела строки в
   * `validateArgs` (500) — иначе хвост аргумента уходил в API невидимым
   * (аудит Э8). «Было» из снимка — тоже до 500.
   */
  fieldValueChars: 500,
  /** Аргументов больше — предложение не создаётся (каждый — строкой карточки). */
  fieldsMax: 40,
  errorTextChars: 300,
  /** «Да» исполняется дольше этого — карточка считает исход неизвестным. */
  executingStaleMs: MINUTE,
  /**
   * Аудит Э8 (4), Р-З9-21: повтор «Да» после `unknown` тем же ключом — не
   * позже суток от исполнения. Позже API заказчика вправе забыть ключ
   * идемпотентности (обычно 24 ч) — повтор стал бы дублем; карточка
   * истекает, сотрудник проверяет в админке и просит заново (новый ключ).
   */
  unknownRetryMs: DAY,
  /** Запуск мемо АМ-N живёт 30 мин. */
  memoRunTtlMs: 30 * MINUTE,
} as const;

/** Потолок сайта по умолчанию (`assist_admin_settings.actionsDailyCap`). */
export const ACTIONS_DAILY_CAP_DEFAULT = 100;

export const PROPOSAL_STATUSES = [
  'pending',
  'executing',
  'done',
  'failed',
  'unknown',
  'rejected',
  'expired',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Статус цепочки (§5-бис.15 п.11) — в журнале новой записью `chain`. */
export type ChainStatus =
  'committed' | 'compensated' | 'compensation_failed' | 'unknown';

/**
 * Хеш предложения: операция + аргументы в каноническом JSON (порядок ключей
 * не влияет). «Да» сверяет хеш, который видел сотрудник, с хешем строки и с
 * пересчётом по сохранённым параметрам (§5.4 п.6; приёмка Э8 п.2).
 */
export function proposalHash(
  operationRowId: string,
  args: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(canonicalJson([operationRowId, args]))
    .digest('hex');
}

/** Значение по пути `a.b[0].c` в JSON (без прототипов). */
export function jsonAt(root: unknown, path: string): unknown {
  let cur: unknown = root;
  const parts = path.match(/[A-Za-z0-9_-]+|\[\d{1,3}\]/g) ?? [];
  for (const raw of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (raw.startsWith('[')) {
      const i = Number(raw.slice(1, -1));
      if (!Array.isArray(cur)) return undefined;
      cur = cur[i];
    } else {
      if (typeof cur !== 'object' || Array.isArray(cur)) return undefined;
      if (!Object.prototype.hasOwnProperty.call(cur, raw)) return undefined;
      cur = (cur as Record<string, unknown>)[raw];
    }
  }
  return cur;
}

/**
 * Аргументы связанной операции (компенсация/предпросмотр) из ссылок
 * `$.request.<путь>` (исходные аргументы) и `$.preview.<путь>` (снимок
 * «было»). Не найдено значение — null (связь неисполнима, а не «пусто»).
 */
export function linkedArgs(
  link: LinkedOperation,
  request: Record<string, unknown>,
  preview: unknown,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [name, ref] of Object.entries(link.params)) {
    if (!VALUE_REF_RE.test(ref)) return null;
    const m = /^\$\.(request|preview)\.(.+)$/.exec(ref)!;
    const v = jsonAt(m[1] === 'request' ? request : preview, m[2]);
    if (v === undefined) return null;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return null;
    out[name] = v;
  }
  return out;
}

/** Строка карточки «было → станет» (§5.4 п.5, §5.5 `preview`). */
export interface ProposalField {
  name: string;
  in: 'path' | 'query' | 'body';
  /** Прежнее значение из `preview` (нет предпросмотра — нет поля). */
  before?: string | string[] | null;
  after: string | string[];
}

function shown(v: unknown): string | string[] {
  if (Array.isArray(v)) {
    return v.slice(0, 100).map((x) => shownScalar(x));
  }
  return shownScalar(v);
}

function shownScalar(v: unknown): string {
  const s =
    v === null || v === undefined
      ? '—'
      : typeof v === 'object'
        ? canonicalJson(v)
        : String(v);
  // Управляющие — пробелом; невидимые и bidi-символы (U+202E «справа
  // налево» и т.п.) — заметным «�»: показанное не должно расходиться с
  // отправляемым (аудит Э8).
  const clean = s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(
      /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g,
      '\ufffd',
    );
  return clean.length > ACTION_LIMITS.fieldValueChars
    ? `${clean.slice(0, ACTION_LIMITS.fieldValueChars)}…`
    : clean;
}

/** Прежнее значение поля в снимке: верхний уровень или `data.<имя>`. */
function previewValue(preview: unknown, name: string): unknown {
  const top = jsonAt(preview, name);
  if (top !== undefined) return top;
  return jsonAt(preview, `data.${name}`);
}

/**
 * Строки карточки: КАЖДЫЙ переданный аргумент (массив — все элементы:
 * «обновить 5 заказов» — 5 строк, §5.4), прежнее значение — только из
 * снимка `preview` и только для изменяемых полей (не для id в пути).
 */
export function proposalFields(
  params: readonly OperationParam[],
  args: Record<string, unknown>,
  preview: unknown,
): ProposalField[] {
  const out: ProposalField[] = [];
  for (const p of params) {
    const v = args[p.name];
    if (v === undefined) continue;
    const f: ProposalField = { name: p.name, in: p.in, after: shown(v) };
    if (preview !== undefined && preview !== null && p.in !== 'path') {
      const b = previewValue(preview, p.name);
      f.before = b === undefined ? null : shown(b);
    }
    out.push(f);
    if (out.length >= ACTION_LIMITS.fieldsMax) break;
  }
  return out;
}

/**
 * Каждый аргумент виден строкой карточки (аудит Э8): аргументов больше
 * `fieldsMax` — предложение не создаётся, а не уходит в API с невидимым
 * хвостом.
 */
export function cardShowsAllArgs(args: Record<string, unknown>): boolean {
  return Object.keys(args).length <= ACTION_LIMITS.fieldsMax;
}

const CONFIRM_WORD: Record<ActionLang, string> = {
  uk: 'ПІДТВЕРДЖУЮ',
  ru: 'ПОДТВЕРЖДАЮ',
  en: 'CONFIRM',
};

/** Сколько строк меняет действие: длина самого длинного массива или 1. */
export function itemsCount(args: Record<string, unknown>): number {
  let n = 1;
  for (const v of Object.values(args)) {
    if (Array.isArray(v)) n = Math.max(n, v.length);
  }
  return n;
}

/**
 * Слово подтверждения danger (§5.2: «ОТМЕНИТЬ 3 ЗАКАЗА»): слово владельца
 * (`confirmWord`) или «ПІДТВЕРДЖУЮ» + число строк — сотрудник видит, СКОЛЬКО
 * меняет, и набирает это руками.
 */
export function confirmPhraseFor(
  word: string | null,
  lang: ActionLang,
  args: Record<string, unknown>,
): string {
  const w = normalizePhrase(word || CONFIRM_WORD[lang]);
  return `${w} ${itemsCount(args)}`;
}

export function normalizePhrase(s: string): string {
  return s
    .normalize('NFC')
    .toUpperCase()
    .replace(/Ё/g, 'Е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Сумма для денежного потолка: число, null (нет параметра) или 'missing'. */
export function amountOf(
  amountParam: string | null,
  args: Record<string, unknown>,
): number | null | 'missing' {
  if (!amountParam) return null;
  const v = args[amountParam];
  if (v === undefined || v === null || v === '') return 'missing';
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.abs(n) : 'missing';
}

/** Глаголы изменения — просьба сотрудника «сделай» (uk/ru/en, основы). */
const MUTATE_STEMS =
  /(?<!\p{L})(змін|поміня|постав|встанов|онов|додай|додат|створ|познач|відправ|надішл|признач|перевед|переміст|увімкн|вимкн|активу|архів|закр|відкри|підтверд|відхил|измен|поменя|установ|обнов|добав|созда|отмет|отправ|назнач|перевед|перемест|включ|выключ|архив|закро|откро|подтверд|отклон|change|set|update|mark|add|create|assign|move|send|enable|disable|activate|archive|close|reopen|approve|reject|confirm|publish|edit|rename|put)/iu;

/** Разрушительные основы (§5.2 стоп-лист) — просьба о danger. */
const DANGER_STEMS =
  /(?<!\p{L})(видал|удал|прибер|убер|delete|remove|erase|скасу|отмен|cancel|поверн|возврат|верни|refund|спиш|спис|charge|виплат|выплат|payout|заблок|block|ban|очист|clear|purge|масов|массов|bulk)/iu;

/**
 * Просил ли сотрудник ИЗМЕНЕНИЕ своими словами (§5.7: «модель пытается
 * вызвать danger вне запроса сотрудника» — пометка «без вашей просьбы»).
 * write — любой глагол изменения или разрушения; danger — только
 * разрушительный (словарь `danger-words` + стоп-лист §5.2). Это пометка на
 * ревью, а не разрешение: «Да» нужно в любом случае.
 */
export function requestedByEmployee(
  question: string,
  kind: OperationKind,
): boolean {
  const q = question.normalize('NFC');
  const danger = DANGER_STEMS.test(q) || dangerKindsFor(q).length > 0;
  if (kind === 'danger') return danger;
  return danger || MUTATE_STEMS.test(q);
}

/** Подпись изменяющего запроса `X-V4C-Signature` (§5.5, по образцу вебхуков). */
export const SIGNATURE_HEADER = 'x-v4c-signature';
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * `t=<unix>,v1=<hex HMAC-SHA256(secret,
 * "<t>.<METHOD>.<Idempotency-Key>.<путь?запрос>.<тело>")>`: метод и адрес
 * в строке — перехваченную подпись не приложить к другому эндпоинту; время —
 * получатель отвергает старое своим окном; ключ идемпотентности — повтор в
 * окне с ДРУГИМ ключом (обход дедупликации получателя) подпись не пройдёт
 * (аудит Э8). Ключ — до адреса: в ключе нет точек, разбор однозначен.
 */
export function signRequest(
  secret: string,
  method: string,
  idempotencyKey: string,
  pathAndQuery: string,
  body: string,
  unixSec: number,
): string {
  const t = Math.floor(unixSec);
  const v1 = createHmac('sha256', secret)
    .update(
      `${t}.${method.toUpperCase()}.${idempotencyKey}.${pathAndQuery}.${body}`,
      'utf8',
    )
    .digest('hex');
  return `t=${t},v1=${v1}`;
}

/** Предложение просрочено (или зависло в исполнении) к моменту `now`. */
/** Р-З9-21: `unknown` старше суток от исполнения — повтор «Да» закрыт. */
export function unknownRetryClosed(
  p: { status: string; executedAt?: Date | null; decidedAt: Date | null },
  now: Date,
): boolean {
  if (p.status !== 'unknown') return false;
  const at = p.executedAt ?? p.decidedAt;
  return !!at && now.getTime() - at.getTime() > ACTION_LIMITS.unknownRetryMs;
}

export function effectiveStatus(
  p: {
    status: string;
    expiresAt: Date;
    decidedAt: Date | null;
    executedAt?: Date | null;
  },
  now: Date,
): ProposalStatus {
  const s = p.status as ProposalStatus;
  if (s === 'pending' && p.expiresAt.getTime() <= now.getTime()) {
    return 'expired';
  }
  if (unknownRetryClosed(p, now)) return 'expired';
  if (
    s === 'executing' &&
    p.decidedAt &&
    now.getTime() - p.decidedAt.getTime() > ACTION_LIMITS.executingStaleMs
  ) {
    return 'unknown';
  }
  return s;
}

/** Текст ошибки API для карточки: без управляющих символов, усечён (§5.7). */
export function apiErrorText(
  body: string,
  mask: (s: string) => string,
): string | null {
  let text = body;
  try {
    const j = JSON.parse(body) as unknown;
    const msg =
      jsonAt(j, 'message') ??
      jsonAt(j, 'error.message') ??
      jsonAt(j, 'error') ??
      jsonAt(j, 'detail') ??
      jsonAt(j, 'title');
    if (typeof msg === 'string') text = msg;
  } catch {
    /* не JSON — сырой текст */
  }
  const clean = mask(
    text
      .replace(/<[^>]*>/g, ' ')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  if (!clean) return null;
  return clean.length > ACTION_LIMITS.errorTextChars
    ? `${clean.slice(0, ACTION_LIMITS.errorTextChars)}…`
    : clean;
}

/** Тексты, которые пишет КОД (не модель) — предложения, итоги, отказы. */
export const ACTION_TEXT = {
  proposed: {
    uk: (what: string) =>
      `Я збираюсь: ${what}. Перевірте поля в картці й підтвердьте «Так» або відхиліть — без вашого «Так» нічого не зміниться.`,
    ru: (what: string) =>
      `Я собираюсь: ${what}. Проверьте поля в карточке и подтвердите «Да» или отклоните — без вашего «Да» ничего не изменится.`,
    en: (what: string) =>
      `I'm about to: ${what}. Check the fields in the card and confirm with "Yes" or reject — nothing changes without your "Yes".`,
  },
  unrequested: {
    uk: 'Асистент запропонував це сам, без вашого прохання. Перевірте уважно.',
    ru: 'Ассистент предложил это сам, без вашей просьбы. Проверьте внимательно.',
    en: 'The assistant suggested this on its own, without your request. Check carefully.',
  },
  done: {
    uk: (what: string) => `Готово: ${what}. Запис є в журналі дій.`,
    ru: (what: string) => `Готово: ${what}. Запись есть в журнале действий.`,
    en: (what: string) => `Done: ${what}. It's recorded in the action log.`,
  },
  failed: {
    uk: (what: string, err: string | null) =>
      `Система відхилила дію «${what}»${err ? `: ${err}` : ''}. Нічого не змінено.`,
    ru: (what: string, err: string | null) =>
      `Система отклонила действие «${what}»${err ? `: ${err}` : ''}. Ничего не изменено.`,
    en: (what: string, err: string | null) =>
      `The system rejected «${what}»${err ? `: ${err}` : ''}. Nothing was changed.`,
  },
  retryExpired: {
    uk: 'Повтор цієї дії більше не приймається (минуло понад 24 години). Перевірте результат в адмінці; якщо дії немає — попросіть ще раз, буде нова картка.',
    ru: 'Повтор этого действия больше не принимается (прошло больше 24 часов). Проверьте результат в админке; если действия нет — попросите заново, будет новая карточка.',
    en: 'This action can no longer be retried (more than 24 hours have passed). Check the result in the admin panel; if it was not applied, ask again to get a new card.',
  },
  unknown: {
    uk: (what: string) =>
      `Не знаю, чи застосувалась дія «${what}» — система не відповіла вчасно. Перевірте в адмінці (кнопка «Перевірити»); повтор — лише новим «Так» із тим самим ключем.`,
    ru: (what: string) =>
      `Не знаю, применилось ли действие «${what}» — система не ответила вовремя. Проверьте в админке (кнопка «Проверить»); повтор — только новым «Да» с тем же ключом.`,
    en: (what: string) =>
      `I don't know whether «${what}» was applied — the system didn't respond in time. Check in the admin panel ("Check"); a retry needs a new "Yes" with the same key.`,
  },
  authFailed: {
    uk: (name: string) =>
      `Доступ помічника до «${name}» не працює (ключ API відхилено) — дію не виконано, власник отримав сповіщення.`,
    ru: (name: string) =>
      `Доступ помощника к «${name}» не работает (ключ API отклонён) — действие не выполнено, владелец получил уведомление.`,
    en: (name: string) =>
      `The assistant's access to «${name}» isn't working (API key rejected) — nothing was done, the owner was notified.`,
  },
  rejected: {
    uk: 'Добре, дію відхилено — нічого не змінено.',
    ru: 'Хорошо, действие отклонено — ничего не изменено.',
    en: 'OK, the action was rejected — nothing was changed.',
  },
  noUndo: {
    uk: 'Скасувати цю дію не можна.',
    ru: 'Отменить это действие нельзя.',
    en: 'This action cannot be undone.',
  },
  limit: {
    uk: 'Ліміт дій вичерпано — спробуйте пізніше або зверніться до власника.',
    ru: 'Лимит действий исчерпан — попробуйте позже или обратитесь к владельцу.',
    en: 'The action limit is used up — try later or ask the owner.',
  },
  amountLimit: {
    uk: 'Сума перевищує ліміт, який встановив власник, — дію не запропоновано.',
    ru: 'Сумма превышает лимит, установленный владельцем, — действие не предложено.',
    en: 'The amount exceeds the limit set by the owner — the action was not proposed.',
  },
  amountMissing: {
    uk: 'Вкажіть суму явно — без неї грошову дію не пропоную.',
    ru: 'Укажите сумму явно — без неё денежное действие не предлагаю.',
    en: 'Please state the amount explicitly — I won’t propose a money action without it.',
  },
  pendingMany: {
    uk: 'Спершу підтвердьте або відхиліть попередні дії в картках.',
    ru: 'Сначала подтвердите или отклоните предыдущие действия в карточках.',
    en: 'First confirm or reject the previous actions in their cards.',
  },
  tooManyFields: {
    uk: (n: number) =>
      `Забагато параметрів (більше ${n}) — розбийте дію на кілька, щоб кожне поле було видно в картці.`,
    ru: (n: number) =>
      `Слишком много параметров (больше ${n}) — разбейте действие на несколько, чтобы каждое поле было видно в карточке.`,
    en: (n: number) =>
      `Too many parameters (more than ${n}) — split the action so every field is visible in the card.`,
  },
  planNeeded: {
    uk: '«Адмінка: дії» — у тарифі Pro. Поки можу лише читати дані.',
    ru: '«Админка: действия» — в тарифе Pro. Пока могу только читать данные.',
    en: '"Admin: actions" is in the Pro plan. For now I can only read data.',
  },
} as const;

/** Короткое «что делаю» для карточки и текстов: описание операции или её имя. */
export function actionTitle(op: {
  summary: string | null;
  operationId: string;
}): string {
  const s = (op.summary ?? '').replace(/\s+/g, ' ').trim();
  return (s || op.operationId).slice(0, 120);
}

/** Окно компенсации ещё открыто. */
export function compensationOpen(executedAt: Date | null, now: Date): boolean {
  return (
    !!executedAt &&
    now.getTime() - executedAt.getTime() <= ACTION_LIMITS.compensationWindowMs
  );
}
