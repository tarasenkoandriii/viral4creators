/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TutorialScenarioAdminService } from './tutorial-scenario-admin.service';

function build() {
  const rows: Record<string, unknown>[] = [];
  const prisma = {
    tutorialScenario: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  };
  const blob = {
    listByPrefix: jest.fn().mockResolvedValue({ blobs: [], cursor: null }),
    deleteMany: jest.fn().mockResolvedValue(undefined),
  };
  const service = new TutorialScenarioAdminService(prisma as any, blob as any);
  return { service, prisma, blob, rows };
}

describe('TutorialScenarioAdminService.remove (этап D)', () => {
  it('за строкой убирается и кеш её озвучки', async () => {
    // Сверка кеша ходит только по сценариям, которые сегодня
    // собираются; у удалённого сборки не будет никогда, и его
    // дорожки остались бы в Blob навсегда. До этапа D это был один
    // файл на пару, теперь до тридцати (находка аудита этапа D).
    const { service, prisma, blob } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      subjectKey: '3',
      locale: 'en',
    });
    prisma.tutorialScenario.delete = jest.fn().mockResolvedValue({});
    blob.listByPrefix.mockResolvedValue({
      blobs: [{ pathname: 'tutorial-voiceovers/en/3/0/a-1.mp3' }],
      cursor: null,
    });

    await service.remove('ts-1');

    expect(blob.listByPrefix).toHaveBeenCalledWith(
      'tutorial-voiceovers/en/3/',
      expect.anything(),
    );
    expect(blob.deleteMany).toHaveBeenCalledWith([
      'tutorial-voiceovers/en/3/0/a-1.mp3',
    ]);
  });

  it('кеш не убрался — строка всё равно удалена', async () => {
    // Падать из-за неубранного кеша после удаления строки поздно.
    const { service, prisma, blob } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      subjectKey: '3',
      locale: 'en',
    });
    prisma.tutorialScenario.delete = jest.fn().mockResolvedValue({});
    blob.listByPrefix.mockRejectedValue(new Error('Blob недоступен'));

    await expect(service.remove('ts-1')).resolves.toEqual({ id: 'ts-1' });
  });
});

describe('TutorialScenarioAdminService.setNarrationReviewed (этап D)', () => {
  it('отметка ставится с именем оператора и датой', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      subjectKey: '1',
      locale: 'ru',
    });

    await service.setNarrationReviewed('ts-1', true, 'op-1');

    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith({
      where: { id: 'ts-1' },
      data: {
        narrationReviewedBy: 'op-1',
        narrationReviewedAt: expect.any(Date),
      },
    });
  });

  it('отметка СНИМАЕТСЯ, а не только ставится', async () => {
    // В отличие от `approve`, который необратим: тот разрешает
    // ТРАТИТЬ деньги, и отозвать потраченное нельзя, а вычитка про
    // текст — перечитал, передумал, снял.
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      subjectKey: '1',
      locale: 'ru',
    });

    await service.setNarrationReviewed('ts-1', false, 'op-1');

    expect(prisma.tutorialScenario.update.mock.calls[0][0].data).toEqual({
      narrationReviewedBy: null,
      narrationReviewedAt: null,
    });
  });

  it('несуществующий сценарий — 404, а не молчаливая запись', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue(null);

    await expect(
      service.setNarrationReviewed('нет', true, 'op-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
  });
});

describe('TutorialScenarioAdminService.list', () => {
  it('передаёт фильтры в findMany/count как есть и считает пагинацию', async () => {
    const { service, prisma } = build();
    await service.list({
      subjectKey: '3',
      locale: 'ru',
      costly: true,
      approved: false,
      page: 2,
      pageSize: 20,
    });
    const expectedWhere = {
      subjectKey: '3',
      locale: 'ru',
      costly: true,
      approved: false,
    };
    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith({
      where: expectedWhere,
      orderBy: { createdAt: 'desc' },
      skip: 20,
      take: 20,
    });
    expect(prisma.tutorialScenario.count).toHaveBeenCalledWith({
      where: expectedWhere,
    });
  });

  it('без фильтров — subjectKey/locale/costly/approved уходят undefined, а не пустой строкой', async () => {
    const { service, prisma } = build();
    await service.list({ page: 1, pageSize: 10 });
    expect(prisma.tutorialScenario.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          subjectKey: undefined,
          locale: undefined,
          costly: undefined,
          approved: undefined,
        },
      }),
    );
  });

  it('возвращает total/page/pageSize вместе со строками', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findMany.mockResolvedValue([{ id: 'ts-1' }]);
    prisma.tutorialScenario.count.mockResolvedValue(7);
    const result = await service.list({ page: 1, pageSize: 10 });
    expect(result).toEqual({
      rows: [{ id: 'ts-1' }],
      total: 7,
      page: 1,
      pageSize: 10,
    });
  });
});

