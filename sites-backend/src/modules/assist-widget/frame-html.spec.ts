/**
 * HTML iframe и его CSP (ТЗ §4.12; приёмка Э2 5а — серверная часть):
 * статический шаблон без данных сайта, строгая CSP, frame-ancestors —
 * только допущенные origin, без инъекции директив.
 */
import { frameCsp, frameHtml, FRAME_ROOT_ID } from './frame-html';
import { frameAncestors, LOCAL_FRAME_ANCESTORS } from './origin-guard';

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name} `))
    ?.slice(name.length + 1);
}

describe('frameHtml', () => {
  it('статический шаблон: наш chat.js/css, корень W1, ни inline-скриптов, ни данных', () => {
    const html = frameHtml();
    expect(html).toContain('<script src="/v1/chat.js" defer></script>');
    expect(html).toContain('<link rel="stylesheet" href="/v1/chat.css">');
    expect(html).toContain(`<div id="${FRAME_ROOT_ID}"></div>`);
    expect(html).not.toMatch(/<script>|\son\w+=|\sstyle=/);
    expect(frameHtml()).toBe(html);
  });
});

describe('frameCsp', () => {
  it('строгая политика: self, без eval, Trusted Types без политик', () => {
    const csp = frameCsp('https://shop.example.com');
    expect(directive(csp, 'default-src')).toBe("'none'");
    expect(directive(csp, 'script-src')).toBe("'self'");
    expect(directive(csp, 'connect-src')).toBe("'self'");
    // Э5: звук озвучки — только из Blob-URL, никаких внешних источников.
    expect(directive(csp, 'media-src')).toBe('blob:');
    expect(directive(csp, 'img-src')).toBe("'self'");
    expect(directive(csp, 'base-uri')).toBe("'none'");
    expect(directive(csp, 'form-action')).toBe("'none'");
    expect(directive(csp, 'require-trusted-types-for')).toBe("'script'");
    expect(directive(csp, 'trusted-types')).toBe("'none'");
    expect(directive(csp, 'frame-ancestors')).toBe('https://shop.example.com');
    expect(csp).not.toMatch(/unsafe-|\*/);
  });

  it("инъекция директив через «origin» — отброшена; пусто — 'none'", () => {
    const csp = frameCsp(
      "https://a.com; script-src * 'unsafe-eval' https://b.com",
    );
    expect(directive(csp, 'frame-ancestors')).toBe('https://b.com');
    expect(csp.match(/script-src/g)).toHaveLength(1);
    expect(directive(frameCsp(''), 'frame-ancestors')).toBe("'none'");
    expect(directive(frameCsp('javascript:alert(1)'), 'frame-ancestors')).toBe(
      "'none'",
    );
    expect(directive(frameCsp("'none' https://a.com"), 'frame-ancestors')).toBe(
      "'none'",
    );
  });
});

describe('frameAncestors', () => {
  it('live: только точные origin; localhost у live-ключа не пропускается', () => {
    expect(
      frameAncestors({
        keyKind: 'live',
        allowedOrigins: [
          'https://shop.ua',
          'https://shop.ua/',
          'http://localhost:3000',
          'https://a.ua;x',
        ],
        preview: false,
        previewAncestors: ['https://web.telegram.org'],
      }),
    ).toBe('https://shop.ua');
    expect(
      frameAncestors({
        keyKind: 'live',
        allowedOrigins: [],
        preview: false,
        previewAncestors: [],
      }),
    ).toBe("'none'");
  });

  it('test: только localhost/127.0.0.1 любого порта; предпросмотр добавляет предков TMA', () => {
    expect(
      frameAncestors({
        keyKind: 'test',
        allowedOrigins: ['https://shop.ua'],
        preview: false,
        previewAncestors: [],
      }),
    ).toBe(LOCAL_FRAME_ANCESTORS.join(' '));
    expect(
      frameAncestors({
        keyKind: 'live',
        allowedOrigins: ['https://shop.ua'],
        preview: true,
        previewAncestors: ['https://web.telegram.org'],
      }),
    ).toBe('https://shop.ua https://web.telegram.org');
  });
});
