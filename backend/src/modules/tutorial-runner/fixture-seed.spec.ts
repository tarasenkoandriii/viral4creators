/* eslint-disable @typescript-eslint/no-explicit-any -- двойники Prisma */
import { seedFixtureUser } from './fixture-seed';
import { DEFAULT_VOICE_MODE, usesOwnVoice } from '../../common/voice-mode';

function build() {
  const upsert = (id: string) =>
    jest.fn().mockImplementation(async (args: any) => ({
      id: args?.where?.id ?? id,
      ...(args?.create ?? {}),
    }));
  const user = jest
    .fn()
    .mockResolvedValue({ id: 'usr_fixture', telegramId: '42' });
  const prisma = {
    user: { upsert: user },
    brandManifest: { upsert: upsert('m') },
    brandCharacter: { upsert: upsert('c') },
    project: { upsert: upsert('p') },
    productItem: { upsert: upsert('i') },
    session: { upsert: upsert('s') },
    // Бриф поздравления: 1:1 к проекту, поэтому `where` — `projectId`,
    // а не `id`. Отдельный мок нужен потому, что три фикстурных
    // проекта-поздравления заводятся вместе с брифами (29.09.2026).
    greetingBrief: {
      upsert: jest.fn(async (args?: Record<string, any>) => ({
        id: `gb_${args?.where?.projectId ?? 'x'}`,
        ...(args?.create ?? {}),
      })),
    },
  };
  return {
    prisma,
    user,
    session: prisma.session.upsert,
    greetingBrief: prisma.greetingBrief.upsert,
    project: prisma.project.upsert,
  };
}

describe('seedFixtureUser', () => {
  it('фикстура помечена тестовой И в create, и в update', async () => {
    // Расход ночной обучалки пишется на неё. Без флага он попадал бы
    // в общие числа отчёта вперемешку с настоящими людьми; без флага
    // в `update` его не получила бы уже заведённая фикстура.
    const { prisma, user } = build();

    await seedFixtureUser(prisma as any, '42');

    const args = user.mock.calls[0][0];
    expect(args.create.isTestUser).toBe(true);
    expect(args.update.isTestUser).toBe(true);
  });

  it('и получает потолок тестовых, а не двухдолларовый тарифный', async () => {
    // Тариф по умолчанию — LITE, его суточный потолок два доллара,
    // самый низкий в продукте. `PlanService.stateOf` зажигает
    // `nearlyExhausted` на 80 % от него, а `AccountNotice` рисует
    // плашку в оболочке приложения — то есть на КАЖДОМ экране,
    // который снимает этот же прогон. Плашка «дневной лимит
    // исчерпан» уехала бы в обучающий ролик и в снимки лендинга
    // (находка повторного сквозного аудита A+B+C).
    const { prisma, user } = build();

    await seedFixtureUser(prisma as any, '42');

    const args = user.mock.calls[0][0];
    expect(args.create.freeOutsideProject).toBe(true);
    expect(args.update.freeOutsideProject).toBe(true);
  });

  it('сценарных галочек НЕ выдаёт — иначе зелёная плашка в каждом кадре', async () => {
    // `showsTestAccess` требует непустой список сценарных галочек.
    // Выдать их фикстуре значило бы поставить благодарственную
    // плашку в каждый снимаемый экран.
    const { prisma, user } = build();

    await seedFixtureUser(prisma as any, '42');

    const args = user.mock.calls[0][0];
    expect(args.create.freeScenarios).toBeUndefined();
    expect(args.update.freeScenarios).toBeUndefined();
  });

  it('в журнале сказано, что аккаунт помечен тестовым', async () => {
    // `FIXTURE_TELEGRAM_ID` вполне может указывать на живой аккаунт
    // («возьмём мой»), и тогда кнопка «Завести фикстуру» уводит
    // расход этого человека из общих чисел отчёта. Молча — нельзя.
    const { prisma } = build();

    const result = await seedFixtureUser(prisma as any, '42');

    expect(result.log[0]).toMatch(/помечен тестовым/);
  });

  it('готовый ролик несёт режим озвучки — иначе карточки переозвучки нет', async () => {
    // Находка второго боевого прогона 29.09.2026: `RevoicePanel`
    // рендерится только при `usesOwnVoice(video.voiceMode)`, а фикстура
    // клала ролик без поля вовсе — карточка не появлялась никогда, и
    // сценарий хука `revoice-panel` ждал её 15 секунд и падал.
    //
    // Значение сверяется с `DEFAULT_VOICE_MODE`, а не пишется строкой:
    // фикстура должна выглядеть как обычный сегодняшний ролик, и когда
    // умолчание продукта сменится, тест обязан поехать вместе с ним.
    const { prisma, session } = build();

    await seedFixtureUser(prisma as any, '42');

    const args = session.mock.calls[0][0];
    for (const side of [args.create, args.update]) {
      expect(side.liveData.generatedVideo.voiceMode).toBe(DEFAULT_VOICE_MODE);
      expect(usesOwnVoice(side.liveData.generatedVideo.voiceMode)).toBe(true);
    }
  });
});

