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
  PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
  PERSONA_VOICE_ONLY_PERSONAL,
  PRESENTER_LOOK_NOT_FOUND,
  PersonaStateRow,
  personaEnabled,
  personaUsable,
  personaVoiceNeedsPresenter,
} from '../../common/greeting-persona';
import { isPersonaVoice } from '../user-voices/persona-voice';
import type { Session } from '../../common/types/session.types';
import {
  GREETING_ERROR_CODES,
  GreetingErrorCode,
} from '../../common/greeting-errors';
import { RESEMBLE_PENDING_DELETE_PREFIX } from '../tts/resemble.service';

export const PERSONA_NOT_USABLE_AT_RENDER =
  'Ваша персона удалена, отозвана или не прошла проверку — ролик с вашим лицом или голосом снять нельзя. ' +
  'Выберите ИИ-ведущего и другой голос.';
export const PERSONA_VOICE_GONE_AT_RENDER =
  'Голос вашей персоны удалён — выберите другой голос отправителя.';
/**
 * Голос бренд-бука — свой клон, которого больше нет (CONTRACT6 п.4).
 * Снимок сессии хранит `ttsVoiceId` копией: удаление голоса обнуляет его
 * в бренд-буках (`UserVoicesService.remove`), но не в снимках уже
 * созданных сессий.
 */
export const BRAND_VOICE_GONE_AT_RENDER =
  'Голос из бренд-бука удалён — выберите другой голос в оформлении ролика или уберите бренд-бук.';

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
      select: { id: true } | { id: true; userId: true };
    }): Promise<{ id: string; userId?: string } | null>;
  };
  /**
   * Список ожидания удаления у Resemble (`resemble_pending_delete:<id>`).
   * Необязателен структурно: `PrismaService` его всегда имеет, а без него
   * (дублёр в тесте) проверка списка просто не делается.
   */
  platformSetting?: {
    findUnique(args: {
      where: { key: string };
      select: { key: true };
    }): Promise<{ key: string } | null>;
  };
}

export type PersonaRenderProblem =
  | { code: typeof PERSONA_DISABLED_CODE; message: string }
  | { code: GreetingErrorCode; message: string }
  | { code?: undefined; message: string };

/**
 * Голос бренд-бука провайдера Resemble — жив ли он для ЭТОГО
 * пользователя (CONTRACT6 п.4). `null` — можно.
 *
 * Отказ, если:
 *  - клон ждёт удаления у Resemble (строка списка ожидания): человек
 *    голос удалил, у провайдера он ещё жив — синтез прошёл бы голосом,
 *    согласие на который забрали;
 *  - такой клон есть в базе, но у ДРУГОГО пользователя: ключ Resemble у
 *    продукта один на всех, и каталог провайдера отдаёт все клоны
 *    аккаунта.
 *
 * Отступление от буквы контракта («требовать строку UserVoice этого
 * пользователя»): голос Resemble без строки UserVoice вовсе — это голос
 * каталога аккаунта, заведённый оператором (`ResembleService.voices`
 * отдаёт весь аккаунт), и строгое правило закрыло бы бренд-букам все
 * такие голоса. Удалённый клон без записи в списке ожидания у Resemble
 * уже удалён (404 → `forgetPendingDelete`) — синтез им не выйдет, лицо
 * и голос человека в ролик не попадут.
 */
async function brandResembleVoiceProblem(
  db: PersonaRenderDb,
  userId: string | null,
  voiceId: string,
): Promise<PersonaRenderProblem | null> {
  const gone: PersonaRenderProblem = {
    code: GREETING_ERROR_CODES.GREETING_BRAND_VOICE_UNAVAILABLE,
    message: BRAND_VOICE_GONE_AT_RENDER,
  };
  const pending = db.platformSetting
    ? await db.platformSetting.findUnique({
        where: { key: RESEMBLE_PENDING_DELETE_PREFIX + voiceId },
        select: { key: true },
      })
    : null;
  if (pending) return gone;
  const row = await db.userVoice.findFirst({
    where: { resembleVoiceId: voiceId },
    select: { id: true, userId: true },
  });
  if (row && row.userId !== userId) {
    // Может быть и строка этого же пользователя рядом — ищем её явно.
    const own = userId
      ? await db.userVoice.findFirst({
          where: { resembleVoiceId: voiceId, userId },
          select: { id: true },
        })
      : null;
    if (!own) return gone;
  }
  return null;
}

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
  // CONTRACT6 п.4: удалённый (или чужой) клон в копии бренд-бука — до
  // любых проверок персоны: голос озвучит ролик и без режима «Я в кадре».
  if (brandVoice && brand?.ttsProvider === 'resemble') {
    if (!db) {
      // Проверить нечем — ошибка в сторону «пропустить» озвучила бы
      // ролик голосом, согласие на который могли забрать.
      return {
        code: GREETING_ERROR_CODES.GREETING_BRAND_VOICE_UNAVAILABLE,
        message: BRAND_VOICE_GONE_AT_RENDER,
      };
    }
    const voiceProblem = await brandResembleVoiceProblem(
      db,
      userId,
      brandVoice,
    );
    if (voiceProblem) return voiceProblem;
  }
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
  // CONTRACT6 п.3: голос персоны на Hedra без образа — лицо чужое.
  if (brief && personaVoiceNeedsPresenter(brief, brief.senderVoice)) {
    return {
      code: GREETING_ERROR_CODES.GREETING_PERSONA_VOICE_NEEDS_PRESENTER,
      message: PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
    };
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
