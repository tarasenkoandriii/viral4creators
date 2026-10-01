/* СГЕНЕРИРОВАНО scripts/sync-site-tma-kit.mjs — не править. Источник: site-tma-kit/src/screens/AuthorizationsScreen.tsx */
import { useState } from 'react';
import { ShieldOff, Unlock } from 'lucide-react';
import { useKit } from '../kit-context';
import { fmt } from '../i18n';
import { formatDate } from '../format';
import { errorText } from '../errors';
import { useAsync } from '../use-async';
import {
  Alert,
  Badge,
  Button,
  Card,
  CopyField,
  ScreenTitle,
  Spinner,
} from '../ui';
import type { RevokeResult } from '../types';

/**
 * «Кто ещё подтвердил этот хост» (QA-ТЗ §5.1): видит кабинет, который сам
 * подтвердил хост; отозвать все чужие подтверждения (с запретом повтора) и
 * снять блокировку с отдельного кабинета — только владелец кабинета.
 *
 * Чужие кабинеты не называются (сервер их не раскрывает) — только номер
 * строки, статус и способ.
 */
export function AuthorizationsScreen({ hostId }: { hostId: string }) {
  const { api, dict, account, locale } = useKit();
  const t = dict.access;
  const isOwner = account.me.role === 'owner';
  const data = useAsync(() => api.authorizations(hostId), [api, hostId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    tone: 'success' | 'danger';
    text: string;
  } | null>(null);
  const [revoke, setRevoke] = useState<RevokeResult | null>(null);

  if (data.loading && !data.data)
    return <Spinner label={dict.common.loading} />;
  if (data.error || !data.data) {
    return (
      <div className="space-y-4">
        <ScreenTitle>{t.title}</ScreenTitle>
        <Alert tone="danger">
          {data.error ? errorText(data.error, dict) : dict.common.error}
        </Alert>
      </div>
    );
  }

  const { host, others } = data.data;
  const canRevoke = isOwner && others.some((o) => !o.reverifyBlocked);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice({ tone: 'danger', text: errorText(e, dict) });
    } finally {
      setBusy(null);
    }
  }

  const copy = { copyLabel: dict.common.copy, copiedLabel: dict.common.copied };
  const markers = revoke?.foreignMarkers;
  const hasMarkers = !!markers && (markers.dns.length > 0 || !!markers.file);

  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <Card className="space-y-1">
        <div className="font-mono text-sm break-all">https://{host.host}</div>
        <p className="text-xs text-silver-500">{t.intro}</p>
      </Card>

      {notice && <Alert tone={notice.tone}>{notice.text}</Alert>}
      {!isOwner && others.length > 0 && (
        <Alert tone="neutral">{t.ownerOnly}</Alert>
      )}

      {revoke && (
        <Alert tone="success">{fmt(t.revoked, { n: revoke.revoked })}</Alert>
      )}
      {markers && hasMarkers && (
        <Card className="space-y-3">
          <h2 className="font-semibold">{t.markersTitle}</h2>
          <p className="text-xs text-silver-500">{t.markersHint}</p>
          {markers.dns.map((v) => (
            <CopyField
              key={v}
              label={fmt(t.dnsName, { name: markers.dnsName })}
              value={v}
              {...copy}
            />
          ))}
          {markers.file && (
            <CopyField label={t.file} value={markers.file} {...copy} />
          )}
        </Card>
      )}

      <Card>
        {others.length === 0 ? (
          <p className="text-sm text-silver-500">{t.empty}</p>
        ) : (
          <ul className="divide-y divide-silver-200 dark:divide-silver-800">
            {others.map((o, i) => (
              <li key={o.hostId} className="py-2 flex items-center gap-2">
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="text-sm">{fmt(t.other, { n: i + 1 })}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge
                      tone={o.status === 'verified' ? 'warning' : 'neutral'}
                    >
                      {dict.status[o.status]}
                    </Badge>
                    {o.method && (
                      <span className="text-xs text-silver-500">
                        {dict.verify.methods[o.method]}
                      </span>
                    )}
                    {o.verifiedAt && (
                      <span className="text-xs text-silver-500">
                        {formatDate(o.verifiedAt, locale)}
                      </span>
                    )}
                    {o.reverifyBlocked && (
                      <Badge tone="danger">{t.blocked}</Badge>
                    )}
                  </div>
                </div>
                {isOwner && o.reverifyBlocked && (
                  <Button
                    variant="outline"
                    icon={<Unlock size={16} />}
                    loading={busy === `unblock:${o.hostId}`}
                    onClick={() =>
                      run(`unblock:${o.hostId}`, async () => {
                        await api.unblockForeign(hostId, o.hostId);
                        setNotice({ tone: 'success', text: t.unblocked });
                        data.reload();
                      })
                    }
                  >
                    {t.unblock}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {canRevoke && (
        <Button
          block
          variant="danger"
          icon={<ShieldOff size={16} />}
          loading={busy === 'revoke'}
          onClick={() => {
            if (!window.confirm(fmt(t.revokeConfirm, { host: host.host })))
              return;
            void run('revoke', async () => {
              setRevoke(await api.revokeForeign(hostId));
              data.reload();
            });
          }}
        >
          {t.revokeAll}
        </Button>
      )}
    </div>
  );
}
