/**
 * Протокол очереди воркера (Э-С Ш3) — тот же модуль, что копия у воркера
 * (scripts/sync-worker-shared.mjs): параметры без секретов (строгие
 * ключи), замок хостов, результат только на хостах замка, коды — из
 * закрытого списка, повтор — по коду.
 */
import {
  ProtocolError,
  RETRYABLE_ERRORS,
  isWorkerErrorCode,
  lockedUrl,
  parseJobParams,
  parseJobResult,
} from './protocol';
import { retryDelayMs } from './browser-job-rules';

describe('протокол очереди браузерного воркера', () => {
  const snap = {
    url: 'https://shop.example.com/',
    allowedHosts: ['shop.example.com'],
    viewport: 'mobile',
    screenshot: true,
    mapElements: false,
  };

  it('параметры: лишний ключ (секрет) — отказ; замок — только имена, без IP', () => {
    expect(() =>
      parseJobParams('ui-snapshot', { ...snap, cookies: 'x' }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('ui-snapshot', {
        ...snap,
        allowedHosts: ['169.254.169.254'],
      }),
    ).toThrow(/allowedHosts/);
    expect(() =>
      parseJobParams('ui-snapshot', { ...snap, url: 'file:///etc/passwd' }),
    ).toThrow(/scheme/);
    expect(() =>
      parseJobParams('ui-snapshot', {
        ...snap,
        url: 'https://evil.example.com/',
      }),
    ).toThrow(/url.host/);
    expect(parseJobParams('ui-snapshot', snap)).toEqual(snap);
  });

  it('замок учитывает нестандартный порт; фрагмент срезается', () => {
    expect(
      lockedUrl('https://shop.example.com:8443/a#x', ['shop.example.com:8443']),
    ).toBe('https://shop.example.com:8443/a');
    expect(() =>
      lockedUrl('https://shop.example.com:8443/a', ['shop.example.com']),
    ).toThrow(ProtocolError);
  });

  it('результат: элементы сверх лимита и адрес вне замка — отказ', () => {
    const p = parseJobParams('ui-snapshot', snap);
    const res = (elements: unknown[], url = 'https://shop.example.com/') => ({
      finalUrl: url,
      snapshot: { url, title: '', elements },
      mapElements: [],
      screenshot: null,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
    });
    expect(() =>
      parseJobResult('ui-snapshot', p, res([], 'https://evil.example.com/')),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobResult('ui-snapshot', p, res(new Array(151).fill({}))),
    ).toThrow(/elements/);
    expect(parseJobResult('ui-snapshot', p, res([]))).toMatchObject({
      screenshot: null,
    });
  });

  it('аудит Ш3: ссылка элемента снимка — только http(s), origin + путь', () => {
    const p = parseJobParams('ui-snapshot', snap);
    const el = (href: unknown) => ({
      ref: 'e1',
      role: 'link',
      tag: 'a',
      text: 'Каталог',
      hiddenLabel: null,
      assistId: null,
      inputType: null,
      href,
      disabled: false,
      checked: null,
      selected: null,
      options: [],
      heading: null,
      submit: false,
      inForm: false,
      confirmZone: false,
      pd: false,
      toggle: false,
      gesture: null,
      inView: true,
      box: null,
    });
    const res = (href: unknown) => ({
      finalUrl: 'https://shop.example.com/',
      snapshot: {
        url: 'https://shop.example.com/',
        title: '',
        elements: [el(href)],
      },
      mapElements: [],
      screenshot: null,
      viewport: { width: 390, height: 844 },
      blockedRequests: 0,
    });
    for (const bad of [
      'javascript:alert(document.cookie)',
      'data:text/html,<script>alert(1)</script>',
      'https://user:pw@shop.example.com/',
      'не адрес',
    ]) {
      expect(() => parseJobResult('ui-snapshot', p, res(bad))).toThrow(
        /elements\.0\.href/,
      );
    }
    const ok = parseJobResult(
      'ui-snapshot',
      p,
      res('https://other.example.com/catalog?utm=1#x'),
    ) as { snapshot: { elements: Array<{ href: string | null }> } };
    expect(ok.snapshot.elements[0].href).toBe(
      'https://other.example.com/catalog',
    );
  });

  it('коды ошибок — закрытый список; повтор только у временных; пауза растёт и ограничена', () => {
    expect(isWorkerErrorCode('egress_blocked')).toBe(true);
    expect(isWorkerErrorCode('ECONNRESET at 10.0.0.1')).toBe(false);
    expect(RETRYABLE_ERRORS.has('nav_timeout')).toBe(true);
    expect(RETRYABLE_ERRORS.has('login_failed')).toBe(false);
    expect(RETRYABLE_ERRORS.has('egress_blocked')).toBe(false);
    // Потолок трафика (Ш3-хвост (9)) — причина есть, повтора нет.
    expect(isWorkerErrorCode('traffic_limit')).toBe(true);
    expect(RETRYABLE_ERRORS.has('traffic_limit')).toBe(false);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000]);
    expect(retryDelayMs(20)).toBe(10 * 60_000);
    // Раунд обучалки (Ш3-хвост (3)): отказ стоп-листа и «нет цели» — без
    // повтора (повтор нажал бы кнопку второй раз).
    expect(isWorkerErrorCode('click_refused')).toBe(true);
    expect(RETRYABLE_ERRORS.has('click_refused')).toBe(false);
    expect(RETRYABLE_ERRORS.has('target_missing')).toBe(false);
  });

  it('tutorial-explore: ≤ 1 клик CSS, ввод — только конвертами; сессия — конвертом; ≤ 4 хоста замка', () => {
    const p = {
      url: 'https://shop.example.com/cart',
      allowedHosts: ['shop.example.com', 'www.example.com'],
      allowedOrigin: 'https://www.example.com',
      viewport: 'mobile',
      clicks: ['a[aria-label="Кошик"]'],
      fills: [],
      replay: null,
      login: null,
      session: null,
      replyKey: 'k'.repeat(43),
      nonce: 'n'.repeat(22),
      videoFrame: false,
    };
    expect(parseJobParams('tutorial-explore', p)).toEqual(p);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, actions: [] }),
    ).toThrow(ProtocolError);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, clicks: ['text=Купити'] }),
    ).toThrow(/clicks/);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, session: 'sid=1' }),
    ).toThrow(/session/);
    expect(() =>
      parseJobParams('tutorial-explore', { ...p, replyKey: 'short' }),
    ).toThrow(/replyKey/);
    expect(() =>
      parseJobParams('tutorial-explore', {
        ...p,
        allowedHosts: [
          ...p.allowedHosts,
          'm.example.com',
          'a.example.com',
          'b.example.com',
        ],
      }),
    ).toThrow(/allowedHosts/);
    const r = parseJobResult(
      'tutorial-explore',
      parseJobParams('tutorial-explore', p),
      {
        currentUrl: 'https://www.example.com/cart?id=5#x',
        elements: [],
        looksLikeLogin: true,
        screenshot: 0,
        videoFrame: null,
        reply: null,
        sensitiveFill: false,
        autoLogin: null,
      },
    ) as { currentUrl: string };
    // Аудит захода 7: query (ПД) — только в конверте ответа.
    expect(r.currentUrl).toBe('https://www.example.com/cart');
  });

  it('frames-capture: `image` — jpeg | png2x, старые параметры без него — как раньше', () => {
    const f = {
      url: 'https://shop.example.com/',
      allowedHosts: ['shop.example.com'],
      viewport: 'mobile',
      frames: 2,
    };
    expect(parseJobParams('frames-capture', f)).toEqual(f);
    expect(
      parseJobParams('frames-capture', { ...f, image: 'png2x' }),
    ).toMatchObject({ image: 'png2x' });
    expect(() =>
      parseJobParams('frames-capture', { ...f, image: 'webp' }),
    ).toThrow(/image/);
  });
});
