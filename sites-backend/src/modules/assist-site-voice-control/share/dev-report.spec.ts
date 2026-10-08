/**
 * Заход 9, Р-З9-9: «отчёт для разработчика» — срез отчёта мастера без ПД и
 * HTML без скриптов. Мутанты: в срез попадают команды/запреты/окружение;
 * подпись из страницы выводится без экранирования; страница ссылки (GET)
 * показывает содержимое отчёта; CSP разрешает скрипты.
 */
import type { WizardReport } from '../api-types';
import {
  DEV_REPORT_CSP,
  devReportGone,
  devReportHtml,
  devReportLanding,
  devReportOf,
  esc,
} from './dev-report';

const report = (): WizardReport =>
  ({
    v: 1,
    lang: 'en',
    page: '/checkout-help',
    host: 'shop.example.com',
    testHost: false,
    result: 'partial',
    items: [
      { step: 3, level: 'fail', code: 'suspicious_unreviewed', data: { n: 1 } },
      { step: 4, level: 'fail', code: 'dry_low', data: { ok: 1, need: 3 } },
    ],
    env: {
      widget: true,
      chunks: true,
      csp: 2,
      tt: 0,
      micPolicy: 'allowed',
      release: 'r1',
    },
    mic: 'ok',
    markup: {
      total: 10,
      withId: 2,
      unnamed: [{ key: 'u1', tag: 'button', selector: 'form#o > button' }],
      closedShadow: 1,
      extIframes: 0,
      duplicates: [{ name: 'Buy', count: 2 }],
      denied: 0,
    },
    never: [
      { ref: 'e3', text: '<img src=x onerror=alert(1)>', reason: 'payment' },
    ],
    suspicious: [
      {
        key: 's1',
        why: 'icon_trash',
        tag: 'button',
        label: '',
        selector: 'button.trash',
      },
      {
        key: 's2',
        why: 'class_delete',
        tag: 'a',
        label: 'x',
        selector: 'a.rm',
      },
    ],
    reviewed: { s1: 'deny' },
    denySuggestions: ['button.trash'],
    dry: [
      {
        planId: 'plan-1',
        command: 'call me at +380501234567',
        steps: 2,
        ok: 1,
      },
    ],
    safe: [
      {
        planId: 'plan-2',
        command: 'open delivery',
        status: 'done',
        done: true,
      },
    ],
    forbidden: [
      {
        kind: 'pay',
        command: 'pay',
        candidates: 1,
        blocked: true,
        reasons: ['payment'],
        targets: ['Pay 100 UAH'],
      },
    ],
    fragment: '<button data-assist-id="add-to-cart">…</button>',
    undo: {
      pairs: 1,
      unresolved: [
        { text: 'To cart', reverse: 'remove-from-cart', problem: 'no_row' },
        {
          text: 'Call +380501234567',
          reverse: 'remove-from-cart',
          problem: 'zone',
        },
      ],
    },
  }) as unknown as WizardReport;

describe('«отчёт для разработчика» (заход 9, Р-З9-9)', () => {
  it('срез: коды, разметка, списки и решения владельца; без команд, запретов, окружения и id планов', () => {
    const d = devReportOf(report(), {
      src: 't1',
      reportedAt: new Date('2026-10-08T10:00:00Z'),
    });
    expect(d).toMatchObject({
      lang: 'en',
      result: 'partial',
      page: '/checkout-help',
      denySuggestions: ['button.trash'],
    });
    expect(d.undo[0]).toEqual({
      text: 'To cart',
      reverse: 'remove-from-cart',
      problem: 'no_row',
    });
    expect(d.suspicious.map((s) => s.decision)).toEqual(['deny', null]);
    // P3-1: текст обратной цели — маской.
    expect(d.undo[1].text).not.toContain('380501234567');
    expect(d.items[1]).toEqual({
      step: 4,
      level: 'fail',
      code: 'dry_low',
      data: { ok: 1, need: 3 },
    });
    const all = JSON.stringify(d);
    for (const leak of [
      '380501234567',
      'open delivery',
      'plan-1',
      'plan-2',
      'Pay 100',
      'micPolicy',
      '"r1"',
    ])
      expect(all).not.toContain(leak);
  });

  it('HTML: всё со страницы — экранировано, скриптов нет; GET — только кнопка; недействительная — одна страница', () => {
    const d = devReportOf(report(), { src: 't1', reportedAt: null });
    const html = devReportHtml(d);
    expect(html).not.toMatch(/<script|<img/i);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('form#o &gt; button');
    expect(html).toContain(
      '&lt;button data-assist-id=&quot;add-to-cart&quot;&gt;',
    );
    expect(html).not.toContain('t1');
    expect(html).toContain('lang="en"');
    const landing = devReportLanding('tok_ABCDEFGHIJKLMNOPQRSTUV', 'ru');
    expect(landing).toContain(
      'action="/w/v1/vc-report/tok_ABCDEFGHIJKLMNOPQRSTUV"',
    );
    expect(landing).toContain('Открыть отчёт');
    expect(landing).not.toContain('button.trash');
    expect(devReportGone('xx')).toContain('lang="uk"');
    expect(esc(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;');
    expect(DEV_REPORT_CSP).toContain("default-src 'none'");
    expect(DEV_REPORT_CSP).not.toMatch(/script-src|unsafe-eval/);
    expect(DEV_REPORT_CSP).toContain("frame-ancestors 'none'");
  });
});
