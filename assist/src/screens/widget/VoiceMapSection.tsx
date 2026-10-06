/**
 * Раздел «Голосовая карта» (Э6-тер, ТЗ §5-кватер.9, §5-кватер.12–13; В-49,
 * В-50): «Открыть редактор на сайте» (одноразовая ссылка во внешнем
 * браузере), сводка черновика и ворот, версии с диффом и отчётом ворот,
 * ПУБЛИКАЦИЯ — только здесь (панель редактора на сайте лишь присылает
 * запрос), «Вернуть версию N», «Завершить все сессии», экспорт/импорт JSON.
 * Режим «Снимок» (скриншот публичной страницы в TMA) — с браузерным
 * воркером Ш3 (В-58), здесь его нет.
 */
import { useRef, useState } from 'react';
import { Download, ExternalLink, ShieldOff, Upload } from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Badge, Button } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { openExternal } from '../../lib/open-link';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  voiceMapErrorCode,
  type MapVersionDetail,
  type MapVersionStatus,
} from '../../lib/voice-map-api';
import { NoticeBar, type Notice } from '../knowledge/parts';

function tone(s: MapVersionStatus) {
  return s === 'published'
    ? 'success'
    : s === 'held'
      ? 'warning'
      : s === 'discarded'
        ? 'danger'
        : 'neutral';
}

