'use client';

import { useEffect } from 'react';

/**
 * Э-С Ш5: консультант лендинга — виджет платформы (тенант «viral4creators»
 * в sites-backend) вместо `AssistantWidget`, когда так решил переключатель
 * сборки (`lib/assist-widget.ts`). Та же одна строка, что у заказчиков:
 * `<script async src="…/loader.js" data-site="pk_…">`.
 *
 * Бюджет страницы: сам компонент — несколько строк без зависимостей, а
 * загрузчик вставляется ПОЗЖЕ первой отрисовки — после `load` +
 * `requestIdleCallback` или по первому взаимодействию, что раньше (тот же
 * приём, что у `sites-landing/src/lib/widget-loader.ts`). Чат (iframe)
 * загрузчик создаёт сам только по клику. До загрузки вызовы `V4CAssist(…)`
 * копятся в очереди `V4CAssist.q` — её читает загрузчик при старте.
 *
 * Кнопки «Спросить об этом шаге» (`data-assistant-ask-step` в HowItWorks)
 * работают и здесь: вопрос уходит в виджет командой `ask`.
 */

type Stub = ((...args: unknown[]) => void) & { q?: unknown[] };

/** Имя глобала загрузчика (`WIDGET_GLOBAL` в brand.ts виджета). */
const GLOBAL = 'V4CAssist';
const MARK = 'data-v4c-landing';
const INTERACTION = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'] as const;

function stub(): Stub {
  const w = window as unknown as Record<string, Stub | undefined>;
  const existing = w[GLOBAL];
  if (existing) return existing;
  const s: Stub = function (...args: unknown[]) {
    (s.q = s.q || []).push(args);
  };
  w[GLOBAL] = s;
  return s;
}

function inject(src: string, siteKey: string, lang: string | null): void {
  if (document.querySelector(`script[${MARK}]`)) return;
  stub();
  const s = document.createElement('script');
  s.async = true;
  s.src = src;
  s.setAttribute('data-site', siteKey);
  if (lang) s.setAttribute('data-lang', lang);
  s.setAttribute(MARK, '');
  document.body.appendChild(s);
}

/** Первое из: взаимодействие, idle после `load`. Возвращает отмену. */
function schedule(start: () => void): () => void {
  let done = false;
  let idle: number | null = null;
  let timer: number | null = null;
  const w = window as unknown as {
    requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    cancelIdleCallback?: (h: number) => void;
  };
  const cancel = () => {
    for (const e of INTERACTION) window.removeEventListener(e, fire, true);
    window.removeEventListener('load', onLoad);
    if (idle !== null && w.cancelIdleCallback) w.cancelIdleCallback(idle);
    if (timer !== null) window.clearTimeout(timer);
  };
  function fire() {
    if (done) return;
    done = true;
    cancel();
    start();
  }
  function onLoad() {
    if (w.requestIdleCallback) idle = w.requestIdleCallback(fire, { timeout: 4000 });
    else timer = window.setTimeout(fire, 2000);
  }
  for (const e of INTERACTION) window.addEventListener(e, fire, { capture: true, passive: true });
  if (document.readyState === 'complete') onLoad();
  else window.addEventListener('load', onLoad, { once: true });
  return () => {
    done = true;
    cancel();
  };
}

export function PlatformAssist({
  src,
  siteKey,
  lang,
  askPrefill,
}: {
  src: string;
  siteKey: string;
  /** `data-lang` загрузчику — только uk/ru/en (иначе язык страницы/браузера). */
  lang: string | null;
  /** Шаблон вопроса о шаге: `{{title}}` — название шага. */
  askPrefill: string;
}) {
  useEffect(() => schedule(() => inject(src, siteKey, lang)), [src, siteKey, lang]);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-assistant-ask-step]');
      if (!el) return;
      e.preventDefault();
      const title = el.getAttribute('data-assistant-step-title') ?? '';
      inject(src, siteKey, lang);
      // Функция-замена: `$&`/`$'` в названии шага — текст, не шаблон.
      stub()('ask', askPrefill.replace('{{title}}', () => title).slice(0, 500));
    }
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [src, siteKey, lang, askPrefill]);

  // Маркер для CSS: `body:not(:has(.assistant-widget)) .step-ask-btn`
  // прячет кнопки «Спросить об этом шаге», когда консультанта нет. Здесь он
  // есть (виджет платформы), и маркер — уже в серверной разметке: кнопки
  // видны сразу, без сдвига вёрстки после загрузки.
  return <span className="assistant-widget" hidden aria-hidden="true" />;
}
