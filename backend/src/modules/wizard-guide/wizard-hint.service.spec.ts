/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые двойники */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { NotFoundException } from '@nestjs/common';
import {
  PERSONAL_LIMIT_NOTICE,
  WizardHintService,
} from './wizard-hint.service';

const DRAFT = {
  stepsPerRound: [1, 2],
  title: 'Как оформить заказ',
  status: 'DRAFTING',
  requiresLiveLoginReplay: false,
  credentialsEnc: null,
};

/** Ровно те поля запроса к модели, которые читают проверки ниже. */
interface GenerateCall {
  config: { systemInstruction: string };
}

function build(
  over: {
    project?: Record<string, unknown> | null;
    globalOn?: boolean;
    cached?: { hint: string; actions: unknown; createdAt: Date } | null;
    text?: string;
    spentToday?: number;
    countToday?: number;
    settings?: Record<string, string>;
    throws?: boolean;
    /** Общие правила расхода: блокировка и суточный потолок (§5.8). */
    canSpend?: boolean;
  } = {},
) {
  const prisma = {
    project: {
      findFirst: jest
        .fn()
        .mockResolvedValue(
          over.project === undefined
            ? { type: 'CLIENT_SITE', aiGuideEnabled: true }
            : over.project,
        ),
    },
    clientSiteTutorialDraft: { findUnique: jest.fn().mockResolvedValue(DRAFT) },
    wizardHintCache: {
      findUnique: jest.fn().mockResolvedValue(over.cached ?? null),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    wizardHint: { create: jest.fn().mockResolvedValue({}) },
  };
  const settings = {
    get: jest.fn(async (key: string) => over.settings?.[key] ?? null),
  };
  const aiUsage = {
    recordGemini: jest.fn().mockResolvedValue(undefined),
    countToday: jest.fn().mockResolvedValue(over.countToday ?? 0),
    spentTodayForOperation: jest.fn().mockResolvedValue(over.spentToday ?? 0),
  };
  const guide = {
    available: jest.fn().mockResolvedValue(over.globalOn ?? true),
  };
  const plan = {
    assertCanSpendUser: jest.fn(async () => {
      if (over.canSpend === false) throw new Error('аккаунт заблокирован');
    }),
  };
  const svc = new WizardHintService(
    prisma as any,
    settings as any,
    aiUsage as any,
    guide as any,
    plan as any,
  );
  // Параметр объявлен, хотя мок его не читает: без него `mock.calls[0][0]`
  // — элемент пустого кортежа, и шаг «типы» в CI (корневой tsconfig
  // видит спеки) падает там, где `jest` с `diagnostics: false` молчит.
  const generateContent = jest.fn(async (_req: GenerateCall) => {
    if (over.throws) throw new Error('провайдер лёг');
    return {
      text: over.text ?? 'Начните со страницы, куда реально приходят.',
      // Та же метрика, по которой считается расход: журнал обязан
      // писать её, а не нули.
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 100,
        thoughtsTokenCount: 30,
      },
    };
  });
  (svc as any).genai = { models: { generateContent } };
  return { svc, prisma, aiUsage, guide, generateContent, settings, plan };
}

