/**
 * Повторная проверка «Я в кадре» у денег — при старте рендера (CONTRACT5
 * п.14, ТЗ Greeting 2.0 §4.8, §4.9).
 *
 * Снимок сессии хранит КОПИЮ образа и голоса, и с момента выбора многое
 * могло измениться: режим выключили, образ удалили (файлы вместе с ним —
 * §4.9), персону отозвали, голос персоны удалили. Рендер по копии в любом
 * из этих случаев снял бы лицо или голос человека, который своё согласие
 * уже забрал. Поэтому перед списанием кредита всё это проверяется заново
 * по базе — не по снимку.
 *
 * Проверяется только то, что реально уходит в ролик: образ-ведущий, клон
 * голоса персоны отправителем и голос персоны в личном бренд-буке. Личный
 * бренд-бук без голоса персоны несёт лишь подпись и стиль карточек — ему
 * достаточно включённого режима.
 */

import {
  PERSONA_DISABLED_CODE,
  PERSONA_DISABLED_MESSAGE,
  PERSONA_VOICE_ONLY_PERSONAL,
  PRESENTER_LOOK_NOT_FOUND,
  PersonaStateRow,
  personaEnabled,
  personaUsable,
} from '../../common/greeting-persona';
import { isPersonaVoice } from '../user-voices/persona-voice';
import type { Session } from '../../common/types/session.types';

export const PERSONA_NOT_USABLE_AT_RENDER =
  'Ваша персона удалена, отозвана или не прошла проверку — ролик с вашим лицом или голосом снять нельзя. ' +
  'Выберите ИИ-ведущего и другой голос.';
export const PERSONA_VOICE_GONE_AT_RENDER =
  'Голос вашей персоны удалён — выберите другой голос отправителя.';

/** Минимум Prisma для проверки (структурно — `PrismaService` подходит). */
export interface PersonaRenderDb {
  persona: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: Record<string, true>;
    }): Promise<unknown>;
  };
  personaLook: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
  userVoice: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

export type PersonaRenderProblem =
  | { code: typeof PERSONA_DISABLED_CODE; message: string }
  | { code?: undefined; message: string };

/**
 * `null` — рендерить можно. `db` нет (сервис собран без Prisma) при
 * использованной персоне — отказ: проверить нечем, а ошибка в эту
 * сторону снимает человека без согласия.
 */
export async function personaRenderProblem(
  db: PersonaRenderDb | null | undefined,
  session: Pick<
    Session,
    'userId' | 'greetingBriefSnapshot' | 'brandManifestSnapshot'
  >,
): Promise<PersonaRenderProblem | null> {
  const brief = session.greetingBriefSnapshot;
  const brand = session.brandManifestSnapshot;
  const presenter = brief?.presenter ?? null;
  const senderPersonaVoice = brief?.senderVoice?.personaVoice === true;
  const personal = brand?.kind === 'PERSONAL';
  const brandVoice = brand?.ttsVoiceId?.trim() || null;
  if (!presenter && !senderPersonaVoice && !personal && !brandVoice) {
    return null;
  }

  const userId = session.userId ?? null;
  // Голос персоны в бренд-буке узнаётся только по базе — снимок признака
  // не несёт. Нужен лишь тогда, когда в сессии есть бренд с голосом.
  const brandPersonaVoice =
    !!brandVoice && !!userId && !!db
      ? await isPersonaVoice(db, userId, brandVoice)
      : false;
  if (!presenter && !senderPersonaVoice && !personal && !brandPersonaVoice) {
    return null;
  }

  if (!personaEnabled()) {
    return {
      code: PERSONA_DISABLED_CODE,
      message: `${PERSONA_DISABLED_MESSAGE} Выберите ИИ-ведущего, другой голос или бренд-бук.`,
    };
  }
  if (brandPersonaVoice && !personal) {
    return { message: PERSONA_VOICE_ONLY_PERSONAL };
  }
  const needsPersona = !!presenter || senderPersonaVoice || brandPersonaVoice;
  if (!needsPersona) return null;
  if (!db || !userId) return { message: PERSONA_NOT_USABLE_AT_RENDER };

  const persona = (await db.persona.findFirst({
    where: { userId },
    select: {
      id: true,
      livenessCheckedAt: true,
      revokedAt: true,
      verifyResult: true,
    },
  })) as (PersonaStateRow & { id: string }) | null;
  if (!personaUsable(persona)) {
    return { message: PERSONA_NOT_USABLE_AT_RENDER };
  }
  if (presenter) {
    const look = await db.personaLook.findFirst({
      where: {
        id: presenter.lookId,
        deletedAt: null,
        personaId: persona!.id,
      },
      select: { id: true },
    });
    if (!look) return { message: PRESENTER_LOOK_NOT_FOUND };
  }
  if (senderPersonaVoice) {
    const voice = await db.userVoice.findFirst({
      where: {
        id: brief!.senderVoice!.userVoiceId,
        userId,
        personaId: { not: null },
      },
      select: { id: true },
    });
    if (!voice) return { message: PERSONA_VOICE_GONE_AT_RENDER };
  }
  return null;
}
