/**
 * AssistPublicDb — клиент под логин-ролью в `assist_public` (ТЗ помощника
 * §4.3-бис, слой 3; план Э0: «второй Prisma-клиент… ПРОВЕРИТЬ работу роли»).
 *
 * Без базы — проверки конфигурации. На реальном Postgres (CI, джоба
 * sites-backend: логин-роль `assist_widget_ci` создаётся шагом после
 * миграций) — этот самый клиент, с тем же адаптером и схемой `sites`,
 * читает `assist_site_chunks` и получает отказ на `assist_admin_chunks`.
 * В CI отсутствие строки — провал, а не пропуск (как assist-public-role.spec).
 */

import {
  AssistPublicDb,
  assertDistinctLogin,
  loginOf,
} from './assist-public-db.service';

const PUBLIC_URL = process.env.ASSIST_PUBLIC_DATABASE_URL;
const IN_CI = process.env.CI === 'true';

describe('AssistPublicDb — конфигурация', () => {
  it('loginOf: пользователь из строки, без пароля; мусор — null', () => {
    expect(
      loginOf('postgresql://assist_widget.ref:p%40ss@h:6543/postgres'),
    ).toBe('assist_widget.ref');
    expect(loginOf(undefined)).toBeNull();
    expect(loginOf('не url')).toBeNull();
  });

  it('тот же логин, что у основного клиента, — отказ (слой 3 выключился бы молча)', () => {
    expect(() =>
      assertDistinctLogin(
        'postgresql://postgres.ref:a@h:6543/postgres',
        'postgresql://postgres.ref:b@h:6543/postgres',
      ),
    ).toThrow(/отдельная логин-роль/);
  });

  it('текст отказа не содержит пароля', () => {
    let message = '';
    try {
      assertDistinctLogin(
        'postgresql://u:SeCrEt1@h/db',
        'postgresql://u:SeCrEt2@h/db',
      );
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/ASSIST_PUBLIC_DATABASE_URL/);
    expect(message).not.toMatch(/SeCrEt/);
  });

  it('разные логины или нет публичной строки — можно', () => {
    expect(() =>
      assertDistinctLogin(
        'postgresql://assist_widget.ref:a@h:6543/postgres',
        'postgresql://postgres.ref:b@h:6543/postgres',
      ),
    ).not.toThrow();
    expect(() =>
      assertDistinctLogin(undefined, 'postgresql://postgres:b@h/db'),
    ).not.toThrow();
  });

  it('конструктор сам применяет проверку', () => {
    const saved = { ...process.env };
    process.env.SITES_DATABASE_URL = 'postgresql://same:a@127.0.0.1:9/db';
    process.env.ASSIST_PUBLIC_DATABASE_URL =
      'postgresql://same:b@127.0.0.1:9/db';
    try {
      expect(() => new AssistPublicDb()).toThrow(/отдельная логин-роль/);
    } finally {
      process.env = saved;
    }
  });

  it('без строки сервис поднимается (виджета на Э0 нет), не подключаясь', async () => {
    const saved = { ...process.env };
    delete process.env.ASSIST_PUBLIC_DATABASE_URL;
    try {
      const db = new AssistPublicDb();
      const connect = jest.spyOn(db, '$connect');
      await db.onModuleInit();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      process.env = saved;
    }
  });
});

if (!PUBLIC_URL) {
  describe('AssistPublicDb на реальном Postgres', () => {
    (IN_CI ? it : it.skip)(
      'ПРОПУЩЕНО: нет ASSIST_PUBLIC_DATABASE_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
      () => {
        throw new Error(
          'CI=true, но ASSIST_PUBLIC_DATABASE_URL не задана — проверка клиента виджета не выполнилась',
        );
      },
    );
  });
} else {
  describe('AssistPublicDb на реальном Postgres (логин-роль в assist_public)', () => {
    let db: AssistPublicDb;

    beforeAll(async () => {
      db = new AssistPublicDb();
      await db.$connect();
    });

    afterAll(async () => {
      await db.$disconnect();
    });

    it('схема sites выбирается адаптером: assist_site_chunks читается', async () => {
      // Контроль: без него отказ ниже мог бы значить «нет связи» или «не та
      // схема», а не «нет прав».
      await expect(db.assistSiteChunk.findMany({ take: 1 })).resolves.toEqual(
        expect.any(Array),
      );
    });

    it('assist_admin_chunks — отказ Postgres (нет прав)', async () => {
      await expect(db.assistAdminChunk.findMany({ take: 1 })).rejects.toThrow(
        /permission denied|42501/i,
      );
    });

    it('кабинеты и участники — отказ', async () => {
      await expect(db.siteAccount.findMany({ take: 1 })).rejects.toThrow(
        /permission denied|42501/i,
      );
      await expect(db.siteAccountMember.findMany({ take: 1 })).rejects.toThrow(
        /permission denied|42501/i,
      );
    });
  });
}
