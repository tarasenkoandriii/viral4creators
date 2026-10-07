/* eslint-disable @typescript-eslint/no-explicit-any -- тестовые дублёры */
/**
 * C2 захода 8: точечная запись снимка поздравления — чистые решения и
 * цикл повторов. SQL проверяет `greeting-snapshot-write.pg.spec.ts` на
 * настоящем Postgres.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  GREETING_POLICY_KEYS,
  MAX_SNAPSHOT_WRITE_ATTEMPTS,
  SNAPSHOT_READ_TAG,
  SNAPSHOT_WRITE_TAG,
  applyGreetingSnapshotChange,
  diffGreetingSnapshot,
  readGreetingSnapshot,
  snapshotWritePayload,
  updateGreetingSnapshot,
} from './greeting-snapshot-write';
import type { GreetingBriefSnapshot } from './types/greeting.types';
import { fakeSnapshotDb } from '../../test/fake-greeting-snapshot-db';

const brief = (over: Record<string, unknown> = {}) =>
  ({
    occasion: 'BIRTHDAY',
    tone: 'WARM',
    recipientName: 'Аня',
    ...over,
  }) as unknown as GreetingBriefSnapshot;

function memory(initial: GreetingBriefSnapshot | null) {
  let row: any = initial
    ? { sessionId: 's1', greetingBriefSnapshot: initial }
    : null;
  const sessions = {
    getSession: jest.fn(async () => row),
    updateSession: jest.fn(async (_id: string, patch: any) => {
      row = { ...row, ...patch };
      return row;
    }),
  };
  return {
    sessions,
    get snapshot() {
      return row?.greetingBriefSnapshot;
    },
    set(over: Record<string, unknown>) {
      row = {
        ...row,
        greetingBriefSnapshot: { ...row.greetingBriefSnapshot, ...over },
      };
    },
  };
}

describe('diffGreetingSnapshot', () => {
  it('только изменённые ключи; исчезнувшие — undefined (удалить)', () => {
    const a = brief({ sticker: { id: 'x' }, sceneCount: 2 });
    const b = { ...brief({ sticker: { id: 'x' }, tone: 'FUNNY' }) } as any;
    expect(diffGreetingSnapshot(a, b)).toEqual({
      tone: 'FUNNY',
      sceneCount: undefined,
    });
    expect('sceneCount' in diffGreetingSnapshot(a, b)).toBe(true);
  });

  it('вложенные объекты сравниваются по значению, а не по ссылке', () => {
    const a = brief({ cards: { title: 'А', closing: null } });
    const b = brief({ cards: { title: 'А', closing: null } });
    expect(diffGreetingSnapshot(a, b)).toEqual({});
    expect(
      diffGreetingSnapshot(a, brief({ cards: { title: 'Б', closing: null } })),
    ).toEqual({ cards: { title: 'Б', closing: null } });
  });

  it('ключ со значением undefined там, где его и не было, — не правка', () => {
    expect(
      diffGreetingSnapshot(brief(), brief({ sticker: undefined })),
    ).toEqual({});
  });

  it('null — значение, а не удаление', () => {
    expect(
      diffGreetingSnapshot(
        brief({ sticker: { id: 'x' } }),
        brief({ sticker: null }),
      ),
    ).toEqual({ sticker: null });
  });
});

describe('snapshotWritePayload', () => {
  it('undefined в правке — удаление ключа, остальное — запись', () => {
    const p = snapshotWritePayload(brief(), {
      set: { sticker: null, sceneCount: undefined } as any,
    });
    expect(p.set).toEqual({ sticker: null });
    expect(p.remove).toEqual(['sceneCount']);
    expect(p.expect).toEqual({});
    expect(p.all).toBeUndefined();
  });

  it('expect берёт значения из ПРОЧИТАННОГО снимка; отсутствующий ключ — null', () => {
    const p = snapshotWritePayload(brief(), {
      set: { sceneCount: 3 },
      expect: GREETING_POLICY_KEYS,
    });
    expect(p.expect).toEqual({
      occasion: 'BIRTHDAY',
      occasionRegister: null,
      tone: 'WARM',
    });
  });

  it("expect: 'all' — условие по снимку целиком", () => {
    const cur = brief({ sceneCount: 2 });
    const p = snapshotWritePayload(cur, {
      set: { tone: 'FUNNY' } as any,
      expect: 'all',
    });
    expect(p.all).toEqual(cur);
    expect(p.expect).toEqual({});
  });

  it('expect без прочитанного снимка — ошибка программиста', () => {
    expect(() =>
      snapshotWritePayload(null, { set: {}, expect: ['tone'] }),
    ).toThrow('прочитанный снимок');
    expect(() =>
      snapshotWritePayload(null, { set: {}, expect: 'all' }),
    ).toThrow('прочитанный снимок');
  });

  it('другие ключи сессии: undefined — стереть (null), горячие и сам снимок — отказ', () => {
    const p = snapshotWritePayload(brief(), {
      set: {},
      data: { generationPrompt: undefined },
    });
    expect(p.data).toEqual({ generationPrompt: null });
    expect(() =>
      snapshotWritePayload(brief(), {
        set: {},
        data: { generatedVideo: { status: 'pending' } } as any,
      }),
    ).toThrow('горячий ключ');
    expect(() =>
      snapshotWritePayload(brief(), {
        set: {},
        data: { greetingBriefSnapshot: brief() } as any,
      }),
    ).toThrow('через set');
  });
});

describe('applyGreetingSnapshotChange / readGreetingSnapshot', () => {
  it('пустая правка в базу не ходит', async () => {
    const db = { $queryRaw: jest.fn() };
    const cur = brief();
    await expect(
      applyGreetingSnapshotChange(db as any, 's1', cur, { set: {} }),
    ).resolves.toBe(cur);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it('запрос записи — один параметр с правкой и id сессии, с меткой', async () => {
    const db = {
      $queryRaw: jest.fn().mockResolvedValue([{ snapshot: { tone: 'X' } }]),
    };
    const out = await applyGreetingSnapshotChange(db as any, 's1', brief(), {
      set: { sceneCount: 2 },
    });
    expect(out).toEqual({ tone: 'X' });
    const [strings, json, id] = db.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain(SNAPSHOT_WRITE_TAG);
    expect(JSON.parse(json).set).toEqual({ sceneCount: 2 });
    expect(id).toBe('s1');
  });

  it('промах условия — null; снимок строкой (драйвер) разбирается', async () => {
    const miss = { $queryRaw: jest.fn().mockResolvedValue([]) };
    await expect(
      applyGreetingSnapshotChange(miss as any, 's1', brief(), {
        set: { sceneCount: 2 },
      }),
    ).resolves.toBeNull();
    const asText = {
      $queryRaw: jest.fn().mockResolvedValue([{ snapshot: '{"tone":"Y"}' }]),
    };
    await expect(readGreetingSnapshot(asText as any, 's1')).resolves.toEqual({
      tone: 'Y',
    });
    expect(asText.$queryRaw.mock.calls[0][0].join('?')).toContain(
      SNAPSHOT_READ_TAG,
    );
    const none = {
      $queryRaw: jest.fn().mockResolvedValue([{ snapshot: null }]),
    };
    await expect(readGreetingSnapshot(none as any, 's1')).resolves.toBeNull();
  });
});

describe('updateGreetingSnapshot — прочитал, решил, записал', () => {
  it('без помех — одна запись, только свои ключи, соседние поля целы', async () => {
    const m = memory(brief({ sceneCount: 2 }));
    const db = fakeSnapshotDb(m.sessions);
    const out = await updateGreetingSnapshot(db, 's1', m.snapshot, () => ({
      set: { sticker: null },
    }));
    expect(db.writes).toHaveLength(1);
    expect(out).toEqual(brief({ sceneCount: 2, sticker: null }));
  });

  it('две правки по одному устаревшему снимку — обе доходят', async () => {
    const m = memory(brief());
    const db = fakeSnapshotDb(m.sessions);
    const stale = m.snapshot;
    await updateGreetingSnapshot(db, 's1', stale, () => ({
      set: { sceneCount: 3 },
    }));
    await updateGreetingSnapshot(db, 's1', stale, () => ({
      set: { cards: { title: 'А', closing: null } },
    }));
    expect(m.snapshot).toEqual(
      brief({ sceneCount: 3, cards: { title: 'А', closing: null } }),
    );
  });

  it('зависимый ключ поменяли — решение пересчитывается по свежему снимку', async () => {
    const m = memory(brief());
    const db = fakeSnapshotDb(m.sessions, {
      beforeWrite: (n) => n === 1 && m.set({ tone: 'FUNNY' }),
    });
    const seen: string[] = [];
    await updateGreetingSnapshot(db, 's1', m.snapshot, (cur) => {
      seen.push(cur.tone);
      return { set: { sceneCount: 2 }, expect: ['tone'] };
    });
    expect(seen).toEqual(['WARM', 'FUNNY']);
    expect(db.writes).toHaveLength(2);
    expect(m.snapshot).toEqual(brief({ tone: 'FUNNY', sceneCount: 2 }));
  });

  it('независимый ключ поменяли — условие не ломается, запись с первого раза', async () => {
    const m = memory(brief());
    const db = fakeSnapshotDb(m.sessions, {
      beforeWrite: (n) => n === 1 && m.set({ sticker: null }),
    });
    await updateGreetingSnapshot(db, 's1', m.snapshot, () => ({
      set: { sceneCount: 2 },
      expect: ['tone'],
    }));
    expect(db.writes).toHaveLength(1);
    expect(m.snapshot).toEqual(brief({ sticker: null, sceneCount: 2 }));
  });

  it(`${MAX_SNAPSHOT_WRITE_ATTEMPTS} промаха подряд — 409 GREETING_EDIT_IN_PROGRESS, ничего не записано`, async () => {
    const m = memory(brief());
    let i = 0;
    const db = fakeSnapshotDb(m.sessions, {
      beforeWrite: () => m.set({ recipientName: `r${++i}` }),
    });
    const err = await updateGreetingSnapshot(db, 's1', m.snapshot, () => ({
      set: { sceneCount: 2 },
      expect: 'all',
    })).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'GREETING_EDIT_IN_PROGRESS' }),
    );
    expect(db.writes).toHaveLength(MAX_SNAPSHOT_WRITE_ATTEMPTS);
    expect(db.applied).toHaveLength(0);
    expect(m.snapshot.sceneCount).toBeUndefined();
  });

  it('отказ решения (политика) на повторе — отказ, а не запись', async () => {
    const m = memory(brief());
    const db = fakeSnapshotDb(m.sessions, {
      beforeWrite: (n) => n === 1 && m.set({ occasion: 'CONDOLENCE' }),
    });
    await expect(
      updateGreetingSnapshot(db, 's1', m.snapshot, (cur) => {
        if (cur.occasion === 'CONDOLENCE') throw new Error('политика');
        return { set: { sceneCount: 4 }, expect: GREETING_POLICY_KEYS };
      }),
    ).rejects.toThrow('политика');
    expect(db.applied).toHaveLength(0);
  });

  it('сессию удалили между попытками — 404', async () => {
    const m = memory(brief());
    const db = fakeSnapshotDb(m.sessions, {
      beforeWrite: () => {
        m.sessions.getSession.mockResolvedValue(null);
      },
    });
    await expect(
      updateGreetingSnapshot(db, 's1', m.snapshot, () => ({
        set: { sceneCount: 2 },
      })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
