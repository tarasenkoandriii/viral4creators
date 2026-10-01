import { useEffect, useRef, useState } from 'react';
import {
  ExternalLink,
  Monitor,
  Moon,
  RefreshCw,
  Smartphone,
  Sun,
} from 'lucide-react';
import { useKit } from '../../kit';
import { Alert, Button, Card, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { useSetupErrorText } from '../../lib/use-error-text';
import { WIDGET_PREVIEW_TOKEN_ATTR } from '../../lib/widget-brand';
import { previewTag, type PreviewTag } from '../../lib/widget-view';
import type { WidgetSettingsView } from '../../lib/widget-types';

type Device = 'desktop' | 'phone';
type Theme = 'light' | 'dark';

const PAGE = {
  light: { bg: '#F4F5F7', fg: '#1F2937', block: '#DADDE3' },
  dark: { bg: '#111318', fg: '#E5E7EB', block: '#2A2E37' },
} as const;

/**
 * Макет страницы сайта в пустом iframe того же origin (about:blank) и
 * НАСТОЯЩИЙ загрузчик виджета в нём (§3-бис.4): тот же код, что на сайте,
 * с токеном `purpose=tma` (контракт Э2 §5 «W1 ↔ W4»). Всё — через DOM API,
 * без HTML-строк: значения в тег попадают только после `previewTag`
 * (https-origin, ключ по формату, токен base64url).
 */
function mountMockPage(
  doc: Document,
  tag: PreviewTag,
  theme: Theme,
  title: string
): void {
  const c = PAGE[theme];
  doc.documentElement.setAttribute('data-theme', theme);
  doc.documentElement.style.colorScheme = theme;
  const style = doc.createElement('style');
  style.textContent = `html,body{margin:0;min-height:100%}body{font-family:system-ui,sans-serif;background:${c.bg};color:${c.fg};padding:16px}.b{background:${c.block};border-radius:8px;margin:12px 0}`;
  doc.head.replaceChildren(style);
  const h = doc.createElement('h1');
  h.textContent = title;
  h.style.fontSize = '18px';
  const blocks = [48, 120, 16, 16, 16, 140].map((height) => {
    const d = doc.createElement('div');
    d.className = 'b';
    d.style.height = `${height}px`;
    return d;
  });
  const script = doc.createElement('script');
  script.async = true;
  script.src = tag.src;
  script.setAttribute('data-site', tag.site);
  script.setAttribute(WIDGET_PREVIEW_TOKEN_ATTR, tag.token);
  doc.body.replaceChildren(h, ...blocks, script);
}

export function WidgetPreview({
  siteId,
  view,
  version,
  onGetKeys,
  keysBusy,
}: {
  siteId: string;
  view: WidgetSettingsView;
  /** Меняется после сохранения черновика — виджет перезагружается. */
  version: number;
  onGetKeys: () => void;
  keysBusy: boolean;
}) {
  const { appDict } = useAssist();
  const { widget } = useAssist();
  const t = appDict.setup.widget.preview;
  const [device, setDevice] = useState<Device>('desktop');
  const [theme, setTheme] = useState<Theme>('light');
  const [tick, setTick] = useState(0);
  const [failed, setFailed] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const ready = !!view.publicKey && !!view.widgetOrigin;
  const frameKey = `${version}-${tick}-${theme}-${device}`;

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setFailed(false);
    // Токен одноразовый: новый на каждую перезагрузку макета.
    widget.previewToken(siteId, { purpose: 'tma' }).then(
      (r) => {
        if (cancelled) return;
        const tag = previewTag(view.widgetOrigin, view.publicKey, r.token);
        const doc = frame.current?.contentDocument;
        if (!tag || !doc) {
          setFailed(true);
          return;
        }
        mountMockPage(doc, tag, theme, t.mockTitle);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
    // frameKey — новый iframe; остальное — его составляющие.
  }, [
    frameKey,
    ready,
    siteId,
    view.publicKey,
    view.widgetOrigin,
    widget,
    theme,
    t.mockTitle,
  ]);

  const seg = (on: boolean) =>
    `inline-flex items-center gap-1 rounded-full px-3 py-1.5 text-xs min-h-[32px] ${
      on
        ? 'bg-accent text-accent-on'
        : 'bg-silver-200/60 dark:bg-silver-800/60 text-silver-600 dark:text-silver-300'
    }`;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-semibold flex-1">{t.title}</div>
        <button
          type="button"
          className={seg(device === 'desktop')}
          onClick={() => setDevice('desktop')}
          aria-pressed={device === 'desktop'}
        >
          <Monitor size={14} /> {t.desktop}
        </button>
        <button
          type="button"
          className={seg(device === 'phone')}
          onClick={() => setDevice('phone')}
          aria-pressed={device === 'phone'}
        >
          <Smartphone size={14} /> {t.phone}
        </button>
        <button
          type="button"
          className={seg(theme === 'light')}
          onClick={() => setTheme('light')}
          aria-pressed={theme === 'light'}
        >
          <Sun size={14} /> {t.light}
        </button>
        <button
          type="button"
          className={seg(theme === 'dark')}
          onClick={() => setTheme('dark')}
          aria-pressed={theme === 'dark'}
        >
          <Moon size={14} /> {t.dark}
        </button>
        <Button
          variant="ghost"
          icon={<RefreshCw size={14} />}
          aria-label={t.reload}
          onClick={() => setTick((n) => n + 1)}
        />
      </div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      {!view.publicKey ? (
        <Alert tone="neutral">
          {t.needKeys}
          <div className="mt-2">
            <Button variant="outline" loading={keysBusy} onClick={onGetKeys}>
              {t.getKeys}
            </Button>
          </div>
        </Alert>
      ) : !ready || failed ? (
        <Alert tone="warning">{t.unavailable}</Alert>
      ) : null}
      {ready && (
        <div className="flex justify-center">
          <iframe
            key={frameKey}
            ref={frame}
            title={t.title}
            className="rounded-xl border border-silver-200 dark:border-silver-800 bg-white"
            style={
              device === 'phone'
                ? { width: 375, maxWidth: '100%', height: 640 }
                : { width: '100%', height: 560 }
            }
          />
        </div>
      )}
      <OnSiteLink siteId={siteId} view={view} />
    </Card>
  );
}

