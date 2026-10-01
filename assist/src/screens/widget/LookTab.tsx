import { useRef, useState } from 'react';
import { Save, Upload } from 'lucide-react';
import { fmt } from '../../kit';
import { Alert, Button, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { ClientSetupError } from '../../lib/setup-errors';
import { useSetupErrorText } from '../../lib/use-error-text';
import { WIDGET_ANCHOR, WIDGET_GLOBAL } from '../../lib/widget-brand';
import {
  assetFileProblem,
  buttonText,
  contrastHint,
  linesToList,
  normalizeHex,
} from '../../lib/widget-view';
import {
  AVATAR_MIN_SIDE,
  WIDGET_COLOR_PRESETS,
  WIDGET_FONTS,
  WIDGET_LAUNCHER_ICONS,
  WIDGET_MOBILE_MODES,
  WIDGET_POSITIONS,
  WIDGET_PRESETS,
  WIDGET_TEXT_LIMITS,
  WIDGET_THEMES,
  WIDGET_UI_LANGS,
  type AssetView,
  type WidgetConfig,
  type WidgetSettingsView,
  type WidgetUiLang,
} from '../../lib/widget-types';
import {
  ConfirmButton,
  NoticeBar,
  textareaClass,
  type Notice,
} from '../knowledge/parts';
import { Field, HistoryList, NumberInput, Select, Toggle } from './controls';
import { WidgetPreview } from './WidgetPreview';

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

function imageSize(file: File): Promise<{ w: number; h: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ w: 0, h: 0 });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

