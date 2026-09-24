/**
 * Приглашения: правила без базы — «Условно бесплатный Lite» §5,
 * этап 134.
 *
 * Здесь всё, что можно проверить, не поднимая ни Prisma, ни Nest: как
 * выглядит код, что считается засчитанным и сколько их можно засчитать
 * за сутки. Сам засчёт — в `ReferralService`.
 */

/**
 * Алфавит кода.
 *
 * Base32 без `0`, `1`, `O`, `I`, `L` — знаков, которые люди путают,
 * переписывая ссылку с чужого экрана или диктуя её вслух. Приглашение
 * живёт в чужих руках, и «код не подошёл» здесь стоит не сообщения об
 * ошибке, а потерянного приглашённого.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 8;

/** Сколько приглашений засчитывается одному человеку в сутки. */
export const DEFAULT_REFERRAL_DAILY_COUNTED_CAP = 10;

/** Сколько приглашённых нужно, чтобы стена снялась насовсем (этап 135). */
export const DEFAULT_REFERRAL_UNLOCK_TARGET = 7;

/** Сколько генераций получает сам приглашённый (Р6). Ноль — выключено. */
export const DEFAULT_REFERRAL_INVITEE_BONUS = 1;

/**
 * Сколько часов после создания аккаунта человек ещё считается пришедшим
 * по приглашению (§5.2: «приглашённым считается только пользователь,
 * которого раньше не было»).
 *
 * Почему окно, а не ноль. Правило ТЗ звучит как «`telegramId` не
 * встречался в базе», и проверить его буквально в момент привязки
 * нельзя: к этому моменту человек уже представился, то есть строка
 * `User` уже есть. Зато у неё есть `createdAt`, и это ровно дата
 * ПЕРВОГО появления этого `telegramId` — поле уникально. Значит
 * «раньше не было» = «аккаунт заведён только что».
 *
 * Ноль не годится: между переходом по ссылке и входом человек проходит
 * мастер, а привязка может опоздать на повтор — сеть, закрытая вкладка,
 * возврат назавтра. Сутки закрывают все эти случаи и при этом не
 * пускают в программу тех, кто пользуется продуктом месяцами: их клик
 * по чужой ссылке не должен создавать ничего.
 */
export const DEFAULT_REFERRAL_CLAIM_WINDOW_HOURS = 24;

function intFromEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  // Ноль — законное значение («выключить»), мусор и отрицательное — нет:
  // сломанная настройка не должна молча менять правила программы.
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function referralDailyCountedCap(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intFromEnv(
    env.REFERRAL_DAILY_COUNTED_CAP,
    DEFAULT_REFERRAL_DAILY_COUNTED_CAP,
  );
}

export function referralUnlockTarget(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intFromEnv(env.REFERRAL_UNLOCK_TARGET, DEFAULT_REFERRAL_UNLOCK_TARGET);
}

export function referralInviteeBonus(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intFromEnv(env.REFERRAL_INVITEE_BONUS, DEFAULT_REFERRAL_INVITEE_BONUS);
}

export function referralClaimWindowMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return (
    intFromEnv(
      env.REFERRAL_CLAIM_WINDOW_HOURS,
      DEFAULT_REFERRAL_CLAIM_WINDOW_HOURS,
    ) *
    60 *
    60 *
    1000
  );
}

/**
 * Этот человек ещё «новый»? — единственное, чем §5.2 отличает
 * приглашённого от давнего пользователя, нажавшего на чужую ссылку.
 *
 * Ноль в окне означает «привязывать некого»: программа приглашений
 * фактически выключена, и это законное значение, как и везде здесь.
 */
export function isNewcomer(
  createdAt: Date,
  windowMs: number,
  now: Date = new Date(),
): boolean {
  if (windowMs <= 0) return false;
  const age = now.getTime() - createdAt.getTime();
  // Аккаунт «из будущего» (часы сервера разъехались) — не повод
  // отказать человеку: он тем более только что появился.
  return age <= windowMs;
}

/**
 * Телеметрия кабинета — §12.2 ТЗ: «тем же механизмом, что телеметрия
 * мастера», то есть в `wizard_step_events`, где нет ни одного
 * идентифицирующего поля и уже работает 30-дневная ретенция.
 *
 * `scenario` — чем кабинет отличается от мастера в той же таблице.
 */
export const INVITE_TELEMETRY_SCENARIO = 'invite';

/**
 * Ровно четыре события, названные в §12.2, и ни одного сверх: открыл
 * кабинет, скопировал ссылку, нажал «Поделиться», упёрся в стену.
 *
 * Список закрытый и проверяется на входе. Открытый `stepId` в
 * анонимном маршруте — это чужая строка в нашей таблице: писать туда
 * произвольный текст без идентичности не должно быть можно.
 */
export const INVITE_EVENT_STEPS = ['cabinet', 'copy', 'share', 'wall'] as const;
export type InviteEventStep = (typeof INVITE_EVENT_STEPS)[number];

/**
 * Какое событие чем является. `enter` — человек где-то оказался,
 * `click` — нажал. Пара задана здесь, а не на клиенте: иначе одно и
 * то же действие приезжало бы то одним видом, то другим, и сводка
 * перестала бы складываться.
 */
export const INVITE_EVENT_KIND: Record<InviteEventStep, 'enter' | 'click'> = {
  cabinet: 'enter',
  copy: 'click',
  share: 'click',
  wall: 'enter',
};

export function isInviteEventStep(raw: unknown): raw is InviteEventStep {
  return (
    typeof raw === 'string' &&
    (INVITE_EVENT_STEPS as readonly string[]).includes(raw)
  );
}

/** Нормализация кода из ссылки: регистр и пробелы человеку прощаем. */
export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

/**
 * Код из случайных байт.
 *
 * `randomBytes`, а не `Math.random`: код — это публичная ссылка, и
 * предсказуемый генератор позволил бы перебрать чужие. Перебор сам по
 * себе ничего не даёт (по чужому коду человек просто приведёт другу
 * чужого приглашённого), но и защищаться тут нечем дороже одной строки.
 */
export function makeCode(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

/** Приглашение засчитано: дошёл до ролика и не снято оператором. */
export function isCounted(referral: {
  status: string;
  revokedAt?: Date | null;
}): boolean {
  return referral.status === 'GENERATED' && !referral.revokedAt;
}

/** Три числа воронки для кабинета (§7.1). */
export interface ReferralFunnel {
  visited: number;
  identified: number;
  generated: number;
}

/**
 * Считается по ЧИСЛАМ, а не по списку строк. Найдено аудитом этапа 134:
 * кабинет отдаёт список приглашённых, обрезанный полусотней, и первая
 * редакция считала воронку по нему же — у человека с шестьюдесятью
 * приглашёнными на экране навсегда стояло «50 вошли». Список — это
 * витрина, а воронка — счёт; считать витриной нельзя.
 */
export function funnelOf(counts: {
  visitCount: number;
  identified: number;
  generated: number;
}): ReferralFunnel {
  return {
    // Переходов не может быть меньше, чем вошедших: счётчик кликов
    // теряется на блокировщиках и приватных вкладках, а строка о
    // вошедшем не теряется никогда. Показать «3 перехода, 5 вошли» —
    // значит заставить человека не верить обоим числам.
    visited: Math.max(counts.visitCount, counts.identified),
    identified: counts.identified,
    generated: counts.generated,
  };
}
