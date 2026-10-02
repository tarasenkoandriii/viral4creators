import { useState } from 'react';
import { PUBLIC_API_BASE } from '../../lib/config';
import { goalWebhookUrl } from '../../lib/public-api';
import { fmt, formatDate, useAsync, useKit } from '../../kit';
import { Alert, Card, CopyField, ScreenTitle, Spinner } from '../../kit/ui';
import { useAssist } from '../../lib/assist-context';
import { canManageSecrets, canSeeStats } from '../../lib/e3-view';
import { navigate } from '../../lib/router';
import type { IntegrationsView, SecretIssuedView } from '../../lib/stats-types';
import { useE3ErrorText } from '../../lib/use-error-text';
import {
  ConfirmButton,
  LoadError,
  NoticeBar,
  type Notice,
} from '../knowledge/parts';
import { ManagerOnly } from './parts';

/**
 * Интеграции (§3-бис.2, §5-тер.1): секреты вебхука целей и userHash —
 * выпуск/отзыв только владельцем, секрет показывается ОДИН раз (в памяти
 * экрана, не в хранилище); код установки для GTM/npm/WordPress — из
 * `installGuides` вида (тот же тег, что «Установка»).
 */
export function IntegrationsScreen({ siteId }: { siteId: string }) {
  const { account, dict, locale } = useKit();
  const { appDict, stats, widget } = useAssist();
  const t = appDict.e3.integrations;
  const errText = useE3ErrorText();
  const ok = canSeeStats(account.me);
  const owner = canManageSecrets(account.me);
  const loaded = useAsync(
    () => (ok ? stats.integrations(siteId) : Promise.resolve(null)),
    [stats, siteId, ok]
  );
  const guides = useAsync(
    () => (ok ? widget.get(siteId) : Promise.resolve(null)),
    [widget, siteId, ok]
  );
  const [view, setView] = useState<IntegrationsView | null>(null);
  const [secret, setSecret] = useState<SecretIssuedView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (!ok) return <ManagerOnly />;
  const v = view ?? loaded.data;
  if (loaded.loading && !v) return <Spinner label={dict.common.loading} />;
  if (!v) return <LoadError error={loaded.error} onRetry={loaded.reload} />;
  const copy = { copyLabel: dict.common.copy, copiedLabel: dict.common.copied };

  async function act(name: string, job: () => Promise<void>) {
    setBusy(name);
    setNotice(null);
    try {
      await job();
      setView(await stats.integrations(siteId));
    } catch (e) {
      setNotice({ tone: 'danger', text: errText(e) });
    } finally {
      setBusy(null);
    }
  }

  const issue = (kind: 'goal-webhook' | 'identity') =>
    act(`issue-${kind}`, async () => {
      const s = await stats.issueSecret(siteId, kind);
      if (!s) throw new Error('secret');
      setSecret(s);
    });
  const revoke = (kind: 'goal-webhook' | 'identity') =>
    act(`revoke-${kind}`, async () => {
      await stats.revokeIntegration(siteId, kind);
      setSecret(null);
      setNotice({ tone: 'success', text: t.revoked });
    });

  const block = (
    kind: 'goal-webhook' | 'identity',
    title: string,
    active: boolean,
    createdAt: string | null,
    extra?: JSX.Element
  ) => (
    <Card className="space-y-2">
      <div className="font-semibold">{title}</div>
      <div className="text-sm text-silver-500">
        {active && createdAt
          ? fmt(t.active, { date: formatDate(createdAt, locale) })
          : t.inactive}
      </div>
      {extra}
      {secret &&
        secret.kind === (kind === 'identity' ? 'identity' : 'goal_webhook') && (
          <div className="space-y-1">
            <Alert tone="warning">{t.secretOnce}</Alert>
            <CopyField label={title} value={secret.secret} {...copy} />
          </div>
        )}
      {owner ? (
        <div className="flex flex-wrap gap-2">
          <ConfirmButton
            variant={active ? 'outline' : 'solid'}
            loading={busy === `issue-${kind}`}
            hint={active ? t.reissue : undefined}
            onConfirm={() => void issue(kind)}
          >
            {active ? t.reissue : t.issue}
          </ConfirmButton>
          {active && (
            <ConfirmButton
              variant="ghost"
              loading={busy === `revoke-${kind}`}
              onConfirm={() => void revoke(kind)}
            >
              {t.revoke}
            </ConfirmButton>
          )}
        </div>
      ) : (
        <div className="text-xs text-silver-500">{t.ownerOnly}</div>
      )}
    </Card>
  );

  const g = guides.data?.installGuides;
  return (
    <div className="space-y-4">
      <ScreenTitle>{t.title}</ScreenTitle>
      <p className="text-sm text-silver-500">{t.intro}</p>
      <NoticeBar notice={notice} />
      {block(
        'goal-webhook',
        t.webhook,
        v.goalWebhook.active,
        v.goalWebhook.createdAt,
        <>
          {goalWebhookUrl(v.goalWebhook.endpoint, PUBLIC_API_BASE) && (
            <CopyField
              label={t.endpoint}
              value={goalWebhookUrl(v.goalWebhook.endpoint, PUBLIC_API_BASE)}
              {...copy}
            />
          )}
          {v.goalWebhook.lastUsedAt && (
            <div className="text-xs text-silver-500">
              {fmt(t.lastUsed, {
                date: formatDate(v.goalWebhook.lastUsedAt, locale),
              })}
            </div>
          )}
        </>
      )}
      {block('identity', t.identity, v.identity.active, v.identity.createdAt)}

      <Card className="space-y-3">
        <div className="font-semibold">{t.install}</div>
        {!g ? (
          <div className="text-sm space-y-2">
            <div>{t.noKeys}</div>
            <button
              type="button"
              className="underline"
              onClick={() =>
                navigate({ name: 'widget', siteId, tab: 'install' })
              }
            >
              {appDict.setup.widget.tabs.install}
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t.gtm}</div>
              <div className="text-xs text-silver-500">{t.gtmHint}</div>
              <CopyField label={t.gtm} value={g.gtm.html} {...copy} />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t.npm}</div>
              <CopyField label="npm" value={g.npm.install} {...copy} />
              <CodeBlock text={g.npm.code} />
              <div className="text-xs text-silver-500">{t.npmReact}</div>
              <CodeBlock text={g.npm.react} />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t.wordpress}</div>
              <ol className="list-decimal pl-5 text-sm space-y-0.5">
                {t.wpSteps.map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
              <div className="text-xs text-silver-500">
                {fmt(t.wpSlug, { slug: g.wordpress.pluginSlug })}
              </div>
              <CopyField
                label={t.wpKey}
                value={g.wordpress.siteKey}
                {...copy}
              />
              <CopyField
                label={t.wpOrigin}
                value={g.wordpress.widgetOrigin}
                {...copy}
              />
            </div>
            <div className="space-y-1">
              <div className="text-sm font-medium">{t.jsApi}</div>
              <CodeBlock text={g.jsApi.goal} />
              <CodeBlock text={g.jsApi.identify} />
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

/** Код — текстом в <pre> (никакой разметки из ответа сервера). */
function CodeBlock({ text }: { text: string }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-silver-100 dark:bg-silver-900 p-2 text-xs whitespace-pre">
      {text}
    </pre>
  );
}
