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
  };
  return { prisma, user, session: prisma.session.upsert };
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
