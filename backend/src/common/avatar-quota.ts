/**
 * Суточная квота на аватар-ролики (Hedra) — по числу вызовов, а не по
 * деньгам.
 *
 * Зачем отдельно от суточного денежного потолка (`spend-limits.ts`).
 * Потолок PREMIUM — $100 в сутки, а секунда аватара стоит порядка трёх
 * центов: одному пользователю этого хватит примерно на пятьдесят минут
 * говорящей головы за вечер. Деньги при этом формально не превышены, но
 * счёт от Hedra за такой вечер придёт настоящий. Счётчик вызовов
 * закрывает ровно этот разрыв — как это уже сделано для картинок
 * (`image-generation-quota.ts`, тот же довод: «нажать сто раз подряд
 * можно за минуту»).
 *
 * Считаем только сутки, без месячного лимита. У картинок месяц нужен,
 * потому что дневной потолок там десятки штук; здесь суточный потолок
 * мал сам по себе, и второй рубеж был бы церемонией.
 *
 * Расход берётся из той же операции `avatar-generation`, которой пишет
 * расход пилот аватара, — и это правильно: считается он по `userId`, а
 * пилот запускает оператор из-под своей учётной записи, так что
 * пользовательскую квоту он не трогает.
 *
 * Чистый модуль, без инъекций Nest, — ради теста в изоляции.
 */
import type { PlanId } from './plans';

/** Операции, расходующие эту квоту. */
export const AVATAR_OPERATIONS = ['avatar-generation'] as const;

/**
 * Ноль на LITE и STANDARD — не «запрет про запас», а то же, что говорит
 * тариф: аватар входит в PREMIUM. Гейт по тарифу стоит раньше и вернёт
 * 403 сам; ноль здесь — второй рубеж на случай, если когда-нибудь фичу
 * откроют ниже тарифом, забыв про потолок.
 */
const DEFAULTS: Record<PlanId, number> = {
  LITE: 0,
  STANDARD: 0,
  PREMIUM: 5,
};

export const AVATAR_QUOTA_ENV: Record<PlanId, string> = {
  LITE: 'AVATAR_VIDEO_DAY_LITE',
  STANDARD: 'AVATAR_VIDEO_DAY_STANDARD',
  PREMIUM: 'AVATAR_VIDEO_DAY_PREMIUM',
};

/** Целое ≥ 0 из env; мусор или пусто — значение по умолчанию. Ноль —
 * законный способ временно закрыть аватар на тарифе без выката. */
function intFrom(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export function avatarQuotaPerDay(
  plan: PlanId,
  env: NodeJS.ProcessEnv = process.env,
): number {
  return intFrom(env, AVATAR_QUOTA_ENV[plan], DEFAULTS[plan]);
}

/** Исчерпана ли квота. Отдельной функцией — чтобы граница «>=», а не
 * «>», была написана один раз и проверена тестом. */
export function avatarQuotaExhausted(used: number, quota: number): boolean {
  return used >= quota;
}
