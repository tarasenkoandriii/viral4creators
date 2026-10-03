/**
 * Учёт команды голосового управления (§5-бис.9, §7.1): команда — это
 * сообщение диалога (счётчик диалогов тарифа), а команда-с-планом
 * засчитывается как ответ модели в правиле «> 30 ответов → ×2». Та же
 * механика, что `claimDialog` конвейера чата (assist-site-chat): первый
 * ответ диалога засчитывает диалог одним условным UPDATE флага, единицы —
 * условным UPDATE счётчика подписки; не поместились — откат флага и счёта,
 * плана нет (мягкий стоп). Под assist_public (права — миграции Э2–Э5).
 */
import {
  claimUnits,
  effectiveLimit,
  readUsage,
  type RawDb,
} from '../../assist-billing/public/entitlements';
import type { SubscriptionState } from '../../assist-billing/subscription-state';
import { DIALOG_BASE_UNITS, unitsDelta } from '../../assist-billing/units';

const CONV = '"sites"."assist_site_conversations"';

/** Есть ли место для ещё одного ответа (чтение; захват — claimPlanAnswer). */
export async function quotaLeft(
  db: RawDb,
  accountId: string,
  state: SubscriptionState,
): Promise<boolean> {
  if (!state.planId) return false;
  const usage = await readUsage(db, accountId, state.periodKey);
  return usage.units < effectiveLimit(state, usage);
}

export async function claimPlanAnswer(
  db: RawDb,
  p: { accountId: string; conversationId: string; state: SubscriptionState },
): Promise<boolean> {
  const won = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE ${CONV} SET "dialogCounted" = true
      WHERE "id" = $1 AND NOT "dialogCounted" RETURNING "id"`,
    p.conversationId,
  );
  const counted = await db.$queryRawUnsafe<
    Array<{ answers: number; voice: boolean }>
  >(
    `UPDATE ${CONV} SET "answers" = "answers" + 1
      WHERE "id" = $1 RETURNING "answers", "voice"`,
    p.conversationId,
  );
  const n = counted[0]?.answers ?? 1;
  const units = unitsDelta(
    DIALOG_BASE_UNITS[counted[0]?.voice ? 'voice' : 'text'],
    n,
    won.length > 0,
  );
  if (units === 0) return true;
  const ok = await claimUnits(db, {
    accountId: p.accountId,
    state: p.state,
    units,
    dialogs: won.length ? 1 : 0,
  });
  if (!ok) {
    await db.$executeRawUnsafe(
      `UPDATE ${CONV}
          SET "answers" = GREATEST(0, "answers" - 1)${won.length ? ', "dialogCounted" = false' : ''}
        WHERE "id" = $1`,
      p.conversationId,
    );
  }
  return ok;
}
