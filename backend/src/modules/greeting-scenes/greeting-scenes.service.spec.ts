/* eslint-disable @typescript-eslint/no-explicit-any -- test doubles */
jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GreetingScenesService } from './greeting-scenes.service';
import { MAX_GREETING_SCENES } from '../../common/greeting-scenes';
import type { SessionService } from '../../common/session.service';

function build(snapshot: Record<string, unknown> | null = {}) {
  let current: Record<string, unknown> | null =
    snapshot === null ? null : { occasion: 'BIRTHDAY', ...snapshot };
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
  const svc = new GreetingScenesService(sessions as unknown as SessionService);
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
