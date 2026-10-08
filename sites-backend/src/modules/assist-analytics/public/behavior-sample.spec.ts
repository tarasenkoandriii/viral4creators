/**
 * Заход 9 (Р-З9-25): выборка поведения сверх квоты — детерминированно по
 * HMAC(секрет, сайт:pvId) (аудит P2-1), доля по расходу.
 */
import {
  BEHAVIOR_HARD_CAP_FACTOR,
  BEHAVIOR_OVER_QUOTA_SAMPLE_RATE,
  behaviorSampleRate,
  inBehaviorSample,
} from './ai-intake.service';

describe('выборка поведения сверх квоты', () => {
  it('доля: в квоте — 1, сверх — выборка, за потолком — 0; без квоты — 0', () => {
    expect(behaviorSampleRate(0, 100)).toBe(1);
    expect(behaviorSampleRate(99, 100)).toBe(1);
    expect(behaviorSampleRate(100, 100)).toBe(BEHAVIOR_OVER_QUOTA_SAMPLE_RATE);
    expect(behaviorSampleRate(100 * BEHAVIOR_HARD_CAP_FACTOR - 1, 100)).toBe(
      BEHAVIOR_OVER_QUOTA_SAMPLE_RATE,
    );
    expect(behaviorSampleRate(100 * BEHAVIOR_HARD_CAP_FACTOR, 100)).toBe(0);
    expect(behaviorSampleRate(0, 0)).toBe(0);
  });

  it('pvId: решение стабильно, доля близка к заданной, rate = 1 — все, 0 — никто', () => {
    const ids = Array.from(
      { length: 20_000 },
      (_, i) => `pv${i.toString(36)}x${(i * 7919).toString(36)}`,
    );
    const hit = ids.filter((id) => inBehaviorSample('site1', id, 0.1, 'k'));
    expect(hit.length / ids.length).toBeGreaterThan(0.08);
    expect(hit.length / ids.length).toBeLessThan(0.12);
    for (const id of hit.slice(0, 50))
      expect(inBehaviorSample('site1', id, 0.1, 'k')).toBe(true);
    expect(ids.every((id) => inBehaviorSample('site1', id, 1, 'k'))).toBe(true);
    expect(ids.some((id) => inBehaviorSample('site1', id, 0, 'k'))).toBe(false);
  });

  it('аудит P2-1: решение — по секрету платформы и сайту (pvId «в выборку» не подобрать)', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `pvaudit${i}`);
    const pick = (site: string, secret: string) =>
      ids.filter((id) => inBehaviorSample(site, id, 0.1, secret)).join(',');
    // Другой секрет — другая выборка: без секрета сервера её не предсказать.
    expect(pick('site1', 'secret-a')).not.toBe(pick('site1', 'secret-b'));
    // Тот же pvId на другом сайте — независимое решение.
    expect(pick('site1', 'secret-a')).not.toBe(pick('site2', 'secret-a'));
  });
});
