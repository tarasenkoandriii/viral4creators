'use client';

import { useEffect, useState } from 'react';
import { getEnvSettings } from '../../lib/endpoints';
import type { EnvCheckResult, EnvSettingsResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

const SEVERITY_LABEL: Record<EnvCheckResult['severity'], string> = {
  ok: 'Корректно',
  warning: 'Проверьте',
  critical: 'Ошибка',
};

function StatusBadge({ severity }: { severity: EnvCheckResult['severity'] }) {
  return <span className={`badge-status badge-status-${severity}`}>{SEVERITY_LABEL[severity]}</span>;
}

function groupChecks(checks: EnvCheckResult[]): Array<[string, EnvCheckResult[]]> {
  const order: string[] = [];
  const byGroup = new Map<string, EnvCheckResult[]>();
  for (const check of checks) {
    if (!byGroup.has(check.group)) {
      byGroup.set(check.group, []);
      order.push(check.group);
    }
    byGroup.get(check.group)!.push(check);
  }
  return order.map((group) => [group, byGroup.get(group)!]);
}

export default function SettingsPage() {
  const [result, setResult] = useState<EnvSettingsResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getEnvSettings()
      .then(setResult)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить настройки'));
  }, []);

  if (error) {
    return (
      <div className="page">
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
      </div>
    );
  }

  if (!result) {
    return (
      <div className="page">
        <p className="muted">Загрузка…</p>
      </div>
    );
  }

  const problems = result.checks.filter((c) => !c.ok);

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Настройки</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        Статус переменных окружения бэкенда — задана ли переменная и похожа ли она на корректное
        значение. Секретные значения (ключи, токены, строки подключения к БД) здесь никогда не
        показываются — только вердикт и пояснение. Подробнее по каждой переменной —
        doc/LOCAL-DEVELOPMENT.md и doc/TELEGRAM-ADMIN.md.
      </p>

      <div className="card" style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 12 }}>
        <StatusBadge severity={result.allOk ? 'ok' : problems.some((p) => p.severity === 'critical') ? 'critical' : 'warning'} />
        <span>
          {result.allOk
            ? 'Все переменные окружения в порядке.'
            : `${problems.length} из ${result.checks.length} переменных требуют внимания.`}
        </span>
      </div>

      {groupChecks(result.checks).map(([group, checks]) => (
        <div className="settings-group" key={group}>
          <h2>{group}</h2>
          <div className="table-scroll">
            <table className="table-narrow">
              <thead>
                <tr>
                  <th>Переменная</th>
                  <th>Статус</th>
                  <th>Значение</th>
                  <th>Комментарий</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((check) => (
                  <tr key={check.key}>
                    <td>
                      {check.key}
                      {check.required && (
                        <span className="muted" title="Обязательна">
                          {' '}
                          *
                        </span>
                      )}
                    </td>
                    <td>
                      <StatusBadge severity={check.severity} />
                    </td>
                    <td className="muted">{check.value ?? (check.set ? '(задано, секрет)' : '—')}</td>
                    <td className="muted">{check.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