/** «Посмотреть на сайте»: одноразовая ссылка на подтверждённый хост (§3-бис.4). */
function OnSiteLink({
  siteId,
  view,
}: {
  siteId: string;
  view: WidgetSettingsView;
}) {
  const { appDict, widget } = useAssist();
  const { dict } = useKit();
  const t = appDict.setup.widget.preview;
  const errText = useSetupErrorText();
  const hosts = view.hosts.filter(
    (h) => h.status === 'verified' && h.widgetAllowed && !h.graceUntil
  );
  const [hostId, setHostId] = useState<string>(hosts[0]?.hostId ?? '');
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!view.publicKey) return null;
  if (hosts.length === 0) {
    return <div className="text-xs text-silver-500">{t.noVerifiedHost}</div>;
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex-1 min-w-[12rem] text-sm">
          <span className="block text-xs text-silver-500 mb-1">
            {t.chooseHost}
          </span>
          <select
            className={inputClass}
            value={hostId}
            onChange={(e) => {
              setHostId(e.target.value);
              setUrl(null);
            }}
          >
            {hosts.map((h) => (
              <option key={h.hostId} value={h.hostId}>
                {h.origin}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          loading={busy}
          icon={<ExternalLink size={16} />}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              const r = await widget.previewToken(siteId, {
                purpose: 'site',
                hostId,
              });
              setUrl(r.url);
              if (!r.url) setError(dict.common.error);
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t.onSite}
        </Button>
      </div>
      <div className="text-xs text-silver-500">{t.onSiteHint}</div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-accent underline break-all"
        >
          <ExternalLink size={14} /> {t.open}
        </a>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
