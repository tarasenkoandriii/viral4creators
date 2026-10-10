"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getSonioxDashboard,
  sonioxFailures,
  sonioxInWindow,
  sonioxHourSeries,
  type SonioxDashboard,
  type SonioxSource,
} from "../../lib/soniox";
const roles: Record<string, string> = {
  client: "Клиенты и посетители",
  operator: "Операторы платформы",
  administrator: "Администраторы клиентов",
  cron: "Кроны",
  system: "Фоновые процессы",
  qa: "QA",
};
const operations: Record<string, string> = {
  stt: "Распознавание",
  tts: "Генерация речи",
  catalog: "Каталог голосов",
  cleanup: "Уборка",
};
const states: Record<string, string> = {
  ok: "Успешно",
  error: "Ошибка",
  timeout: "Таймаут",
  empty: "Нет речи / пустой результат",
  running: "В работе",
  interrupted: "Нет завершения",
  skipped: "Пропущено",
  "not-configured": "Нет ключа",
};
const n = (v: number | null | undefined) =>
  typeof v === "number"
    ? v.toLocaleString("ru-RU", { maximumFractionDigits: 2 })
    : "—";
const time = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString("ru-RU") : "—";
export default function SonioxPage() {
  const [data, setData] = useState<SonioxDashboard | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState<1 | 7>(7),
    [role, setRole] = useState("all"),
    [operation, setOperation] = useState("all"),
    [live, setLive] = useState(true);
  const loading = useRef(false),
    mounted = useRef(true);
  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    setBusy(true);
    try {
      const result = await getSonioxDashboard();
      if (mounted.current) {
        setData(result);
        setError(null);
      }
    } catch (e) {
      if (mounted.current)
        setError(
          e instanceof Error ? e.message : "Не удалось загрузить Soniox",
        );
    } finally {
      loading.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 15000);
    return () => clearInterval(id);
  }, [load, live]);
  const sources: Array<[string, SonioxSource]> = data
    ? [
        ["Генератор / TMA", data.generator],
        ["QA / AI helper", data.sites],
      ]
    : [];
  const readable = sources.some(([, s]) => s.available);
  const incomplete = sources.some(([, s]) => !s.available);
  const groups = sources.flatMap(([product, s]) =>
    (s.groups ?? [])
      .filter(
        (g) =>
          sonioxInWindow(g, days) &&
          (role === "all" || g.actorRole === role) &&
          (operation === "all" || g.operation === operation),
      )
      .map((g) => ({ ...g, product })),
  );
  const sum = (
    field: "calls" | "seconds" | "words" | "characters",
    predicate = (g: (typeof groups)[number]) => true,
  ) => groups.filter(predicate).reduce((a, g) => a + g[field], 0);
  const total = sum("calls"),
    failed = sum("calls", (g) => sonioxFailures(g.status));
  const active = sources.reduce(
    (a, [, s]) => a + (s.coverage?.[0]?.active ?? 0),
    0,
  );
  const recent = sources
    .flatMap(([product, s]) =>
      (s.recent ?? [])
        .filter(
          (e) =>
            (role === "all" || e.actorRole === role) &&
            (operation === "all" || e.operation === operation) &&
            (days === 7 || Date.parse(e.startedAt) >= Date.now() - 86400000),
        )
        .map((e) => ({ ...e, product })),
    )
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Soniox — вся система</h1>
          <p className="muted">
            Распознавание, синтез речи, ошибки и текущие задачи. Последние 7
            дней и 24 часа — скользящие окна, время отображается локально.
          </p>
        </div>
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {busy ? "Обновление…" : "Обновить"}
        </button>
      </div>
      <div
        style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}
      >
        <select
          aria-label="Период"
          value={days}
          onChange={(e) => setDays(Number(e.target.value) as 1 | 7)}
        >
          <option value={7}>Последняя неделя</option>
          <option value={1}>Последние 24 часа</option>
        </select>
        <select
          aria-label="Кто использует"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="all">Все участники</option>
          {Object.entries(roles).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label="Операция"
          value={operation}
          onChange={(e) => setOperation(e.target.value)}
        >
          <option value="all">Все операции</option>
          {Object.entries(operations).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />{" "}
          Обновлять каждые 15 секунд
        </label>
      </div>
      {error && (
        <p role="alert">
          {error}. Показанные ранее данные могут быть устаревшими.
        </p>
      )}
      {!data && !error && <p>Загрузка состояния…</p>}
      {data && (
        <>
          <p className="muted">
            {incomplete ? "Сводка неполная: часть источников недоступна. " : ""}
            Снимок: {time(data.generatedAt)}. «В работе» — начатые задачи без
            завершения моложе 5 минут; более старые показаны как «Нет
            завершения». Это наблюдаемое состояние, а не проверка доступности
            Soniox.
          </p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
              gap: 12,
            }}
          >
            {[
              ["Попытки", readable ? n(total) : "—"],
              ["Ошибки / таймауты", readable ? n(failed) : "—"],
              ["Доля ошибок", total ? n((failed / total) * 100) + "%" : "—"],
              ["Сейчас в работе (вся система)", readable ? n(active) : "—"],
              ["Слова распознаны", readable ? n(sum("words")) : "—"],
              ["Аудио, минуты", readable ? n(sum("seconds") / 60) : "—"],
              ["Символы озвучки", readable ? n(sum("characters")) : "—"],
            ].map(([label, value]) => (
              <div className="card" key={label} style={{ padding: 16 }}>
                <div className="muted">{label}</div>
                <strong style={{ fontSize: 26 }}>{value}</strong>
              </div>
            ))}
          </div>
          <h2>Источники и полнота данных</h2>
          {sources.map(([name, s]) => (
            <div
              className="card"
              key={name}
              style={{ padding: 16, marginBottom: 12 }}
            >
              <strong>
                {name}: {s.available ? "журнал доступен" : "данные недоступны"}
              </strong>
              <p>
                {s.error ??
                  `Ключ: ${s.keyConfigured ? "настроен" : "не настроен"}. Первая запись за неделю: ${time(s.coverage?.[0]?.firstEventAt)}. Нет завершения: ${n(s.coverage?.[0]?.interrupted)}.`}
              </p>
              <p className="muted">
                Ошибки и активные задачи учитываются с момента установки
                журнала. Старые расходы можно увидеть ниже; отсутствие событий
                до установки не означает отсутствие вызовов.
              </p>
            </div>
          ))}
          <h2>Использование и качество по участникам</h2>
          <p className="muted">
            Участники, кабинеты и сайты считаются по известным идентификаторам;
            анонимные посетители не становятся отдельными учётными записями.
            Успешное распознавание означает получение текста, а не выполнение
            команды.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Продукт / участник</th>
                  <th>Операция / источник</th>
                  <th>Состояние</th>
                  <th>Вызовы</th>
                  <th>Слова / символы</th>
                  <th>Аудио, мин.</th>
                  <th>Среднее / p95, с</th>
                  <th>Уверенность STT / ниже 60%</th>
                  <th>Участники / кабинеты / сайты</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g, i) => (
                  <tr key={i}>
                    <td>
                      {g.product}
                      <br />
                      {roles[g.actorRole] ?? g.actorRole}
                      <br />
                      {g.window === "day" ? "За 24 часа" : "Предыдущие 6 дней"}
                    </td>
                    <td>
                      {operations[g.operation] ?? g.operation}
                      <br />
                      <small>{g.source}</small>
                    </td>
                    <td>{states[g.status] ?? g.status}</td>
                    <td>{n(g.calls)}</td>
                    <td>
                      {n(g.words)} / {n(g.characters)}
                    </td>
                    <td>{n(g.seconds / 60)}</td>
                    <td>
                      {g.latencyAvgMs === null ? "—" : n(g.latencyAvgMs / 1000)}{" "}
                      /{" "}
                      {g.latencyP95Ms === null ? "—" : n(g.latencyP95Ms / 1000)}
                    </td>
                    <td>
                      {g.confidence === null
                        ? "—"
                        : n(g.confidence * 100) + "%"}{" "}
                      / {n(g.lowConfidence)}
                    </td>
                    <td>
                      {n(g.actors)} / {n(g.accounts)} / {n(g.sites)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!groups.length && <p>В выбранном окне нет записанных событий.</p>}
          </div>
          <h2>Активность по часам</h2>
          {sources.map(([name, s]) => {
            const points = sonioxHourSeries(s.hourly ?? [], days);
            const max = Math.max(1, ...points.map((p) => p.calls));
            return (
              <div key={name}>
                <h3>{name}</h3>
                <p className="muted">
                  Все роли и операции; высота — вызовы, красная часть — ошибки и
                  таймауты.
                </p>
                <svg
                  viewBox="0 0 840 130"
                  role="img"
                  aria-label={`Почасовая активность ${name}`}
                  style={{ width: "100%", maxHeight: 180 }}
                >
                  {points.map((p, i) => {
                    const x = (i * 840) / Math.max(1, points.length),
                      w = Math.max(1, 840 / Math.max(1, points.length) - 1);
                    return (
                      <g key={p.at}>
                        <title>
                          {time(p.at)}: {p.calls} вызовов, {p.errors} ошибок
                        </title>
                        <rect
                          x={x}
                          y={120 - (p.calls / max) * 100}
                          width={w}
                          height={(p.calls / max) * 100}
                          fill="var(--signal-ok,#33aa88)"
                        />
                        <rect
                          x={x}
                          y={120 - (p.errors / max) * 100}
                          width={w}
                          height={(p.errors / max) * 100}
                          fill="var(--signal-critical,#e55)"
                        />
                      </g>
                    );
                  })}
                  <text x="0" y="130" fontSize="9" fill="currentColor">
                    {time(points[0]?.at)}
                  </text>
                  <text
                    x="840"
                    y="130"
                    textAnchor="end"
                    fontSize="9"
                    fill="currentColor"
                  >
                    {time(points[points.length - 1]?.at)}
                  </text>
                </svg>
              </div>
            );
          })}
          <h2>Задачи в работе сейчас</h2>
          {sources.map(([name, s]) => (
            <div key={name}>
              <h3>{name}</h3>
              {s.active?.length ? (
                <ul>
                  {s.active.map((e) => (
                    <li key={e.id}>
                      {operations[e.operation] ?? e.operation} ·{" "}
                      {roles[e.actorRole] ?? e.actorRole} · {e.source} · начато{" "}
                      {time(e.startedAt)} · ожидание{" "}
                      {n((Date.now() - Date.parse(e.startedAt)) / 1000)} с
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  {s.available
                    ? "Нет наблюдаемых задач в работе."
                    : "Нет данных."}
                </p>
              )}
            </div>
          ))}
          <h2>Последние события и то, что происходит сейчас</h2>
          <p className="muted">
            До 100 последних событий из каждого бэкенда. Аудио и тексты
            пользователя в журнале не хранятся.
          </p>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>Начало</th>
                  <th>Продукт / участник</th>
                  <th>Источник</th>
                  <th>Операция</th>
                  <th>Состояние</th>
                  <th>Длительность</th>
                  <th>Объём / язык</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((e) => (
                  <tr key={e.product + e.id}>
                    <td>{time(e.startedAt)}</td>
                    <td>
                      {e.product}
                      <br />
                      {roles[e.actorRole] ?? e.actorRole}
                      <br />
                      <small>
                        {[e.actorId, e.accountId, e.siteId]
                          .filter(Boolean)
                          .join(" / ")}
                      </small>
                    </td>
                    <td>
                      <small>{e.source}</small>
                    </td>
                    <td>{operations[e.operation] ?? e.operation}</td>
                    <td>
                      {states[e.status] ?? e.status}
                      {e.reasonCode && e.reasonCode !== e.status ? (
                        <small> / {e.reasonCode}</small>
                      ) : null}
                    </td>
                    <td>
                      {e.elapsedMs === null
                        ? "—"
                        : n(e.elapsedMs / 1000) + " с"}
                    </td>
                    <td>
                      {n(e.words)} слов / {n(e.characters)} симв. /{" "}
                      {n(e.seconds)} с<br />
                      {e.language ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h2>Финансовый журнал Soniox — последние 7 дней</h2>
          <p className="muted">
            Независимый журнал оплаченных объёмов. Не суммируется с оперативными
            попытками; ошибки до создания платной задачи сюда не попадают.
            Фильтры выше к этому разделу не применяются.
          </p>
          {sources.map(([name, s]) => (
            <div key={name}>
              <h3>{name}</h3>
              <ul>
                {(s.usage ?? []).map((u) => (
                  <li key={u.operation}>
                    {u.operation}: {n(u.calls)} вызовов, {n(u.seconds / 60)}{" "}
                    мин., {n(u.characters)} символов, ${n(u.costUsd)}; без цены:{" "}
                    {n(u.unpriced)}
                  </li>
                ))}
              </ul>
              {!s.usage?.length && (
                <p>
                  {s.billingAvailable === false
                    ? "Финансовый журнал недоступен."
                    : "Нет доступных строк расходов."}
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
