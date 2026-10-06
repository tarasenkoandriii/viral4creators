/**
 * «Голос → Мемо → Из шаблона платформы» и «Опубликовать проверенные»
 * (Э6-тер (к), ТЗ §5-бис.17 п.6, п.14): блок виден, только когда сайт —
 * WooCommerce (применён шаблон голосовой карты). Шаблон создаёт ЧЕРНОВИКИ
 * (подписи кнопок — с этого сайта) и сразу собирает версии на проверку;
 * каждое мемо проверяется на сайте в своей карточке («Перевірити на
 * сайті»), а публикуются проверенные одним нажатием (сервер публикует
 * только прошедшие прогон — остальные возвращает с причиной).
 */
import { useState } from 'react';
import { LayoutTemplate, Send } from 'lucide-react';
import { fmt, useAsync, useKit } from '../../kit';
import { Button } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import type { MemoLang } from '../../lib/memo-api';
import { useSetupErrorText } from '../../lib/use-error-text';
import { voiceControlErrorCode } from '../../lib/voice-control-api';
import { NoticeBar, type Notice } from '../knowledge/parts';

const PLATFORM_NAMES: Record<string, string> = { woocommerce: 'WooCommerce' };

export function MemoFromTemplate({
  siteId,
  full,
  onChanged,
}: {
  siteId: string;
  /** Лимит тарифа исчерпан — создавать нельзя (сервер всё равно откажет). */
  full: boolean;
  onChanged: () => void;
}) {
  const { appDict, voiceControl } = useAssist();
  const { locale } = useKit();
  const t = appDict.voiceControl.memo.template;
  const tv = appDict.voiceControl;
  const errText = useSetupErrorText();
  const api = voiceControl.memoTemplates;
  const list = useAsync(() => api.list(siteId), [api, siteId]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const d = list.data;
  if (!d || !d.platform) return null;
  const platform = d.platform;
  const name = PLATFORM_NAMES[platform] ?? platform;
  const items = d.templates.filter((x) => x.platform === platform);
  const lang = locale as MemoLang;
  const label = (key: string) => {
    const it = items.find((x) => x.key === key);
    return (it && (it.names[lang] ?? it.names.uk)) || key;
  };
  const reason = (code: string) =>
    (t.reasons as Record<string, string>)[code] ?? t.reasons.other;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const code = voiceControlErrorCode(e);
      setNotice({ tone: 'danger', text: code ? tv.errors[code] : errText(e) });
    } finally {
      setBusy(false);
      list.reload();
      onChanged();
    }
  };

  const apply = () =>
    run(async () => {
      const r = await api.apply(siteId, platform);
      const parts: string[] = [];
      if (r.created.length)
        parts.push(
          fmt(t.created, {
            list: r.created
              .map((c) => `М-${c.number} «${label(c.key)}»`)
              .join(', '),
          })
        );
      if (r.rejected.length)
        parts.push(
          fmt(t.rejected, {
            list: r.rejected
              .map((x) => `«${label(x.key)}» — ${reason(x.code)}`)
              .join(', '),
          })
        );
      if (r.unresolved.length)
        parts.push(
          fmt(t.unresolved, {
            list: r.unresolved.map((u) => `«${label(u.key)}»`).join(', '),
          })
        );
      setNotice({
        tone:
          r.rejected.length || r.unresolved.length || !r.created.length
            ? 'warning'
            : 'success',
        text: parts.join(' '),
      });
      setOpen(false);
    });

  const publish = () =>
    run(async () => {
      const r = await api.publishBatch(siteId);
      const ok = r.results.filter((x) => x.ok).length;
      const bad = r.results.filter((x) => !x.ok);
      const parts = [fmt(t.publishedBatch, { ok, n: r.results.length })];
      if (bad.length)
        parts.push(
          fmt(t.notPublished, {
            list: bad
              .map((x) => `М-${x.number} — ${reason(x.code ?? 'other')}`)
              .join(', '),
          })
        );
      setNotice({
        tone: bad.length ? 'warning' : 'success',
        text: parts.join(' '),
      });
    });

  return (
    <div className="space-y-2">
      <NoticeBar notice={notice} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          icon={<LayoutTemplate size={16} />}
          disabled={busy}
          onClick={() => setOpen(!open)}
        >
          {fmt(t.open, { platform: name })}
        </Button>
        <Button
          variant="outline"
          icon={<Send size={16} />}
          loading={busy}
          disabled={busy}
          onClick={() => void publish()}
        >
          {t.publishChecked}
        </Button>
      </div>
      {open && (
        <div className="space-y-2 rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs">
          <p className="text-silver-500">{fmt(t.intro, { platform: name })}</p>
          <ul className="list-disc pl-5 space-y-1">
            {items.map((it) => (
              <li key={it.key}>
                «{it.names[lang] ?? it.names.uk ?? it.key}»
                {it.goal[lang] ? ` — ${it.goal[lang]}` : ''}
                {it.exists ? (
                  <span className="text-silver-500"> · {t.exists}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <Button
            loading={busy}
            disabled={busy || full}
            onClick={() => void apply()}
          >
            {t.create}
          </Button>
        </div>
      )}
    </div>
  );
}