/**
 * Три сессии вместо одной — разбор достижимости хуков 29.09.2026.
 *
 * Сессия с готовым роликом показывает поверхности просмотра и не
 * показывает поверхности работы. Десять хуков каталога жили на
 * экранах, до которых с неё не дойти никаким кликом.
 */
describe('seedFixtureUser: сессии под каждое состояние мастера', () => {
  const sessionsOf = (session: jest.Mock) =>
    new Map<string, any>(
      session.mock.calls.map((c) => [c[0].where.id, c[0].create]),
    );
  /** Сессии МАСТЕРА ТОВАРА — у них есть снимок товара. У сессий
   *  поздравления его нет: там проект 1:1 к брифу, товара не бывает. */
  const wizardSessionsOf = (session: jest.Mock) =>
    new Map(
      [...sessionsOf(session)].filter(([, s]) => s.data.productInformation),
    );

  it('заводит ровно три сессии мастера: готовую, до промпта и перед рендером', async () => {
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    expect([...wizardSessionsOf(session).keys()]).toEqual([
      'fixture-tutorial-session',
      'fixture-tutorial-session-prompt-pending',
      'fixture-tutorial-session-ready-to-render',
    ]);
  });

  it('у сессии ДО промпта промпта нет — иначе карточку релевантности прячет он сам', async () => {
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    const s = sessionsOf(session).get(
      'fixture-tutorial-session-prompt-pending',
    );
    expect(s.status).toBe('product_info_added');
    expect(s.data.generationPrompt).toBeUndefined();
    expect(s.liveData).toEqual({});
  });

  it('у сессии ПЕРЕД рендером промпт одобрен, а ролика нет', async () => {
    // Оба условия обязательны и по разным причинам: без одобрения
    // позиция «Видео» степпера некликабельна (`stepTargets`), а с
    // готовым роликом карточка запуска рендера скрыта.
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    const s = sessionsOf(session).get(
      'fixture-tutorial-session-ready-to-render',
    );
    expect(s.status).toBe('prompt_generated');
    expect(s.data.generationPrompt.approvedAt).toEqual(expect.any(String));
    expect(s.generationStatus).toBeNull();
    expect(s.liveData).toEqual({});
  });

  it('товар записан ПО КОНТРАКТУ ProductInformation, а не выдуманными ключами', async () => {
    // До 29.09.2026 здесь лежало `{ title, description }`.
    // `seedFromSession` читает `productName`, получал `undefined`, и
    // позиция «Промпт» степпера не открывалась никогда —
    // `stepTargets` требует `sourced && s.productName`.
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    for (const s of wizardSessionsOf(session).values()) {
      expect(s.data.productInformation.productName).toEqual(expect.any(String));
      expect(s.data.productInformation.productDescription).toEqual(
        expect.any(String),
      );
      expect(s.data.productInformation.title).toBeUndefined();
      // По нему `seedFromSession` ставит `imageUploadProgress: 100`, а
      // без сотни карточка запуска рендера скрыта первым же условием.
      expect(s.data.productInformation.productImagePathname).toEqual(
        expect.any(String),
      );
    }
  });

  it('у всех трёх есть завершённый разбор — без него кликабельна ОДНА позиция степпера', async () => {
    // `stepTargets`: `analysed` ложно → «Анализ» закрыт, а из него
    // выводится `sourced`, от которого зависят «Товар» и «Промпт».
    // То есть без разбора все четыре позиции мертвы, клик проходит
    // вхолостую (`goToStep` при `target === null` возвращает прежнее
    // состояние), и следующий `waitFor` падает через 15 секунд.
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    for (const s of wizardSessionsOf(session).values()) {
      expect(s.data.videoAnalysis.status).toBe('complete');
      expect(s.data.videoAnalysis.sceneBreakdown).toEqual(expect.any(String));
      expect(s.data.videoAnalysis.characters.length).toBeGreaterThan(0);
      expect(s.data.videoAnalysis.scenes.length).toBeGreaterThan(0);
    }
  });

  it('состояния различаются ТОЛЬКО состоянием: товар, разбор и бренд одинаковы', async () => {
    // Иначе расхождение экранов можно было бы списать на разные
    // данные, и находка растворилась бы в «ну там другая сессия».
    const { prisma, session } = build();
    await seedFixtureUser(prisma as any, '42');
    const all = [...wizardSessionsOf(session).values()];
    const first = JSON.stringify(all[0].data.videoAnalysis);
    for (const s of all) {
      expect(JSON.stringify(s.data.videoAnalysis)).toBe(first);
      expect(s.data.productInformation.productName).toBe(
        all[0].data.productInformation.productName,
      );
    }
  });
});

