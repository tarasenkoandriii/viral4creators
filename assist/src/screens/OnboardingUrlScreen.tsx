import { useState } from 'react';
import { Globe, Map as MapIcon, MessageSquare } from 'lucide-react';
import { canManage, fmt, useKit } from '../kit';
import { Alert, Button, Card } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import type { UrlPreview } from '../lib/knowledge-types';
import { normalizeSiteUrl } from '../lib/knowledge-view';
import { navigate } from '../lib/router';
import { useErrorText } from '../lib/use-error-text';

/**
 * Онбординг, шаг 2 (ТЗ §3.1): адрес сайта → нормализация (схема; `www`
 * не срезаем — отдельный хост) → быстрый предпросмотр без записи
 * (`POST /assist/url-preview`: title, язык, sitemap). Затем шаг 3 —
 * сайт создаётся неподтверждённым, и сразу запускается песочница.
 */
export function OnboardingUrlScreen() {
  const { api, account, dict } = useKit();
  const { knowledge, appDict } = useAssist();
  const t = appDict.onboarding;
  const errText = useErrorText();
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<UrlPreview | null>(null);
  const [busy, setBusy] = useState<'preview' | 'create' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  if (!canManage(account.me.role)) {
    return (
      <Alert tone="warning">{dict.errors.api.ACCOUNT_ROLE_REQUIRED}</Alert>
    );
  }

  async function look() {
    const n = normalizeSiteUrl(raw);
    if (!n.ok) {
      setError(dict.addSite.errors[n.error]);
      setPreview(null);
      return;
    }
    setBusy('preview');
    setError(null);
    setInfo(null);
    try {
      setPreview(await knowledge.urlPreview(n.url));
    } catch (e) {
      setPreview(null);
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function tryIt() {
    if (!preview) return;
    const n = normalizeSiteUrl(preview.url || raw);
    if (!n.ok) return;
    setBusy('create');
    setError(null);
    try {
      // Адрес уже в кабинете (сайт из QA или повторный онбординг) — не
      // плодим второй сайт, ведём в песочницу существующего.
      const existing = (await api.listSites()).find((s) =>
        s.hosts.some((h) => h.host === n.host)
      );
      let siteId: string;
      if (existing) {
        siteId = existing.id;
        setInfo(t.existing);
      } else {
        const site = await api.createSite(preview.title || n.host, n.url);
        siteId = site.id;
        // Новый сайт пришёл через онбординг Помощника — подключаем его
        // сразу (хост ещё не подтверждён, поэтому обхода и трат нет).
        await knowledge.enable(siteId).catch(() => undefined);
      }
      try {
        await knowledge.createSandbox(siteId);
      } catch {
        // Ошибку (лимит, рубильник) покажет экран песочницы — у него
        // есть «Запустить заново»; сайт уже создан, повтор формы не нужен.
      }
      navigate({ name: 'sandbox', siteId }, true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="text-xs text-silver-500">{fmt(t.step, { n: 2 })}</div>
      <h1 className="text-xl font-bold tracking-tight">{t.urlTitle}</h1>
      <Card className="space-y-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void look();
          }}
        >
          <input
            value={raw}
            onChange={(e) => {
              setRaw(e.target.value);
              setPreview(null);
            }}
            placeholder={t.urlPlaceholder}
            aria-label={t.urlLabel}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="flex-1 min-w-0 rounded-lg border border-silver-300 dark:border-silver-700 bg-transparent px-3 py-2 font-mono text-sm min-h-[44px]"
          />
          <Button
            type="submit"
            variant="outline"
            loading={busy === 'preview'}
            disabled={!raw.trim()}
          >
            {t.preview}
          </Button>
        </form>
        {busy === 'preview' && (
          <div className="text-sm text-silver-500">{t.previewing}</div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
        {info && <Alert tone="accent">{info}</Alert>}
      </Card>

      {preview && (
        <Card className="space-y-2 text-sm">
          <div className="font-semibold">{t.found}</div>
          <div className="flex items-center gap-2">
            <Globe size={16} className="text-accent shrink-0" />
            <span className="font-mono break-all">{preview.host}</span>
          </div>
          <div>
            {preview.title ? fmt(t.title, { title: preview.title }) : t.noTitle}
          </div>
          {preview.lang && <div>{fmt(t.lang, { lang: preview.lang })}</div>}
          <div className="flex items-center gap-2 text-silver-500">
            <MapIcon size={16} className="shrink-0" />
            {preview.sitemapFound ? t.sitemapYes : t.sitemapNo}
          </div>
          <div className="text-xs text-silver-500 pt-1">{t.rule}</div>
          <Button
            block
            icon={<MessageSquare size={16} />}
            loading={busy === 'create'}
            onClick={tryIt}
          >
            {busy === 'create' ? t.creating : t.tryIt}
          </Button>
        </Card>
      )}

      <Button
        variant="ghost"
        block
        onClick={() => navigate({ name: 'site-new' })}
      >
        {t.skip}
      </Button>
    </div>
  );
}
