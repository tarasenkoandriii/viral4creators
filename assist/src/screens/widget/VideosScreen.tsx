/**
 * Экран «Видео» (Э6, ТЗ помощника §4.11): ролики обучалки этого сайта,
 * одобренные модератором, с переключателем «показывать в виджете», кнопка
 * «Снять новое обучение» (deep-link в визард обучалки генератора с
 * привязкой к сайту) и сводка карты интерфейса для «показать на экране»
 * (§4.12: сигнал «карта устарела»). Э-С Ш4: сводка общей карты —
 * устаревшие ЭЛЕМЕНТЫ (порог промахов по виду вёрстки), источники и вид по
 * страницам (`GET /assist/sites/:id/ui-map`, раскрывается по кнопке).
 */
import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { fmt, getTelegramWebApp, useAsync, useKit } from '../../kit';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  duration,
  mediaErrorCode,
  type SiteUiMapView,
  type SiteVideosView,
} from '../../lib/media-api';
import { openExternal } from '../../lib/open-link';
import { useSetupErrorText } from '../../lib/use-error-text';
import { canManageWidget } from '../../lib/widget-view';
import { LoadError, NoticeBar, type Notice } from '../knowledge/parts';
import { Toggle } from './controls';

/** Ссылка t.me: в TMA — `openTelegramLink` (Mini App генератора), иначе вкладка. */
function openTutorial(url: string): void {
  const tg = getTelegramWebApp() as
    { openTelegramLink?: (u: string) => void } | null | undefined;
  if (tg?.openTelegramLink) tg.openTelegramLink(url);
  else openExternal(url);
}

export function VideosScreen({ siteId }: { siteId: string }) {
  const { account, dict } = useKit();
  const { appDict, media } = useAssist();
  const ok = canManageWidget(account.me);
  const loaded = useAsync(
    () => (ok ? media.list(siteId) : Promise.resolve(null)),
    [media, siteId, ok]
  );
  if (!ok) return <Alert tone="warning">{appDict.setup.common.noAccess}</Alert>;
  if (loaded.loading && !loaded.data)
    return <Spinner label={dict.common.loading} />;
  if (!loaded.data)
    return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  return <Videos siteId={siteId} initial={loaded.data} />;
}

