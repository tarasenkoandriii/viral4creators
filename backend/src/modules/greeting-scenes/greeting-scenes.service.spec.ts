/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GreetingScenesService } from './greeting-scenes.service';
import { MAX_GREETING_SCENES } from '../../common/greeting-scenes';
import type { SessionService } from '../../common/session.service';
import { fakeSnapshotDb } from '../../../test/fake-greeting-snapshot-db';

function build(
  snapshot: Record<string, unknown> | null = {},
  opts: {
    beforeWrite?: (
      attempt: number,
      set: (patch: Record<string, unknown>) => void,
    ) => void;
  } = {},
) {
  let current: Record<string, unknown> | null =
    snapshot === null ? null : { occasion: 'BIRTHDAY', ...snapshot };
  // «Параллельная» правка снимка из другого запроса — мимо сервиса.
  const set = (patch: Record<string, unknown>) => {
    current = { ...current, ...patch };
  };
  const updateSession = jest
    .fn()
    .mockImplementation((_id: string, patch: Record<string, any>) => {
      current = patch.greetingBriefSnapshot;
      return Promise.resolve(undefined);
    });
  const sessions = {
    getSession: jest
      .fn()
      .mockImplementation(() =>
        Promise.resolve({ sessionId: 's1', greetingBriefSnapshot: current }),
      ),
    updateSession,
  };
  const svc = new GreetingScenesService(
    sessions as unknown as SessionService,
    fakeSnapshotDb(sessions, {
      beforeWrite: (n) => opts.beforeWrite?.(n, set),
    }) as any,
  );
  return { svc, updateSession, snapshotNow: () => current };
}

describe('GreetingScenesService (фича №7)', () => {
  it('по умолчанию одна сцена — прежнее поведение', async () => {
    const view = await build().svc.get('s1');
    expect(view.sceneCount).toBe(1);
    expect(view.durations).toEqual([15]);
  });

  it('показывает, по скольку секунд выйдут сцены', async () => {
    // Человек выбирает число сцен и вправе видеть последствие выбора.
    const view = await build().svc.setCount('s1', 3);
    expect(view.durations).toEqual([5, 5, 5]);
    expect(view.durations.reduce((a, b) => a + b, 0)).toBe(15);
  });

  it('число сцен зажимается в границы', async () => {
    const { svc } = build();
    expect((await svc.setCount('s1', 99)).sceneCount).toBe(MAX_GREETING_SCENES);
    expect((await svc.setCount('s1', 0)).sceneCount).toBe(1);
  });

  it('чужой выбор голоса не трогается ни при каком числе сцен', async () => {
    // Ограничений совместимости у фичи нет: сцены описываются одним
    // промптом, и голос — свой ли, пресетный ли — звучит один раз на
    // весь ролик, сколько бы в нём ни было склеек.
    const senderVoice = { userVoiceId: 'u', resembleVoiceId: 'c', label: 'L' };
    const { svc, snapshotNow } = build({ presetVoiceId: 'eve', senderVoice });
    for (const n of [3, 1, 4]) {
      await svc.setCount('s1', n);
      expect(snapshotNow()?.presetVoiceId).toBe('eve');
      expect(snapshotNow()?.senderVoice).toEqual(senderVoice);
    }
  });

  it('не поздравительная сессия — 404', async () => {
    const { svc } = build(null);
    await expect(svc.get('s1')).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * Этап B (Г-2 ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md):
   * потолок сцен — по регистру повода. Траурному ролику нарезка из
   * четырёх склеек не подходит; отказ, а не тихое урезание.
   */
  it('соболезнование: не больше двух сцен, и экран это знает', async () => {
    const { svc } = build({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' });
    expect((await svc.get('s1')).maxScenes).toBe(2);
    expect((await svc.setCount('s1', 2)).sceneCount).toBe(2);
    await expect(svc.setCount('s1', 3)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('«Особый повод» в траурном регистре — тот же потолок', async () => {
    const { svc } = build({
      occasion: 'OTHER',
      occasionRegister: 'MOURNING',
      tone: 'RESPECTFUL',
    });
    await expect(svc.setCount('s1', 4)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

describe('GreetingScenesService — C2: запись снимка без потери правок', () => {
  it('пишется только sceneCount — наклейка и карточки, сохранённые параллельно, остаются', async () => {
    const sticker = {
      id: 'st_1',
      url: 'u',
      pathname: 'p',
      placement: 'center',
    };
    const { svc, snapshotNow } = build(
      {},
      {
        beforeWrite: (n, set) =>
          n === 1 &&
          set({ sticker, cards: { title: 'Марине', closing: null } }),
      },
    );
    await svc.setCount('s1', 3);
    expect(snapshotNow()).toEqual(
      expect.objectContaining({
        sceneCount: 3,
        sticker,
        cards: { title: 'Марине', closing: null },
      }),
    );
  });

  it('повод сменили на траурный между чтением и записью — проверка по свежему снимку, 400', async () => {
    const { svc, snapshotNow } = build(
      {},
      {
        beforeWrite: (n, set) =>
          n === 1 && set({ occasion: 'CONDOLENCE', tone: 'RESPECTFUL' }),
      },
    );
    await expect(svc.setCount('s1', 4)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(snapshotNow()?.sceneCount).toBeUndefined();
  });

  it('смена только наклейки (не повода) условия не ломает — запись с первого раза', async () => {
    const { svc, snapshotNow } = build(
      {},
      { beforeWrite: (n, set) => n === 1 && set({ sticker: null }) },
    );
    await svc.setCount('s1', 2);
    expect(snapshotNow()?.sceneCount).toBe(2);
  });
});
