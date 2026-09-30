/**
 * Серверная проверка пары (повод, тон) на пути правки брифа — этап 2,
 * фича №3 компаньон-ТЗ.
 *
 * §3 ТЗ требует, чтобы недопустимый тон «валидировался серверно (не
 * просто скрывался в UI)». Тесты проверяют именно это: не то, что
 * интерфейс не покажет кнопку, а то, что запрос с таким телом получит
 * 400 — визард обходится прямым вызовом API, эта проверка не обходится.
 */
jest.mock('../plan/plan.service', () => ({ PlanService: class {} }));
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { GreetingBriefService } from './greeting-brief.service';
import { OTHER_MOOD_REQUIRED } from '../../common/greeting-policy';

const brief = (over: Record<string, unknown> = {}) => ({
  id: 'gb1',
  projectId: 'p1',
  occasion: 'BIRTHDAY',
  customOccasionText: null,
  recipientName: 'Аня',
  senderName: null,
  tone: 'FUNNY',
  personalMessage: null,
  presenterProvider: 'grok',
  resolution: '720p',
  brandManifestId: null,
  occasionDate: null,
  createdAt: new Date('2026-09-22T10:00:00Z'),
  updatedAt: new Date('2026-09-22T10:00:00Z'),
  ...over,
});

function build(current = brief()) {
  const prisma = {
    greetingBrief: {
      findFirst: jest.fn().mockResolvedValue(current),
      update: jest
        .fn()
        .mockImplementation(
          async ({ data }: { data: Record<string, unknown> }) =>
            brief({ ...current, ...data }),
        ),
    },
    brandManifest: { findFirst: jest.fn().mockResolvedValue({ id: 'bm1' }) },
  };
  const plans = { planOfUser: jest.fn().mockResolvedValue('PREMIUM') };
  return {
    service: new GreetingBriefService(prisma as never, plans as never),
    prisma,
  };
}

