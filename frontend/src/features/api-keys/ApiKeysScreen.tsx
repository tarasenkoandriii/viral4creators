/**
 * ApiKeysScreen (#/api-keys) — ключи внешнего API (этап 145,
 * docs-tz/TZ-Vneshnee-API.md).
 *
 * ## Зачем экран, если ключ можно было бы выдать поддержкой
 *
 * «Отзыв, ротация и время последнего использования» — из постановки
 * пункта 10: без них ключ ушедшего подрядчика не удалит никто. Значит
 * экран нужен не ради выдачи (её можно сделать когда угодно), а ради
 * того, что делают ПОСЛЕ неё.
 *
 * ## Секрет живёт только в памяти этого экрана
 *
 * Ни `localStorage`, ни адресной строки: иначе «показан один раз»
 * перестаёт быть правдой ровно тогда, когда это важно. Любая
 * перезагрузка списка его стирает (`keepSecret`), и это не небрежность,
 * а способ сказать «второго шанса нет» СЕЙЧАС, а не через месяц, когда
 * человек придёт за копией.
 *
 * ## Замок, а не спрятанный раздел
 *
 * У режима ниже Premium экран показывает, что закрыто и чем открывается
 * (`LockedNote`, ТЗ §23): спрятанная функция не сообщает ничего —
 * человек решает, что сервис её не умеет.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, KeyRound, Trash2 } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Input,
  LockedNote,
  Spinner,
} from '../../components/ui';
import { ScreenHeader, LoadError } from '../projects/shared';
import {
  issueApiKey,
  listApiKeys,
  revokeApiKey,
  setApiKeyWebhook,
} from '../../services/api-keys-api';
import {
  keepSecret,
  slotsLeft,
  sortKeys,
  statusOf,
  type ApiKeyView,
} from '../../lib/api-keys';
import { errorMessage, isUnauthorized } from '../../services/projects-api';
import { useAsync } from '../../lib/useAsync';
import { usePlanContext } from '../../lib/plan-context';
import { useI18n } from '../../lib/i18n-context';
import { allows, lockLabel } from '../../lib/plan';

function shortDate(value: string, locale: string): string {
  return new Date(value).toLocaleDateString(locale);
}

/**
 * Полный адрес проверочного вызова (аудит этапа 145).
 *
 * Не `/api/v1/me`: относительный путь бесполезен ровно тому, для кого
 * подсказка и написана, — она копируется в чужой `curl`, где никакого
 * «текущего хоста» нет. Берём тот же адрес, которым ходит сам экран.
 */
function checkUrl(): string {
  const base = (
    import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000/api'
  ).replace(/\/+$/, '');
  return `${base}/v1/me`;
}

