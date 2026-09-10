/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
/**
 * AdminSessionGuard — единственный барьер перед данными админки (список
 * сессий, телеметрия, расходы). CSRF-половина барьера проверена в
 * `admin-auth-gates.spec.ts` на самой функции; здесь — вторая половина,
 * которая не проверялась нигде: превращение cookie в `request.userId`.
 *
 * Самое ценное здесь — срок жизни. Проверку `expiresAt` легко счесть
 * лишней («сессии же чистятся кроном»): уборка оппортунистическая, и без
 * этой строки выданная однажды cookie админки работала бы вечно — в том
 * числе украденная и в том числе после того, как истёк срок, на который
 * доступ выдавали. Ни один тест этого не ловил.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { UnauthorizedException } from '@nestjs/common';
import { AdminSessionGuard } from './admin-session.guard';

function build(session: { userId: string; expiresAt: Date } | null) {
  const prisma = {
    adminSession: { findUnique: jest.fn().mockResolvedValue(session) },
  };
  return { guard: new AdminSessionGuard(prisma as any), prisma };
}

/** GET — безопасный метод, CSRF-проверка на нём пропускает всё; так
 * здесь проверяется именно работа с сессией, а не барьер Origin. */
function context(cookie: string | undefined) {
  const request: any = { method: 'GET', headers: { cookie } };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as any,
  };
}

const envBackup = { ...process.env };
beforeEach(() => {
  delete process.env.CORS_ORIGIN;
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  process.env = { ...envBackup };
});

describe('AdminSessionGuard — без действующей cookie внутрь не пускает', () => {
  it('cookie нет вовсе — 401 и ни одного запроса в базу', async () => {
    // Анонимный запрос не должен даже стоить обращения к БД: маршруты
    // админки открыты снаружи, и это дешёвый способ их нагрузить.
    const { guard, prisma } = build(null);
    const { ctx } = context(undefined);
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
  });

  it('чужие cookie есть, admin_session нет — тот же отказ', async () => {
    // Пользовательская cookie user_session правами админки не является:
    // перепутать имена — значит открыть админку каждому вошедшему.
    const { guard, prisma } = build(null);
    const { ctx } = context('user_session=tok_user; theme=dark');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.adminSession.findUnique).not.toHaveBeenCalled();
  });

  it('придуманный токен — 401, и личности в запросе не появляется', async () => {
    // Не «пустить анонимно»: дальше по маршруту `req.userId` считается
    // проверенным, и undefined там означал бы выборку по чужим данным.
    const { guard } = build(null);
    const { ctx, request } = context('admin_session=подобранный');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(request.userId).toBeUndefined();
  });
});

describe('AdminSessionGuard — срок жизни cookie', () => {
  it('просроченная сессия не пускает, хотя строка в базе ещё есть', async () => {
    // Ключевая проверка файла: строки чистятся оппортунистически (при
    // следующем логине) и кроном раз в сутки, то есть просроченная
    // сессия РЕАЛЬНО лежит в базе часами. Убрать сравнение с `expiresAt`
    // — и админская cookie станет вечной, а тестам это было бы всё равно.
    const { guard } = build({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() - 1000),
    });
    const { ctx, request } = context('admin_session=tok_1');
    await expect(guard.canActivate(ctx)).rejects.toThrow(/expired/i);
    expect(request.userId).toBeUndefined();
  });

  it('сессия, истекающая ровно сейчас, уже не действует', async () => {
    // Граница закрыта в сторону отказа: «ещё одна секунда» на границе —
    // это не удобство, а сессия, живущая дольше выданного срока.
    const { guard } = build({ userId: 'usr_1', expiresAt: new Date() });
    const { ctx } = context('admin_session=tok_1');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('давно истёкшая сессия не воскресает — 401, а не тихий пропуск', async () => {
    const { guard } = build({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    const { ctx } = context('admin_session=tok_1');
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});

describe('AdminSessionGuard — действующая cookie', () => {
  it('живая сессия пускает и проставляет userId для маршрута', async () => {
    // `request.userId` — то, ради чего гвард существует: /admin/auth/me
    // и весь admin-panel читают именно его.
    const { guard, prisma } = build({
      userId: 'usr_1',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { ctx, request } = context('admin_session=tok_1');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.userId).toBe('usr_1');
    // Ищется ровно предъявленный токен: поиск по чему-либо ещё означал
    // бы вход по значению, которым владеет не только владелец сессии.
    expect(prisma.adminSession.findUnique).toHaveBeenCalledWith({
      where: { token: 'tok_1' },
    });
  });

  it('admin_session находится среди других cookie заголовка', async () => {
    // В браузере рядом всегда лежат чужие cookie; наивный парсер «первая
    // пара в заголовке» закрыл бы вход всем, у кого есть что-то ещё.
    const { guard, prisma } = build({
      userId: 'usr_2',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const { ctx, request } = context(
      'theme=dark; admin_session=tok_2; user_session=tok_user',
    );

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.userId).toBe('usr_2');
    expect(prisma.adminSession.findUnique).toHaveBeenCalledWith({
      where: { token: 'tok_2' },
    });
  });
});
