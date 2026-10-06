'use client';

// «Обзор» — первая страница админки: очередь внимания
// (doc/TUTORIAL-DEMO-QUALITY-SPEC.md, раздел «Дашборд внимания»).
//
// Раньше `/` перенаправлял на `/sessions`, и ошибки кронов, модерация и
// ролики на одобрении не были видны при входе. Теперь здесь общая
// очередь: сначала то, что блокирует, потом решения оператора, потом к
// сведению; у каждой карточки причина, возраст, ответственный и переход
// к существующему экрану, где проблема решается. Сама страница ничего не
// одобряет — только ведёт к действию.
//
// Обновление — кнопкой и раз в минуту, пока вкладка видна; при
// возвращении на вкладку — сразу, если данные устарели. «Всё спокойно»
// показывается только когда ответили все источники: недоступный
// источник — «не удалось проверить», а не зелёный ноль.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAttention } from '../lib/endpoints';
import { ApiRequestError } from '../lib/admin-api';
import { useAdminAuth } from '../lib/admin-auth-context';
import {
  ATTENTION_REFRESH_MS,
  ATTENTION_SECTIONS,
  actionLabel,
  calmState,
  formatAge,
  formatClock,
  formatSince,
  groupBySeverity,
  OWNER_LABEL,
  SEVERITY_BADGE,
  SEVERITY_LABEL,
} from '../lib/attention';
import type { AttentionItem, AttentionView } from '../lib/attention';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось загрузить очередь';
}

