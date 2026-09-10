'use client';

import { useEffect, useState } from 'react';
import { getTelemetry } from '../../lib/endpoints';
import type { TelemetryResult } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';

export default function TelemetryPage() {
  const [telemetry, setTelemetry] = useState<TelemetryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getTelemetry()
      .then(setTelemetry)
      .catch((err) => setError(err instanceof ApiRequestError ? err.message : 'Не удалось загрузить телеметрию'));
  }, []);

  if (error) {
    return (
      <div className="page">
        <p style={{ color: 'var(--signal-critical)' }}>{error}</p>
      </div>
    );
  }

  if (!telemetry) {
    return (
      <div className="page">
        <p className="muted">Загрузка…</p>
      </div>
    );
  }

  return (
    <div className="page">
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Телеметрия</h1>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="muted">Всего сессий</div>
          <div className="value">{telemetry.total}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">За 24ч</div>
          <div className="value">{telemetry.createdLast24h}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">За 7д</div>
          <div className="value">{telemetry.createdLast7d}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">Ошибок генерации</div>
          <div className="value">{telemetry.failedGenerations}</div>
        </div>
      </div>

      <h2 style={{ fontSize: 16, marginTop: 28, marginBottom: 12 }}>По статусу</h2>
      <div className="table-scroll">
        <table className="table-narrow">
          <thead>
            <tr>
              <th>Статус</th>
              <th>Кол-во</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(telemetry.byStatus).map(([status, count]) => (
              <tr key={status}>
                <td>{status}</td>
                <td>{count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