describe('GreetingBriefService.updateBrief — пара (повод, тон)', () => {
  it('отвергает шутливый тон, выставленный для соболезнования', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', { tone: 'FUNNY' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  /**
   * Второй, менее очевидный путь: тон не трогают, меняют ПОВОД. Тон
   * остался с прошлой правки и стал неуместным. Без проверки пары (а не
   * каждого поля по отдельности) это прошло бы молча.
   */
  it('отвергает смену повода, при которой уже выбранный тон становится неуместным', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'BIRTHDAY', tone: 'FUNNY' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', { occasion: 'CONDOLENCE' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('сообщение отказа называет допустимые тоны, а не просто «нельзя»', async () => {
    const { service } = build(brief({ occasion: 'BIRTHDAY', tone: 'FUNNY' }));
    await expect(
      service.updateBrief('u1', 'p1', { occasion: 'GET_WELL' }),
    ).rejects.toThrow(/SUPPORTIVE/);
  });

  it('допустимая пара проходит и сохраняется', async () => {
    const { service, prisma } = build(
      brief({ occasion: 'BIRTHDAY', tone: 'WARM' }),
    );
    await service.updateBrief('u1', 'p1', {
      occasion: 'CONDOLENCE',
      tone: 'RESPECTFUL',
    });
    const data = prisma.greetingBrief.update.mock.calls[0][0].data;
    expect(data.occasion).toBe('CONDOLENCE');
    expect(data.tone).toBe('RESPECTFUL');
  });

  it('новый повод этапа 2 принимается', async () => {
    const { service, prisma } = build(brief({ tone: 'WARM' }));
    await service.updateBrief('u1', 'p1', { occasion: 'HOUSEWARMING' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data.occasion).toBe(
      'HOUSEWARMING',
    );
  });
});

/**
 * Этап D (ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md §3.4
 * п.1, приёмка §8.1): «OTHER … без ответа на вопрос о настроении бриф не
 * сохраняется» — и при правке тоже. `resolveNext` общий для правки брифа
 * проекта и правки из сессии, поэтому достаточно проверить его здесь.
 */
describe('GreetingBriefService.updateBrief — OTHER требует ответа о настроении', () => {
  function buildWithClassifier(current = brief()) {
    const built = build(current);
    const classify = jest.fn().mockResolvedValue(null);
    const service = new GreetingBriefService(
      built.prisma as never,
      { planOfUser: jest.fn().mockResolvedValue('PREMIUM') } as never,
      { classify } as never,
    );
    return { ...built, service, classify };
  }

  const other = (over: Record<string, unknown> = {}) =>
    brief({
      occasion: 'OTHER',
      customOccasionText: 'Защита диплома',
      tone: 'WARM',
      ...over,
    });

  it('смена повода на OTHER без ответа — 400, классификатор не зовётся', async () => {
    const { service, prisma, classify } = buildWithClassifier(
      brief({ tone: 'WARM' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', {
        occasion: 'OTHER',
        customOccasionText: 'Защита диплома',
      }),
    ).rejects.toThrow(OTHER_MOOD_REQUIRED);
    expect(classify).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('смена повода на OTHER с ответом — сохраняется с источником user', async () => {
    const { service, prisma, classify } = buildWithClassifier(
      brief({ tone: 'WARM' }),
    );
    await service.updateBrief('u1', 'p1', {
      occasion: 'OTHER',
      customOccasionText: 'Защита диплома',
      occasionRegister: 'SOLEMN',
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasion: 'OTHER',
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
    });
  });

  /**
   * Старый бриф OTHER: вопрос тогда не задавался, регистр — умолчание.
   * Любая правка без ответа отклоняется — так и задумано: интерфейс
   * теперь спрашивает и без ответа дальше не пускает.
   */
  it.each([
    ['default', 'WARM_NEUTRAL'],
    [null, null],
  ])(
    'старый бриф OTHER (источник %s) без ответа не сохраняется',
    async (registerSource, occasionRegister) => {
      const { service, prisma, classify } = buildWithClassifier(
        other({ registerSource, occasionRegister }),
      );
      await expect(
        service.updateBrief('u1', 'p1', { recipientName: 'Оля' }),
      ).rejects.toThrow(OTHER_MOOD_REQUIRED);
      expect(classify).not.toHaveBeenCalled();
      expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
    },
  );

  it('старый бриф OTHER с ответом в правке — сохраняется', async () => {
    const { service, prisma } = buildWithClassifier(
      other({ registerSource: 'default', occasionRegister: 'WARM_NEUTRAL' }),
    );
    await service.updateBrief('u1', 'p1', {
      recipientName: 'Оля',
      occasionRegister: 'CELEBRATORY',
    });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      recipientName: 'Оля',
      occasionRegister: 'CELEBRATORY',
      registerSource: 'user',
    });
  });

  it('прежний ответ человека (источник user) переживает правку других полей', async () => {
    const { service, prisma } = buildWithClassifier(
      other({ registerSource: 'user', occasionRegister: 'SOLEMN' }),
    );
    await service.updateBrief('u1', 'p1', { recipientName: 'Оля' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
    });
  });

  it('явный null у OTHER — тот же пропуск, 400', async () => {
    const { service, prisma, classify } = buildWithClassifier(
      other({ registerSource: 'user', occasionRegister: 'SOLEMN' }),
    );
    await expect(
      service.updateBrief('u1', 'p1', { occasionRegister: null }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(classify).not.toHaveBeenCalled();
    expect(prisma.greetingBrief.update).not.toHaveBeenCalled();
  });

  it('каталожному поводу ответ не нужен, присланный — игнорируется', async () => {
    const { service, prisma, classify } = buildWithClassifier(
      brief({ tone: 'WARM' }),
    );
    await service.updateBrief('u1', 'p1', {
      recipientName: 'Оля',
      occasionRegister: null,
    });
    await service.updateBrief('u1', 'p1', { occasionRegister: 'MOURNING' });
    expect(classify).not.toHaveBeenCalled();
    for (const [call] of prisma.greetingBrief.update.mock.calls) {
      expect(call.data).toMatchObject({
        occasionRegister: null,
        registerSource: null,
      });
    }
  });

  it('уход с OTHER на каталожный повод без ответа — проходит', async () => {
    const { service, prisma } = buildWithClassifier(
      other({ registerSource: 'default', occasionRegister: 'WARM_NEUTRAL' }),
    );
    await service.updateBrief('u1', 'p1', { occasion: 'BIRTHDAY' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data.occasion).toBe(
      'BIRTHDAY',
    );
  });
});

/**
 * Этап D, «Открыто осознанно» §12: ответ человека о настроении хранится
 * отдельно от итога (`userOccasionRegister`). Раньше при подъёме регистра
 * словами или классификатором в брифе оставался только победивший сигнал,
 * и ответ терялся: правка без повторного ответа получала 400, а
 * переписанное описание, с которого подъём снят, падало в умолчание.
 */
describe('GreetingBriefService — ответ о настроении отдельно от итога', () => {
  function buildWith(current: ReturnType<typeof brief>) {
    const built = build(current);
    const classify = jest.fn().mockResolvedValue(null);
    const service = new GreetingBriefService(
      built.prisma as never,
      { planOfUser: jest.fn().mockResolvedValue('PREMIUM') } as never,
      { classify } as never,
    );
    return { ...built, service, classify };
  }

  // Поднятый ключевыми словами бриф: человек ответил «торжественное»,
  // «поминки» подняли регистр до траурного.
  const raised = (over: Record<string, unknown> = {}) =>
    brief({
      occasion: 'OTHER',
      customOccasionText: 'Поминки деда',
      tone: 'RESPECTFUL',
      occasionRegister: 'MOURNING',
      registerSource: 'keywords',
      userOccasionRegister: 'SOLEMN',
      ...over,
    });

  it('поднятый бриф правится без повторного ответа, ответ сохраняется', async () => {
    const { service, prisma } = buildWith(raised());
    await service.updateBrief('u1', 'p1', { recipientName: 'Оля' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      recipientName: 'Оля',
      occasionRegister: 'MOURNING',
      registerSource: 'keywords',
      userOccasionRegister: 'SOLEMN',
    });
  });

  it('подъём снят переписанным описанием — итог возвращается к ответу, не к умолчанию', async () => {
    const { service, prisma, classify } = buildWith(raised());
    await service.updateBrief('u1', 'p1', {
      customOccasionText: 'Юбилей деда',
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'SOLEMN',
      registerSource: 'user',
      userOccasionRegister: 'SOLEMN',
    });
  });

  it('новый ответ в запросе заменяет сохранённый', async () => {
    const { service, prisma } = buildWith(raised());
    await service.updateBrief('u1', 'p1', { occasionRegister: 'SENSITIVE' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'MOURNING',
      userOccasionRegister: 'SENSITIVE',
    });
  });

  it('старая строка без колонки, источник user — ответ берётся из итога и записывается', async () => {
    const { service, prisma } = buildWith(
      brief({
        occasion: 'OTHER',
        customOccasionText: 'Защита диплома',
        tone: 'WARM',
        occasionRegister: 'SOLEMN',
        registerSource: 'user',
      }),
    );
    await service.updateBrief('u1', 'p1', { recipientName: 'Оля' });
    expect(prisma.greetingBrief.update.mock.calls[0][0].data).toMatchObject({
      occasionRegister: 'SOLEMN',
      userOccasionRegister: 'SOLEMN',
    });
  });

  it('уход на каталожный повод забывает ответ', async () => {
    const { service, prisma } = buildWith(raised());
    await service.updateBrief('u1', 'p1', { occasion: 'CONDOLENCE' });
    expect(
      prisma.greetingBrief.update.mock.calls[0][0].data.userOccasionRegister,
    ).toBeNull();
  });

  it('GET отдаёт ответ человека и у поднятого брифа, и у старой строки', async () => {
    expect(
      (await buildWith(raised()).service.getBrief('u1', 'p1'))
        .userOccasionRegister,
    ).toBe('SOLEMN');
    const legacy = await buildWith(
      raised({
        userOccasionRegister: undefined,
        registerSource: 'user',
        occasionRegister: 'SOLEMN',
      }),
    ).service.getBrief('u1', 'p1');
    expect(legacy.userOccasionRegister).toBe('SOLEMN');
    const lost = await buildWith(
      raised({ userOccasionRegister: undefined }),
    ).service.getBrief('u1', 'p1');
    expect(lost.userOccasionRegister).toBeNull();
  });
});

/** CONTRACT6 п.7 (G-B1): отказы брифа — по-русски, с кодом, без UUID. */
describe('GreetingBriefService — коды отказов', () => {
  it('бриф не найден — код, без идентификатора проекта в тексте', async () => {
    const { service, prisma } = build();
    prisma.greetingBrief.findFirst.mockResolvedValue(null);
    const projectId = '3f2a9c1e-0000-4000-8000-000000000001';
    const err = await service.getBrief('u1', projectId).catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_BRIEF_NOT_FOUND');
    expect(err.message).not.toContain(projectId);
    expect(err.message).toMatch(/[а-я]/);
  });

  it('повод «Другое» без текста — код и русский текст', async () => {
    const { service } = build();
    const err = await service
      .updateBrief('u1', 'p1', { occasion: 'OTHER', customOccasionText: '' })
      .catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_OCCASION_TEXT_REQUIRED');
    expect(err.message).toMatch(/Другое/);
  });

  it('чужой бренд-бук — код, без идентификатора в тексте', async () => {
    const { service, prisma } = build();
    prisma.brandManifest.findFirst.mockResolvedValue(null);
    const err = await service
      .updateBrief('u1', 'p1', { brandManifestId: 'bm-secret-id' })
      .catch((e) => e);
    expect(err.getResponse().code).toBe('GREETING_BRAND_NOT_FOUND');
    expect(err.message).not.toContain('bm-secret-id');
  });
});
