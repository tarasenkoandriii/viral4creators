/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
/**
 * Модерация корпуса опыта — «Тонкая красная линия» §6.5, §6.7, этап 9.
 *
 * Проверяется граница, ради которой весь §6 и написан: что именно
 * нельзя опубликовать и что именно не становится советом.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { AdminExperienceService } from './admin-experience.service';

const RU_TEXT = {
  id: 't1',
  locale: 'ru',
  symptom: 'код не приходит',
  cause: null,
  advice: 'смотрите в Telegram',
  source: 'ADMIN',
  reviewed: true,
  updatedAt: new Date(),
};

function build(
  over: {
    experience?: Record<string, unknown> | null;
    candidate?: Record<string, unknown> | null;
    candidateStatus?: string;
  } = {},
) {
  // `??` здесь не годится: `null` — осмысленное значение «ситуации
  // нет», и он бы подставил заготовку вместо неё.
  const experience =
    over.experience === undefined
      ? {
          id: 'e1',
          scenario: 'CLIENT_SITE',
          stepId: 'record',
          status: 'DRAFT',
          occurrences: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          texts: [RU_TEXT],
        }
      : over.experience;
  const candidate =
    over.candidate === undefined
      ? {
          id: 'c1',
          scenario: 'CLIENT_SITE',
          stepId: 'record',
          locale: 'de',
          status: over.candidateStatus ?? 'NEW',
          matchedId: 'e1',
          decision: 'AUTO',
        }
      : over.candidate;
  const prisma: Record<string, any> = {
    wizardExperience: {
      findMany: jest.fn().mockResolvedValue([experience]),
      findUnique: jest.fn().mockResolvedValue(experience),
      create: jest.fn().mockResolvedValue({ id: 'e-new' }),
      update: jest.fn().mockResolvedValue({}),
    },
    wizardExperienceText: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    wizardExperienceCandidate: {
      findUnique: jest.fn().mockResolvedValue(candidate),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: 'c-new' }),
    },
    // Обе формы: массив операций (у `merge`) и интерактивная
    // транзакция с `tx` (у `unmerge` — там две модели, и массив по
    // типам не проходит с настоящим клиентом Prisma).
    $transaction: jest.fn(async (arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
        : arg,
    ),
  };
  return { prisma, svc: new AdminExperienceService(prisma as never) };
}

describe('публикация (§6.5)', () => {
  it('без прочитанного русского совета — отказ с причиной', async () => {
    const { svc } = build({
      experience: {
        id: 'e1',
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        status: 'DRAFT',
        occurrences: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        texts: [{ ...RU_TEXT, locale: 'de' }],
      },
    });
    await expect(svc.publish('e1', 'op1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('с русским советом — публикуется и помнит, кто это сделал', async () => {
    const { svc, prisma } = build();
    await svc.publish('e1', 'op1');
    expect(prisma.wizardExperience.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { status: 'PUBLISHED', publishedBy: 'op1' },
    });
  });

  it('опубликовать сменой статуса в обход проверки нельзя', async () => {
    // Иначе рядом с проверенной дверью появляется непроверенная.
    const { svc } = build();
    await expect(svc.setStatus('e1', 'PUBLISHED')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('тексты (§6.7)', () => {
  it('правка оператором делает текст прочитанным и авторским', async () => {
    const { svc, prisma } = build();
    await svc.saveText('e1', 'de', {
      symptom: 'Code kommt nicht',
      advice: 'im Telegram nachsehen',
    });
    const args = prisma.wizardExperienceText.upsert.mock.calls[0][0];
    expect(args.create).toMatchObject({ source: 'ADMIN', reviewed: true });
    expect(args.update).toMatchObject({ source: 'ADMIN', reviewed: true });
  });

  it('неизвестный ключ словаря не сохраняется', async () => {
    // Опечатка в ключе — самая частая ошибка при наборе; ловить её
    // через «почему-то этой записи нет в советах» дороже, чем отказом.
    const { svc } = build();
    await expect(
      svc.saveText('e1', 'ru', {
        symptom: 'что-то',
        advice: 'нажмите {{clientSiteWizard.goneButton}}',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('известный ключ сохраняется как есть, без подстановки', async () => {
    // Подстановка — при ОТДАЧЕ: вмороженное название пережило бы правку
    // словаря молча.
    const { svc, prisma } = build();
    await svc.saveText('e1', 'ru', {
      symptom: 'вход не проходит',
      advice: 'нажмите {{clientSiteWizard.liveButton}}',
    });
    const args = prisma.wizardExperienceText.upsert.mock.calls[0][0];
    expect(args.create.advice).toContain('{{clientSiteWizard.liveButton}}');
  });

  it('неизвестная локаль отвергается', async () => {
    const { svc } = build();
    await expect(
      svc.saveText('e1', 'fr', { symptom: 'a', advice: 'b' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('битые ключи видны в списке, а не только при сохранении', async () => {
    // Ключ может исчезнуть ПОСЛЕ сохранения — кнопку переименовали.
    const { svc } = build({
      experience: {
        id: 'e1',
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        status: 'PUBLISHED',
        occurrences: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        texts: [
          { ...RU_TEXT, advice: 'нажмите {{clientSiteWizard.goneButton}}' },
        ],
      },
    });
    const [row] = await svc.list({});
    expect(row.brokenKeys).toEqual(['clientSiteWizard.goneButton']);
  });
});

describe('кандидаты (§6.4, §6.7)', () => {
  it('из кандидата заводится черновик с русским советом оператора', async () => {
    // Сырой текст жалобы не переносится ни в каком виде — это и есть
    // граница §6.5.
    const { svc, prisma } = build();
    await svc.promote(
      'c1',
      { symptom: 'код не приходит', advice: 'смотрите в Telegram' },
      'op1',
    );
    const data = prisma.wizardExperience.create.mock.calls[0][0].data;
    expect(data.status).toBe('DRAFT');
    expect(data.texts.create).toMatchObject({
      locale: 'ru',
      source: 'ADMIN',
      reviewed: true,
    });
  });

  it('сведение поднимает счётчик встреч', async () => {
    const { svc, prisma } = build();
    await svc.merge('c1', 'e1', 'op1');
    const ops = prisma.$transaction.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(prisma.wizardExperience.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { occurrences: { increment: 1 } },
    });
  });

  it('«это другое» возвращает кандидата и откатывает счётчик', async () => {
    // Иначе счётчик врёт навсегда, а по нему сортируется промпт.
    const { svc, prisma } = build({ candidateStatus: 'MERGED' });
    await svc.unmerge('c1', 'op1');
    expect(prisma.wizardExperience.update).toHaveBeenCalledWith({
      where: { id: 'e1' },
      data: { occurrences: { decrement: 1 } },
    });
    const back = prisma.wizardExperienceCandidate.update.mock.calls[0][0].data;
    expect(back.status).toBe('NEW');
    expect(back.matchedId).toBeNull();
  });

  it('«это другое» не трогает счётчик, если сведения не было', async () => {
    const { svc, prisma } = build({
      candidate: {
        id: 'c1',
        scenario: 'CLIENT_SITE',
        stepId: 'record',
        locale: 'de',
        status: 'MERGED',
        matchedId: null,
        decision: 'NONE',
      },
    });
    await svc.unmerge('c1', 'op1');
    expect(prisma.wizardExperience.update).not.toHaveBeenCalled();
  });

  it('прикрепление кандидата пишет текст на ЕГО языке', async () => {
    // Просьба владельца дословно: немецкая жалоба становится немецким
    // текстом существующей ситуации, а не второй ситуацией.
    const { svc, prisma } = build();
    await svc.attachText(
      'c1',
      'e1',
      { symptom: 'Code kommt nicht', advice: 'im Telegram nachsehen' },
      'op1',
    );
    expect(prisma.wizardExperienceText.upsert.mock.calls[0][0].where).toEqual({
      experienceId_locale: { experienceId: 'e1', locale: 'de' },
    });
  });

  it('несуществующий кандидат — 404, а не тихий успех', async () => {
    const { svc } = build({ candidate: null });
    await expect(svc.reject('c1', 'op1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('разобранного кандидата нельзя разобрать второй раз', async () => {
    // Двойной клик по «Свести» на медленной сети поднимал бы
    // `occurrences` дважды за один сигнал — а по этому счётчику
    // сортируется срез корпуса, то есть ошибка не косметическая.
    const { svc, prisma } = build({ candidateStatus: 'MERGED' });
    await expect(svc.merge('c1', 'e1', 'op1')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('из одного кандидата нельзя завести две ситуации', async () => {
    const { svc, prisma } = build({ candidateStatus: 'PROMOTED' });
    await expect(
      svc.promote('c1', { symptom: 'а', advice: 'б' }, 'op1'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.wizardExperience.create).not.toHaveBeenCalled();
  });

  it('«это другое» не применяется к неразобранному кандидату', async () => {
    const { svc } = build({ candidateStatus: 'NEW' });
    await expect(svc.unmerge('c1', 'op1')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('текст к несуществующей ситуации не сохраняется', async () => {
    // Иначе нарушение внешнего ключа доедет до оператора пятисоткой без
    // единого слова о том, что произошло.
    const { svc, prisma } = build({ experience: null });
    await expect(
      svc.saveText('нет-такой', 'ru', { symptom: 'а', advice: 'б' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.wizardExperienceText.upsert).not.toHaveBeenCalled();
  });
});
