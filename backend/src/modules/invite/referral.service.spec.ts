/**
 * Приглашения — «Условно бесплатный Lite» §5, этап 134.
 *
 * Проверки здесь про три вещи, на которых ошибка стоит денег или
 * доверия: чей приглашённый, когда он засчитан и не начислили ли мы
 * дважды.
 *
 * ## Почему двойники здесь с памятью, а не с `mockResolvedValue`
 *
 * Аудит этапа 134 нашёл три ошибки, которых плоские двойники не видели
 * ПО УСТРОЙСТВУ: начисление откладывалось и терялось навсегда, потому
 * что повторный проход читал уже изменённую строку, а двойник всегда
 * отдавал первоначальную. Поэтому строка приглашения здесь живёт в
 * переменной и меняется `updateMany`, а «уникальный индекс журнала»
 * смоделирован множеством выданных ключей: повторное начисление по
 * тому же ключу отвечает `false`, как и настоящий P2002.
 */

jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { ReferralService } from './referral.service';

type Row = {
  id: string;
  inviterId: string;
  inviteeId: string;
  status: string;
  revokedAt: Date | null;
  generatedAt: Date | null;
};

function build(
  over: {
    codeOwner?: string | null;
    referral?: Row | null;
    rows?: Row[];
    invitee?: {
      createdAt: Date;
      isTestUser: boolean;
      isBlocked: boolean;
    } | null;
    /** Общий предохранитель программы (§12.3) исчерпан. */
    capped?: boolean;
    /** Уже начислено этому пригласившему сегодня. */
    grantedToday?: number;
    createThrows?: unknown;
  } = {},
) {
  const rows: Row[] =
    over.rows ??
    (over.referral === null
      ? []
      : [
          over.referral ?? {
            id: 'r1',
            inviterId: 'inviter',
            inviteeId: 'invitee',
            status: 'IDENTIFIED',
            revokedAt: null,
            generatedAt: null,
          },
        ]);

  /** Что журнал уже содержит: ключ `<причина>:<приглашение>`. */
  const ledger = new Set<string>();

  const credits = {
    grantFree: jest.fn(
      async (userId: string, reason: string, referralId?: string | null) => {
        const key = `${reason}:${referralId ?? userId}`;
        // Уникальный индекс журнала: второй раз по тому же ключу — нет.
        if (ledger.has(key)) return false;
        // Предохранитель: строка не пишется, значит ключ не занят, и
        // следующий проход попробует снова — ровно это и обещает §12.3.
        if (over.capped) return false;
        ledger.add(key);
        return true;
      },
    ),
  };

  const prisma = {
    user: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          over.invitee === undefined
            ? { createdAt: new Date(), isTestUser: false, isBlocked: false }
            : over.invitee,
        ),
    },
    referralCode: {
      findUnique: jest
        .fn()
        .mockResolvedValue(
          'codeOwner' in over
            ? over.codeOwner && { userId: over.codeOwner, code: 'ABCD2345' }
            : { userId: 'inviter', code: 'ABCD2345' },
        ),
      create: jest.fn().mockResolvedValue({ code: 'ABCD2345' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    referral: {
      findUnique: jest.fn(
        async ({ where }: { where: { inviteeId: string } }) =>
          rows.find((r) => r.inviteeId === where.inviteeId) ?? null,
      ),
      create: over.createThrows
        ? jest.fn().mockRejectedValue(over.createThrows)
        : jest.fn().mockResolvedValue({ id: 'r1' }),
      findMany: jest.fn(
        async ({
          where,
          orderBy,
        }: {
          where: {
            inviterId: string;
            status?: string;
            revokedAt?: null;
          };
          // Двойник обязан СЛУШАТЬСЯ `orderBy`, а не сортировать
          // по-своему: иначе тест очереди проверял бы сортировку
          // двойника, а не запрос сервиса — мутация `asc`→`desc` его
          // переживала.
          orderBy?: { generatedAt?: 'asc' | 'desc' };
        }) => {
          const dir = orderBy?.generatedAt === 'desc' ? -1 : 1;
          return rows
            .filter(
              (r) =>
                r.inviterId === where.inviterId &&
                // Условия берём ИЗ ЗАПРОСА, а не зашиваем в двойник:
                // зашитый фильтр `revokedAt` делал двойник умнее
                // сервиса и переживал снятие этого условия в коде.
                (where.status === undefined || r.status === where.status) &&
                (where.revokedAt === undefined || !r.revokedAt),
            )
            .sort(
              (a, b) =>
                dir *
                ((a.generatedAt?.getTime() ?? 0) -
                  (b.generatedAt?.getTime() ?? 0)),
            )
            .map((r) => ({ id: r.id }));
        },
      ),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: Partial<Row>;
        }) => {
          const row = rows.find(
            (r) => r.id === where.id && r.status === where.status,
          );
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
    },
    creditLedger: {
      count: jest.fn(
        async () =>
          over.grantedToday ??
          [...ledger].filter((k) => k.startsWith('REFERRAL:')).length,
      ),
      findMany: jest.fn(async () =>
        [...ledger]
          .filter((k) => k.startsWith('REFERRAL:'))
          .map((k) => ({ referralId: k.slice('REFERRAL:'.length) })),
      ),
    },
  };

  const svc = new ReferralService(prisma as never, credits as never);
  return { svc, prisma, credits, rows, ledger };
}

