/**
 * №29: разбор итога Т-3 в отчёт `autotest` — цели карты и контрольные
 * команды (цель первого шага), доля потерянного → pass/partial/fail;
 * страницы не открылись — результата нет (сайт не виноват).
 */
import type { UiSnapElement } from '../../assist-ui-core/types';
import {
  autotestFailedReport,
  autotestReport,
  type AutotestOutcome,
} from './voice-monitor-autotest';

const el = (text: string, assistId: string | null = null) =>
  ({
    ref: 'e1',
    role: 'button',
    tag: 'button',
    text,
    assistId,
  }) as unknown as UiSnapElement;

const cmd = (
  id: string,
  text: string | null,
  assistId: string | null = null,
) => ({
  id,
  pagePath: '/',
  expected: [{ kind: 'click', role: 'button', text, assistId }],
});

const outcome = (
  elements: UiSnapElement[],
  map: AutotestOutcome['map'] = null,
  ok = true,
): AutotestOutcome => ({
  pages: [{ path: '/', ok, error: ok ? null : 'nav_failed' }],
  snapshots: ok
    ? [
        {
          path: '/',
          snapshot: { url: 'https://s.example.com/', title: '', elements },
        },
      ]
    : [],
  map,
});

describe('отчёт Т-3 по расписанию (voice-monitor-autotest)', () => {
  it('команды: по разметке и по видимому тексту; неоднозначное — потеряно; без цели — не проверено', () => {
    const { report, commands } = autotestReport(
      [
        cmd('a', 'Купити'),
        cmd('b', null, 'cart'),
        cmd('c', 'Двічі'),
        cmd('d', null),
      ],
      outcome([el('Купити'), el('Кошик', 'cart'), el('Двічі'), el('Двічі')]),
    );
    expect(commands.map((c) => c.status)).toEqual([
      'found',
      'found',
      'lost',
      'unchecked',
    ]);
    expect(report.result).toBe('partial');
    expect(report.autotest).toMatchObject({ checked: 3, lost: 1, error: null });
  });

  it('цели карты считаются вместе с командами; ≥ половины потеряно — fail', () => {
    const map = {
      version: 3,
      targets: [
        { key: 't1', lost: true, stability: 'fragile' },
        { key: 't2', lost: true, stability: 'medium' },
        { key: 't3', lost: false, stability: 'strong' },
      ],
      lost: 2,
      fragile: 1,
    };
    const { report } = autotestReport(
      [cmd('a', 'Купити')],
      outcome([el('Купити')], map),
    );
    expect(report.autotest).toMatchObject({
      version: 3,
      checked: 4,
      lost: 2,
      lostTargets: ['t1', 't2'],
      fragileTargets: 1,
    });
    expect(report.result).toBe('fail');
    const none = autotestReport([cmd('a', 'Купити')], outcome([el('Купити')]));
    expect(none.report.result).toBe('pass');
  });

  it('страницы не открылись — результата нет; нечего проверять — тоже', () => {
    const down = autotestReport([cmd('a', 'Купити')], outcome([], null, false));
    expect(down.report.result).toBeNull();
    expect(down.report.autotest.error).toBe('pages_failed');
    const empty = autotestReport([], outcome([el('x')]));
    expect(empty.report.result).toBeNull();
    expect(empty.report.autotest.error).toBe('nothing_checked');
  });

  it('отказ воркера — отчёт без результата, код — только из безопасного набора символов', () => {
    expect(autotestFailedReport('nav_timeout').autotest.error).toBe(
      'nav_timeout',
    );
    expect(autotestFailedReport('<script>').autotest.error).toBe('internal');
    expect(autotestFailedReport('x').result).toBeNull();
  });
});
