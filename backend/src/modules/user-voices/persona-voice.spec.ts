/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
import { isPersonaVoice } from './persona-voice';

/** CONTRACT5 п.5а: голос персоны — только в PERSONAL бренд-буке и отправителем. */
describe('isPersonaVoice', () => {
  const rows = [
    {
      id: 'v-persona',
      userId: 'u1',
      personaId: 'p1',
      resembleVoiceId: 'r-persona',
    },
    {
      id: 'v-plain',
      userId: 'u1',
      personaId: null,
      resembleVoiceId: 'r-plain',
    },
    {
      id: 'v-other',
      userId: 'u2',
      personaId: 'p2',
      resembleVoiceId: 'r-other',
    },
  ];
  // Тот же фильтр, что даст Prisma: userId, personaId not null, id OR resembleVoiceId.
  const db = {
    userVoice: {
      findFirst: jest.fn(async ({ where }: { where: any }) => {
        const found = rows.find(
          (r) =>
            r.userId === where.userId &&
            (where.personaId?.not === null ? r.personaId !== null : true) &&
            where.OR.some(
              (c: any) =>
                (c.id !== undefined && c.id === r.id) ||
                (c.resembleVoiceId !== undefined &&
                  c.resembleVoiceId === r.resembleVoiceId),
            ),
        );
        return found ? { id: found.id } : null;
      }),
    },
  };

  it('голос персоны — по id и по resembleVoiceId', async () => {
    await expect(isPersonaVoice(db, 'u1', 'v-persona')).resolves.toBe(true);
    await expect(isPersonaVoice(db, 'u1', 'r-persona')).resolves.toBe(true);
  });

  it('обычный клон, чужой голос, пусто — false', async () => {
    await expect(isPersonaVoice(db, 'u1', 'v-plain')).resolves.toBe(false);
    await expect(isPersonaVoice(db, 'u1', 'r-plain')).resolves.toBe(false);
    await expect(isPersonaVoice(db, 'u1', 'v-other')).resolves.toBe(false);
    await expect(isPersonaVoice(db, 'u1', 'r-other')).resolves.toBe(false);
    db.userVoice.findFirst.mockClear();
    for (const v of [null, undefined, '', '   ']) {
      await expect(isPersonaVoice(db, 'u1', v)).resolves.toBe(false);
    }
    await expect(isPersonaVoice(db, '', 'v-persona')).resolves.toBe(false);
    expect(db.userVoice.findFirst).not.toHaveBeenCalled();
  });

  it('запрос ограничен владельцем и персоной', async () => {
    db.userVoice.findFirst.mockClear();
    await isPersonaVoice(db, 'u1', ' r-persona ');
    expect(db.userVoice.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        personaId: { not: null },
        OR: [{ id: 'r-persona' }, { resembleVoiceId: 'r-persona' }],
      },
      select: { id: true },
    });
  });
});
