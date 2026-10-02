/**
 * Тариф кабинета и счётчик единиц — ПУБЛИЧНАЯ часть assist-billing (её
 * зовёт конвейер ответа виджета под ролью assist_public; правило графа
 * `public-zone-e4`). Только сырой SQL по колонкам, которые роли открыты
 * миграцией …_assist_billing: строка подписки без шифра recToken, счётчик
 * периода, `min(assist_sites.createdAt)` — начало пробного (первый сайт
 * кабинета с помощником; нет такого — первый сайт кабинета вообще: знания
 * «Админки» могут начаться раньше виджета), пока крон не записал строку
 * подписки.
 *
 * Кэша нет намеренно: оплата меняет лимит со следующего вопроса посетителя
 * (приёмка Э4 «оплата повышает тариф без перезагрузки виджета»), а чтение
 * — одна строка по первичному ключу.
 *
 * Квота — ОДИН условный UPDATE (§4.5 уточнение 3):
 *   units + w <= лимит тарифа + докупка + (авто-пакет, если владелец
 *   включил автодокупку и потолок денег ещё позволяет пакет)
 * Авто-пакет — «кредит на один пакет»: крон assist-billing-tick списывает
 * его по recToken и переносит в докупку; не списалось — автодокупка
 * выключается, следующий пакет не открывается (риск ≤ одного пакета).
 */

import {
  ASSIST_PLANS,
  TOPUP_PACK_UNITS,
  siteDailyCapFromPlan,
  topupPackMicroUsd,
} from '../plans';
import {
  subscriptionState,
  unitsLimit,
  type SubscriptionRow,
  type SubscriptionState,
} from '../subscription-state';

/** Клиент — публичный (виджет) или основной (крон, кабинет): только сырой SQL. */
export interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const SUBS = '"sites"."assist_subscriptions"';
const USAGE = '"sites"."assist_account_usage"';
const ASSIST_SITES = '"sites"."assist_sites"';
const SITES = '"sites"."site_sites"';

export interface UsageRow {
  units: number;
  dialogs: number;
  extraUnits: number;
  autoPacks: number;
  autoSpentMicroUsd: number;
  exhaustedAt: Date | null;
}

export const EMPTY_USAGE: UsageRow = {
  units: 0,
  dialogs: 0,
  extraUnits: 0,
  autoPacks: 0,
  autoSpentMicroUsd: 0,
  exhaustedAt: null,
};

/** Строка подписки (колонки роли) и начало пробного — одним запросом. */
export async function readSubscription(
  db: RawDb,
  accountId: string,
): Promise<{ row: SubscriptionRow | null; trialStart: Date | null }> {
  const rows = await db.$queryRawUnsafe<
    Array<{
      planId: string | null;
      status: string | null;
      method: string | null;
      anchorAt: Date | null;
      paidThrough: Date | null;
      cancelAtPeriodEnd: boolean | null;
      autoTopUp: boolean | null;
      autoTopUpCapMicroUsd: bigint | null;
      trialStart: Date | null;
    }>
  >(
    `SELECT s."planId", s."status", s."method", s."anchorAt", s."paidThrough",
            s."cancelAtPeriodEnd", s."autoTopUp", s."autoTopUpCapMicroUsd",
            COALESCE(
              (SELECT min(x."createdAt") FROM ${ASSIST_SITES} x WHERE x."accountId" = $1),
              (SELECT min(y."createdAt") FROM ${SITES} y WHERE y."accountId" = $1)
            ) AS "trialStart"
       FROM (SELECT 1) AS one
       LEFT JOIN ${SUBS} s ON s."accountId" = $1`,
    accountId,
  );
  const r = rows[0];
  if (!r) return { row: null, trialStart: null };
  const row: SubscriptionRow | null =
    r.planId && r.anchorAt && r.paidThrough
      ? {
          planId: r.planId,
          status: r.status ?? 'active',
          method: r.method ?? 'manual',
          anchorAt: r.anchorAt,
          paidThrough: r.paidThrough,
          cancelAtPeriodEnd: !!r.cancelAtPeriodEnd,
          autoTopUp: !!r.autoTopUp,
          autoTopUpCapMicroUsd: r.autoTopUpCapMicroUsd ?? BigInt(0),
        }
      : null;
  return { row, trialStart: r.trialStart };
}

export async function readState(
  db: RawDb,
  accountId: string,
  now: Date,
): Promise<SubscriptionState> {
  const { row, trialStart } = await readSubscription(db, accountId);
  return subscriptionState(row, trialStart, now);
}

