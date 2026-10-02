'use client';

import { useState } from 'react';
import { track } from '../lib/track';
import { assistCall, requestWidgetLoad } from '../lib/widget-loader';

const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
const THEMES = ['light', 'dark', 'auto'] as const;
type Corner = (typeof CORNERS)[number];
type Theme = (typeof THEMES)[number];

export interface PlaygroundStrings {
  heading: string;
  corner: string;
  corners: Record<Corner, string>;
  theme: string;
  themes: Record<Theme, string>;
  open: string;
  announce: string;
  note: string;
}

/**
 * Панель «Покрутите виджет» (§4.3, компактная — на главной Помощника):
 * угол — публичный `V4CAssist('position', …)`, тема — `V4CAssist('preview',
 * { brand: { theme } })` (работает только у сайта с `allowClientPreview`,
 * иначе виджет молча игнорирует), «Открыть помощника» — `V4CAssist('open')`.
 * Всё — только в этой вкладке; перезагрузка — исходный вид.
 */
export function WidgetPlayground({ strings: t }: { strings: PlaygroundStrings }) {
  const [corner, setCorner] = useState<Corner>('bottom-right');
  const [theme, setTheme] = useState<Theme>('auto');
  const [announce, setAnnounce] = useState('');
  const say = (label: string, value: string) => setAnnounce(t.announce.replace('{param}', label).replace('{value}', value));

  return (
    <div className="playground" data-testid="playground">
      <h3 className="playground-h">{t.heading}</h3>
      <fieldset className="cfg-group">
        <legend>{t.corner}</legend>
        <div className="cfg-options">
          {CORNERS.map((c) => (
            <label key={c} className="cfg-option">
              <input
                type="radio"
                name="pg-corner"
                value={c}
                checked={corner === c}
                onChange={() => {
                  setCorner(c);
                  requestWidgetLoad();
                  assistCall('position', c);
                  say(t.corner, t.corners[c]);
                  track('widget_corner_change', { corner: c, place: 'playground' });
                }}
              />
              <span>{t.corners[c]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="cfg-group">
        <legend>{t.theme}</legend>
        <div className="cfg-options">
          {THEMES.map((th) => (
            <label key={th} className="cfg-option">
              <input
                type="radio"
                name="pg-theme"
                value={th}
                checked={theme === th}
                onChange={() => {
                  setTheme(th);
                  requestWidgetLoad();
                  assistCall('preview', { brand: { theme: th } });
                  say(t.theme, t.themes[th]);
                  track('configurator_change', { param: 'theme', place: 'playground' });
                }}
              />
              <span>{t.themes[th]}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p>
        <button
          type="button"
          className="button"
          data-cta="playground"
          onClick={() => {
            requestWidgetLoad();
            assistCall('open');
          }}
        >
          {t.open}
        </button>
      </p>
      <p className="cfg-hint">{t.note}</p>
      <p className="sr-only" role="status" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
