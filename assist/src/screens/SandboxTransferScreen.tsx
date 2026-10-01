import { useState } from 'react';
import { useKit } from '../kit';
import { Alert, Button, Card } from '../kit/ui';
import { useAssist } from '../lib/assist-context';
import { canTransferSandbox } from '../lib/knowledge-view';
import { navigate } from '../lib/router';
import { useErrorText } from '../lib/use-error-text';

/**
 * Перенос песочницы лендинга в кабинет (`startapp=sb_<id>`, лендинг-ТЗ
 * §6; контракт Э1 §1 п.5): сайт и хост создаются `pending`, песочница
 * привязывается к кабинету. Только по нажатию — запуск по ссылке не
 * должен молча создавать сайты в кабинете (ссылку могли переслать).
 */
export function SandboxTransferScreen({ sandboxId }: { sandboxId: string }) {
  const { account } = useKit();
  const { knowledge, appDict } = useAssist();
  const t = appDict.transfer;
  const errText = useErrorText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canTransferSandbox(account.me)) {
    return <Alert tone="warning">{t.noAccess}</Alert>;
  }

  async function transfer() {
    setBusy(true);
    setError(null);
    try {
      const r = await knowledge.transferSandbox(sandboxId);
      navigate({ name: 'sandbox', siteId: r.siteId }, true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold tracking-tight">{t.title}</h1>
      <Card className="space-y-3 text-sm">
        <p>{t.intro}</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button loading={busy} onClick={transfer}>
            {t.submit}
          </Button>
          <Button
            variant="ghost"
            onClick={() => navigate({ name: 'home' }, true)}
          >
            {t.later}
          </Button>
        </div>
      </Card>
    </div>
  );
}
