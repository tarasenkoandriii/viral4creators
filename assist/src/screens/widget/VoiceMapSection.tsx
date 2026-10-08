/**
 * Раздел «Голосовая карта» (Э6-тер, ТЗ §5-кватер.9, §5-кватер.12–13; В-49,
 * В-50): «Открыть редактор на сайте» (одноразовая ссылка во внешнем
 * браузере), сводка черновика и ворот, версии с диффом и отчётом ворот,
 * ПУБЛИКАЦИЯ — только здесь (панель редактора на сайте лишь присылает
 * запрос), «Вернуть версию N», «Завершить все сессии», экспорт/импорт JSON.
 * Заход 9: режим «Снимок» (Ш3-хвост (4), ТЗ §5-кватер.2 — скриншот
 * публичной страницы воркером, рамки элементов, касание → карточка цели:
 * имя, «в карту»/«запретить», «открыть в редакторе»), сверка версии
 * воркером с сухим прогоном (§5-кватер.10) в «Версиях», «отчёт для
 * разработчика» — ссылка только на чтение (§5-кватер.4).
 */
import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Copy,
  Download,
  ExternalLink,
  FileText,
  ShieldOff,
  Upload,
} from 'lucide-react';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Badge, Button, inputClass } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { PUBLIC_API_BASE } from '../../lib/config';
import { openExternal } from '../../lib/open-link';
import { useSetupErrorText } from '../../lib/use-error-text';
import {
  snapshotDescriptor,
  voiceMapErrorCode,
  type MapVersionDetail,
  type MapVersionStatus,
  type SnapshotElement,
  type SnapshotView,
  type WorkerCheckView,
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
      <SnapshotPanel siteId={siteId} host={s.hosts[0] ?? null} />
      <DevReportPanel siteId={siteId} />
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
                {(v.status === 'checking' || v.status === 'published') && (
                  <CheckButton siteId={siteId} n={v.number} />
                )}
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

const pathOf = (url: string | null): string => {
  try {
    return url ? new URL(url).pathname : '/';
  } catch {
    return '/';
  }
};

/** Ключ цели из элемента «Снимка»: разметка или латиница подписи. */
function mapKeyOf(e: SnapshotElement): string {
  const base = (e.assistId ?? e.text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return base.length >= 2 ? base : `target-${e.ref.replace(/[^a-z0-9]/gi, '')}`;
}

/**
 * Режим «Снимок» (§5-кватер.2): воркер снимает публичную страницу
 * подтверждённого хоста без cookie и кликов; рамки — интерактивные
 * элементы; касание рамки — карточка цели (имя → в черновик карты,
 * «запретить», «открыть в редакторе» на этой странице). Риск и разбор
 * дескриптора — на сервере (как у панели редактора).
 */
function SnapshotPanel({
  siteId,
  host,
}: {
  siteId: string;
  host: string | null;
}) {
  const { appDict, voiceControl } = useAssist();
  const { locale } = useKit();
  const t = appDict.voiceControl.voiceMap;
  const errText = useSetupErrorText();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(host ? `https://${host}/` : 'https://');
  const [vp, setVp] = useState<'mobile' | 'desktop'>('mobile');
  const [view, setView] = useState<SnapshotView | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<SnapshotElement | null>(null);
  const [name, setName] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );
  const fail = (e: unknown) => {
    const code = voiceMapErrorCode(e);
    setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
  };
  const poll = (sid: string, left: number) => {
    timer.current = window.setTimeout(async () => {
      try {
        const v = await voiceControl.voiceMap.snapshotView(siteId, sid);
        setView(v);
        if ((v.status === 'queued' || v.status === 'running') && left > 0)
          poll(sid, left - 1);
        else setBusy(false);
      } catch (e) {
        setBusy(false);
        fail(e);
      }
    }, 2_000);
  };
  const take = async () => {
    setBusy(true);
    setNotice(null);
    setSel(null);
    setView(null);
    try {
      poll(await voiceControl.voiceMap.snapshot(siteId, url.trim(), vp), 45);
    } catch (e) {
      setBusy(false);
      fail(e);
    }
  };
  const add = async (deny: boolean) => {
    if (!sel || !view) return;
    setNotice(null);
    try {
      const key = mapKeyOf(sel);
      const rev = await voiceControl.voiceMap.draftRevision(siteId);
      await voiceControl.voiceMap.patch(siteId, rev, [
        {
          op: 'upsert-target',
          target: {
            key,
            scope: 'page',
            pagePath: pathOf(view.url),
            descriptor: snapshotDescriptor(sel, host),
            names: deny || !name.trim() ? {} : { [locale]: name.trim() },
            denylisted: deny,
          },
        },
      ]);
      setNotice({ tone: 'success', text: fmt(t.snap.added, { k: key }) });
      setSel(null);
    } catch (e) {
      fail(e);
    }
  };
  if (!open)
    return (
      <Button
        variant="outline"
        icon={<Camera size={16} />}
        onClick={() => setOpen(true)}
      >
        {t.snap.title}
      </Button>
    );
  const vw = view?.viewport ?? null;
  return (
    <div className="space-y-2 rounded-lg border border-silver-200 dark:border-silver-800 p-2">
      <div className="text-xs font-medium">{t.snap.title}</div>
      <p className="text-[11px] text-silver-500">{t.snap.hint}</p>
      <NoticeBar notice={notice} />
      <input
        className={inputClass}
        value={url}
        aria-label={t.snap.url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        {(['mobile', 'desktop'] as const).map((x) => (
          <Button
            key={x}
            variant={vp === x ? 'solid' : 'outline'}
            onClick={() => setVp(x)}
          >
            {t.snap[x]}
          </Button>
        ))}
        <Button loading={busy} disabled={busy} onClick={() => void take()}>
          {t.snap.take}
        </Button>
      </div>
      {busy && <p className="text-xs">{t.snap.wait}</p>}
      {view && (view.status === 'failed' || view.status === 'cancelled') && (
        <p className="text-xs text-red-600">
          {fmt(t.snap.failed, { c: view.errorCode ?? '—' })}
        </p>
      )}
      {view && view.status === 'done' && vw && (
        <div className="relative w-full overflow-hidden rounded border border-silver-200 dark:border-silver-800">
          {view.screenshot ? (
            <img src={view.screenshot.url} alt="" className="block w-full" />
          ) : (
            <div
              className="w-full bg-silver-100 dark:bg-silver-900 text-[11px] p-2"
              style={{ aspectRatio: `${vw.width} / ${vw.height}` }}
            >
              {t.snap.none}
            </div>
          )}
          {view.elements
            .filter((e) => e.box)
            .map((e) => (
              <button
                key={e.ref}
                type="button"
                title={e.text}
                aria-label={e.text || e.tag}
                onClick={() => {
                  setSel(e);
                  setName(e.text.slice(0, 60));
                }}
                className={`absolute border-2 rounded ${sel?.ref === e.ref ? 'border-orange-500 bg-orange-500/20' : e.assistId ? 'border-green-600/80' : 'border-amber-500/80'}`}
                style={{
                  left: `${(e.box!.x / vw.width) * 100}%`,
                  top: `${(e.box!.y / vw.height) * 100}%`,
                  width: `${(e.box!.w / vw.width) * 100}%`,
                  height: `${(e.box!.h / vw.height) * 100}%`,
                }}
              />
            ))}
        </div>
      )}
      {sel && (
        <div className="space-y-2 rounded-lg border border-silver-200 dark:border-silver-800 p-2 text-xs">
          <div>
            «{sel.text || '—'}» · {sel.role || sel.tag}
            {sel.assistId ? ` · data-assist-id="${sel.assistId}"` : ''}
          </div>
          <input
            className={inputClass}
            value={name}
            maxLength={60}
            aria-label={t.snap.name}
            placeholder={t.snap.name}
            onChange={(e) => setName(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void add(false)}>{t.snap.add}</Button>
            <Button variant="outline" onClick={() => void add(true)}>
              {t.snap.deny}
            </Button>
            <Button
              variant="outline"
              icon={<ExternalLink size={14} />}
              onClick={() =>
                void voiceControl.voiceMap
                  .editorLink(siteId, { path: pathOf(view?.url ?? null) })
                  .then((l) => openExternal(l.url))
                  .catch(fail)
              }
            >
              {t.snap.editor}
            </Button>
            <Button variant="ghost" onClick={() => setSel(null)}>
              {t.snap.close}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Сверка версии воркером: дескрипторы, сухой прогон, отпечатки (§5-кватер.10). */
function CheckButton({ siteId, n }: { siteId: string; n: number }) {
  const { appDict, voiceControl } = useAssist();
  const t = appDict.voiceControl.voiceMap;
  const errText = useSetupErrorText();
  const [view, setView] = useState<WorkerCheckView | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    []
  );
  const load = async (left: number) => {
    try {
      const v = await voiceControl.voiceMap.workerCheckView(siteId, n);
      setView(v);
      if ((v.status === 'queued' || v.status === 'running') && left > 0)
        timer.current = window.setTimeout(() => void load(left - 1), 3_000);
      else setBusy(false);
    } catch (e) {
      let err: unknown = e;
      // Сверки не было (автозапуск выключен) — запускаем по кнопке.
      if (voiceMapErrorCode(e) === 'VOICE_MAP_CHECK_NOT_FOUND' && left > 40) {
        try {
          await voiceControl.voiceMap.workerCheck(siteId, n);
          timer.current = window.setTimeout(() => void load(40), 3_000);
          return;
        } catch (e2) {
          err = e2;
        }
      }
      setBusy(false);
      const c2 = voiceMapErrorCode(err);
      setErr(c2 ? t.errors[c2] : errText(err));
    }
  };
  const r = view?.report ?? null;
  return (
    <>
      <Button
        variant="ghost"
        loading={busy}
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setErr('');
          void load(41);
        }}
      >
        {t.check.run}
      </Button>
      {busy && <span className="text-[11px]">{t.check.wait}</span>}
      {err && <span className="text-[11px] text-red-600">{err}</span>}
      {r && (
        <div className="w-full text-[11px] space-y-1">
          <div>
            {fmt(t.check.result, {
              p: r.pages,
              pf: r.pagesFailed,
              l: r.lost,
              f: r.fragile,
            })}
          </div>
          {r.dryRun && (
            <>
              <div>
                {fmt(t.check.dry, {
                  o: r.dryRun.ok,
                  x: r.dryRun.failed,
                  s: r.dryRun.skipped,
                })}
              </div>
              <div className={r.dryRun.forbiddenBlocked ? '' : 'text-red-600'}>
                {r.dryRun.forbiddenBlocked
                  ? t.check.forbiddenOk
                  : t.check.forbiddenBad}
              </div>
              {r.dryRun.problems.length > 0 && (
                <ul className="list-disc pl-5">
                  {r.dryRun.problems.map((x, i) => (
                    <li key={i}>
                      «{x.text}» → {x.key} ·{' '}
                      {(t.check.outcomes as Record<string, string>)[
                        x.outcome
                      ] ?? x.outcome}{' '}
                      · {x.path}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {r.mixed.map((m) => (
            <div key={m.pathPattern} className="text-amber-600">
              {fmt(t.check.mixed, {
                m: m.pathPattern,
                list: m.paths.join(', '),
              })}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** «Отчёт для разработчика» — ссылка только на чтение (§5-кватер.4). */
function DevReportPanel({ siteId }: { siteId: string }) {
  const { appDict, voiceControl } = useAssist();
  const { locale } = useKit();
  const t = appDict.voiceControl.voiceMap;
  const errText = useSetupErrorText();
  const [link, setLink] = useState<{
    url: string;
    until: string;
    t: number;
    m: number;
  } | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  // Аудит P3: живая ссылка видна при открытии экрана (срок, просмотры).
  const status = useAsync(
    () => voiceControl.voiceMap.devReportStatus(siteId),
    [voiceControl, siteId]
  );
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      const code = voiceMapErrorCode(e);
      setNotice({ tone: 'danger', text: code ? t.errors[code] : errText(e) });
    } finally {
      setBusy(false);
      status.reload();
    }
  };
  const live = status.data ?? null;
  return (
    <div className="space-y-1">
      <Button
        variant="outline"
        icon={<FileText size={16} />}
        loading={busy}
        disabled={busy}
        onClick={() =>
          void act(async () => {
            const r = await voiceControl.voiceMap.devReport(siteId);
            setLink({
              url: `${PUBLIC_API_BASE.replace(/\/+$/, '')}${r.path}?lang=${locale}`,
              until: r.expiresAt,
              t: r.targets,
              m: r.missing,
            });
          })
        }
      >
        {t.dev.make}
      </Button>
      <p className="text-[11px] text-silver-500">{t.dev.hint}</p>
      <NoticeBar notice={notice} />
      {live && !link && (
        <div className="text-xs flex items-center justify-between gap-2">
          <span>
            {fmt(t.dev.live, {
              d: formatDate(live.expiresAt, locale),
              n: live.views,
            })}
          </span>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await voiceControl.voiceMap.revokeDevReport(siteId);
                setNotice({ tone: 'success', text: t.dev.revoked });
              })
            }
          >
            {t.dev.revoke}
          </Button>
        </div>
      )}
      {link && (
        <div className="text-xs space-y-1">
          <div>
            {fmt(t.dev.made, {
              t: link.t,
              m: link.m,
              d: formatDate(link.until, locale),
            })}
          </div>
          <code className="block break-all text-[11px]">{link.url}</code>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              icon={<Copy size={14} />}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(link.url)
                  .then(() =>
                    setNotice({ tone: 'success', text: t.dev.copied })
                  )
              }
            >
              {t.dev.copy}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await voiceControl.voiceMap.revokeDevReport(siteId);
                  setLink(null);
                  setNotice({ tone: 'success', text: t.dev.revoked });
                })
              }
            >
              {t.dev.revoke}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
