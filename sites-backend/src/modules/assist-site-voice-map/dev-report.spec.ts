/**
 * Заход 9 (Э6-тер (9)): «отчёт для разработчика» — снимок по черновику
 * карты и страница только для чтения: строки разметки, запрет —
 * `data-assist="never"`, «Как отменить»; всё экранировано; ни скриптов,
 * ни подписей, которых владелец не давал.
 */
import { parseVoiceMapContent } from '../assist-ui-core/voice-map';
import {
  buildDevReport,
  DEV_REPORT_CSP,
  devReportHtml,
  devReportInvalidHtml,
  devReportLang,
} from './dev-report';

const content = parseVoiceMapContent({
  schemaVersion: 1,
  templates: [
    {
      id: 'tp',
      name: 'Товар',
      pathPattern: '/product/*',
      samplePages: ['/product/1'],
    },
  ],
  targets: [
    {
      key: 'buy',
      scope: 'template',
      templateId: 'tp',
      descriptor: {
        tag: 'button',
        role: 'button',
        text: 'Купити',
        css: 'form.cart > button',
        unique: true,
      },
      names: { uk: 'Купити' },
      semanticType: 'add-to-cart',
      undo: { assistId: 'remove-from-cart', at: null },
    },
    {
      key: 'reviews',
      scope: 'template',
      templateId: 'tp',
      descriptor: {
        tag: 'button',
        role: 'tab',
        text: 'Відгуки',
        assistId: 'reviews',
        unique: true,
      },
      names: { uk: 'Відгуки' },
    },
    {
      key: 'pay',
      scope: 'site',
      descriptor: {
        tag: 'button',
        role: 'button',
        text: 'Оплатити',
        unique: true,
      },
      denylisted: true,
    },
    {
      key: 'xss',
      scope: 'page',
      pagePath: '/a',
      descriptor: {
        tag: 'button',
        role: 'button',
        text: '<img src=x onerror=alert(1)>',
        unique: true,
      },
      names: { uk: 'Тест' },
    },
    {
      key: 'gone',
      scope: 'site',
      descriptor: {
        tag: 'button',
        role: 'button',
        text: 'Старе',
        unique: true,
      },
      status: 'removed',
    },
  ],
});

const report = buildDevReport(content, {
  host: 'shop.example.com',
  platform: 'woocommerce@1',
  draftRevision: 7,
  publishedVersion: 2,
  now: new Date('2026-10-09T10:00:00Z'),
});

describe('отчёт для разработчика (заход 9)', () => {
  it('снимок: группы (сайт → шаблон → страница), строка разметки, запрет — never, «Как отменить»; удалённые — нет', () => {
    expect(report.groups.map((g) => [g.kind, g.pattern ?? g.title])).toEqual([
      ['site', '*'],
      ['template', '/product/*'],
      ['page', '/a'],
    ]);
    const tpl = report.groups[1];
    // «Купити» без разметки — «никогда» по тексту (В-52): снимает именно
    // разметка — разработчику строка `data-assist-id`, не запрет.
    expect(tpl.items.find((i) => i.key === 'buy')).toMatchObject({
      line: 'data-assist-id="add-to-cart"',
      css: 'form.cart > button',
      undo: 'remove-from-cart',
      has: null,
    });
    expect(tpl.items.find((i) => i.key === 'reviews')).toMatchObject({
      line: null,
      has: 'data-assist-id="reviews"',
    });
    expect(report.groups[0].items[0]).toMatchObject({
      key: 'pay',
      line: 'data-assist="never"',
      denylisted: true,
    });
    expect(report.counts).toEqual({
      targets: 4,
      missing: 3,
      never: 1,
      fragile: 0,
    });
    expect(JSON.stringify(report)).not.toContain('Старе');
  });

  it('страница: всё экранировано, скриптов нет, CSP без скриптов и встраивания; язык; «недействительна» — одна', () => {
    // Подписи пикер чистит от `<>` ещё при разборе; страница всё равно
    // экранирует КАЖДОЕ поле — снимок в базе мог прийти из старой версии.
    const evil = {
      ...report,
      host: '<script>alert(1)</script>',
      groups: [
        {
          ...report.groups[1],
          title: '<img src=x onerror=alert(1)>',
          items: [
            {
              ...report.groups[1].items[0],
              key: '"><script>x()</script>',
              css: "a[href='x'] & b",
            },
          ],
        },
      ],
    };
    const bad = devReportHtml(evil, 'uk');
    expect(bad).not.toMatch(/<script/i);
    expect(bad).not.toContain('<img src=x');
    expect(bad).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(bad).toContain('a[href=&#39;x&#39;] &amp; b');
    const html = devReportHtml(report, 'uk');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('data-assist-id=&quot;add-to-cart&quot;');
    expect(html).toContain('WooCommerce');
    expect(devReportHtml(report, 'en')).toContain(
      'Voice map — developer report',
    );
    expect(devReportLang('ru')).toBe('ru');
    expect(devReportLang('<x>')).toBe('uk');
    expect(DEV_REPORT_CSP).toContain("default-src 'none'");
    expect(DEV_REPORT_CSP).toContain("frame-ancestors 'none'");
    expect(DEV_REPORT_CSP).not.toContain('script-src');
    expect(devReportInvalidHtml('uk')).toContain('недійсне');
  });

  it('аудит P2-1: пути страниц и образцы шаблона — маска ПД пути; подписи и имена — маска подписи (HTML и JSON)', () => {
    const pd = parseVoiceMapContent({
      schemaVersion: 1,
      templates: [
        {
          id: 'tu',
          name: 'Кабінет',
          pathPattern: '/u/*',
          samplePages: ['/u/ivan.petrenko@example.com/orders/123456789012'],
        },
      ],
      targets: [
        {
          key: 'orders',
          scope: 'page',
          pagePath: '/u/ivan.petrenko@example.com/orders/123456789012',
          descriptor: {
            tag: 'button',
            role: 'button',
            text: 'Замовлення',
            unique: true,
          },
          names: { uk: 'Замовлення' },
        },
        {
          key: 'repeat',
          scope: 'template',
          templateId: 'tu',
          descriptor: {
            tag: 'button',
            role: 'button',
            text: 'Повторити',
            unique: true,
          },
          names: { uk: 'Повторити' },
        },
      ],
    });
    const r = buildDevReport(pd, {
      host: 'shop.example.com',
      platform: null,
      draftRevision: 1,
      publishedVersion: 0,
      now: new Date('2026-10-09T10:00:00Z'),
    });
    const all = JSON.stringify(r) + devReportHtml(r, 'uk');
    expect(all).not.toContain('ivan.petrenko');
    expect(all).not.toContain('123456789012');
    expect(r.groups.map((g) => [g.kind, g.title, g.sample])).toEqual([
      ['template', 'Кабінет', '/u/:email/orders/:n'],
      ['page', '/u/:email/orders/:n', '/u/:email/orders/:n'],
    ]);
    // Черновик карты не тронут — маска только в снимке отчёта.
    expect(pd.targets[0].pagePath).toContain('ivan.petrenko');
  });
});