export async function readUsage(
  db: RawDb,
  accountId: string,
  periodKey: string | null,
): Promise<UsageRow> {
  if (!periodKey) return { ...EMPTY_USAGE };
  const rows = await db.$queryRawUnsafe<
    Array<{
      units: number;
      dialogs: number;
      extraUnits: number;
      autoPacks: number;
      autoSpentMicroUsd: bigint;
      exhaustedAt: Date | null;
    }>
  >(
    `SELECT "units", "dialogs", "extraUnits", "autoPacks", "autoSpentMicroUsd", "exhaustedAt"
       FROM ${USAGE} WHERE "accountId" = $1 AND "periodKey" = $2`,
    accountId,
    periodKey,
  );
  const r = rows[0];
  if (!r) return { ...EMPTY_USAGE };
  return {
    units: r.units,
    dialogs: r.dialogs,
    extraUnits: r.extraUnits,
    autoPacks: r.autoPacks,
    autoSpentMicroUsd: Number(r.autoSpentMicroUsd),
    exhaustedAt: r.exhaustedAt,
  };
}

/** Разрешён ли сейчас авто-пакет сверх лимита (потолок денег владельца). */
export function autoAllowanceUnits(
  state: SubscriptionState,
  usage: Pick<UsageRow, 'autoSpentMicroUsd'>,
): number {
  if (!state.planId || !state.autoTopUp) return 0;
  const pack = topupPackMicroUsd(state.planId);
  if (pack === null) return 0;
  return usage.autoSpentMicroUsd + pack <= state.autoTopUpCapMicroUsd
    ? TOPUP_PACK_UNITS
    : 0;
}

/** Лимит единиц с докупкой и авто-пакетом — столько можно занять всего. */
export function effectiveLimit(
  state: SubscriptionState,
  usage: UsageRow,
): number {
  if (!state.planId) return 0;
  return unitsLimit(state, usage.extraUnits) + autoAllowanceUnits(state, usage);
}

/**
 * Занять единицы периода одним условным UPDATE. false — лимит выбран (или
 * тарифа нет): строка помечается `exhaustedAt` (уведомление 100% — крон).
 */
export async function claimUnits(
  db: RawDb,
  p: {
    accountId: string;
    state: SubscriptionState;
    units: number;
    dialogs: number;
  },
): Promise<boolean> {
  const { state } = p;
  if (!state.planId || !state.periodKey) return false;
  const units = Math.max(0, Math.floor(p.units));
  const dialogs = Math.max(0, Math.floor(p.dialogs));
  if (units === 0 && dialogs === 0) return true;
  const planUnits = ASSIST_PLANS[state.planId].dialogsPerMonth;
  const pack = topupPackMicroUsd(state.planId);
  const auto = state.autoTopUp && pack !== null;
  await db.$executeRawUnsafe(
    `INSERT INTO ${USAGE} ("accountId", "periodKey", "updatedAt")
     VALUES ($1, $2, now()) ON CONFLICT DO NOTHING`,
    p.accountId,
    state.periodKey,
  );
  const n = await db.$executeRawUnsafe(
    `UPDATE ${USAGE}
        SET "units" = "units" + $3, "dialogs" = "dialogs" + $4, "updatedAt" = now()
      WHERE "accountId" = $1 AND "periodKey" = $2
        AND "units" + $3 <= $5 + "extraUnits"
          + CASE WHEN $6::boolean AND "autoSpentMicroUsd" + $7 <= $8 THEN $9 ELSE 0 END`,
    p.accountId,
    state.periodKey,
    units,
    dialogs,
    planUnits,
    auto,
    pack ?? 0,
    state.autoTopUpCapMicroUsd,
    TOPUP_PACK_UNITS,
  );
  if (n === 1) return true;
  await markExhausted(db, p.accountId, state.periodKey);
  return false;
}

/** Отметка мягкого стопа периода (уведомление 100% — крон). */
export async function markExhausted(
  db: RawDb,
  accountId: string,
  periodKey: string,
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE ${USAGE} SET "exhaustedAt" = COALESCE("exhaustedAt", now()), "updatedAt" = now()
      WHERE "accountId" = $1 AND "periodKey" = $2`,
    accountId,
    periodKey,
  );
}

/**
 * Вернуть единицы, если ответ модели так и не состоялся после захвата (тот
 * же приём, что откат флага диалога в конвейере). Не ниже нуля.
 */
export async function releaseUnits(
  db: RawDb,
  p: { accountId: string; periodKey: string; units: number; dialogs: number },
): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE ${USAGE}
        SET "units" = GREATEST(0, "units" - $3), "dialogs" = GREATEST(0, "dialogs" - $4), "updatedAt" = now()
      WHERE "accountId" = $1 AND "periodKey" = $2`,
    p.accountId,
    p.periodKey,
    Math.max(0, Math.floor(p.units)),
    Math.max(0, Math.floor(p.dialogs)),
  );
}

/**
 * Суточный денежный потолок ответов сайта (§7.3): ручная колонка сайта
 * (оператор платформы) или «месячная себестоимость лимита тарифа / 10».
 */
export function siteDailyCapMicroUsd(
  override: number | null | undefined,
  state: Pick<SubscriptionState, 'planId'>,
): number {
  // Нет действующего тарифа — денег на ответы нет и у ручного потолка.
  if (!state.planId) return 0;
  if (typeof override === 'number' && Number.isFinite(override)) {
    return override;
  }
  return siteDailyCapFromPlan(state.planId);
}
