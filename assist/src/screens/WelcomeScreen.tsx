import { Link2, MessageSquare, Send } from 'lucide-react';
import { Alert, Button, Card } from '../kit/ui';
import type { AppDictionary } from '../i18n';

const ICONS = [MessageSquare, Link2, Send];

/**
 * Онбординг, экран 1 (ТЗ §3.1): что делает Помощник + пример диалога +
 * «Подключить сайт». С Э1 кнопка ведёт на шаг 2 (адрес → предпросмотр,
 * `OnboardingUrlScreen`), затем шаг 3 — песочница (`SandboxScreen`).
 */
export function WelcomeScreen({
  t,
  created,
  onConnect,
}: {
  t: AppDictionary['welcome'];
  created: boolean;
  onConnect: () => void;
}) {
  return (
    <div className="space-y-4">
      {created && <Alert tone="success">{t.created}</Alert>}
      <h1 className="text-2xl font-bold tracking-tight">{t.title}</h1>
      <div className="space-y-3">
        {t.cards.map((c, i) => {
          const Icon = ICONS[i] ?? MessageSquare;
          return (
            <Card key={c.title} className="flex gap-3">
              <Icon size={22} className="text-accent shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">{c.title}</div>
                <div className="text-sm text-silver-500">{c.text}</div>
              </div>
            </Card>
          );
        })}
      </div>
      <Card className="space-y-2 text-sm" aria-hidden>
        <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-sm bg-accent text-accent-on px-3 py-2">
          {t.exampleQ}
        </div>
        <div className="w-fit max-w-[85%] rounded-2xl rounded-bl-sm bg-silver-100 dark:bg-silver-800 px-3 py-2">
          {t.exampleA}
        </div>
      </Card>
      <p className="text-sm text-silver-500">{t.firstStep}</p>
      <Button block onClick={onConnect}>
        {t.connect}
      </Button>
    </div>
  );
}
