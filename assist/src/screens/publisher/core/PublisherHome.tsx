import { useState } from 'react';
import { useAsync } from '../../../kit';
import { Alert, Badge, Button } from '../../../kit/ui';
import { canAny } from '../../../lib/publisher/permissions';
import { GATE_NAMES } from '../../../lib/publisher/states';
import { fmtDate, fmtText } from '../../../lib/publisher/view';
import { useMutation, usePubApis } from '../hooks';
import {
  DateText,
  Field,
  GateCard,
  Loadable,
  Notice,
  PubErrorAlert,
  Row,
  Section,
  Select,
  TextInput,
} from '../parts';
import { usePublisher } from '../publisher-context';
import { PUBLISHER_HOME_CARDS } from '../registry';

/**
 * Обзор продукта (§14.1 «PublisherHome»): вид и режим, пять гейтов с
 * `missing[]` (зелёный — только гейт без пунктов), карточки реестра
 * (задачи проверки, сроки — P-G1; бюджет, заявки, очередь, интеграции —
 * P-G2). Управление продуктом (имя, режим) — только `publisher=admin`.
 */
export function PublisherHome() {
  const { product, t, roles, can, go } = usePublisher();
  const apis = usePubApis();
  const gates = useAsync(() => apis.core.gates(product.id), [apis, product.id]);
  const cards = PUBLISHER_HOME_CARDS.filter((c) => canAny(roles, c.actions))
    .slice()
    .sort((a, b) => a.order - b.order);

  return (
    <div className="space-y-4">
      <Section
        title={t.gates.title}
        action={
          <Button variant="outline" onClick={() => go('launch')}>
            {t.gates.goLaunch}
          </Button>
        }
      >
        <p className="text-xs text-silver-500">{t.gates.hint}</p>
        <Loadable state={gates}>
          {(g) => (
            <div className="space-y-3">
              {GATE_NAMES.map((name) => (
                <GateCard key={name} result={g[name] ?? null} />
              ))}
            </div>
          )}
        </Loadable>
      </Section>
      {cards.map((c) => (
        <c.Card key={c.key} />
      ))}
      <ProductCard />
      {!can('product.read') && (
        <Alert tone="warning">{t.common.noPermission}</Alert>
      )}
    </div>
  );
}

function ProductCard() {
  const { product: p, t, can, reloadProduct, locale } = usePublisher();
  const apis = usePubApis();
  const [name, setName] = useState(p.name);
  const [mode, setMode] = useState<typeof p.mode | ''>(p.mode);
  const [reason, setReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const rename = useMutation();
  const modeM = useMutation();
  const reset = useMutation();
  const myRoles = p.myRoles.accountOwner
    ? t.roles.accountOwner
    : [
        ...p.myRoles.roles.map((r) => t.roles.names[r]),
        ...(p.myRoles.admin ? [t.roles.names.admin] : []),
      ].join(', ') || t.roles.noRoles;
  return (
    <Section title={p.name}>
      <Row label={t.product.kind}>{t.product.kinds[p.kind]}</Row>
      <Row label={t.product.mode}>
        <Badge tone={p.mode === 'live' ? 'accent' : 'neutral'}>
          {t.product.modes[p.mode]}
        </Badge>
        {p.liveSince && (
          <span className="ml-2 text-xs text-silver-500">
            {fmtText(t.product.liveSince, {
              date: fmtDate(p.liveSince, locale),
            })}
          </span>
        )}
      </Row>
      <Row label={t.product.publicKey}>
        <code className="text-xs break-all">{p.publicKey}</code>
      </Row>
      <Row label={t.roles.title}>
        {fmtText(t.roles.mine, { list: myRoles })}
      </Row>
      <Row label={t.common.created}>
        <DateText iso={p.createdAt} />
      </Row>
      <Notice text={notice} />
      {can('product.update') && (
        <div className="space-y-2">
          <Field label={t.product.name}>
            <TextInput value={name} onChange={setName} maxLength={120} />
          </Field>
          <PubErrorAlert error={rename.error} onReload={reloadProduct} />
          <Button
            variant="outline"
            loading={rename.busy}
            disabled={!name.trim() || name.trim() === p.name}
            onClick={async () => {
              const r = await rename.run((k) =>
                apis.core.rename(
                  p.id,
                  { name: name.trim(), expectedRevision: p.revision },
                  k
                )
              );
              if (r) {
                setNotice(t.product.renamed);
                reloadProduct();
              }
            }}
          >
            {t.product.rename}
          </Button>
        </div>
      )}
      {can('product.mode') && (
        <div className="space-y-2">
          <Field label={t.product.modeChange} hint={t.product.modeLiveHint}>
            <Select
              value={mode}
              options={['closed', 'test', 'live'] as const}
              labels={t.product.modes}
              onChange={setMode}
            />
          </Field>
          {mode === 'closed' && (
            <Field label={t.product.modeReason}>
              <TextInput value={reason} onChange={setReason} maxLength={500} />
            </Field>
          )}
          <PubErrorAlert error={modeM.error} onReload={reloadProduct} />
          <Button
            variant="outline"
            loading={modeM.busy}
            disabled={!mode || mode === p.mode}
            onClick={async () => {
              if (!mode) return;
              const r = await modeM.run((k) =>
                apis.core.changeMode(
                  p.id,
                  {
                    mode,
                    expectedRevision: p.revision,
                    ...(reason.trim() ? { reason: reason.trim() } : {}),
                  },
                  k
                )
              );
              if (r) {
                setNotice(t.product.modeChanged);
                reloadProduct();
              }
            }}
          >
            {t.common.save}
          </Button>
        </div>
      )}
      {can('test.rate_limit.reset') &&
        (p.mode === 'test' || p.kind === 'test') && (
          <div className="space-y-2">
            <PubErrorAlert error={reset.error} />
            <Button
              variant="ghost"
              loading={reset.busy}
              onClick={async () => {
                const r = await reset.run((k) =>
                  apis.core.resetRateLimit(p.id, k)
                );
                if (r)
                  setNotice(fmtText(t.product.resetDone, { n: r.removed }));
              }}
            >
              {t.product.resetRateLimit}
            </Button>
          </div>
        )}
    </Section>
  );
}