export function VoiceMapSection({ siteId }: { siteId: string }) {
  const { appDict, voiceControl } = useAssist();
  const { locale } = useKit();
  const t = appDict.voiceControl.voiceMap;
  const errText = useSetupErrorText();
  const sum = useAsync(
    () => voiceControl.voiceMap.summary(siteId),
    [voiceControl, siteId]
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState<MapVersionDetail | null>(null);
  const file = useRef<HTMLInputElement | null>(null);
  if (!sum.data) return null;
  const s = sum.data;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const code = voiceMapErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
      sum.reload();
    }
  };

  const g = s.draftGates;
  return (
    <div className="space-y-2 rounded-xl border border-silver-200 dark:border-silver-800 p-3">
      <div className="font-semibold text-sm flex items-center justify-between gap-2">
        <span>{t.title}</span>
        <Badge tone={s.publishedVersion ? 'success' : 'neutral'}>
          {s.publishedVersion
            ? fmt(t.published, { v: s.publishedVersion })
            : '—'}
        </Badge>
      </div>
      <p className="text-xs text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      <Button
        icon={<ExternalLink size={16} />}
        loading={busy}
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const l = await voiceControl.voiceMap.editorLink(siteId, {});
            openExternal(l.url);
          })
        }
      >
        {t.open}
      </Button>
      <p className="text-[11px] text-silver-500">{t.linkHint}</p>
      {!s.publishedVersion && <p className="text-xs">{t.none}</p>}
      <p className="text-xs">
        {fmt(t.draft, {
          t: s.targets,
          d: s.denylisted,
          s: s.templates,
          f: s.fragile,
        })}
      </p>
      {s.draftDirty && <p className="text-xs text-amber-600">{t.dirty}</p>}
      <p className="text-xs">
        {g.ok ? t.gatesOk : fmt(t.gatesBad, { n: g.problems.length })}
      </p>
      {!g.ok && (
        <ul className="text-xs list-disc pl-5">
          {g.problems.slice(0, 10).map((p, i) => (
            <li key={i}>
              {t.gates[p.code]}
              {p.key ? ` · ${p.key}` : ''}
              {p.phrase ? ` · «${p.phrase}»` : ''}
            </li>
          ))}
        </ul>
      )}
      {s.templateSuggestions.length > 0 && (
        <p className="text-[11px] text-silver-500">
          {fmt(t.templates, {
            list: s.templateSuggestions
              .slice(0, 5)
              .map((x) => `${x.pathPattern} (${x.pages})`)
              .join(', '),
          })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const v = await voiceControl.voiceMap.build(siteId);
              setOpen(v);
            })
          }
        >
          {t.build}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const n = await voiceControl.voiceMap.platformTemplate(
                siteId,
                'woocommerce',
                s.draftRevision
              );
              setNotice({
                tone: 'success',
                text: fmt(t.platformAdded, { n }),
              });
            })
          }
        >
          {t.platformWoo}
        </Button>
        <Button
          variant="outline"
          icon={<Download size={16} />}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const f = await voiceControl.voiceMap.exportFile(siteId);
              const blob = new Blob([f.json], { type: 'application/json' });
              const a = document.createElement('a');
              a.href = URL.createObjectURL(blob);
              a.download = f.name;
              a.click();
              URL.revokeObjectURL(a.href);
            })
          }
        >
          {t.export}
        </Button>
        <Button
          variant="outline"
          icon={<Upload size={16} />}
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          {t.import}
        </Button>
        <input
          ref={file}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            void run(async () => {
              const json: unknown = JSON.parse(await f.text());
              const r = await voiceControl.voiceMap.importFile(
                siteId,
                s.draftRevision,
                json
              );
              // Э6-тер (к): мемо файла — черновики с новыми номерами; отказы
              // (опасный шаг, имя занято, лимит тарифа) — с причиной.
              const mr = r.memos.rejected;
              const why = (code: string) =>
                (t.importReasons as Record<string, string>)[code] ??
                (appDict.voiceControl.memo.gates as Record<string, string>)[
                  code
                ] ??
                t.importReasons.other;
              const parts = [
                fmt(t.imported, {
                  a: r.accepted,
                  r: r.rejected,
                  s: r.signed ? t.importSigned : '',
                }),
              ];
              if (r.memos.created.length || mr.length)
                parts.push(
                  fmt(t.importMemos, {
                    c: r.memos.created.length,
                    r: mr.length,
                  })
                );
              if (mr.length)
                parts.push(
                  fmt(t.importMemoRejected, {
                    list: mr
                      .map(
                        (x) => `${x.key ?? `#${x.index + 1}`} — ${why(x.code)}`
                      )
                      .join(', '),
                  })
                );
              setNotice({
                tone: r.rejected || mr.length ? 'warning' : 'success',
                text: parts.join(' '),
              });
            });
          }}
        />
      </div>
      <div className="text-xs flex items-center justify-between gap-2">
        <span>{fmt(t.sessions, { n: s.activeSessions })}</span>
        {s.activeSessions > 0 && (
          <Button
            variant="ghost"
            icon={<ShieldOff size={14} />}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await voiceControl.voiceMap.revokeSessions(siteId);
                setNotice({ tone: 'success', text: t.revoked });
              })
            }
          >
            {t.revoke}
          </Button>
        )}
      </div>
      {s.versions.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">{t.versions}</div>
          {s.versions.map((v) => (
            <div
              key={v.number}
              className="rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <span>
                  v{v.number} ·{' '}
                  {fmt(t.diff, {
                    a: v.diff.added,
                    c: v.diff.changed,
                    r: v.diff.removed,
                  })}
                  {v.requestedVia === 'editor' ? ` · ${t.viaEditor}` : ''}
                </span>
                <Badge tone={tone(v.status)}>{t.status[v.status]}</Badge>
              </div>
              <div className="text-silver-500">
                {formatDate(v.publishedAt ?? v.createdAt, locale)} ·{' '}
                {v.ok ? t.gatesOk : fmt(t.gatesBad, { n: v.problems })}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  onClick={() =>
                    void run(async () =>
                      setOpen(
                        open?.number === v.number
                          ? null
                          : await voiceControl.voiceMap.version(
                              siteId,
                              v.number
                            )
                      )
                    )
                  }
                >
                  …
                </Button>
                {v.status === 'checking' && (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await voiceControl.voiceMap.publish(siteId, v.number);
                        setNotice({
                          tone: 'success',
                          text: fmt(t.publishedOk, { n: v.number }),
                        });
                      })
                    }
                  >
                    {t.publish}
                  </Button>
                )}
                {(v.status === 'checking' || v.status === 'held') && (
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await voiceControl.voiceMap.discard(siteId, v.number);
                      })
                    }
                  >
                    {t.discard}
                  </Button>
                )}
                {v.status === 'published' &&
                  v.number !== s.publishedVersion && (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setOpen(
                            await voiceControl.voiceMap.rollback(
                              siteId,
                              v.number
                            )
                          );
                        })
                      }
                    >
                      {t.rollback}
                    </Button>
                  )}
              </div>
              {open?.number === v.number && (
                <ul className="list-disc pl-5">
                  {open.targets.map((x) => (
                    <li key={x.key}>
                      {x.name || x.key} · {x.key} · {x.scope} · {x.risk}
                      {x.denylisted ? ' · ⛔' : ''}
                      {open.diffKeys.added.includes(x.key) ? ' · +' : ''}
                      {open.diffKeys.changed.includes(x.key) ? ' · ~' : ''}
                    </li>
                  ))}
                  {open.diffKeys.removed.map((k) => (
                    <li key={`r-${k}`}>− {k}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