function Videos({
  siteId,
  initial,
}: {
  siteId: string;
  initial: SiteVideosView;
}) {
  const { appDict, media } = useAssist();
  const t = appDict.media;
  const errText = useSetupErrorText();
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const toggle = async (id: string, enabled: boolean) => {
    setBusy(id);
    setNotice(null);
    try {
      const v = await media.setEnabled(siteId, id, enabled);
      setView((s) => ({
        ...s,
        videos: s.videos.map((x) => (x.id === v.id ? v : x)),
      }));
      setNotice({ tone: 'success', text: t.saved });
    } catch (e) {
      const code = mediaErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {!view.planAllowsVideo && <Alert tone="neutral">{t.plan}</Alert>}
      <Card className="space-y-2">
        {view.tutorialLink ? (
          <>
            <Button
              icon={<Clapperboard size={16} />}
              onClick={() => openTutorial(view.tutorialLink as string)}
            >
              {t.record}
            </Button>
            <p className="text-xs text-silver-500">{t.recordHint}</p>
          </>
        ) : (
          <p className="text-xs text-silver-500">{t.noLink}</p>
        )}
      </Card>
      {view.videos.length === 0 ? (
        <p className="text-sm text-silver-500">{t.empty}</p>
      ) : (
        <ul className="space-y-2">
          {view.videos.map((v) => (
            <li key={v.id}>
              <Card className="space-y-1">
                <div className="font-semibold text-sm">{v.title}</div>
                {v.durationMs !== null && (
                  <div className="text-xs text-silver-500">
                    {fmt(t.duration, { d: duration(v.durationMs) })}
                  </div>
                )}
                {v.requiresLogin ? (
                  <p className="text-xs text-silver-500">{t.loginOnly}</p>
                ) : (
                  <Toggle
                    checked={v.enabled}
                    disabled={
                      busy !== null || (!view.planAllowsVideo && !v.enabled)
                    }
                    label={t.show}
                    onChange={(on) => void toggle(v.id, on)}
                  />
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
      <UiMapCard siteId={siteId} summary={view.uiMap} />
    </div>
  );
}

/** Э-С Ш4: карта интерфейса — сводка и (по кнопке) страницы. */
function UiMapCard({
  siteId,
  summary,
}: {
  siteId: string;
  summary: SiteVideosView['uiMap'];
}) {
  const { appDict, media } = useAssist();
  const t = appDict.media.map;
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<SiteUiMapView | null>(null);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    if (detail) return;
    try {
      setDetail(await media.uiMap(siteId));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  };

  return (
    <Card className="space-y-2">
      <div className="font-semibold text-sm">{t.title}</div>
      {summary.pages === 0 ? (
        <p className="text-xs text-silver-500">{t.empty}</p>
      ) : (
        <>
          <p className="text-xs text-silver-500">
            {fmt(t.pages, { n: String(summary.pages) })}
          </p>
          {summary.staleElements > 0 && (
            <Alert tone="warning">
              {fmt(t.stale, {
                e: String(summary.staleElements),
                n: String(summary.stalePages),
              })}
            </Alert>
          )}
          <Button variant="outline" onClick={() => void toggle()}>
            {open ? t.hide : t.details}
          </Button>
          {open && failed && <Alert tone="danger">{t.loadError}</Alert>}
          {open && !detail && !failed && <Spinner />}
          {open && detail && <UiMapDetail view={detail} />}
        </>
      )}
    </Card>
  );
}

function UiMapDetail({ view }: { view: SiteUiMapView }) {
  const { appDict } = useAssist();
  const t = appDict.media.map;
  return (
    <div className="space-y-2">
      <p className="text-xs text-silver-500">
        {fmt(t.stability, {
          s: String(view.byStability.strong),
          n: String(view.elements),
        })}
      </p>
      <ul className="space-y-2">
        {view.items.map((p) => (
          <li
            key={`${p.host}${p.path}`}
            className="text-xs space-y-0.5 border-t border-silver-200 pt-2"
          >
            <div className="font-medium break-all">
              {p.host}
              {p.path}
            </div>
            <div className="text-silver-500">
              {fmt(t.elements, { n: String(p.elements) })} ·{' '}
              {p.sources.map((s) => t.sources[s]).join(', ')} ·{' '}
              {p.viewports.map((v) => t.views[v]).join(', ')}
            </div>
            {p.lastCapturedAt && (
              <div className="text-silver-500">
                {fmt(t.updated, {
                  d: new Date(p.lastCapturedAt).toLocaleDateString(),
                })}
              </div>
            )}
            {p.stale.map((e, i) => (
              <div key={i} className="text-amber-600">
                {fmt(t.staleItem, {
                  label: e.label,
                  view: t.views[e.viewport],
                })}
              </div>
            ))}
          </li>
        ))}
      </ul>
      {view.truncated && (
        <p className="text-xs text-silver-500">{t.truncated}</p>
      )}
      {view.recrawl && (
        <div className="text-xs text-silver-500 space-y-0.5 border-t border-silver-200 pt-2">
          <p>
            {view.recrawl.perDay === 0
              ? t.recrawlOff
              : fmt(t.recrawl, {
                  today: String(view.recrawl.today),
                  limit: String(view.recrawl.perDay),
                })}
          </p>
          {view.recrawl.recent.map((r, i) => (
            <div key={i} className="break-all">
              {fmt(t.recrawlItem, {
                page: `${r.host}${r.path}`,
                status: t.recrawlStatus[r.status],
                d: new Date(r.createdAt).toLocaleDateString(),
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
