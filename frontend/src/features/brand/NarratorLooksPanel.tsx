import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  ConfirmDialog,
  Field,
  Select,
} from '../../components/ui';
import { api } from '../../services/api';
import { getAuthHeaders } from '../../lib/telegram';
import { storyErrorText } from '../stories/story-errors';
import {
  activeLabel,
  consentTitle,
  generationOffer,
  isHiddenForUser,
  isImageTooLarge,
  itemAction,
  lookTitle,
  MAKEUP_LABEL,
  modeKeepNote,
  modeLabel,
  narratorLookImagePath,
  narratorLooksPath,
  needsRepeatConfirm,
  OUTFIT_LABEL,
  PROBLEM_TEXT,
  previewAsset,
  quotaLine,
  statusText,
  type NarratorLookItem,
  type NarratorLooksState,
} from './narrator-looks';

type Created = { look: NarratorLookItem; reused: boolean };
type Confirm = { kind: 'revoke' } | { kind: 'delete'; item: NarratorLookItem };
/** Большое превью — байтами мимо JSON-конверта (тот же гард владельца). */
async function fetchRawImage(path: string): Promise<string> {
  const base = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api';
  const res = await fetch(`${base}${path}`, {
    headers: getAuthHeaders(),
    credentials: 'include',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error('image');
  return URL.createObjectURL(await res.blob());
}
const errorText = (e: unknown) =>
  storyErrorText(e, {
    noResponse:
      'Ответ сервера не получен. Обновите блок: действие могло выполниться — платный повтор без вашего подтверждения не запускается.',
  });

/**
 * «Образ для сказок» (Story‑Tales, WP5): согласие на синтетический образ,
 * варианты одежды и лёгкого макияжа с предпросмотром, явное «применить»
 * и откат к оригиналу. Блок только для владельца Story: сервер отвечает
 * 404 всем остальным — тогда блок не показывается вовсе. Анимации нет:
 * вступление Story пока статичное.
 */
export function NarratorLooksPanel({
  manifestId,
  narratorCharacterId,
}: {
  manifestId: string;
  narratorCharacterId: string | null;
}) {
  const [state, setState] = useState<NarratorLooksState | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [outfit, setOutfit] = useState('cozy-home');
  const [makeup, setMakeup] = useState('none');
  const [consentChecked, setConsentChecked] = useState(false);
  const [repeatChecked, setRepeatChecked] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [restyleRepeat, setRestyleRepeat] = useState<Record<string, boolean>>(
    {}
  );
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const confirmReturn = useRef<HTMLElement | null>(null);
  const lock = useRef(false);
  const askConfirm = (next: Confirm) => {
    confirmReturn.current = document.activeElement as HTMLElement | null;
    setConfirm(next);
  };
  const closeConfirm = () => {
    setConfirm(null);
    const back = confirmReturn.current;
    confirmReturn.current = null;
    // Фокус — туда, откуда открыли диалог (если кнопка ещё на странице).
    if (back?.isConnected) setTimeout(() => back.focus(), 0);
  };

  const load = useCallback(async () => {
    try {
      const res = await api.get<NarratorLooksState>(
        narratorLooksPath(manifestId)
      );
      if (res.data) setState(res.data);
    } catch (e) {
      if (isHiddenForUser(e)) setHidden(true);
      else setError(errorText(e));
    }
  }, [manifestId]);

  useEffect(() => {
    void load();
  }, [load, narratorCharacterId]);

  // Превью: байты приватные (Postgres), отдаются только владельцу.
  // Ключ — вариант+ассет: файл варианта неизменен, качаем один раз.
  const requested = useRef(new Set<string>());
  const mounted = useRef(true);
  const blobUrls = useRef<string[]>([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      blobUrls.current.forEach((u) => URL.revokeObjectURL(u));
      blobUrls.current = [];
    };
  }, []);
  useEffect(() => {
    if (!state) return;
    for (const item of state.items) {
      const asset = previewAsset(item);
      const key = `${item.id}:${asset}`;
      if (!asset || requested.current.has(key)) continue;
      requested.current.add(key);
      const put = (src: string) => setPreviews((p) => ({ ...p, [key]: src }));
      void api
        .get<{ base64: string; mime: string }>(
          narratorLookImagePath(manifestId, item.id, asset)
        )
        .then((r) => {
          if (mounted.current && r.data)
            put(`data:${r.data.mime};base64,${r.data.base64}`);
        })
        .catch(async (e) => {
          if (!isImageTooLarge(e)) throw e;
          const url = await fetchRawImage(
            narratorLookImagePath(manifestId, item.id, asset, true)
          );
          if (!mounted.current) {
            URL.revokeObjectURL(url);
            return;
          }
          blobUrls.current.push(url);
          put(url);
        })
        .catch(() => {
          requested.current.delete(key);
        });
    }
  }, [state, manifestId]);

  const run = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
      await load();
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  const setView = (r: { data?: NarratorLooksState }) => {
    if (r.data) setState(r.data);
  };

  if (hidden || !state) return null;

  const offer = generationOffer(state, outfit, makeup);
  const repeatNeeded = needsRepeatConfirm(state, outfit, makeup);
  const ch = state.character;

  return (
    <section className="space-y-3 border-t border-white/10 pt-4">
      <h3 className="font-medium">Образ для сказок</h3>
      <p className="text-xs text-silver-400">
        Одежда и лёгкий макияж — отдельные производные изображения от фото
        рассказчика. Оригинал не меняется; вариант становится активным только
        после «Применить». Анимация выключена — во вступлении сказки
        используется статичный образ.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <div className="rounded-xl bg-white/5 p-3 text-sm space-y-1">
        <p>
          Активный образ: <strong>{activeLabel(state)}</strong>
        </p>
        <p className="text-xs text-silver-400">
          Режим персонажа сейчас: {ch ? modeLabel(ch.mode) : 'не выбран'}
          {ch?.sketchRendering === 'stylized' && ' (стилизованный)'}.
        </p>
        {state.active.modeChanged && (
          <p className="text-xs text-amber-300">
            Режим персонажа сменился после применения: в сказке остаётся
            одобренный образ ({modeLabel(state.active.mode)}). Перестилизуйте
            вариант ниже, если нужен новый режим.
          </p>
        )}
        {state.active.problem && (
          <Alert tone="warning">
            {PROBLEM_TEXT[state.active.problem]} Новые рендеры с этим образом не
            запустятся — подмены оригиналом без вашего действия нет.
          </Alert>
        )}
        {state.active.kind === 'variant' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setView(
                  await api.post<NarratorLooksState>(
                    narratorLooksPath(manifestId, '/revert')
                  )
                );
              })
            }
          >
            Вернуть оригинал
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Согласие на синтетический образ</h4>
        <p className="text-xs text-silver-400">{state.consent.text}</p>
        {state.consent.active ? (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-emerald-300">
              Согласие ({consentTitle(state.consent.acceptedVersion)}) действует
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => askConfirm({ kind: 'revoke' })}
            >
              Отозвать согласие
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {state.consent.revokedAt && (
              <p className="text-xs text-amber-300">
                Согласие отозвано: прежние варианты недоступны для сказок
                навсегда — новое согласие их не вернёт, понадобятся новые
                варианты.
              </p>
            )}
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={consentChecked}
                disabled={busy}
                onChange={(e) => setConsentChecked(e.target.checked)}
              />
              Подтверждаю текст согласия ({consentTitle(state.consent.version)})
            </label>
            <Button
              size="sm"
              disabled={busy || !consentChecked}
              onClick={() =>
                void run(async () => {
                  setView(
                    await api.post<NarratorLooksState>(
                      narratorLooksPath(manifestId, '/consent'),
                      { version: state.consent.version, accepted: true }
                    )
                  );
                  setConsentChecked(false);
                })
              }
            >
              Дать согласие
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-sm font-medium">Новый вариант</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label="Одежда" htmlFor="narrator-outfit">
            <Select
              id="narrator-outfit"
              value={outfit}
              disabled={busy}
              onChange={(e) => {
                setOutfit(e.target.value);
                setRepeatChecked(false);
              }}
            >
              {state.presets.outfits.map((o) => (
                <option key={o} value={o}>
                  {OUTFIT_LABEL[o] ?? o}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Макияж" htmlFor="narrator-makeup">
            <Select
              id="narrator-makeup"
              value={makeup}
              disabled={busy}
              onChange={(e) => {
                setMakeup(e.target.value);
                setRepeatChecked(false);
              }}
            >
              {state.presets.makeups.map((m) => (
                <option key={m} value={m}>
                  {MAKEUP_LABEL[m] ?? m}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <p className="text-xs text-silver-400">{modeKeepNote(state)}</p>
        <p className="text-xs text-silver-400">
          {offer.priceLine} · {quotaLine(state.quota)}
        </p>
        {repeatNeeded && !offer.existing && (
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={repeatChecked}
              disabled={busy}
              onChange={(e) => setRepeatChecked(e.target.checked)}
            />
            Прошлая такая же попытка не удалась или её исход неизвестен.
            Повторить (оплачивается заново)
          </label>
        )}
        {offer.disabledReason && (
          <p className="text-xs text-amber-300">{offer.disabledReason}</p>
        )}
        {offer.existing ? (
          <Button
            size="sm"
            disabled={busy || offer.existing.active}
            onClick={() =>
              void run(async () => {
                setView(
                  await api.post<NarratorLooksState>(
                    narratorLooksPath(
                      manifestId,
                      `/${encodeURIComponent(offer.existing!.id)}/apply`
                    )
                  )
                );
              })
            }
          >
            {offer.existing.active
              ? 'Такой вариант уже активен'
              : 'Такой вариант уже есть — применить без оплаты'}
          </Button>
        ) : (
          <Button
            size="sm"
            loading={busy}
            disabled={
              busy || !!offer.disabledReason || (repeatNeeded && !repeatChecked)
            }
            onClick={() =>
              void run(async () => {
                const res = await api.post<Created>(
                  narratorLooksPath(manifestId),
                  {
                    outfit,
                    makeup,
                    maxReserveMicroUsd: offer.reserveMicroUsd,
                    ...(repeatNeeded ? { repeat: true } : {}),
                  }
                );
                setRepeatChecked(false);
                setNotice(
                  res.data?.reused
                    ? 'Такой вариант уже был — возвращён без оплаты.'
                    : 'Вариант готов. Посмотрите превью и примените, если нравится.'
                );
                await load();
              })
            }
          >
            Сгенерировать вариант
          </Button>
        )}
      </div>

      {state.items.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {state.items.map((item) => {
            const asset = previewAsset(item);
            const src = asset ? previews[`${item.id}:${asset}`] : undefined;
            const action = itemAction(state, item);
            return (
              <div
                key={item.id}
                className={`space-y-1 rounded-xl p-2 text-xs ${
                  item.active
                    ? 'bg-white/15 ring-1 ring-white/40'
                    : 'bg-white/5'
                }`}
              >
                {src ? (
                  <img
                    src={src}
                    alt={lookTitle(item)}
                    className="aspect-square w-full rounded-lg object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full rounded-lg bg-white/5" />
                )}
                <p className="font-medium">{lookTitle(item)}</p>
                <p className="text-silver-400">
                  {item.style ? modeLabel(item.style) : 'фото'} ·{' '}
                  {statusText(item)}
                </p>
                {action.kind === 'blocked' && (
                  <p className="text-amber-300">{action.reason}</p>
                )}
                {action.kind === 'restyle' && action.repeatNeeded && (
                  <label className="flex gap-2">
                    <input
                      type="checkbox"
                      checked={!!restyleRepeat[item.id]}
                      disabled={busy}
                      onChange={(e) =>
                        setRestyleRepeat((r) => ({
                          ...r,
                          [item.id]: e.target.checked,
                        }))
                      }
                    />
                    Прошлая перестилизация не удалась или её исход неизвестен.
                    Повторить (оплачивается заново)
                  </label>
                )}
                <div className="flex flex-wrap gap-1">
                  {(action.kind === 'apply' || action.kind === 'restyle') && (
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        (action.kind === 'restyle' &&
                          action.repeatNeeded &&
                          !restyleRepeat[item.id])
                      }
                      onClick={() =>
                        void run(async () => {
                          if (action.kind === 'apply') {
                            setView(
                              await api.post<NarratorLooksState>(
                                narratorLooksPath(
                                  manifestId,
                                  `/${encodeURIComponent(item.id)}/apply`
                                )
                              )
                            );
                            return;
                          }
                          const res = await api.post<Created>(
                            narratorLooksPath(
                              manifestId,
                              `/${encodeURIComponent(item.id)}/restyle`
                            ),
                            {
                              maxReserveMicroUsd: action.reserveMicroUsd,
                              ...(action.repeatNeeded ? { repeat: true } : {}),
                            }
                          );
                          setRestyleRepeat((r) => ({ ...r, [item.id]: false }));
                          setNotice(
                            res.data?.reused
                              ? 'Такой стилизованный вариант уже был — возвращён без оплаты.'
                              : 'Стилизованный вариант готов — примените его.'
                          );
                          await load();
                        })
                      }
                    >
                      {action.label}
                    </Button>
                  )}
                  {action.kind === 'active' && (
                    <span className="text-emerald-300">{action.label}</span>
                  )}
                  {item.status !== 'PENDING' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => askConfirm({ kind: 'delete', item })}
                    >
                      Удалить
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        busy={busy}
        title={
          confirm?.kind === 'revoke'
            ? 'Отозвать согласие на синтетический образ?'
            : `Удалить вариант «${confirm?.kind === 'delete' ? lookTitle(confirm.item) : ''}»?`
        }
        confirmLabel={
          confirm?.kind === 'revoke' ? 'Отозвать согласие' : 'Удалить вариант'
        }
        onCancel={closeConfirm}
        onConfirm={() => {
          const current = confirm;
          if (!current) return;
          void run(async () => {
            setView(
              current.kind === 'revoke'
                ? await api.deleteWithBody<NarratorLooksState>(
                    narratorLooksPath(manifestId, '/consent')
                  )
                : await api.deleteWithBody<NarratorLooksState>(
                    narratorLooksPath(
                      manifestId,
                      `/${encodeURIComponent(current.item.id)}`
                    )
                  )
            );
          }).finally(closeConfirm);
        }}
      >
        {confirm?.kind === 'revoke' ? (
          <>
            Все созданные варианты станут недоступны для сказок навсегда:
            повторное согласие их не вернёт — понадобятся новые платные
            генерации.
            {state.active.kind === 'variant' &&
              ' Активный вариант перестанет подходить: новые сборки с образом не запустятся, пока вы не вернёте оригинал.'}
          </>
        ) : confirm?.kind === 'delete' ? (
          <>
            Изображения варианта будут стёрты без возможности восстановления; в
            журнале останется только запись о генерации.
            {confirm.item.active &&
              ' Этот вариант сейчас активен — образ рассказчика вернётся к оригиналу.'}
          </>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
