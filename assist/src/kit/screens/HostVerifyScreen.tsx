/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/HostVerifyScreen.tsx */
import { useState } from 'react';
import { Ban, ChevronRight, ShieldCheck } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { formatDate } from '../format';
import { checkText, errorText } from '../errors';
import { canManage } from '../account-select';
import { useAsync } from '../use-async';
import {
  availableMethods,
  buildInstruction,
  expiresSoon,
  hostView,
  type VerifyInstruction,
} from '../verification';
import { hapticResult } from '../telegram';
import { Alert, Button, Card, CopyField, ScreenTitle, Spinner } from '../ui';
import { StatusBadge } from '../ui/StatusBadge';
import type { SiteHost, VerifyMethod } from '../types';
import type { ChallengeResult } from '../sites-api';

/**
 * «Подтвердить хост»: три способа (DNS TXT / файл / мета) с копированием,
 * кнопка «Проверить», состояния pending/verified/failed/expired/revoked.
 *
 * Оператор видит статус, но не токен (сервер его не отдаёт) и не кнопки;
 * хост, заблокированный владельцем, — только плашку блокировки.
 */
export function HostVerifyScreen({
  siteId,
  hostId,
  onOpenAccess,
}: {
  siteId: string;
  hostId: string;
  /** «Кто ещё подтвердил этот хост» — экран владельца хоста. */
  onOpenAccess?: () => void;
}) {
  const { api, dict, account, locale } = useKit();
  const t = dict.verify;
  const manage = canManage(account.me.role);
  const host = useAsync<SiteHost | null>(
    async () =>
      (await api.listSites())
        .find((s) => s.id === siteId)
        ?.hosts.find((h) => h.id === hostId) ?? null,
    [api, siteId, hostId]
  );
  const [method, setMethod] = useState<VerifyMethod | null>(null);
  const [challenge, setChallenge] = useState<ChallengeResult | null>(null);
  const [challengeError, setChallengeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  if (host.loading && !host.data)
    return <Spinner label={dict.common.loading} />;
  if (host.error || !host.data) {
    return (
      <Alert tone="danger" title={dict.common.error}>
        {host.error
          ? errorText(host.error, dict)
          : dict.errors.api.HOST_NOT_FOUND}
      </Alert>
    );
  }

  const h = host.data;
  const now = new Date();
  const view = hostView(h, now);
  const methods = availableMethods(h);
  const active: VerifyMethod =
    method && methods.includes(method) ? method : (h.method ?? methods[0]);
  const effectiveMethod = methods.includes(active) ? active : methods[0];
  const token = challenge?.token ?? account.account.verifyToken;

  let instruction: VerifyInstruction | null = null;
  let tokenError = false;
  if (manage && token) {
    // Инструкция сервера (после выбора способа) — авторитетна; до выбора
    // строим из токена кабинета по тому же формату (brand.ts).
    if (challenge?.instruction?.method === effectiveMethod) {
      instruction = challenge.instruction;
    } else {
      try {
        instruction = buildInstruction(effectiveMethod, h, token);
      } catch {
        tokenError = true;
      }
    }
  }

  async function pick(m: VerifyMethod) {
    setMethod(m);
    setResult(null);
    setChallengeError(null);
    try {
      // Сервер фиксирует выбранный способ (по нему пойдёт «Проверить все»)
      // и отдаёт `{ token, method, instruction }`.
      setChallenge(await api.challenge(h.id, m));
    } catch (e) {
      // Инструкция строится и без ответа, но отказ (METHOD_NOT_ALLOWED,
      // REVERIFY_BLOCKED) человек должен увидеть.
      setChallengeError(errorText(e, dict));
    }
  }

  async function check() {
    setChecking(true);
    setResult(null);
    try {
      const r = await api.verify(h.id, effectiveMethod);
      hapticResult(r.ok);
      setResult({ ok: r.ok, text: r.ok ? t.success : checkText(r, dict) });
      host.setData(r.host.id ? r.host : h);
    } catch (e) {
      hapticResult(false);
      setResult({ ok: false, text: errorText(e, dict) });
    } finally {
      setChecking(false);
    }
  }

  const copy = { copyLabel: dict.common.copy, copiedLabel: dict.common.copied };
  const canVerify = manage && !h.reverifyBlocked;

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>

      <Card className="space-y-1">
        <div className="font-mono text-sm break-all">https://{h.host}</div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge host={h} />
          {view === 'verified' && h.expiresAt && (
            <span
              className={`text-xs ${
                expiresSoon(h, now) ? 'text-amber-600' : 'text-silver-500'
              }`}
            >
              {fmt(
                expiresSoon(h, now)
                  ? dict.status.expiresSoon
                  : dict.status.verifiedUntil,
                { date: formatDate(h.expiresAt, locale) }
              )}
            </span>
          )}
        </div>
        {h.lastRecheckAt && (
          <p className="text-xs text-silver-500">
            {fmt(t.lastRecheck, {
              date: formatDate(h.lastRecheckAt, locale),
            })}
          </p>
        )}
        {view === 'expired' && (
          <p className="text-xs text-silver-500">{dict.status.expiredHint}</p>
        )}
        {view === 'revoked' && !h.reverifyBlocked && (
          <p className="text-xs text-silver-500">{dict.status.revokedHint}</p>
        )}
        {view === 'failed' && h.lastCheck && (
          <p className="text-xs text-silver-500">
            {checkText(h.lastCheck, dict)}
          </p>
        )}
      </Card>

      {h.reverifyBlocked && (
        <Alert tone="danger">
          <span className="inline-flex items-start gap-2">
            <Ban size={16} className="shrink-0 mt-0.5" />
            {t.blocked}
          </span>
        </Alert>
      )}

      {manage && view === 'verified' && onOpenAccess && (
        <button
          type="button"
          onClick={onOpenAccess}
          className="w-full text-left"
        >
          <Card className="flex items-center gap-2 hover:border-accent transition-colors">
            <span className="flex-1 text-sm">{t.access}</span>
            <ChevronRight size={18} className="text-silver-400" />
          </Card>
        </button>
      )}

      {!manage && <Alert tone="neutral">{t.tokenHidden}</Alert>}

      {canVerify && (
        <>
          <p className="text-sm text-silver-500">{t.intro}</p>
          {methods.length === 1 && (
            <Alert tone="warning">{t.platformOnlyDns}</Alert>
          )}

          <div role="tablist" className="grid grid-cols-3 gap-2">
            {methods.map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={m === effectiveMethod}
                onClick={() => void pick(m)}
                className={`rounded-xl border px-2 py-2 text-xs min-h-[44px] ${
                  m === effectiveMethod
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-silver-300 dark:border-silver-700'
                }`}
              >
                {t.methods[m]}
              </button>
            ))}
          </div>

          {challengeError && <Alert tone="danger">{challengeError}</Alert>}

          <Card className="space-y-3">
            <p className="text-xs text-silver-500">
              {t.methodHints[effectiveMethod]}
            </p>
            {(tokenError || !token) && (
              <Alert tone="danger">{dict.common.error}</Alert>
            )}
            {instruction?.method === 'dns' && (
              <>
                <p className="text-sm">{t.dnsSteps}</p>
                <div className="text-xs text-silver-500">
                  {t.recordType}: {instruction.recordType}
                </div>
                <CopyField
                  label={t.recordName}
                  value={instruction.name}
                  {...copy}
                />
                <CopyField
                  label={t.recordValue}
                  value={instruction.value}
                  {...copy}
                />
              </>
            )}
            {instruction?.method === 'file' && (
              <>
                <p className="text-sm">{t.fileSteps}</p>
                <CopyField
                  label={t.fileUrl}
                  value={instruction.url}
                  {...copy}
                />
                <CopyField
                  label={t.fileContent}
                  value={instruction.content}
                  {...copy}
                />
              </>
            )}
            {instruction?.method === 'meta' && (
              <>
                <p className="text-sm">{t.metaSteps}</p>
                <CopyField
                  label={t.metaPage}
                  value={instruction.pageUrl}
                  {...copy}
                />
                <CopyField
                  label={t.metaTag}
                  value={instruction.tag}
                  {...copy}
                />
              </>
            )}
          </Card>

          {result && (
            <Alert tone={result.ok ? 'success' : 'warning'}>
              {result.text}
            </Alert>
          )}

          <Button
            block
            icon={<ShieldCheck size={16} />}
            loading={checking}
            disabled={tokenError || !instruction}
            onClick={check}
          >
            {checking ? t.checking : t.check}
          </Button>
        </>
      )}
    </div>
  );
}
