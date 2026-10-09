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
  utteranceMasked: `команда ${id}`,
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
    // Заход 11: фраза команды — в отчёте (TMA показывает, что потерялось).
    expect(report.autotest.commands.map((c) => c.text)).toEqual([
      'команда a',
      'команда b',
      'команда c',
      'команда d',
    ]);
  });

  it('заход 11: фраза команды в отчёте — не длиннее 120 символов; нет фразы — пустая строка', () => {
    const long = { ...cmd('a', 'Купити'), utteranceMasked: 'ж'.repeat(300) };
    const bare = { id: 'b', pagePath: '/', expected: [] };
    const { commands } = autotestReport([long, bare], outcome([el('Купити')]));
    expect(commands[0].text).toBe(`${'ж'.repeat(119)}…`);
    expect(commands[1]).toEqual({
      id: 'b',
      path: '/',
      text: '',
      status: 'unchecked',
    });
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
      lostTargetsTotal: 2,
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

  it('аудит з11 P2-1: фраза — второй слой маски (карта с двойными пробелами, телефон, e-mail), без управляющих символов; обрезка не режет метку маски', () => {
    const { commands } = autotestReport(
      [
        {
          ...cmd('a', 'Купити'),
          utteranceMasked: 'оплати картою 4111  1111  1111  1111',
        },
        {
          ...cmd('b', 'Купити'),
          utteranceMasked: 'передзвоніть на +380 (50) 123-45-67',
        },
        {
          ...cmd('c', 'Купити'),
          utteranceMasked: 'лист на ivan@shop.ua\u202eкошик',
        },
        {
          ...cmd('d', 'Купити'),
          utteranceMasked: `${'а'.repeat(115)} 4111 1111 1111 1111`,
        },
      ],
      outcome([el('Купити')]),
    );
    expect(commands[0].text).toBe('оплати картою [№]');
    expect(commands[0].text).not.toMatch(/\d{4}/);
    expect(commands[1].text).not.toMatch(/\d{3}/);
    expect(commands[1].text).toMatch(/^передзвоніть на \[/);
    expect(commands[2].text).not.toContain('ivan@shop.ua');
    expect(commands[2].text).not.toMatch(/\u202e/);
    // Метка маски не влезает целиком — отрезается вся, без «[№» на конце.
    expect(commands[3].text.length).toBeLessThanOrEqual(120);
    expect(commands[3].text).toBe(`${'а'.repeat(115)}…`);
  });

  it('отказ воркера — отчёт без результата, код — только из безопасного набора символов', () => {
    expect(autotestFailedReport('nav_timeout').autotest.error).toBe(
      'nav_timeout',
    );
    expect(autotestFailedReport('<script>').autotest.error).toBe('internal');
    expect(autotestFailedReport('x').result).toBeNull();
  });
});