describe('WizardHintService (§5)', () => {
  it('глобальный рубильник выключен — модель не зовётся', async () => {
    const { svc, generateContent } = build({ globalOn: false });
    expect(await svc.hint('u1', 'p1', 'record')).toMatchObject({ hint: null });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('чекбокс проекта выключен — модель не зовётся', async () => {
    // Главная проверка этапа: выключенный чекбокс не должен давать НИ
    // ОДНОГО платного вызова.
    const { svc, generateContent } = build({
      project: { type: 'CLIENT_SITE', aiGuideEnabled: false },
    });
    expect(await svc.hint('u1', 'p1', 'record')).toMatchObject({ hint: null });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('чужой проект — 404', async () => {
    const { svc } = build({ project: null });
    await expect(svc.hint('u1', 'p1', 'record')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('незнакомый шаг — молчание, а не выдумка', async () => {
    const { svc, generateContent } = build();
    expect(await svc.hint('u1', 'p1', 'таких-шагов-нет')).toMatchObject({
      hint: null,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('свежий кеш отдаётся без вызова модели', async () => {
    const { svc, generateContent, prisma } = build({
      cached: { hint: 'из кеша', actions: [], createdAt: new Date() },
    });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r).toMatchObject({ hint: 'из кеша', source: 'cache' });
    expect(generateContent).not.toHaveBeenCalled();
    // Попадание считается: по его доле видно, разорит фича или нет.
    expect(prisma.wizardHintCache.update).toHaveBeenCalled();
  });

  it('протухший кеш не отдаётся', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const { svc, generateContent } = build({
      cached: { hint: 'вчерашнее', actions: [], createdAt: old },
    });
    expect((await svc.hint('u1', 'p1', 'record')).source).toBe('model');
    expect(generateContent).toHaveBeenCalled();
  });

  it('исчерпанный дневной бюджет молчит, не объясняясь', async () => {
    // Человек не должен уметь по ответу определить состояние нашей
    // кассы: «нечего сказать» и «деньги кончились» для него одно.
    const { svc, generateContent } = build({ spentToday: 9_000_000 });
    expect(await svc.hint('u1', 'p1', 'record')).toEqual({
      hint: null,
      actions: [],
      source: null,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('личный лимит — единственное, о чём говорят вслух', async () => {
    // Это ЕГО лимит, и он завтра вернётся. Наружу едет КОД, а не
    // фраза: подпись даёт словарь, у которого есть пять языков.
    const { svc } = build({ countToday: 40 });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r.hint).toBeNull();
    expect(r.notice).toBe(PERSONAL_LIMIT_NOTICE);
    expect(r.notice).not.toMatch(/[а-яё]/i);
  });

  it('нулевой лимит — это тишина, а не «у вас кончилось»', async () => {
    // Ноль ставит оператор, приостанавливая фичу. Говорить человеку про
    // его лимит там, где лимита нет ни у кого, — вводить в заблуждение.
    const { svc, generateContent } = build({
      settings: { ai_guide_personal_limit: '0' },
    });
    expect(await svc.hint('u1', 'p1', 'record')).toEqual({
      hint: null,
      actions: [],
      source: null,
    });
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('заблокированный аккаунт не тратит на подсказки', async () => {
    // Блокировка — решение оператора, и своего бюджета фичи для неё
    // мало: тот про наши деньги, а не про право этого человека тратить.
    const { svc, generateContent } = build({ canSpend: false });
    expect((await svc.hint('u1', 'p1', 'record')).hint).toBeNull();
    expect(generateContent).not.toHaveBeenCalled();
  });

  it('общие правила расхода спрашиваются по проекту', async () => {
    // Сценарий тестового доступа определяется типом ПРОЕКТА — без
    // `projectId` тестовый аккаунт платил бы за подсказки по общему
    // потолку, а не по своему (TODO §III п.37).
    const { svc, plan } = build();
    await svc.hint('u1', 'p1', 'record');
    expect(plan.assertCanSpendUser).toHaveBeenCalledWith('u1', {
      projectId: 'p1',
    });
  });

  it('личный лимит настраивается, а мусор в настройке его не выключает', async () => {
    const { svc } = build({
      countToday: 3,
      settings: { ai_guide_personal_limit: 'много' },
    });
    expect((await svc.hint('u1', 'p1', 'record')).source).toBe('model');
  });

  it('пустой ответ модели — это молчание, а не пустая подсказка', async () => {
    const { svc, prisma } = build({ text: '   ' });
    expect((await svc.hint('u1', 'p1', 'record')).hint).toBeNull();
    expect(prisma.wizardHintCache.upsert).not.toHaveBeenCalled();
  });

  it('отказ модели не роняет мастер', async () => {
    const { svc } = build({ throws: true });
    await expect(svc.hint('u1', 'p1', 'record')).resolves.toMatchObject({
      hint: null,
    });
  });

  it('контакты в ответе маскируются и помечаются', async () => {
    const { svc, prisma } = build({ text: 'Пишите на sales@example.com' });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r.hint).not.toContain('sales@example.com');
    expect(prisma.wizardHint.create.mock.calls[0][0].data.flagged).toBe(true);
  });

  it('расход пишется под своей операцией, а не под ассистентской', async () => {
    const { svc, aiUsage } = build();
    await svc.hint('u1', 'p1', 'record');
    expect(aiUsage.recordGemini.mock.calls[0][1]).toMatchObject({
      operation: 'wizard-hint',
      userId: 'u1',
    });
  });

  it('состояние едет в промпт фактами, а не значениями полей', async () => {
    // Инъекция через поле невозможна не потому, что мы её фильтруем, а
    // потому, что значения полей туда не попадают вовсе.
    const { svc, generateContent } = build();
    await svc.hint('u1', 'p1', 'record');
    const instruction =
      generateContent.mock.calls[0][0].config.systemInstruction;
    expect(instruction).toContain('записано шагов: 2');
    expect(instruction).not.toContain('Как оформить заказ');
  });

  it('разные состояния дают разные ключи кеша', async () => {
    const a = build();
    await a.svc.hint('u1', 'p1', 'record');
    const keyA = a.prisma.wizardHintCache.findUnique.mock.calls[0][0].where.key;

    const b = build();
    b.prisma.clientSiteTutorialDraft.findUnique.mockResolvedValue({
      ...DRAFT,
      title: null,
    });
    await b.svc.hint('u1', 'p1', 'record');
    const keyB = b.prisma.wizardHintCache.findUnique.mock.calls[0][0].where.key;

    expect(keyA).not.toBe(keyB);
  });

  it('ключ кеша не содержит ни пользователя, ни проекта', async () => {
    // Иначе кеш перестаёт быть общим, попадания исчезают, а в ключ
    // приезжает персональное.
    const { svc, prisma } = build();
    await svc.hint('u1', 'p1', 'record');
    const key = prisma.wizardHintCache.findUnique.mock.calls[0][0].where.key;
    expect(key).not.toContain('u1');
    expect(key).not.toContain('p1');
  });

  // ── Этап 7: действия-кнопки ──────────────────────────────────────

  it('выдуманный шаг не доезжает до экрана, совет доезжает', async () => {
    // Единственное место, где ответ модели превращается в кликабельный
    // элемент. Кнопка на несуществующий шаг хуже отсутствия кнопки.
    const { svc } = build({
      text: `Загляните в просмотр.\n<<<actions>>>\n{"items":[{"kind":"goto-step","stepId":"выдумка"},{"kind":"goto-step","stepId":"review"}]}`,
    });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r.hint).toBe('Загляните в просмотр.');
    expect(r.actions).toEqual([{ kind: 'goto-step', stepId: 'review' }]);
  });

  it('придуманный адрес не доезжает ни в каком виде', async () => {
    const { svc } = build({
      text: `Совет.\n<<<actions>>>\n{"items":[{"kind":"open-doc","slug":"свой-сайт","url":"https://зло"}]}`,
    });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r.actions).toEqual([]);
    expect(JSON.stringify(r)).not.toContain('зло');
  });

  it('документ из белого списка проходит', async () => {
    const { svc } = build({
      text: `Совет.\n<<<actions>>>\n{"items":[{"kind":"open-doc","slug":"offer"}]}`,
    });
    expect((await svc.hint('u1', 'p1', 'record')).actions).toEqual([
      { kind: 'open-doc', slug: 'offer' },
    ]);
  });

  it('блок действий не остаётся в тексте подсказки', async () => {
    const { svc } = build({
      text: `Только текст.\n<<<actions>>>\n{"items":[]}`,
    });
    expect((await svc.hint('u1', 'p1', 'record')).hint).toBe('Только текст.');
  });

  it('действия кладутся в кеш вместе с текстом', async () => {
    // Иначе второй человек на том же состоянии получит совет без
    // кнопки — и разницу никто не объяснит.
    const { svc, prisma } = build({
      text: `Совет.\n<<<actions>>>\n{"items":[{"kind":"goto-step","stepId":"url"}]}`,
    });
    await svc.hint('u1', 'p1', 'record');
    const written = prisma.wizardHintCache.upsert.mock.calls[0][0];
    expect(written.create.actions).toEqual([
      { kind: 'goto-step', stepId: 'url' },
    ]);
  });

  it('промпт называет допустимые шаги и не называет label/url', async () => {
    // Модель называет ТОЛЬКО идентификатор; о чём не спросили — реже
    // выдумывает.
    const { svc, generateContent } = build();
    await svc.hint('u1', 'p1', 'record');
    const instruction =
      generateContent.mock.calls[0][0].config.systemInstruction;
    expect(instruction).toContain('goto-step');
    expect(instruction).toContain('url, record, review');
    expect(instruction).not.toContain('label');
    expect(instruction).not.toMatch(/"url"/);
  });

  // ── Найдено аудитом волн A+B ─────────────────────────────────────

  it('обновление протухшего ключа освежает и его возраст', async () => {
    // Иначе кеш умирает НАВСЕГДА: запись переписывается свежим текстом,
    // но со старой датой, и следующий запрос снова считает её
    // протухшей — то есть после первых суток модель зовётся на каждый
    // запрос, а `hits` навсегда остаётся нулём.
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const { svc, prisma } = build({
      cached: { hint: 'вчерашнее', actions: [], createdAt: old },
    });
    await svc.hint('u1', 'p1', 'record');
    const written = prisma.wizardHintCache.upsert.mock.calls[0][0];
    expect(written.update.createdAt).toBeInstanceOf(Date);
    expect((written.update.createdAt as Date).getTime()).toBeGreaterThan(
      old.getTime(),
    );
  });

  it('запрещённое обещание не показывается и не кешируется', async () => {
    // Ассистент на лендинге такое только помечает — он стримит, и текст
    // уже у посетителя. Советник не стримит и потому может отбросить, а
    // отбросить обязан: кеш общий, и одно «безлимит» иначе выдавалось
    // бы всем на этом шаге сутки.
    const { svc, prisma } = build({ text: 'Берите безлимит и не думайте.' });
    expect((await svc.hint('u1', 'p1', 'record')).hint).toBeNull();
    expect(prisma.wizardHintCache.upsert).not.toHaveBeenCalled();
    // В журнал при этом попадает — иначе оператор не узнает, что модель
    // начала обещать.
    const row = prisma.wizardHint.create.mock.calls[0][0].data;
    expect(row.flagged).toBe(true);
    expect(row.hint).toContain('безлимит');
  });

  it('контакты маскируются, но подсказка остаётся', async () => {
    const { svc } = build({ text: 'Пишите на ivan@example.com, поможем.' });
    const r = await svc.hint('u1', 'p1', 'record');
    expect(r.hint).toContain('[e-mail скрыт]');
    expect(r.hint).not.toContain('example.com');
  });

  it('журнал знает токены и цену, а не нули', async () => {
    // Пустые колонки, которые ВЫГЛЯДЯТ как данные, — ловушка для
    // следующего экрана админки, который на них обопрётся.
    const { svc, prisma } = build();
    await svc.hint('u1', 'p1', 'record');
    const row = prisma.wizardHint.create.mock.calls[0][0].data;
    expect(row.inTokens).toBe(1000);
    expect(row.outTokens).toBe(130);
  });
});
