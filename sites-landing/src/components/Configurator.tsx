'use client';

import { useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react';
import { track } from '../lib/track';
import { assistCall } from '../lib/widget-loader';
import {
  COLOR_PRESETS,
  DRAFT_MAX_BYTES,
  FONTS_AVAILABLE,
  ICONS,
  MOBILE_MODES,
  POSITIONS,
  PRESETS,
  TEXT_LIMITS,
  THEMES,
  UI_LANGS,
  cleanLine,
  defaultDraft,
  draftBytes,
  enforceContrast,
  installSnippet,
  logoProblem,
  normalizeHex,
  parseDraftResponse,
  previewPatch,
  serializeDraft,
  sniffRaster,
  themeColors,
  tmaDraftLink,
  type DraftConfig,
  type DraftResult,
  type Icon,
  type Position,
  type UiLang,
} from '../lib/widget-draft';
import type { Dictionary } from '../lib/get-dictionary';

/** Строки конфигуратора — из словаря, `{brand}` уже подставлен сервером. */
export type ConfiguratorStrings = Dictionary['widgetPage']['configurator'];

export interface ConfiguratorProps {
  strings: ConfiguratorStrings;
  locale: UiLang;
  /** Приветствия по умолчанию (языки виджета) — показываются, пока текст не правили. */
  defaultGreetings: Record<UiLang, string>;
  defaultName: string;
  loaderSrc: string;
  anchor: string;
  draftsEndpoint: string;
  /** Имя бота кабинета; нет — нет «Сохранить и подключить» (§7.1). */
  botUsername: string | null;
  /** Живой виджет на этой странице — `V4CAssist('preview')` показывает настройки на нём. */
  liveWidget: boolean;
}

type Device = 'desktop' | 'phone';
type Surface = 'light' | 'dark';
type Backdrop = 'shop' | 'saas' | 'blog';
const BACKDROPS: readonly Backdrop[] = ['shop', 'saas', 'blog'];

const ICON_PATHS: Record<Icon | 'close' | 'send', string> = {
  chat: 'M4 3h16a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 4v-4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  question:
    'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2v2zm2.1-7.8-.9.9c-.8.8-1.2 1.4-1.2 2.9h-2v-.5c0-1.1.4-2.1 1.2-2.9l1.2-1.3A2 2 0 1 0 10 8H8a4 4 0 1 1 7.1 2.2z',
  headset: 'M12 2a9 9 0 0 0-9 9v6a3 3 0 0 0 3 3h2v-8H5v-1a7 7 0 0 1 14 0v1h-3v8h2a3 3 0 0 0 3-3v-6a9 9 0 0 0-9-9z',
  close: 'M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z',
  send: 'M2 21 23 12 2 3v7l15 2-15 2z',
};

function Svg({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={d} />
    </svg>
  );
}

function sub(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z]+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

function Radio<T extends string>({
  name,
  legend,
  options,
  value,
  labels,
  onChange,
  render,
}: {
  name: string;
  legend: string;
  options: readonly T[];
  value: T;
  labels: Record<T, string>;
  onChange: (v: T) => void;
  render?: (v: T) => ReactNode;
}) {
  return (
    <fieldset className="cfg-group">
      <legend>{legend}</legend>
      <div className="cfg-options">
        {options.map((o) => (
          <label key={o} className="cfg-option">
            <input type="radio" name={name} value={o} checked={value === o} onChange={() => onChange(o)} />
            {render ? render(o) : null}
            <span>{labels[o]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Конфигуратор-превью без регистрации (§5). Ничего не уходит на сервер,
 * кроме черновика по кнопке «Сохранить и подключить» (§5.3); логотип —
 * только `blob:` в этом браузере. Предпросмотр — безопасный макет нашим
 * DOM (подпись «макет»); если на странице живой виджет — те же настройки
 * применяются к нему через `V4CAssist('preview')` (только эта вкладка).
 */
export function Configurator(props: ConfiguratorProps) {
  const t = props.strings;
  const [cfg, setCfg] = useState<DraftConfig>(() => defaultDraft(props.defaultName));
  const [hexInput, setHexInput] = useState<string>(COLOR_PRESETS[0]);
  const [textHex, setTextHex] = useState<string>('#FFFFFF');
  const [textsLang, setTextsLang] = useState<UiLang>(props.locale);
  const [device, setDevice] = useState<Device>('desktop');
  const [surface, setSurface] = useState<Surface>('light');
  const [backdrop, setBackdrop] = useState<Backdrop>('shop');
  const [open, setOpen] = useState(true);
  const [logo, setLogo] = useState<string | null>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const [showCode, setShowCode] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<DraftResult | null>(null);
  const tracked = useRef(new Set<string>());
  const savedRef = useRef<HTMLParagraphElement>(null);

  const contrast = useMemo(() => enforceContrast(cfg.brand.primaryColor, cfg.brand.buttonTextColor), [cfg.brand.primaryColor, cfg.brand.buttonTextColor]);
  const colors = useMemo(
    () => themeColors({ primaryColor: contrast.primaryColor, buttonTextColor: contrast.buttonTextColor }),
    [contrast.primaryColor, contrast.buttonTextColor],
  );
  const serialized = useMemo(() => serializeDraft(cfg), [cfg]);
  const bytes = draftBytes(serialized);
  const tooLarge = bytes > DRAFT_MAX_BYTES;

  // Живой виджет на странице — показать ему те же настройки (с задержкой,
  // чтобы ввод HEX по букве не дёргал виджет). Флаг allowClientPreview
  // проверяет сам виджет: без него вызов молча игнорируется.
  useEffect(() => {
    if (!props.liveWidget) return;
    const id = window.setTimeout(() => assistCall('preview', previewPatch(cfg)), 250);
    return () => window.clearTimeout(id);
  }, [cfg, props.liveWidget]);

  // Логотип — blob: только в этом браузере; освобождаем при смене/уходе.
  useEffect(() => () => void (logo && URL.revokeObjectURL(logo)), [logo]);

  function changed(param: string, label: string, value: string) {
    setAnnounce(sub(t.announce, { param: label, value }));
    setSaved(null);
    if (!tracked.current.has(param)) {
      tracked.current.add(param);
      track('configurator_change', { param, place: 'configurator' });
    }
  }

  function update(param: string, label: string, value: string, fn: (c: DraftConfig) => DraftConfig) {
    setCfg((c) => fn(JSON.parse(JSON.stringify(c)) as DraftConfig));
    changed(param, label, value);
  }

  function setColor(hex: string) {
    setHexInput(hex);
    update('color', t.colorLegend, hex, (c) => {
      c.brand.primaryColor = hex;
      return c;
    });
  }

  const greeting = cfg.texts[textsLang]?.greeting ?? props.defaultGreetings[textsLang];
  const suggestions = cfg.texts[textsLang]?.suggestions ?? [];
  function setTexts(param: 'greeting' | 'suggestions', label: string, g: string, s: string[]) {
    update(param, label, '', (c) => {
      c.texts[textsLang] = { greeting: g, suggestions: s };
      return c;
    });
  }

  async function onLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const problem = logoProblem(file);
    const sniffed = problem ? null : sniffRaster(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    if (problem === 'size') return setLogoError(t.logoSize);
    if (problem || !sniffed) return setLogoError(t.logoType);
    setLogoError(null);
    setLogo(URL.createObjectURL(file));
    changed('logo', t.logo, file.name.slice(0, 40));
  }

  async function onSave() {
    if (tooLarge || saving) return;
    setSaving(true);
    let result: DraftResult;
    try {
      const res = await fetch(props.draftsEndpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: serialized }),
      });
      result = parseDraftResponse(res.status, await res.json().catch(() => null));
    } catch {
      result = { ok: false, code: 'NETWORK' };
    }
    setSaving(false);
    setSaved(result);
    const map = { RATE_LIMITED: 'rate_limited', BAD_REQUEST: 'invalid', ORIGIN_DENIED: 'denied', NETWORK: 'error', UNEXPECTED: 'error' } as const;
    track('configurator_save', { result: result.ok ? 'ok' : map[result.code] });
    window.setTimeout(() => savedRef.current?.focus(), 0);
  }

  async function onCopy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }

  const effectiveSurface: Surface = cfg.brand.theme === 'light' ? 'light' : cfg.brand.theme === 'dark' ? 'dark' : surface;
  const pal = effectiveSurface === 'dark' ? colors.dark : colors.light;
  const off = device === 'phone' ? cfg.layout.offset.mobile : cfg.layout.offset.desktop;
  const pos = cfg.layout.position;
  const stageStyle = {
    '--cfg-c': pal.primary,
    '--cfg-t': pal.onPrimary,
    '--cfg-x': `${Math.min(off.x, device === 'phone' ? 60 : 120)}px`,
    '--cfg-y': `${Math.min(off.y, device === 'phone' ? 60 : 120)}px`,
  } as CSSProperties;
  const snippet = installSnippet(props.loaderSrc, cfg, t.keyPlaceholder);
  const deviceMobileMode = device === 'phone' ? cfg.layout.mobile : 'corner';
  const icon = (i: Icon) => <Svg d={ICON_PATHS[i]} />;

  return (
    <div className="cfg" aria-label={t.label} role="region">
      <div className="cfg-settings">
        <h2 className="cfg-h">{t.settings}</h2>

        <fieldset className="cfg-group">
          <legend>{t.colorLegend}</legend>
          <div className="cfg-swatches" role="radiogroup" aria-label={t.presets}>
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={cfg.brand.primaryColor === c}
                aria-label={sub(t.presetLabel, { value: c })}
                className="cfg-swatch"
                style={{ background: c }}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
          <div className="cfg-row">
            <label className="cfg-field">
              <span>{t.customColor}</span>
              <input
                type="text"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                maxLength={7}
                value={hexInput}
                aria-invalid={normalizeHex(hexInput) === null}
                aria-describedby="cfg-hex-hint"
                onChange={(e) => {
                  setHexInput(e.target.value);
                  const h = normalizeHex(e.target.value);
                  if (h) setColor(h);
                }}
              />
            </label>
            <label className="cfg-field cfg-field-color">
              <span>{t.colorPicker}</span>
              <input type="color" value={cfg.brand.primaryColor.toLowerCase()} onChange={(e) => setColor(e.target.value.toUpperCase())} />
            </label>
          </div>
          <p id="cfg-hex-hint" className="cfg-hint">
            {normalizeHex(hexInput) === null ? t.invalidHex : ' '}
          </p>
          <Radio
            name="cfg-btext"
            legend={t.buttonText}
            options={['auto', 'custom'] as const}
            value={cfg.brand.buttonTextColor === 'auto' ? 'auto' : 'custom'}
            labels={{ auto: t.buttonTextAuto, custom: t.buttonTextCustom }}
            onChange={(v) =>
              update('button_text', t.buttonText, v === 'auto' ? t.buttonTextAuto : textHex, (c) => {
                c.brand.buttonTextColor = v === 'auto' ? 'auto' : textHex;
                return c;
              })
            }
          />
          {cfg.brand.buttonTextColor !== 'auto' && (
            <label className="cfg-field">
              <span>{t.buttonTextHex}</span>
              <input
                type="text"
                maxLength={7}
                spellCheck={false}
                value={textHex}
                onChange={(e) => {
                  setTextHex(e.target.value);
                  const h = normalizeHex(e.target.value);
                  if (h)
                    update('button_text', t.buttonText, h, (c) => {
                      c.brand.buttonTextColor = h;
                      return c;
                    });
                }}
              />
            </label>
          )}
          <ul className="cfg-contrast" aria-label={t.contrastHeading}>
            <li>
              {sub(t.contrastText, { value: contrast.text.toFixed(1) })} — <strong>{contrast.text >= 4.5 ? t.contrastOk : t.contrastBad}</strong>
            </li>
            <li>
              {sub(t.contrastUi, { value: contrast.ui.toFixed(1) })} — <strong>{contrast.ui >= 3 ? t.contrastOk : t.contrastBad}</strong>
            </li>
            <li>{sub(t.darkTheme, { value: colors.dark.primary })}</li>
          </ul>
          {contrast.adjusted && (
            <p className="cfg-adjusted" data-adjusted={contrast.adjusted.reason}>
              {contrast.adjusted.reason === 'text_auto'
                ? t.adjustedText
                : sub(contrast.adjusted.reason === 'darkened' ? t.adjustedDarkened : t.adjustedLightened, {
                    from: contrast.adjusted.from,
                    to: contrast.adjusted.to,
                  })}
            </p>
          )}
        </fieldset>

        <fieldset className="cfg-group">
          <legend>{t.placeLegend}</legend>
          <Radio<Position>
            name="cfg-position"
            legend={t.position}
            options={POSITIONS}
            value={cfg.layout.position}
            labels={t.positions}
            onChange={(v) =>
              update('position', t.position, t.positions[v], (c) => {
                c.layout.position = v;
                return c;
              })
            }
          />
          <div className="cfg-row">
            {(['x', 'y'] as const).map((axis) => (
              <label key={axis} className="cfg-field">
                <span>{axis === 'x' ? t.offsetX : t.offsetY}</span>
                <input
                  type="number"
                  min={0}
                  max={TEXT_LIMITS.offsetMax}
                  step={1}
                  value={cfg.layout.offset[device === 'phone' ? 'mobile' : 'desktop'][axis]}
                  onChange={(e) => {
                    const n = Math.max(0, Math.min(TEXT_LIMITS.offsetMax, Math.round(Number(e.target.value) || 0)));
                    update('offset', axis === 'x' ? t.offsetX : t.offsetY, String(n), (c) => {
                      c.layout.offset[device === 'phone' ? 'mobile' : 'desktop'][axis] = n;
                      return c;
                    });
                  }}
                />
              </label>
            ))}
          </div>
          <p className="cfg-hint">{device === 'phone' ? t.offsetPhone : t.offsetDesktop}</p>
          <label className="cfg-field">
            <span>{t.mobile}</span>
            <select
              value={cfg.layout.mobile}
              onChange={(e) => {
                const v = e.target.value as (typeof MOBILE_MODES)[number];
                update('mobile', t.mobile, t.mobileModes[v], (c) => {
                  c.layout.mobile = v;
                  return c;
                });
              }}
            >
              {MOBILE_MODES.map((m) => (
                <option key={m} value={m}>
                  {t.mobileModes[m]}
                </option>
              ))}
            </select>
          </label>
        </fieldset>

        <fieldset className="cfg-group">
          <legend>{t.launcherLegend}</legend>
          <Radio
            name="cfg-launcher"
            legend={t.launcher}
            options={['default', 'none'] as const}
            value={cfg.layout.launcher}
            labels={t.launchers}
            onChange={(v) =>
              update('launcher', t.launcher, t.launchers[v], (c) => {
                c.layout.launcher = v;
                return c;
              })
            }
          />
          {cfg.layout.launcher === 'none' ? (
            <>
              <p className="cfg-hint">{sub(t.ownButtonNote, { anchor: props.anchor })}</p>
              <Radio
                name="cfg-openat"
                legend={t.openAt}
                options={['corner', 'center'] as const}
                value={cfg.layout.openAt}
                labels={t.openAts}
                onChange={(v) =>
                  update('launcher', t.openAt, t.openAts[v], (c) => {
                    c.layout.openAt = v;
                    return c;
                  })
                }
              />
            </>
          ) : (
            <Radio<Icon>
              name="cfg-icon"
              legend={t.launcherIcon}
              options={ICONS}
              value={cfg.brand.launcherIcon}
              labels={t.icons}
              render={(i) => <span className="cfg-ico">{icon(i)}</span>}
              onChange={(v) =>
                update('avatar', t.launcherIcon, t.icons[v], (c) => {
                  c.brand.launcherIcon = v;
                  return c;
                })
              }
            />
          )}
          <Radio
            name="cfg-preset"
            legend={t.preset}
            options={PRESETS}
            value={cfg.brand.preset}
            labels={t.presetsShape}
            onChange={(v) =>
              update('preset', t.preset, t.presetsShape[v], (c) => {
                c.brand.preset = v;
                return c;
              })
            }
          />
        </fieldset>

        <fieldset className="cfg-group">
          <legend>{t.themeLegend}</legend>
          <label className="cfg-field">
            <span>{t.theme}</span>
            <select
              value={cfg.brand.theme}
              onChange={(e) => {
                const v = e.target.value as (typeof THEMES)[number];
                update('theme', t.theme, t.themes[v], (c) => {
                  c.brand.theme = v;
                  return c;
                });
              }}
            >
              {THEMES.map((m) => (
                <option key={m} value={m}>
                  {t.themes[m]}
                </option>
              ))}
            </select>
          </label>
          <label className="cfg-field">
            <span>{t.font}</span>
            <select
              value={cfg.brand.font}
              onChange={(e) => {
                const v = e.target.value as (typeof FONTS_AVAILABLE)[number];
                update('font', t.font, t.fonts[v], (c) => {
                  c.brand.font = v;
                  return c;
                });
              }}
            >
              {FONTS_AVAILABLE.map((m) => (
                <option key={m} value={m}>
                  {t.fonts[m]}
                </option>
              ))}
            </select>
          </label>
          <p className="cfg-hint">{t.fontsNote}</p>
        </fieldset>

        <fieldset className="cfg-group">
          <legend>{t.identityLegend}</legend>
          <label className="cfg-field">
            <span>{t.name}</span>
            <input
              type="text"
              maxLength={TEXT_LIMITS.name}
              value={cfg.brand.name}
              onChange={(e) => {
                const v = e.target.value;
                update('name', t.name, '', (c) => {
                  c.brand.name = v.slice(0, TEXT_LIMITS.name);
                  return c;
                });
              }}
            />
          </label>
          <Radio<Icon>
            name="cfg-avatar"
            legend={t.avatar}
            options={ICONS}
            value={cfg.brand.avatar.icon}
            labels={t.icons}
            render={(i) => <span className="cfg-ico">{icon(i)}</span>}
            onChange={(v) =>
              update('avatar', t.avatar, t.icons[v], (c) => {
                c.brand.avatar = { kind: 'icon', icon: v };
                return c;
              })
            }
          />
          <label className="cfg-field">
            <span>{t.logo}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={onLogo} aria-describedby="cfg-logo-note" />
          </label>
          <p id="cfg-logo-note" className="cfg-hint">
            {t.logoNote}
          </p>
          {logoError && (
            <p className="cfg-error" role="alert">
              {logoError}
            </p>
          )}
          {logo && (
            <button type="button" className="button button-secondary button-small" onClick={() => setLogo(null)}>
              {t.logoRemove}
            </button>
          )}
        </fieldset>

        <fieldset className="cfg-group">
          <legend>{t.textsLegend}</legend>
          <label className="cfg-field">
            <span>{t.textsLang}</span>
            <select value={textsLang} onChange={(e) => setTextsLang(e.target.value as UiLang)}>
              {UI_LANGS.map((l) => (
                <option key={l} value={l}>
                  {t.langs[l]}
                </option>
              ))}
            </select>
          </label>
          <label className="cfg-field">
            <span>{t.greeting}</span>
            <textarea
              rows={3}
              maxLength={TEXT_LIMITS.greeting}
              value={greeting}
              lang={textsLang}
              onChange={(e) => setTexts('greeting', t.greeting, e.target.value, suggestions)}
            />
          </label>
          {[0, 1, 2].map((i) => (
            <label key={i} className="cfg-field">
              <span>{sub(t.suggestion, { n: i + 1 })}</span>
              <input
                type="text"
                maxLength={TEXT_LIMITS.suggestion}
                lang={textsLang}
                value={suggestions[i] ?? ''}
                onChange={(e) => {
                  const next = [...suggestions];
                  next[i] = e.target.value;
                  setTexts('suggestions', sub(t.suggestion, { n: i + 1 }), greeting, next.map((s) => s ?? ''));
                }}
              />
            </label>
          ))}
          {tooLarge && (
            <p className="cfg-error" role="alert">
              {t.tooLarge}
            </p>
          )}
        </fieldset>
      </div>

      <div className="cfg-preview">
        <h2 className="cfg-h">
          {t.preview} <span className="badge-mock">{t.previewMock}</span>
        </h2>
        <div className="cfg-toolbar">
          <Radio<Device>
            name="cfg-device"
            legend={t.device}
            options={['desktop', 'phone'] as const}
            value={device}
            labels={t.devices}
            onChange={(v) => {
              setDevice(v);
              changed('device', t.device, t.devices[v]);
            }}
          />
          <Radio<Surface>
            name="cfg-surface"
            legend={t.surface}
            options={['light', 'dark'] as const}
            value={effectiveSurface}
            labels={t.surfaces}
            onChange={(v) => {
              setSurface(v);
              changed('surface', t.surface, t.surfaces[v]);
            }}
          />
          <Radio<Backdrop>
            name="cfg-backdrop"
            legend={t.backdrop}
            options={BACKDROPS}
            value={backdrop}
            labels={t.backdrops}
            onChange={(v) => {
              setBackdrop(v);
              changed('backdrop', t.backdrop, t.backdrops[v]);
            }}
          />
          <label className="cfg-check">
            <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> {t.openPreview}
          </label>
        </div>

        <div
          className={`cfg-stage cfg-${device} cfg-pos-${pos} cfg-preset-${cfg.brand.preset} cfg-surface-${effectiveSurface} cfg-mm-${deviceMobileMode} cfg-font-${cfg.brand.font}${
            cfg.layout.launcher === 'none' ? ` cfg-own cfg-at-${cfg.layout.openAt}` : ''
          }`}
          style={stageStyle}
          data-testid="cfg-stage"
          data-position={pos}
          data-primary={pal.primary}
          data-on-primary={pal.onPrimary}
        >
          <div className={`cfg-page cfg-page-${backdrop}`} aria-hidden="true">
            <i className="cfg-b cfg-b-nav" />
            <i className="cfg-b cfg-b-hero" />
            <i className="cfg-b cfg-b-l1" />
            <i className="cfg-b cfg-b-l2" />
            <i className="cfg-b cfg-b-card" />
            <i className="cfg-b cfg-b-card" />
            <i className="cfg-b cfg-b-card" />
          </div>
          {open && (
            <div className="cfg-panel" role="group" aria-label={t.previewPanel}>
              <div className="cfg-head">
                <span className="cfg-avatar">
                  {/* blob:-адрес локального файла — next/image тут не к месту (§5.1: файл не уходит на сервер). */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {logo ? <img src={logo} alt="" /> : icon(cfg.brand.avatar.icon)}
                </span>
                <span className="cfg-name">{cleanLine(cfg.brand.name, TEXT_LIMITS.name) || props.defaultName}</span>
                <span className="cfg-ai">{t.aiLabel}</span>
                <span className="cfg-x" aria-hidden="true">
                  <Svg d={ICON_PATHS.close} />
                </span>
              </div>
              <div className="cfg-body" lang={textsLang}>
                <p className="cfg-bubble">{greeting}</p>
                {suggestions.filter((s) => s.trim()).length > 0 && (
                  <p className="cfg-chips">
                    {suggestions
                      .filter((s) => s.trim())
                      .map((s, i) => (
                        <span key={i} className="cfg-chip">
                          {s}
                        </span>
                      ))}
                  </p>
                )}
              </div>
              <div className="cfg-input">
                <span>{t.inputPlaceholder}</span>
                <span className="cfg-send" aria-hidden="true">
                  <Svg d={ICON_PATHS.send} />
                </span>
              </div>
              <p className="cfg-powered">{t.poweredBy}</p>
            </div>
          )}
          {cfg.layout.launcher === 'default' && (
            <button
              type="button"
              className="cfg-launcher"
              aria-expanded={open}
              aria-label={open ? t.previewClose : t.previewOpen}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? <Svg d={ICON_PATHS.close} /> : icon(cfg.brand.launcherIcon)}
            </button>
          )}
        </div>
        <p className="cfg-hint">{t.previewMockNote}</p>
        {props.liveWidget && <p className="cfg-live-note">{t.previewLive}</p>}
        <p className="sr-only" aria-live="polite" role="status">
          {announce}
        </p>

        <section className="cfg-out" aria-labelledby="cfg-code-h">
          <h2 className="cfg-h" id="cfg-code-h">
            {t.codeHeading}
          </h2>
          <p>
            <button
              type="button"
              className="button button-secondary"
              aria-expanded={showCode}
              aria-controls="cfg-code"
              onClick={() => {
                setShowCode((s) => !s);
                changed('snippet', t.codeHeading, '');
              }}
            >
              {t.getCode}
            </button>
          </p>
          {showCode && (
            <div id="cfg-code">
              <pre className="cfg-code">
                <code>{snippet}</code>
              </pre>
              <p className="cfg-hint">{sub(t.codeNote, { key: t.keyPlaceholder })}</p>
              <p>
                <button type="button" className="button button-small" onClick={() => onCopy(snippet)}>
                  {t.copy}
                </button>{' '}
                <span role="status">{copyState === 'copied' ? t.copied : copyState === 'failed' ? t.copyFailed : ''}</span>
              </p>
            </div>
          )}
        </section>

        {props.botUsername && (
          <section className="cfg-out" aria-labelledby="cfg-save-h">
            <h2 className="cfg-h" id="cfg-save-h">
              {t.saveHeading}
            </h2>
            <p>{t.saveText}</p>
            <p>
              <button type="button" className="button" onClick={onSave} disabled={saving || tooLarge} aria-disabled={saving || tooLarge}>
                {saving ? t.saving : t.save}
              </button>
            </p>
            <p ref={savedRef} tabIndex={-1} role="status" className={saved ? (saved.ok ? 'cfg-saved' : 'cfg-error') : undefined}>
              {saved?.ok && sub(t.saved, { date: new Date(saved.expiresAt).toLocaleDateString(props.locale) })}
              {saved && !saved.ok && t.saveErrors[saved.code]}
            </p>
            {saved?.ok && (
              <p>
                <a
                  className="button"
                  href={tmaDraftLink(props.botUsername, saved.id)}
                  data-tma="wd"
                  data-cta="configurator"
                  rel="noopener"
                  target="_blank"
                >
                  {t.openTelegram}
                </a>
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