describe('TutorialScenarioAdminService.approve', () => {
  it('несуществующий id — NotFoundException', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue(null);
    await expect(service.approve('missing', 'admin-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
  });

  it('бесплатный сценарий (costly=false) — BadRequestException, одобрение не требуется', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      costly: false,
      approved: false,
    });
    await expect(service.approve('ts-1', 'admin-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
  });

  it('costly и не одобрен — ставит approved/approvedBy/approvedAt', async () => {
    const { service, prisma } = build();
    prisma.tutorialScenario.findUnique.mockResolvedValue({
      id: 'ts-1',
      costly: true,
      approved: false,
    });
    prisma.tutorialScenario.update.mockResolvedValue({
      id: 'ts-1',
      approved: true,
    });
    const result = await service.approve('ts-1', 'admin-1');
    expect(prisma.tutorialScenario.update).toHaveBeenCalledWith({
      where: { id: 'ts-1' },
      data: {
        approved: true,
        approvedBy: 'admin-1',
        approvedAt: expect.any(Date),
      },
    });
    expect(result).toEqual({ id: 'ts-1', approved: true });
  });

  it('уже одобрен — идемпотентно возвращает текущую строку, update не зовётся повторно', async () => {
    const { service, prisma } = build();
    const existing = {
      id: 'ts-1',
      costly: true,
      approved: true,
      approvedBy: 'first-admin',
      approvedAt: new Date('2026-01-01'),
    };
    prisma.tutorialScenario.findUnique.mockResolvedValue(existing);
    const result = await service.approve('ts-1', 'second-admin');
    expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  describe('replaceSteps — рычаг, без которого цепочка была заперта', () => {
    const GOOD = [
      { kind: 'goto', route: 'generate' },
      { kind: 'click', selector: '[data-qa="client-site-explore"]' },
    ];

    it('шаги заменяются и строка помечается правленной руками', async () => {
      // Промпт нарочно отдаёт плейсхолдеры селекторов, «которые
      // оператор поправит на настоящие», — а поправить их было нечем
      // (находка сквозного аудита A+B+C).
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      await service.replaceSteps('ts-1', GOOD, 'op-1');

      expect(prisma.tutorialScenario.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ts-1' },
          data: expect.objectContaining({
            generatedBy: 'manual',
            steps: GOOD,
          }),
        }),
      );
    });

    it('одобрение и результат прогона сбрасываются безусловно', async () => {
      // Человек, только что переписавший платные шаги, обязан
      // посмотреть на них заново — даже если переписал их сам.
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      await service.replaceSteps('ts-1', GOOD, 'op-1');

      expect(
        prisma.tutorialScenario.update.mock.calls[0][0].data,
      ).toMatchObject({
        approved: false,
        approvedBy: null,
        approvedAt: null,
        lastRunStatus: null,
        lastRunError: null,
        // И отметка о вычитке реплик (§3-бис.5, этап D): вычитан был
        // ПРЕЖНИЙ текст. Безусловно — даже когда реплики не
        // менялись: иначе правка селектора отметку бы сохраняла, а
        // правка реплики снимала, и оператор держал бы это правило в
        // голове.
        narrationReviewedBy: null,
        narrationReviewedAt: null,
      });
    });

    it('плохая реплика не мешает сохранить шаги — её просто вырезают', async () => {
      // Тот же принцип, что у генератора: всё-или-ничего у шагов, но
      // не у реплик. Оператор, промахнувшийся с длиной одной
      // реплики, не должен терять всю правку.
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      await service.replaceSteps(
        'ts-1',
        [
          { kind: 'goto', route: 'generate', narration: 'ы'.repeat(300) },
          { kind: 'click', selector: '#a', narration: 'Жмём.' },
        ],
        'op-1',
      );

      const saved = prisma.tutorialScenario.update.mock.calls[0][0].data
        .steps as Record<string, unknown>[];
      expect(saved).toHaveLength(2);
      expect(saved[0]).not.toHaveProperty('narration');
      expect(saved[1].narration).toBe('Жмём.');
    });

    it('оператору СКАЗАНО, какие реплики отброшены', async () => {
      // У модели обратная связь была с самого начала (`failures[]`), а
      // у человека не было никакой: он видел зелёное «сохранено» и не
      // находил реплику в списке. Спрашивает-то как раз он (находка
      // аудита этапа D).
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      const result = await service.replaceSteps(
        'ts-1',
        [{ kind: 'goto', route: 'generate', narration: 'ы'.repeat(300) }],
        'op-1',
      );

      expect(result.droppedNarrations).toEqual([
        { stepNumber: 1, reason: expect.stringContaining('220') },
      ]);
    });

    it('ничего не отброшено — пустой список, а не отсутствие поля', async () => {
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      const result = await service.replaceSteps('ts-1', GOOD, 'op-1');

      expect(result.droppedNarrations).toEqual([]);
    });

    it('стоимость пересчитывается по новым шагам', async () => {
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      await service.replaceSteps(
        'ts-1',
        [
          ...GOOD,
          {
            kind: 'triggerPaidOperation',
            operation: 'generation',
            model: 'veo-3.1-generate-preview',
            expectedUnits: { seconds: 8 },
            note: 'рендер',
          },
        ],
        'op-1',
      );

      expect(prisma.tutorialScenario.update.mock.calls[0][0].data.costly).toBe(
        true,
      );
    });

    it('негодные шаги отвергаются целиком — правила те же, что для модели', async () => {
      // Ослаблять валидацию для человека незачем: ошибается он так
      // же, а исполняет их тот же код.
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue({
        id: 'ts-1',
        subjectKey: '1',
        locale: 'ru',
      });

      await expect(
        service.replaceSteps('ts-1', [{ kind: 'нетакой' }], 'op-1'),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tutorialScenario.update).not.toHaveBeenCalled();
    });

    it('чужой id — 404, а не молчаливое создание', async () => {
      const { service, prisma } = build();
      prisma.tutorialScenario.findUnique.mockResolvedValue(null);

      await expect(
        service.replaceSteps('нет-такого', GOOD, 'op-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