/**
 * Тариф фикстуры — разбор достижимости 29.09.2026.
 *
 * У LITE выключены `relevance`, `audit` и `referenceAssets`, а это
 * ровно три хука каталога. На LITE-фикстуре они недостижимы при любом
 * состоянии сессии — та же поломка, что и с недостающими данными,
 * только спрятанная в тарифе.
 */
describe('seedFixtureUser: тариф', () => {
  it('новая фикстура заводится PREMIUM, иначе три хука каталога мертвы', async () => {
    const { prisma, user } = build();
    await seedFixtureUser(prisma as any, '42');
    expect(user.mock.calls[0][0].create.plan).toBe('PREMIUM');
  });

  it('тариф УЖЕ заведённого пользователя не трогается', async () => {
    // `telegramId` из `.env` вполне может указывать на живой аккаунт.
    // Менять человеку тариф сидированием — не право этой функции.
    const { prisma, user } = build();
    await seedFixtureUser(prisma as any, '42');
    expect(user.mock.calls[0][0].update.plan).toBeUndefined();
  });

  it('чужой тариф не молчит: в журнале названы хуки, которые от него упадут', async () => {
    // Молчаливое «всё готово» здесь хуже отсутствия сидирования:
    // оператор нажал кнопку, получил зелёный ответ, а ночью три
    // сценария падают по таймауту без объяснения.
    const { prisma, user } = build();
    user.mockResolvedValue({ id: 'u', telegramId: '42', plan: 'LITE' });
    const result = await seedFixtureUser(prisma as any, '42');
    const warning = result.log.find((l) => l.includes('ВНИМАНИЕ'));
    expect(warning).toContain('LITE');
    expect(warning).toContain('relevance-panel');
    expect(warning).toContain('audit-panel');
    expect(warning).toContain('reference-slots');
  });

  it('советник и его голос выключены у КАЖДОГО проекта фикстуры — и в update (финальный аудит ветки K)', async () => {
    const { prisma, project } = build();
    await seedFixtureUser(prisma as any, '42');
    expect(project.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [args] of project.mock.calls as any[]) {
      expect({ id: args.where.id, ...args.update }).toMatchObject({
        id: args.where.id,
        aiGuideEnabled: false,
        aiGuideVoice: false,
      });
    }
  });

  it('у PREMIUM предупреждения нет', async () => {
    const { prisma, user } = build();
    user.mockResolvedValue({ id: 'u', telegramId: '42', plan: 'PREMIUM' });
    const result = await seedFixtureUser(prisma as any, '42');
    expect(result.log.some((l) => l.includes('ВНИМАНИЕ'))).toBe(false);
  });
});
