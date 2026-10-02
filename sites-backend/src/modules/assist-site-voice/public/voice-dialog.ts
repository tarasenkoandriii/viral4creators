/**
 * «В диалоге был голос» — вес 2 (Э5; ТЗ §7.1 Р-58: «диалог с голосом —
 * распознавание или озвучка хотя бы одного ответа — 2»; assist-billing/units).
 *
 * Отметка — один условный UPDATE `… SET "voice" = true WHERE NOT "voice"`:
 * первым ставит один запрос (параллельные озвучки одного диалога не
 * доплатят дважды). Дальше два случая:
 *  - диалог ещё НЕ засчитан (голосом задан первый вопрос) — ничего не
 *    занимаем: `claimDialog` конвейера при первом ответе модели займёт уже
 *    вес 2 (он читает `voice` из той же строки);
 *  - диалог УЖЕ засчитан как текстовый (вес 1 × множитель) — доплата
 *    разницы `dialogUnits(2, n) − dialogUnits(1, n)` тем же условным UPDATE
 *    счётчика подписки. Не поместилась — отметка снимается и голос этого
 *    диалога отказывает (`denied`): чат продолжает текстом (приёмка Э5).
 *
 * Предпросмотр конфигуратора квоту не тратит (как ответы, Э4) — отметка
 * ставится, доплаты нет. Под assist_public: UPDATE("voice") диалога и
 * колонки счётчика (миграции Э4/Э5).
 */
import type { SubscriptionState } from '../../assist-billing/subscription-state';
import {
  claimUnits,
  type RawDb,
} from '../../assist-billing/public/entitlements';
import { dialogUnits } from '../../assist-billing/units';
import { VOICE_DEFAULTS } from '../voice-config';

const CONV = '"sites"."assist_site_conversations"';

/** Доплата за голос в уже засчитанном диалоге из `answers` ответов. */
export function voiceUpgradeUnits(answers: number): number {
  return Math.max(
    0,
    dialogUnits(VOICE_DEFAULTS.dialogUnits, answers) - dialogUnits(1, answers),
  );
}

export type VoiceMark = 'marked' | 'already' | 'denied';

export async function markVoiceDialog(
  db: RawDb,
  p: {
    accountId: string;
    conversationId: string;
    state: SubscriptionState;
    preview: boolean;
  },
): Promise<VoiceMark> {
  const won = await db.$queryRawUnsafe<
    Array<{ answers: number; dialogCounted: boolean }>
  >(
    `UPDATE ${CONV} SET "voice" = true WHERE "id" = $1 AND NOT "voice"
      RETURNING "answers", "dialogCounted"`,
    p.conversationId,
  );
  if (!won.length) return 'already';
  const { answers, dialogCounted } = won[0];
  if (!dialogCounted || p.preview) return 'marked';
  const units = voiceUpgradeUnits(Number(answers));
  if (units === 0) return 'marked';
  const ok = await claimUnits(db, {
    accountId: p.accountId,
    state: p.state,
    units,
    dialogs: 0,
  });
  if (ok) return 'marked';
  await db.$executeRawUnsafe(
    `UPDATE ${CONV} SET "voice" = false WHERE "id" = $1`,
    p.conversationId,
  );
  return 'denied';
}
