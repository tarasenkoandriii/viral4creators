import { useState } from 'react';
import { Button, inputClass } from '../kit/ui';
export function FixPromptDraft({
  initialPrompt,
  caseKey,
  version,
}: {
  initialPrompt: string;
  caseKey: string;
  version: number;
}) {
  const [draft, setDraft] = useState(initialPrompt);
  const [copyStatus, setCopyStatus] = useState('');
  return (
    <details className="space-y-2">
      <summary>Промпт для разбора ошибки</summary>
      <p>
        Локальный черновик по сохранённому результату. Перед копированием или
        скачиванием удалите пароли, токены и личные данные. Ничего не
        отправляется ИИ автоматически. Изменения не сохраняются в результат
        проверки; при смене кейса черновик формируется заново.
      </p>
      <textarea
        className={inputClass}
        aria-label="Промпт для разбора ошибки"
        rows={12}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setCopyStatus('');
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!draft.trim()}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(draft);
              setCopyStatus('Промпт скопирован.');
            } catch {
              setCopyStatus(
                'Копирование недоступно. Выделите текст вручную или скачайте файл.'
              );
            }
          }}
        >
          Копировать промпт
        </Button>
        <Button
          variant="outline"
          disabled={!draft.trim()}
          onClick={() => {
            const url = URL.createObjectURL(
              new Blob([draft], { type: 'text/plain;charset=utf-8' })
            );
            const link = document.createElement('a');
            link.href = url;
            link.download = `qa-${caseKey.replace(/[^a-zA-Z0-9_-]/g, '_')}-v${version}-prompt.txt`;
            link.click();
            window.setTimeout(() => URL.revokeObjectURL(url), 1000);
          }}
        >
          Скачать промпт (.txt)
        </Button>
      </div>
      <p role="status">{copyStatus}</p>
    </details>
  );
}