export default function OverviewPage() {
  const { me } = useAdminAuth();
  const [view, setView] = useState<AttentionView | null>(null);
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Ответ на старый запрос не должен перезаписать более новый.
  const seq = useRef(0);
  const loadedAtRef = useRef<number>(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    setLoading(true);
    try {
      const data = await getAttention();
      if (id !== seq.current) return;
      setView(data);
      setError(null);
      const at = new Date();
      setLoadedAt(at);
      loadedAtRef.current = at.getTime();
    } catch (e) {
      if (id !== seq.current) return;
      setError(errText(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!me) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, ATTENTION_REFRESH_MS);
    const onVisible = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - loadedAtRef.current >= ATTENTION_REFRESH_MS
      ) {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [me, load]);

  if (!me) {
    return (
      <main className="page">
        <p className="muted">Проверяем вход…</p>
      </main>
    );
  }

  const groups = view ? groupBySeverity(view.items) : null;
  const calm = view ? calmState(view) : null;
  const failed = view ? view.sources.filter((s) => s.status === 'error') : [];
  const quality = view?.sources.find((s) => s.key === 'quality');

  return (
    <main className="page attention-page">
      <div className="attention-head">
        <div>
          <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Обзор</h1>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            Что требует внимания: сначала блокирующее, затем решения оператора.
          </p>
        </div>
        <div className="attention-refresh">
          <span className="muted" aria-live="polite">
            {loadedAt ? `Обновлено в ${formatClock(loadedAt)}` : loading ? 'Загрузка…' : ''}
          </span>
          <button type="button" onClick={() => void load()} disabled={loading}>
            {loading ? 'Обновляем…' : 'Обновить'}
          </button>
        </div>
      </div>

      {error && (
        <p className="critical" role="alert">
          {error}
          {view && loadedAt ? ` — показаны данные на ${formatClock(loadedAt)}.` : ''}
        </p>
      )}

      {view && (
        <div className="stat-grid attention-counts" aria-label="Счётчики очереди">
          <CountTile label="Блокирует" value={view.counts.blocker} tone="critical" />
          <CountTile label="Решения оператора" value={view.counts.decision} tone="warning" />
          <CountTile label="К сведению" value={view.counts.info} tone="ok" />
        </div>
      )}

      {failed.length > 0 && (
        <div className="card attention-sources" role="status">
          <strong>Не все источники проверены.</strong>
          <ul>
            {failed.map((s) => (
              <li key={s.key}>
                {s.label}: <span className="muted">{s.error ?? 'не удалось проверить'}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {calm === 'calm' && (
        <div className="card attention-calm">
          <h2>Всё спокойно</h2>
          <p className="muted">
            Кроны работают, ничего не ждёт одобрения, все источники ответили.
          </p>
        </div>
      )}
      {calm === 'partial' && (
        <div className="card attention-calm">
          <h2>Проблем не найдено</h2>
          <p className="muted">
            Но часть источников проверить не удалось (см. выше) — это не «всё спокойно».
          </p>
        </div>
      )}

      {groups &&
        ATTENTION_SECTIONS.map(({ severity, title, hint }) =>
          groups[severity].length === 0 ? null : (
            <section key={severity} className="attention-section" aria-labelledby={`att-${severity}`}>
              <h2 id={`att-${severity}`}>
                {title} <span className="muted">· {groups[severity].length}</span>
              </h2>
              <p className="muted attention-hint">{hint}</p>
              <ul className="attention-list">
                {groups[severity].map((item) => (
                  <li key={item.id}>
                    <AttentionCard item={item} />
                  </li>
                ))}
              </ul>
            </section>
          ),
        )}

      {view?.truncated && (
        <p className="muted">Показаны самые срочные карточки — остальные появятся по мере разбора.</p>
      )}

      {view && (
        <section className="attention-section" aria-labelledby="att-quality">
          <h2 id="att-quality">Качество демо</h2>
          <div className="card attention-quality">
            {quality?.status === 'not_configured' || !quality ? (
              <>
                <span className="badge-status badge-status-warning">не настроено</span>
                <p className="muted">
                  Автоматическая проверка роликов (Gemini по монтажному manifest) ещё не подключена.
                  Здесь появятся критические дефекты, утечки и исчерпанные повторы проверок —
                  до тех пор качество демо проверяется вручную на вкладке «Консультант лендинга».
                </p>
              </>
            ) : quality.status === 'error' ? (
              <p className="critical">{quality.error ?? 'Не удалось проверить'}</p>
            ) : (
              <p className="muted">Проверка подключена.</p>
            )}
          </div>
        </section>
      )}

      {!view && !error && <p className="muted">Загружаем очередь…</p>}
    </main>
  );
}

function CountTile({ label, value, tone }: { label: string; value: number; tone: 'critical' | 'warning' | 'ok' }) {
  return (
    <div className="stat-tile">
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div className={value > 0 && tone === 'critical' ? 'value critical' : 'value'}>{value}</div>
    </div>
  );
}

function AttentionCard({ item }: { item: AttentionItem }) {
  return (
    <article className={`card attention-card attention-card-${item.severity}`}>
      <div className="attention-card-main">
        <div className="attention-card-title">
          <span className={`badge-status badge-status-${SEVERITY_BADGE[item.severity]}`}>
            {SEVERITY_LABEL[item.severity]}
          </span>
          <h3>{item.title}</h3>
          {item.count !== undefined && item.count > 1 && (
            <span className="attention-count" aria-label={`Количество: ${item.count}`}>
              ×{item.count}
            </span>
          )}
        </div>
        <p className="attention-reason">{item.reason}</p>
        <dl className="attention-meta">
          <div>
            <dt>Возраст</dt>
            <dd title={`с ${formatSince(item.since)}`}>{formatAge(item.ageMs)}</dd>
          </div>
          <div>
            <dt>Ответственный</dt>
            <dd>{OWNER_LABEL[item.owner] ?? item.owner}</dd>
          </div>
          <div>
            <dt>Появилось</dt>
            <dd>{formatSince(item.since)}</dd>
          </div>
        </dl>
      </div>
      <Link className="attention-action" href={item.href} aria-label={`${actionLabel(item.kind)}: ${item.title}`}>
        {actionLabel(item.kind)} →
      </Link>
    </article>
  );
}
