/**
 * Срез корпуса и приём сигналов — «Тонкая красная линия» §6, этап 9.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  ExperienceService,
  EXPERIENCE_SLICE_LIMIT,
} from './experience.service';

const NOW = new Date('2026-09-23T10:00:00Z');

interface Row {
  id: string;
  occurrences: number;
  updatedAt: Date;
  texts: Array<{
    locale: string;
    symptom: string;
    cause: string | null;
    advice: string;
    source: string;
    reviewed: boolean;
    updatedAt: Date;
  }>;
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'x1',
    occurrences: 1,
    updatedAt: NOW,
    texts: [
      {
        locale: 'ru',
        symptom: 'код не приходит',
        cause: null,
        advice: 'смотрите в Telegram',
        source: 'ADMIN',
        reviewed: true,
        updatedAt: NOW,
      },
    ],
    ...over,
  };
}

/** Ровно то, что читают проверки из аргументов моков. */
interface CreateCall {
  data: Record<string, unknown>;
}
interface FindManyCall {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, string>>;
}

function build(
  rows: Row[] = [row()],
  over: { throws?: boolean; waiting?: number } = {},
) {
  const prisma = {
    wizardExperience: {
      findMany: jest.fn(async (_args: FindManyCall) => rows),
    },
    wizardExperienceCandidate: {
      create: jest.fn(async (_args: CreateCall) => {
        if (over.throws) throw new Error('база недоступна');
        return { id: 'c1' };
      }),
      count: jest.fn().mockResolvedValue(over.waiting ?? 0),
    },
  };
  return { prisma, svc: new ExperienceService(prisma as never) };
}

describe('срез корпуса (§5.6, §6)', () => {
  it('берутся только опубликованные и самые частые первыми', async () => {
    const { svc, prisma } = build();
    await svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    const args = prisma.wizardExperience.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: 'PUBLISHED' });
    expect(args.orderBy[0]).toEqual({ occurrences: 'desc' });
  });

  it('в строку попадают симптом, причина и совет', async () => {
    const { svc } = build();
    const slice = await svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    expect(slice.lines).toEqual([
      'код не приходит; что делать: смотрите в Telegram',
    ]);
  });

  it('ключ словаря подставляется подписью, а не остаётся шаблоном', async () => {
    const { svc } = build([
      row({
        texts: [
          {
            locale: 'ru',
            symptom: 'вход не проходит',
            cause: null,
            advice: 'нажмите {{clientSiteWizard.liveButton}}',
            source: 'ADMIN',
            reviewed: true,
            updatedAt: NOW,
          },
        ],
      }),
    ]);
    const slice = await svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    expect(slice.lines[0]).toContain('«Живой вход»');
    expect(slice.lines[0]).not.toContain('{{');
  });

  it('запись с неизвестным ключом не уезжает в промпт', async () => {
    // Приёмка §9 дословно: оператору — пометка, модели — ничего.
    const { svc } = build([
      row({
        texts: [
          {
            locale: 'ru',
            symptom: 'что-то',
            cause: null,
            advice: 'нажмите {{clientSiteWizard.goneButton}}',
            source: 'ADMIN',
            reviewed: true,
            updatedAt: NOW,
          },
        ],
      }),
    ]);
    const slice = await svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    expect(slice.lines).toEqual([]);
  });

  it('запись без текста на локали уходит в очередь на перевод', async () => {
    const { svc } = build();
    const slice = await svc.sliceFor('CLIENT_SITE', 'record', 'de');
    expect(slice.lines).toEqual([]);
    expect(slice.needTranslation).toHaveLength(1);
    expect(slice.needTranslation[0].from.locale).toBe('ru');
  });

  it('в срез идёт не больше пяти записей', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      row({ id: `x${i}`, occurrences: 12 - i }),
    );
    const { svc } = build(many);
    const slice = await svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    expect(slice.lines).toHaveLength(EXPERIENCE_SLICE_LIMIT);
  });

  it('отпечаток меняется от публикации и от роста частоты', async () => {
    const a = await build([row()]).svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    const b = await build([row({ occurrences: 2 })]).svc.sliceFor(
      'CLIENT_SITE',
      'record',
      'ru',
    );
    const c = await build([row(), row({ id: 'x2' })]).svc.sliceFor(
      'CLIENT_SITE',
      'record',
      'ru',
    );
    const d = await build([
      row({ updatedAt: new Date(NOW.getTime() + 60_000) }),
    ]).svc.sliceFor('CLIENT_SITE', 'record', 'ru');
    expect(new Set([a.stamp, b.stamp, c.stamp, d.stamp]).size).toBe(4);
  });

  it('пустой корпус даёт устойчивый отпечаток', async () => {
    // Иначе каждый запрос на шаге без записей опыта промахивался бы
    // мимо кеша — и фича стоила бы ровно столько, сколько экономит кеш.
    const a = await build([]).svc.sliceFor('CLIENT_SITE', 'url', 'ru');
    const b = await build([]).svc.sliceFor('CLIENT_SITE', 'url', 'ru');
    expect(a.stamp).toBe(b.stamp);
  });
});

