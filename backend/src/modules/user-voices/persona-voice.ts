/**
 * Голос персоны «Я в кадре» — опознание по id (ТЗ TZ-Greeting-2.0 §4.6,
 * §4.7; аудит волны, CONTRACT5 п.5а). Клон голоса реального человека
 * можно назначить только там, где в кадре он сам: в личном (PERSONAL)
 * бренд-буке и отправителем своего поздравления. Проверку делают
 * вызывающие (бренд-бук, поздравление) — здесь только ответ «это голос
 * персоны этого пользователя».
 *
 * Функция, а не только метод сервиса: соседним модулям не нужно
 * импортировать `UserVoicesModule` (с его контроллерами) ради одного
 * запроса — достаточно своего `PrismaService`.
 */

/** Ровно то, чем пользуемся; `PrismaService` подходит структурно. */
export interface PersonaVoiceDb {
  userVoice: {
    findFirst(args: {
      where: Record<string, unknown>;
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * `true` — голос принадлежит `userId` И привязан к персоне. `voiceId`
 * сверяется и с `UserVoice.id`, и с `resembleVoiceId`: в бренд-буке и
 * брифе лежит второй (`ttsVoiceId`), в API голосов — первый. Статус не
 * важен: обучающийся или упавший голос персоны остаётся голосом
 * персоны. Чужой, несуществующий или пустой — `false`.
 */
export async function isPersonaVoice(
  prisma: PersonaVoiceDb,
  userId: string,
  voiceId: string | null | undefined,
): Promise<boolean> {
  const id = voiceId?.trim();
  if (!id || !userId) return false;
  const row = await prisma.userVoice.findFirst({
    where: {
      userId,
      personaId: { not: null },
      OR: [{ id }, { resembleVoiceId: id }],
    },
    select: { id: true },
  });
  return row !== null;
}