/** Вкладка «Вид» (§3-бис.1, §3-бис.3, §3-бис.4): настройки + настоящий предпросмотр. */
export function LookTab({
  siteId,
  view,
  onView,
  adjustNotices,
}: {
  siteId: string;
  view: WidgetSettingsView;
  onView: (v: WidgetSettingsView) => void;
  adjustNotices: (v: WidgetSettingsView) => string[];
}) {
  const { appDict, widget } = useAssist();
  const t = appDict.setup.widget.look;
  const tc = appDict.setup.common;
  const errText = useSetupErrorText();
  const [draft, setDraft] = useState<WidgetConfig>(view.draft);
  const [hexInput, setHexInput] = useState(view.draft.brand.primaryColor);
  const [lang, setLang] = useState<WidgetUiLang>('uk');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const logoInput = useRef<HTMLInputElement>(null);
  const avatarInput = useRef<HTMLInputElement>(null);

  const brand = draft.brand;
  const hint = contrastHint(brand);
  const setBrand = (patch: Partial<WidgetConfig['brand']>) =>
    setDraft((d) => ({ ...d, brand: { ...d.brand, ...patch } }));
  const setLayout = (patch: Partial<WidgetConfig['layout']>) =>
    setDraft((d) => ({ ...d, layout: { ...d.layout, ...patch } }));
  const texts = draft.texts[lang] ?? { greeting: '', suggestions: [] };
  const setTexts = (
    patch: Partial<{ greeting: string; suggestions: string[] }>
  ) =>
    setDraft((d) => ({
      ...d,
      texts: { ...d.texts, [lang]: { ...texts, ...patch } },
    }));

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const accept = (v: WidgetSettingsView, okText: string) => {
    onView(v);
    setDraft(v.draft);
    setHexInput(v.draft.brand.primaryColor);
    setSavedTick((n) => n + 1);
    const extra = adjustNotices(v);
    setNotice({
      tone: extra.length ? 'warning' : 'success',
      text: [okText, ...extra].join(' '),
    });
  };

  const save = () =>
    run('save', async () =>
      accept(await widget.saveDraft(siteId, draft), tc.saved)
    );

  async function upload(kind: 'logo' | 'avatar', file: File) {
    await run(kind, async () => {
      const p = assetFileProblem(file);
      if (p === 'type') throw new ClientSetupError('ASSET_TYPE');
      if (p === 'size') throw new ClientSetupError('ASSET_TOO_LARGE');
      if (kind === 'avatar') {
        const { w, h } = await imageSize(file);
        if (w !== h || w < AVATAR_MIN_SIDE) {
          setNotice({ tone: 'danger', text: t.avatarSquare });
          return;
        }
      }
      const asset: AssetView = await widget.uploadAsset(siteId, {
        kind,
        mime: file.type,
        dataBase64: await readAsBase64(file),
      });
      if (kind === 'logo') setBrand({ logoAssetId: asset.id });
      else setBrand({ avatar: { kind: 'asset', assetId: asset.id } });
      setNotice({ tone: 'success', text: t.uploaded });
    });
  }

  const sampleText = buttonText(brand);

  return (
    <div className="space-y-4">
      <NoticeBar notice={notice} />
      {view.publishedVersion > 0 ? (
        <div className="text-sm text-silver-500">
          {fmt(tc.publishedLabel, { n: view.publishedVersion })}
          {view.draftChanged && ` · ${tc.draftChanged}`}
        </div>
      ) : (
        <Alert tone="warning">{tc.notPublished}</Alert>
      )}

      <WidgetPreview
        siteId={siteId}
        view={view}
        version={savedTick}
        keysBusy={busy === 'keys'}
        onGetKeys={() =>
          run('keys', async () => onView(await widget.ensureKeys(siteId)))
        }
      />

      <Card className="space-y-4">
        <div className="font-semibold">{t.brand}</div>
        <Field
          label={t.color}
          hint={
            hint.ok
              ? fmt(t.contrastOk, { ratio: hint.text.toFixed(1) })
              : fmt(t.contrastLow, {
                  ratio: (hint.text < 4.5 ? hint.text : hint.ui).toFixed(1),
                })
          }
        >
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label={t.presets}
          >
            {WIDGET_COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={brand.primaryColor === c}
                aria-label={c}
                onClick={() => {
                  setBrand({ primaryColor: c });
                  setHexInput(c);
                }}
                className={`h-9 w-9 rounded-full border-2 ${brand.primaryColor === c ? 'border-silver-900 dark:border-white' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t.customColor}
              value={brand.primaryColor.toLowerCase()}
              onChange={(e) => {
                const v = normalizeHex(e.target.value);
                if (v) {
                  setBrand({ primaryColor: v });
                  setHexInput(v);
                }
              }}
              className="h-10 w-12 rounded border border-silver-300 dark:border-silver-700 bg-transparent"
            />
            <input
              className={inputClass}
              aria-label={t.customColor}
              value={hexInput}
              maxLength={7}
              onChange={(e) => {
                setHexInput(e.target.value);
                const v = normalizeHex(e.target.value);
                if (v) setBrand({ primaryColor: v });
              }}
            />
          </div>
          {!normalizeHex(hexInput) && (
            <div className="text-xs text-rose-500">{t.colorInvalid}</div>
          )}
        </Field>

        <Field label={t.buttonText}>
          <div className="flex flex-wrap items-center gap-3">
            <Toggle
              checked={brand.buttonTextColor === 'auto'}
              onChange={(on) =>
                setBrand({ buttonTextColor: on ? 'auto' : sampleText })
              }
              label={t.auto}
            />
            {brand.buttonTextColor !== 'auto' && (
              <input
                type="color"
                aria-label={t.custom}
                value={brand.buttonTextColor.toLowerCase()}
                onChange={(e) => {
                  const v = normalizeHex(e.target.value);
                  if (v) setBrand({ buttonTextColor: v });
                }}
                className="h-10 w-12 rounded border border-silver-300 dark:border-silver-700 bg-transparent"
              />
            )}
            <span
              className="inline-flex items-center rounded-full px-4 py-2 text-sm font-medium"
              style={{ backgroundColor: brand.primaryColor, color: sampleText }}
              aria-label={t.sample}
            >
              {brand.name || t.sample}
            </span>
          </div>
        </Field>

        <Field label={t.name} hint={t.nameHint} htmlFor="w-name">
          <input
            id="w-name"
            className={inputClass}
            value={brand.name}
            maxLength={WIDGET_TEXT_LIMITS.name}
            onChange={(e) => setBrand({ name: e.target.value })}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.logo} hint={t.imageHint}>
            <div className="flex flex-wrap items-center gap-2">
              {brand.logoAssetId && view.widgetOrigin && (
                <img
                  src={`${view.widgetOrigin}/widget/v1/asset/${brand.logoAssetId}`}
                  alt=""
                  className="h-10 max-w-[8rem] object-contain rounded bg-silver-100 dark:bg-silver-900"
                />
              )}
              <Button
                variant="outline"
                icon={<Upload size={16} />}
                loading={busy === 'logo'}
                onClick={() => logoInput.current?.click()}
              >
                {t.upload}
              </Button>
              {brand.logoAssetId && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setBrand({
                      logoAssetId: null,
                      launcherIcon:
                        brand.launcherIcon === 'logo'
                          ? 'chat'
                          : brand.launcherIcon,
                    })
                  }
                >
                  {t.remove}
                </Button>
              )}
              <input
                ref={logoInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload('logo', f);
                }}
              />
            </div>
          </Field>
          <Field label={t.avatar}>
            <div className="flex flex-wrap items-center gap-2">
              {brand.avatar.kind === 'asset' && view.widgetOrigin ? (
                <img
                  src={`${view.widgetOrigin}/widget/v1/asset/${brand.avatar.assetId}`}
                  alt=""
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <Select
                  value={
                    brand.avatar.kind === 'icon' ? brand.avatar.icon : 'chat'
                  }
                  options={WIDGET_LAUNCHER_ICONS.filter((i) => i !== 'logo')}
                  labels={t.icons}
                  onChange={(icon) =>
                    setBrand({ avatar: { kind: 'icon', icon } })
                  }
                />
              )}
              <Button
                variant="outline"
                icon={<Upload size={16} />}
                loading={busy === 'avatar'}
                onClick={() => avatarInput.current?.click()}
              >
                {t.avatarUpload}
              </Button>
              {brand.avatar.kind === 'asset' && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    setBrand({ avatar: { kind: 'icon', icon: 'chat' } })
                  }
                >
                  {t.avatarIcon}
                </Button>
              )}
              <input
                ref={avatarInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload('avatar', f);
                }}
              />
            </div>
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.launcherIcon}>
            <Select
              value={brand.launcherIcon}
              options={WIDGET_LAUNCHER_ICONS.filter(
                (i) => i !== 'logo' || !!brand.logoAssetId
              )}
              labels={t.icons}
              onChange={(launcherIcon) => setBrand({ launcherIcon })}
            />
          </Field>
          <Field label={t.font}>
            <Select
              value={brand.font}
              options={WIDGET_FONTS}
              labels={t.fonts}
              onChange={(font) => setBrand({ font })}
            />
          </Field>
          <Field label={t.preset}>
            <Select
              value={brand.preset}
              options={WIDGET_PRESETS}
              labels={t.presetNames}
              onChange={(preset) => setBrand({ preset })}
            />
          </Field>
          <Field label={t.theme}>
            <Select
              value={brand.theme}
              options={WIDGET_THEMES}
              labels={t.themes}
              onChange={(theme) => setBrand({ theme })}
            />
          </Field>
        </div>
        <Toggle
          checked
          disabled
          onChange={() => undefined}
          label={`${t.poweredBy} — ${t.poweredByLocked}`}
        />
        <div className="text-xs text-silver-500">{t.aiLabel}</div>
      </Card>

      <Card className="space-y-3">
        <div className="font-semibold">{t.texts}</div>
        <div className="flex gap-1" role="tablist">
          {WIDGET_UI_LANGS.map((l) => (
            <button
              key={l}
              type="button"
              role="tab"
              aria-selected={l === lang}
              onClick={() => setLang(l)}
              className={`rounded-full px-3 py-1.5 text-xs min-h-[32px] ${l === lang ? 'bg-accent text-accent-on' : 'bg-silver-200/60 dark:bg-silver-800/60'}`}
            >
              {t.langs[l]}
            </button>
          ))}
        </div>
        <Field label={t.greeting} htmlFor="w-greeting">
          <textarea
            id="w-greeting"
            className={textareaClass}
            value={texts.greeting}
            maxLength={WIDGET_TEXT_LIMITS.greeting}
            onChange={(e) => setTexts({ greeting: e.target.value })}
          />
        </Field>
        <Field label={t.suggestions} hint={t.suggestionsHint} htmlFor="w-sugg">
          <textarea
            id="w-sugg"
            className={textareaClass}
            value={texts.suggestions.join('\n')}
            onChange={(e) =>
              setTexts({
                suggestions: linesToList(
                  e.target.value,
                  WIDGET_TEXT_LIMITS.suggestions
                ).map((s) => s.slice(0, WIDGET_TEXT_LIMITS.suggestion)),
              })
            }
          />
        </Field>
      </Card>

      <Card className="space-y-3">
        <div className="font-semibold">{t.layout}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t.position}>
            <Select
              value={draft.layout.position}
              options={WIDGET_POSITIONS}
              labels={t.positions}
              onChange={(position) => setLayout({ position })}
            />
          </Field>
          <Field label={t.mobile}>
            <Select
              value={draft.layout.mobile}
              options={WIDGET_MOBILE_MODES}
              labels={t.mobiles}
              onChange={(mobile) => setLayout({ mobile })}
            />
          </Field>
          <Field
            label={t.launcher}
            hint={
              draft.layout.launcher === 'none'
                ? fmt(t.launcherNoneHint, {
                    anchor: WIDGET_ANCHOR,
                    global: WIDGET_GLOBAL,
                  })
                : undefined
            }
          >
            <Select
              value={draft.layout.launcher}
              options={['default', 'none'] as const}
              labels={t.launchers}
              onChange={(launcher) => setLayout({ launcher })}
            />
          </Field>
          <Field label={t.openAt}>
            <Select
              value={draft.layout.openAt}
              options={['corner', 'center'] as const}
              labels={t.openAts}
              onChange={(openAt) => setLayout({ openAt })}
            />
          </Field>
        </div>
        <Field label={t.offsets}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(['desktop', 'mobile'] as const).map((dev) =>
              (['x', 'y'] as const).map((axis) => (
                <label
                  key={`${dev}-${axis}`}
                  className="text-xs text-silver-500 space-y-1"
                >
                  <span>
                    {dev === 'desktop' ? t.desktop : t.phone} ·{' '}
                    {axis === 'x' ? t.offsetX : t.offsetY}
                  </span>
                  <NumberInput
                    value={draft.layout.offset[dev][axis]}
                    min={0}
                    max={WIDGET_TEXT_LIMITS.offsetMax}
                    onChange={(n) =>
                      setLayout({
                        offset: {
                          ...draft.layout.offset,
                          [dev]: { ...draft.layout.offset[dev], [axis]: n },
                        },
                      })
                    }
                  />
                </label>
              ))
            )}
          </div>
        </Field>
        <Field label={t.zIndex} hint={t.zIndexHint} htmlFor="w-z">
          <NumberInput
            id="w-z"
            value={draft.layout.zIndex}
            min={0}
            max={2147483647}
            onChange={(zIndex) => setLayout({ zIndex })}
          />
        </Field>
        <Toggle
          checked={draft.layout.avoidOverlap}
          onChange={(avoidOverlap) => setLayout({ avoidOverlap })}
          label={t.avoidOverlap}
        />
        <Toggle
          checked={draft.layout.hideOnScrollMobile}
          onChange={(hideOnScrollMobile) => setLayout({ hideOnScrollMobile })}
          label={t.hideOnScroll}
        />
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button
          icon={<Save size={16} />}
          loading={busy === 'save'}
          onClick={save}
        >
          {tc.save}
        </Button>
        <ConfirmButton
          variant="outline"
          hint={t.publishHint}
          loading={busy === 'publish'}
          onConfirm={() =>
            run('publish', async () => {
              // Сначала — сохранить то, что на экране: публикуется черновик сервера.
              await widget.saveDraft(siteId, draft);
              const v = await widget.publish(siteId);
              accept(v, fmt(tc.published, { n: v.publishedVersion }));
            })
          }
        >
          {tc.publish}
        </ConfirmButton>
      </div>
      <div className="text-xs text-silver-500">{t.publishHint}</div>

      <HistoryList
        history={view.history}
        current={view.publishedVersion}
        busy={busy?.startsWith('rb:') ? Number(busy.slice(3)) : null}
        onRollback={(ver) =>
          run(`rb:${ver}`, async () => {
            const v = await widget.rollback(siteId, ver);
            accept(v, fmt(tc.rolledBack, { n: ver, m: v.publishedVersion }));
          })
        }
      />
    </div>
  );
}
