import { useState } from 'react';
import { Button, inputClass } from '../kit/ui';
import {
  emptyQaFinding,
  findingComment,
  type QaFinding,
} from '../lib/qa-finding';
export function QaFindingForm({
  disabled,
  onApply,
  onDirty,
}: {
  disabled: boolean;
  onApply: (comment: string) => void;
  onDirty: () => void;
}) {
  const [finding, setFinding] = useState(emptyQaFinding);
  const comment = findingComment(finding);
  const set = <K extends keyof QaFinding>(key: K, value: QaFinding[K]) => {
    onDirty();
    setFinding((old) => ({ ...old, [key]: value }));
  };
  const fields: [keyof QaFinding, string, number][] = [
    ['url', 'URL страницы без параметров и фрагмента', 300],
    ['context', 'Условия: роль, размер экрана, тема, язык', 300],
    ['steps', 'Шаги воспроизведения', 600],
    ['expected', 'Ожидается; источник бизнес-правила', 600],
    ['actual', 'Фактический результат', 600],
    ['impact', 'Влияние на пользователя', 300],
    ['evidence', 'Ссылки на обезличенные доказательства / описание', 500],
    ['deployedSha', 'SHA деплоя, если подтверждён', 40],
  ];
  return (
    <details className="space-y-2">
      <summary>Оформить замечание по вёрстке или логике</summary>
      <p>
        Ручное наблюдение. Заполните условия и доказательства; не вставляйте
        пароли, токены или персональные данные. Черновик сохраняется только
        после записи ручного результата ниже. До этого при смене кейса он
        теряется.
      </p>
      <label className="block">
        Категория
        <select
          className={inputClass}
          disabled={disabled}
          value={finding.category}
          onChange={(e) =>
            set('category', e.target.value as QaFinding['category'])
          }
        >
          <option value="layout">Вёрстка</option>
          <option value="logic">Логика</option>
          <option value="accessibility">Доступность</option>
        </select>
      </label>
      <label className="block">
        Приоритет
        <select
          className={inputClass}
          disabled={disabled}
          value={finding.severity}
          onChange={(e) =>
            set('severity', e.target.value as QaFinding['severity'])
          }
        >
          {(['P0', 'P1', 'P2', 'P3'] as const).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="block">
        Подтверждение
        <select
          className={inputClass}
          disabled={disabled}
          value={finding.confidence}
          onChange={(e) =>
            set('confidence', e.target.value as QaFinding['confidence'])
          }
        >
          <option value="needs_confirmation">Нужно подтвердить</option>
          <option value="confirmed">Воспроизведено автором</option>
        </select>
      </label>
      {fields.map(([key, label, maxLength]) => (
        <label key={key} className="block">
          {label}
          <textarea
            className={inputClass}
            rows={key === 'steps' ? 3 : 2}
            disabled={disabled}
            maxLength={maxLength}
            value={finding[key]}
            onChange={(e) => set(key, e.target.value)}
          />
        </label>
      ))}
      <p>
        Обязательны URL, условия, шаги, ожидание, результат и влияние. Только
        HTTP(S) без параметров; SHA — 40 символов. Комментарий до 4000 символов.
      </p>
      <Button
        variant="outline"
        disabled={disabled || !comment}
        onClick={() => {
          if (comment) onApply(comment);
        }}
      >
        Перенести замечание в комментарий
      </Button>
      <p>
        Выберите результат самостоятельно: гипотеза не означает подтверждённую
        ошибку. Перенос заменит текущий текст комментария.
      </p>
    </details>
  );
}
