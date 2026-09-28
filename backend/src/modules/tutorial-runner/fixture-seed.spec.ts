/* eslint-disable @typescript-eslint/no-explicit-any -- двойники Prisma */
import { seedFixtureUser } from './fixture-seed';

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
  return { prisma, user };
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
});