describe('кандидаты (§6.2, §9)', () => {
  it('почта в жалобе маскируется перед сохранением', async () => {
    // Человек, описывая проблему входа, вполне может вписать свою
    // почту — и это наша база, а не его.
    const { svc, prisma } = build();
    await svc.addCandidate({
      scenario: 'CLIENT_SITE',
      stepId: 'record',
      locale: 'ru',
      rawText: 'не пришло письмо на ivan@example.com',
      origin: 'COMPLAINT',
    });
    const data = prisma.wizardExperienceCandidate.create.mock.calls[0][0].data;
    expect(data.rawText).toContain('[e-mail скрыт]');
    expect(data.rawText).not.toContain('example.com');
  });

  it('автора у жалобы нет', async () => {
    // Жалоба — про шаг, а не про человека (§9).
    const { svc, prisma } = build();
    await svc.addCandidate({
      scenario: 'CLIENT_SITE',
      stepId: 'record',
      locale: 'ru',
      rawText: 'непонятно',
      origin: 'COMPLAINT',
    });
    const data = prisma.wizardExperienceCandidate.create.mock.calls[0][0].data;
    expect(Object.keys(data).sort()).toEqual([
      'locale',
      'origin',
      'rawText',
      'scenario',
      'stepId',
    ]);
  });

  it('пустая жалоба кандидата не заводит', async () => {
    // «Человеку непонятно на этом шаге» уже посчитано телеметрией;
    // кандидат без слов оператору нечего дать.
    const { svc, prisma } = build();
    expect(
      await svc.addCandidate({
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        locale: 'ru',
        rawText: '   ',
        origin: 'COMPLAINT',
      }),
    ).toBeNull();
    expect(prisma.wizardExperienceCandidate.create).not.toHaveBeenCalled();
  });

  it('упавшая запись не бросает наружу', async () => {
    const { svc } = build([row()], { throws: true });
    await expect(
      svc.addCandidate({
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        locale: 'ru',
        rawText: 'непонятно',
        origin: 'COMPLAINT',
      }),
    ).resolves.toBeNull();
  });

  it('правка текста оператором меняет отпечаток', async () => {
    // `updatedAt` самой ситуации от правки совета не меняется. Без
    // времени текста исправленный совет продолжал бы выдаваться из кеша
    // целые сутки — то есть исправление «не работало» бы ровно так же,
    // как раньше не работала публикация.
    const before = await build([row()]).svc.sliceFor(
      'CLIENT_SITE',
      'record',
      'ru',
    );
    const edited = row();
    edited.texts[0].updatedAt = new Date(NOW.getTime() + 60_000);
    const after = await build([edited]).svc.sliceFor(
      'CLIENT_SITE',
      'record',
      'ru',
    );
    expect(after.stamp).not.toBe(before.stamp);
  });

  it('переполненная очередь шага не растёт дальше', async () => {
    // Очередь оператора — рабочий список, а не журнал: за двухсотым
    // неразобранным сигналом двести первый не добавляет ничего, кроме
    // строк в таблице, которую никто не чистит.
    const { svc, prisma } = build([row()], { waiting: 200 });
    expect(
      await svc.addCandidate({
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        locale: 'ru',
        rawText: 'ещё одна жалоба',
        origin: 'COMPLAINT',
      }),
    ).toBeNull();
    expect(prisma.wizardExperienceCandidate.create).not.toHaveBeenCalled();
  });

  it('очередь считается по своему шагу, а не по всему корпусу', async () => {
    const { svc, prisma } = build();
    await svc.addCandidate({
      scenario: 'CLIENT_SITE',
      stepId: 'record',
      locale: 'ru',
      rawText: 'жалоба',
      origin: 'COMPLAINT',
    });
    expect(
      prisma.wizardExperienceCandidate.count.mock.calls[0][0].where,
    ).toEqual({ scenario: 'CLIENT_SITE', stepId: 'record', status: 'NEW' });
  });
});