export function ApiKeysScreen() {
  const { dict, locale } = useI18n();
  const t = dict.apiKeysScreen;
  const { state } = usePlanContext();
  const { data, loading, error, reload } = useAsync(listApiKeys, []);

  const [name, setName] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Черновик адреса на строку: поле правят, не перезагружая список.
  const [hooks, setHooks] = useState<Record<string, string>>({});
  const [savedHook, setSavedHook] = useState<string | null>(null);
  const secretRef = useRef<HTMLDivElement | null>(null);

  // Подвести секрет под глаза (аудит этапа 145). Кнопка «Выдать» стоит
  // внизу формы, а секрет появляется НАД ней: на телефоне человек
  // нажимал и не видел, что что-то произошло, — а показывается он один
  // раз в жизни.
  useEffect(() => {
    if (secret) secretRef.current?.scrollIntoView({ block: 'center' });
  }, [secret]);

  // Перезагрузка списка стирает показанный секрет — см. шапку файла.
  const refresh = useCallback(() => {
    setSecret((value) => keepSecret(value, 'reloaded'));
    reload();
  }, [reload]);

  const keys = sortKeys(data?.keys ?? []);
  // Потолок — число от сервера: своей копии здесь нет намеренно.
  const left = slotsLeft(keys, data?.maxActive ?? 0);
  const unlocked = allows(state, 'externalApi');

  const issue = async () => {
    setBusy('issue');
    setActionError(null);
    try {
      const result = await issueApiKey(name.trim());
      setSecret(keepSecret(result.secret, 'issued'));
      setCopied(false);
      setName('');
      reload();
    } catch (e) {
      setActionError(isUnauthorized(e) ? t.unauthorizedError : errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (key: ApiKeyView) => {
    // Подтверждение обычным `confirm`: отзыв мгновенно ломает всё, что
    // ходит этим ключом, и отменить его нечем.
    if (!window.confirm(t.revokeConfirm)) return;
    setBusy(key.id);
    setActionError(null);
    try {
      await revokeApiKey(key.id);
      refresh();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const saveWebhook = async (key: ApiKeyView, value: string) => {
    setBusy(`hook:${key.id}`);
    setActionError(null);
    try {
      await setApiKeyWebhook(key.id, value.trim());
      setSavedHook(key.id);
      reload();
    } catch (e) {
      setActionError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async () => {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      // Подпись возвращается сама: «Скопировано» навсегда перестаёт
      // отвечать на вопрос «а сейчас-то скопировалось?».
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Буфер обмена может быть закрыт политикой — тогда человек
      // выделит текст руками, он для того и показан целиком.
      setCopied(false);
    }
  };

  return (
    <div className="p-4">
      <ScreenHeader title={t.title} hint={t.hint} />

      {!unlocked && (
        <LockedNote
          title={t.lockedTitle}
          lock={lockLabel(state, 'externalApi', dict.common)}
        >
          {t.lockedHint}
        </LockedNote>
      )}

      {secret && (
        <div ref={secretRef}>
          <Alert tone="warning" className="mb-4">
            <div className="font-semibold">{t.secretTitle}</div>
            <p className="mt-0.5 text-xs">{t.secretHint}</p>
            <code className="mt-2 block break-all rounded bg-black/20 p-2 text-xs">
              {secret}
            </code>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => void copy()}>
                <Copy size={14} /> {copied ? t.copied : t.copy}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSecret(keepSecret(secret, 'dismissed'))}
              >
                {t.hide}
              </Button>
            </div>
          </Alert>
        </div>
      )}

      {unlocked && (
        <Card className="mb-4">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.namePlaceholder}
              className="flex-1"
            />
            <Button
              onClick={() => void issue()}
              disabled={busy !== null || left === 0}
            >
              <KeyRound size={16} />
              {busy === 'issue' ? t.issuing : t.issue}
            </Button>
          </div>
          <p className="mt-1 text-xs text-silver-400">
            {left === 0 ? t.noSlots : t.slotsLeft.replace('{n}', String(left))}
          </p>
        </Card>
      )}

      {actionError && (
        <Alert tone="error" className="mb-4">
          {actionError}
        </Alert>
      )}

      {loading && <Spinner />}
      {!loading && error ? <LoadError error={error} onRetry={refresh} /> : null}

      {!loading && !error && keys.length === 0 && (
        <p className="text-sm text-silver-400">{t.empty}</p>
      )}

      <div className="flex flex-col gap-2">
        {keys.map((key) => {
          const status = statusOf(key);
          return (
            <Card
              key={key.id}
              className={status === 'revoked' ? 'opacity-60' : undefined}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{key.name}</div>
                  {/* Открытая часть — это ВЕСЬ видимый ключ, без точек:
                      «v4c_abcd••••» намекало бы, что остальное где-то
                      есть и его можно показать. */}
                  <code className="text-xs text-silver-400">{key.hint}</code>
                  <div className="mt-1 text-xs text-silver-400">
                    {status === 'revoked'
                      ? `${t.statusRevoked} · ${shortDate(key.revokedAt as string, locale)}`
                      : status === 'unused'
                        ? t.statusUnused
                        : `${t.lastUsedAt}: ${shortDate(key.lastUsedAt as string, locale)}`}
                    {' · '}
                    {t.createdAt} {shortDate(key.createdAt, locale)}
                  </div>
                </div>
                {!key.revokedAt && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void revoke(key)}
                    disabled={busy !== null}
                  >
                    <Trash2 size={14} />
                    {busy === key.id ? t.revoking : t.revoke}
                  </Button>
                )}
              </div>

              {/* Адрес вебхука — на строке ключа, а не общей настройкой:
                  он свойство ЭТОЙ интеграции, и у двух ключей одного
                  человека приёмники обычно разные (этап 146). */}
              {!key.revokedAt && (
                <div className="mt-2">
                  <label className="text-xs text-silver-400">
                    {t.webhookLabel}
                  </label>
                  <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                    <Input
                      value={hooks[key.id] ?? key.webhookUrl ?? ''}
                      onChange={(e) => {
                        setSavedHook(null);
                        setHooks((prev) => ({
                          ...prev,
                          [key.id]: e.target.value,
                        }));
                      }}
                      placeholder={t.webhookPlaceholder}
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy !== null}
                      onClick={() =>
                        void saveWebhook(
                          key,
                          hooks[key.id] ?? key.webhookUrl ?? ''
                        )
                      }
                    >
                      {savedHook === key.id ? t.webhookSaved : t.webhookSave}
                    </Button>
                  </div>
                  <p className="mt-1 text-xs text-silver-400">
                    {t.webhookHint}
                  </p>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-silver-400">
        {t.usage.replace('{url}', checkUrl())}
      </p>
    </div>
  );
}