const granted = (ledger: Set<string>, reason: string) =>
  [...ledger].filter((k) => k.startsWith(`${reason}:`)).length;

describe('ReferralService.claim — чей приглашённый', () => {
  it('новый человек привязывается к владельцу кода', async () => {
    const { svc, prisma } = build();
    await expect(svc.claim('invitee', 'ABCD2345')).resolves.toBe(true);
    expect(prisma.referral.create).toHaveBeenCalledWith({
      data: { inviterId: 'inviter', inviteeId: 'invitee' },
    });
  });

  it('давний пользователь приглашённым не становится (§5.2)', async () => {
    // Главная находка аудита этапа 134: правило «только тот, кого
    // раньше не было» было записано в комментарии и не выполнялось
    // нигде. Без него вся уже набранная база годилась в приглашённые —
    // по кредиту с каждого и пригласившему, и «приглашённому».
    const { svc, prisma } = build({
      invitee: {
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        isTestUser: false,
        isBlocked: false,
      },
    });
    await expect(svc.claim('invitee', 'ABCD2345')).resolves.toBe(false);
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('себя пригласить нельзя', async () => {
    const { svc, prisma } = build({ codeOwner: 'invitee' });
    await expect(svc.claim('invitee', 'ABCD2345')).resolves.toBe(false);
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('первое касание выигрывает: вторая ссылка не перехватывает', async () => {
    // P2002 по `inviteeId` — человек уже привязан. Молчим: он не делал
    // ничего плохого, просто открыл две ссылки.
    const { svc } = build({ createThrows: { code: 'P2002' } });
    await expect(svc.claim('invitee', 'ABCD2345')).resolves.toBe(false);
  });

  it('несуществующий код ничего не ломает', async () => {
    const { svc, prisma } = build({ codeOwner: null });
    await expect(svc.claim('invitee', 'ZZZZ2345')).resolves.toBe(false);
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('мусор вместо кода даже не ищется в базе', async () => {
    const { svc, prisma } = build();
    await expect(svc.claim('invitee', 'не-код')).resolves.toBe(false);
    expect(prisma.referralCode.findUnique).not.toHaveBeenCalled();
  });
});

describe('ReferralService.countFirstGeneration — засчёт', () => {
  it('первый готовый ролик засчитывает приглашение и начисляет обоим', async () => {
    const { svc, credits, rows } = build();
    await svc.countFirstGeneration('invitee');
    expect(rows[0].status).toBe('GENERATED');
    expect(rows[0].generatedAt).toBeInstanceOf(Date);
    expect(credits.grantFree).toHaveBeenCalledWith('inviter', 'REFERRAL', 'r1');
    expect(credits.grantFree).toHaveBeenCalledWith(
      'invitee',
      'REFERRAL_INVITEE',
      'r1',
    );
  });

  it('повторный вызов не начисляет второй раз', async () => {
    // Момент «ролик готов» вызывается повторно на клиентских ретраях.
    const { svc, ledger } = build();
    await svc.countFirstGeneration('invitee');
    await svc.countFirstGeneration('invitee');
    await svc.countFirstGeneration('invitee');
    expect(granted(ledger, 'REFERRAL')).toBe(1);
    expect(granted(ledger, 'REFERRAL_INVITEE')).toBe(1);
  });

  it('человек без приглашения — тихо ничего', async () => {
    const { svc, credits } = build({ referral: null });
    await svc.countFirstGeneration('invitee');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('тестовый приглашённый не засчитывается (§5.4)', async () => {
    const { svc, credits, rows } = build({
      invitee: { createdAt: new Date(), isTestUser: true, isBlocked: false },
    });
    await svc.countFirstGeneration('invitee');
    expect(rows[0].status).toBe('IDENTIFIED');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('заблокированный приглашённый не засчитывается (§5.4)', async () => {
    const { svc, credits, rows } = build({
      invitee: { createdAt: new Date(), isTestUser: false, isBlocked: true },
    });
    await svc.countFirstGeneration('invitee');
    expect(rows[0].status).toBe('IDENTIFIED');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('снятое оператором приглашение не оживает', async () => {
    const { svc, credits, rows } = build({
      referral: {
        id: 'r1',
        inviterId: 'inviter',
        inviteeId: 'invitee',
        status: 'IDENTIFIED',
        revokedAt: new Date(),
        generatedAt: null,
      },
    });
    await svc.countFirstGeneration('invitee');
    // Не только «не начислили», но и «не засчитали»: снятое остаётся
    // снятым, иначе следующий проход нашёл бы его засчитанным.
    expect(rows[0].status).toBe('IDENTIFIED');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('сбой учёта не бросает наружу — ролик у человека уже готов', async () => {
    const { svc, prisma } = build();
    prisma.referral.findUnique.mockRejectedValue(new Error('база легла'));
    await expect(svc.countFirstGeneration('invitee')).resolves.toBeUndefined();
  });

  it('бонус приглашённому выключается переменной', async () => {
    const before = process.env.REFERRAL_INVITEE_BONUS;
    process.env.REFERRAL_INVITEE_BONUS = '0';
    try {
      const { svc, ledger } = build();
      await svc.countFirstGeneration('invitee');
      expect(granted(ledger, 'REFERRAL')).toBe(1);
      expect(granted(ledger, 'REFERRAL_INVITEE')).toBe(0);
    } finally {
      if (before === undefined) delete process.env.REFERRAL_INVITEE_BONUS;
      else process.env.REFERRAL_INVITEE_BONUS = before;
    }
  });
});

describe('потолки откладывают, а не сжигают (§5.4, §12.3)', () => {
  it('суточный потолок пригласившего: строка засчитана, кредит ждёт', async () => {
    // §5.4 дословно: «приглашение остаётся GENERATED, а начисление ...
    // на следующий день». Первая редакция уходила ДО отметки — и
    // «назавтра» не наступало никогда, потому что факт нигде не
    // записывался.
    const { svc, rows, ledger } = build({ grantedToday: 10 });
    await svc.countFirstGeneration('invitee');
    expect(rows[0].status).toBe('GENERATED');
    expect(granted(ledger, 'REFERRAL')).toBe(0);
  });

  it('назавтра отложенное начисляется — кабинетом, без нового ролика', async () => {
    const { svc, rows, ledger } = build({ grantedToday: 10 });
    await svc.countFirstGeneration('invitee');
    expect(granted(ledger, 'REFERRAL')).toBe(0);

    // Наступили следующие сутки: сегодняшний счёт снова нулевой.
    // Приглашённый второй ролик делать не обязан — догоняет открытие
    // кабинета (`InviteService.stateOf`).
    const next = build({ rows, grantedToday: 0 });
    await next.svc.settlePending('inviter');
    expect(granted(next.ledger, 'REFERRAL')).toBe(1);
  });

  it('общий предохранитель программы тоже только откладывает', async () => {
    const capped = build({ capped: true });
    await capped.svc.countFirstGeneration('invitee');
    expect(capped.rows[0].status).toBe('GENERATED');
    expect(granted(capped.ledger, 'REFERRAL')).toBe(0);

    const later = build({ rows: capped.rows });
    await later.svc.settlePending('inviter');
    await later.svc.settlePending('invitee');
    expect(granted(later.ledger, 'REFERRAL')).toBe(1);
    expect(granted(later.ledger, 'REFERRAL_INVITEE')).toBe(1);
  });

  it('бонус приглашённого не зависит от потолка пригласившего', async () => {
    // Потолок — личный, у пригласившего. Приглашённый в чужую рассылку
    // не вмешивался, и его бонус не должен от неё страдать.
    const { svc, ledger } = build({ grantedToday: 10 });
    await svc.countFirstGeneration('invitee');
    expect(granted(ledger, 'REFERRAL')).toBe(0);
    expect(granted(ledger, 'REFERRAL_INVITEE')).toBe(1);
  });

  it('при нехватке потолка первыми идут те, кто ждёт дольше', async () => {
    const day = 24 * 60 * 60 * 1000;
    const rows: Row[] = [1, 2, 3].map((n) => ({
      id: `r${n}`,
      inviterId: 'inviter',
      inviteeId: `invitee${n}`,
      status: 'GENERATED',
      revokedAt: null,
      generatedAt: new Date(Date.now() - (4 - n) * day),
    }));
    const before = process.env.REFERRAL_DAILY_COUNTED_CAP;
    process.env.REFERRAL_DAILY_COUNTED_CAP = '2';
    try {
      const { svc, ledger } = build({ rows });
      await svc.settlePending('inviter');
      // Порядок выдачи, а не просто набор: `.sort()` здесь скрыл бы
      // разворот очереди.
      expect([...ledger].filter((k) => k.startsWith('REFERRAL:'))).toEqual([
        'REFERRAL:r1',
        'REFERRAL:r2',
      ]);
    } finally {
      if (before === undefined) delete process.env.REFERRAL_DAILY_COUNTED_CAP;
      else process.env.REFERRAL_DAILY_COUNTED_CAP = before;
    }
  });

  it('нулевой потолок приостанавливает начисления, не теряя их', async () => {
    const before = process.env.REFERRAL_DAILY_COUNTED_CAP;
    process.env.REFERRAL_DAILY_COUNTED_CAP = '0';
    let rows: Row[];
    try {
      const paused = build();
      await paused.svc.countFirstGeneration('invitee');
      rows = paused.rows;
      expect(rows[0].status).toBe('GENERATED');
      expect(granted(paused.ledger, 'REFERRAL')).toBe(0);
    } finally {
      if (before === undefined) delete process.env.REFERRAL_DAILY_COUNTED_CAP;
      else process.env.REFERRAL_DAILY_COUNTED_CAP = before;
    }
    const resumed = build({ rows });
    await resumed.svc.settlePending('inviter');
    expect(granted(resumed.ledger, 'REFERRAL')).toBe(1);
  });
});

describe('ReferralService.settlePending — догон начислений', () => {
  it('снятое оператором не начисляет НИ одной стороне', async () => {
    // Снятие (этап 135) обязано останавливать деньги с обеих сторон:
    // и кредит пригласившему, и бонус приглашённому. Первая редакция
    // фильтровала снятое только у пригласившего.
    const { svc, credits } = build({
      rows: [
        {
          id: 'r1',
          inviterId: 'inviter',
          inviteeId: 'invitee',
          status: 'GENERATED',
          revokedAt: new Date(),
          generatedAt: new Date(),
        },
      ],
    });
    await svc.settlePending('inviter');
    await svc.settlePending('invitee');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('вошедший, но не сделавший ролик, денег не приносит', async () => {
    // Граница всей программы: платим за дошедшего до ролика, а не за
    // вошедшего (§5.3). Догон начислений обязан держать её так же
    // строго, как и сам засчёт.
    const { svc, credits } = build({
      rows: [
        {
          id: 'r1',
          inviterId: 'inviter',
          inviteeId: 'invitee',
          status: 'IDENTIFIED',
          revokedAt: null,
          generatedAt: null,
        },
      ],
    });
    await svc.settlePending('inviter');
    await svc.settlePending('invitee');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });

  it('по уже начисленным журнал не дёргается повторно', async () => {
    // Кабинет открывают часто, а приглашённых у человека могут быть
    // десятки. Без сверки с журналом каждое открытие означало бы
    // десятки заведомо провальных вставок.
    const rows: Row[] = [1, 2].map((n) => ({
      id: `r${n}`,
      inviterId: 'inviter',
      inviteeId: `invitee${n}`,
      status: 'GENERATED',
      revokedAt: null,
      generatedAt: new Date(),
    }));
    const { svc, credits } = build({ rows });
    await svc.settlePending('inviter');
    expect(credits.grantFree).toHaveBeenCalledTimes(2);
    credits.grantFree.mockClear();
    await svc.settlePending('inviter');
    expect(credits.grantFree).not.toHaveBeenCalled();
  });
});

describe('ReferralService.registerVisit', () => {
  it('двигает счётчик, строк не создаёт', async () => {
    const { svc, prisma } = build();
    await expect(svc.registerVisit('ABCD2345')).resolves.toBe(true);
    expect(prisma.referralCode.updateMany).toHaveBeenCalledWith({
      where: { code: 'ABCD2345' },
      data: { visitCount: { increment: 1 } },
    });
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('мусор в базу не ходит', async () => {
    const { svc, prisma } = build();
    await expect(svc.registerVisit('***')).resolves.toBe(false);
    expect(prisma.referralCode.updateMany).not.toHaveBeenCalled();
  });
});
