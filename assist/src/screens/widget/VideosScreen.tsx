/**
 * Экран «Видео» (Э6, ТЗ помощника §4.11): ролики обучалки этого сайта,
 * одобренные модератором, с переключателем «показывать в виджете», кнопка
 * «Снять новое обучение» (deep-link в визард обучалки генератора с
 * привязкой к сайту) и сводка карты интерфейса для «показать на экране»
 * (§4.12: сигнал «карта устарела»).
 */
import { useState } from 'react';
import { Clapperboard } from 'lucide-react';
import { fmt, getTelegramWebApp, useAsync, useKit } from '../../kit';
import { Alert, Button, Card, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import {
  duration,
  mediaErrorCode,
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
      <Card className="space-y-1">
        <div className="font-semibold text-sm">{t.map.title}</div>
        {view.uiMap.pages === 0 ? (
          <p className="text-xs text-silver-500">{t.map.empty}</p>
        ) : (
          <>
            <p className="text-xs text-silver-500">
              {fmt(t.map.pages, { n: String(view.uiMap.pages) })}
            </p>
            {view.uiMap.stalePages > 0 && (
              <Alert tone="warning">
                {fmt(t.map.stale, { n: String(view.uiMap.stalePages) })}
              </Alert>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
