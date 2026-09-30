/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
import {
  HINT_AUDIO_PRUNE_BATCH,
  HINT_AUDIO_RETENTION_MS,
  pruneWizardHintAudio,
} from './hint-audio-prune';

const NOW = new Date('2026-10-30T00:00:00Z');

function build(
  rows: Array<{ key: string; pathname: string }>,
  opts: {
    revived?: string[];
  } = {},
) {
  let served = false;
  const prisma = {
    wizardHintAudio: {
      findMany: jest.fn(async (args: any) => {
        // Выборка кандидатов — по `lastUsedAt`; проверка выживших — по ключам.
        if (args.where.lastUsedAt) {
          if (served) return [];
          served = true;
          return rows;
        }
        return (opts.revived ?? []).map((key) => ({ key }));
      }),
      deleteMany: jest.fn(async (_args: any) => ({
        count: rows.length - (opts.revived?.length ?? 0),
      })),
    },
  };
  const blob = { deleteMany: jest.fn(async (p: string[]) => p.length) };
  return { prisma, blob };
}

describe('pruneWizardHintAudio (Greeting 2.0 §4А.4, аудит волны 1)', () => {
  it('убирает строки и файлы, не звучавшие 30 дней', async () => {
    const { prisma, blob } = build([
      { key: 'a', pathname: 'wizard-hint-audio/a.mp3' },
      { key: 'b', pathname: 'wizard-hint-audio/b.mp3' },
    ]);
    expect(await pruneWizardHintAudio(prisma as any, blob, NOW)).toBe(2);
    const cutoff = new Date(NOW.getTime() - HINT_AUDIO_RETENTION_MS);
    expect(prisma.wizardHintAudio.findMany.mock.calls[0][0].where).toEqual({
      lastUsedAt: { lt: cutoff },
    });
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'wizard-hint-audio/a.mp3',
      'wizard-hint-audio/b.mp3',
    ]);
  });

  it('удаление повторяет условие давности — ожившая строка остаётся', async () => {
    const { prisma, blob } = build(
      [
        { key: 'a', pathname: 'wizard-hint-audio/a.mp3' },
        { key: 'b', pathname: 'wizard-hint-audio/b.mp3' },
      ],
      { revived: ['b'] },
    );
    await pruneWizardHintAudio(prisma as any, blob, NOW);
    expect(
      prisma.wizardHintAudio.deleteMany.mock.calls[0][0].where.lastUsedAt,
    ).toBeDefined();
    // Файл ожившей строки не трогается: кеш отдавал бы ссылку в пустоту.
    expect(blob.deleteMany).toHaveBeenCalledWith(['wizard-hint-audio/a.mp3']);
  });

  it('критерий — последнее использование, а не дата рождения', async () => {
    const { prisma, blob } = build([]);
    await pruneWizardHintAudio(prisma as any, blob, NOW);
    const where = prisma.wizardHintAudio.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toBeUndefined();
    expect(where.lastUsedAt).toBeDefined();
    expect(blob.deleteMany).not.toHaveBeenCalled();
  });

  it('партия ограничена', async () => {
    const { prisma, blob } = build([]);
    await pruneWizardHintAudio(prisma as any, blob, NOW);
    expect(prisma.wizardHintAudio.findMany.mock.calls[0][0].take).toBe(
      HINT_AUDIO_PRUNE_BATCH,
    );
  });
});
