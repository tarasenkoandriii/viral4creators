'use client';

// Расходы на ИИ — ТЗ §26 (этап 31). Отвечает на два вопроса сразу:
// «сколько сервис тратит вообще» и «на кого именно».
//
// Три вещи на этом экране сделаны намеренно и стоят объяснения:
//
//  1. Рядом с суммой всегда видна ВЕРСИЯ ПРАЙСА, по которой она
//     посчитана. Сумма без ставок — число без единиц измерения; а если
//     прайс правили, старые строки посчитаны по старым ставкам, и
//     показывать над ними текущую версию было бы враньём.
//  2. Вызовы без ставки в прайсе показаны отдельной строкой. Их деньги в
//     сумму не попали, и молчать об этом нельзя: иначе занижение читается
//     как экономия.
//  3. Расход анонимных сессий показан отдельно от пользовательского.
//     Он реален, но ни на кого не записывается, и подмешивать его в
//     средний расход на пользователя значит завышать этот средний.

import { useEffect, useState } from 'react';
import { getCosts } from '../../lib/endpoints';
import type { CostBucket, CostReport } from '../../lib/types';
import { operationLabel, share, usd } from '../../lib/money';
import { ApiRequestError } from '../../lib/admin-api';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function Breakdown({
  title,
  rows,
  total,
  label = (k: string) => k,
}: {
  title: string;
  rows: CostBucket[];
  total: number;
  label?: (key: string) => string;
}) {
  return (
    <section className="card" style={{ marginTop: 16 }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>{title}</h2>
      {rows.length === 0 ? (
        <p className="muted">Пока пусто.</p>
      ) : (
        <div className="table-scroll">
          <table className="table-narrow" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} style={{ borderTop: '1px solid #333' }}>
                  <td style={{ padding: '6px 0' }}>{label(r.key)}</td>
                  <td className="muted" style={{ width: 90, fontSize: 12 }}>
                    {r.calls} выз.
                  </td>
                  {/* Полоска доли — иллюстрация к проценту справа, а не
                      данные. На телефоне она уводила бы саму сумму за
                      правый край карточки, поэтому там её нет (см.
                      `.share-bar` в globals.css). */}
                  <td className="share-bar" style={{ width: 220 }}>
                    <div
                      style={{
                        height: 6,
                        borderRadius: 3,
                        background: '#2a2a2e',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          width: `${share(r.costMicroUsd, total)}%`,
                          height: '100%',
                          background: 'var(--accent)',
                        }}
                      />
                    </div>
                  </td>
                  <td style={{ width: 110, textAlign: 'right' }}>
                    {usd(r.costMicroUsd)}
                    <span className="muted" style={{ fontSize: 12 }}>
                      {' '}
                      {share(r.costMicroUsd, total)}%
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function CostsPage() {
  const [report, setReport] = useState<CostReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCosts({ top: 20 })
      .then(setReport)
      .catch((e) => setError(errText(e)));
  }, []);

  if (error) {
    return (
      <main className="admin-main">
        <h1>Расходы</h1>
        <p className="critical">{error}</p>
      </main>
    );
  }
  if (!report) {
    return (
      <main className="admin-main">
        <h1>Расходы</h1>
        <p className="muted">Загрузка…</p>
      </main>
    );
  }

  const stale =
    report.pricingVersion !== 'нет данных' &&
    report.pricingVersion !== report.currentPricingVersion;

  return (
    <main className="admin-main">
      <h1>Расходы на ИИ</h1>
      <p className="muted">
        Каждый платный вызов — Gemini, GPT-5, Veo, SerpApi, YouTube —
        записывается отдельной строкой. Суммы считаются по прайсу из
        <code> backend/src/common/ai-pricing.ts</code>; любую ставку можно
        переопределить переменной окружения.
      </p>
      {/* Сказать про исключение НАД цифрами, а не под ними: человек,
          который сверяет счёт провайдера с этой страницей, должен
          узнать про недостающую часть до того, как не сойдётся. */}
      <p className="muted" style={{ fontSize: 13 }}>
        Расход тестовых аккаунтов в эти числа не входит — он вынесен
        отдельной плиткой. Провайдеру за него заплачено, поэтому при
        сверке со счётом его надо прибавить; в экономике продукта ему
        места нет: это её проверка, а не она сама.
      </p>

      <div className="stat-grid">
        <div className="stat-tile">
          <div className="muted">Всего</div>
          <div className="value">{usd(report.totalMicroUsd)}</div>
          <div className="muted">{report.totalCalls} вызовов</div>
        </div>
        <div className="stat-tile">
          <div className="muted">За 24 часа</div>
          <div className="value">{usd(report.last24hMicroUsd)}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">За 7 дней</div>
          <div className="value">{usd(report.last7dMicroUsd)}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">За 30 дней</div>
          <div className="value">{usd(report.last30dMicroUsd)}</div>
        </div>
        <div className="stat-tile">
          <div className="muted">В среднем на пользователя</div>
          <div className="value">{usd(report.avgPerUserMicroUsd)}</div>
          <div className="muted">
            {report.payingUsers} с расходом; анонимные не в счёт
          </div>
        </div>
        <div className="stat-tile">
          <div className="muted">В среднем на сессию</div>
          <div className="value">{usd(report.avgPerSessionMicroUsd)}</div>
          {/* Единственная плитка не «за всё время»: идентификатор сессии
              в свёртку журнала не входит (этап 118), поэтому и деньги, и
              число сессий здесь — по несвёрнутым месяцам. */}
          <div className="muted">
            {report.sessionsWithCost} сессий за последние месяцы
          </div>
        </div>
        <div className="stat-tile">
          <div className="muted">Анонимные сессии</div>
          <div className="value">{usd(report.anonymousMicroUsd)}</div>
          <div
            className={
              report.anonymousSpentTodayMicroUsd >= report.limits.anonymous
                ? 'critical'
                : 'muted'
            }
          >
            сегодня {usd(report.anonymousSpentTodayMicroUsd)} из{' '}
            {usd(report.limits.anonymous)}
          </div>
        </div>
        {/* Тестовые аккаунты (TODO §III п.37). Плитка появляется только
            когда такие аккаунты есть: пустая строка «$0.00 у 0
            аккаунтов» ничего не сообщает, а место занимает. Важно
            сказать прямо, что остальные числа их НЕ включают, — иначе
            складывать их начнут дважды. */}
        {report.testUsers.accounts > 0 && (
          <div className="stat-tile">
            <div className="muted">Тестовые аккаунты</div>
            <div className="value">{usd(report.testUsers.costMicroUsd)}</div>
            <div className="muted">
              {report.testUsers.accounts} акк. · {report.testUsers.calls} выз. ·
              сегодня {usd(report.testUsers.spentTodayMicroUsd)}
            </div>
            <div className="muted" style={{ fontSize: 12 }}>
              не входят в остальные числа этой страницы
            </div>
          </div>
        )}
        <div className="stat-tile">
          <div className="muted">Прайс</div>
          <div className="value" style={{ fontSize: 18 }}>
            {report.pricingVersion}
          </div>
          <div className={stale ? 'warning' : 'muted'}>
            {stale
              ? `сейчас действует ${report.currentPricingVersion} — часть сумм посчитана по старым ставкам`
              : 'по нему посчитаны суммы'}
          </div>
        </div>
      </div>

      {report.unpricedCalls > 0 && (
        <p className="critical" style={{ marginTop: 16 }}>
          {report.unpricedCalls} вызов(ов) без ставки в прайсе — их стоимость
          в сумму НЕ вошла. Добавьте модель в{' '}
          <code>backend/src/common/ai-pricing.ts</code>, иначе общая цифра
          занижена.
        </p>
      )}

      <Breakdown
        title="По провайдерам"
        rows={report.byProvider}
        total={report.totalMicroUsd}
      />
      <Breakdown
        title="По операциям"
        rows={report.byOperation}
        total={report.totalMicroUsd}
        label={operationLabel}
      />
      <Breakdown
        title="По моделям"
        rows={report.byModel}
        total={report.totalMicroUsd}
      />

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Кто тратит больше всех</h2>
        {report.top.length === 0 ? (
          <p className="muted">Пока никто.</p>
        ) : (
          <div className="table-scroll">
            <table className="table-narrow" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Пользователь</th>
                  <th style={{ textAlign: 'left' }}>Режим</th>
                  <th style={{ textAlign: 'left' }}>Вызовов</th>
                  <th style={{ textAlign: 'right' }}>Расход</th>
                </tr>
              </thead>
              <tbody>
                {report.top.map((u) => (
                  <tr key={u.userId} style={{ borderTop: '1px solid #333' }}>
                    <td style={{ padding: '6px 0' }}>
                      <a href={`/users?q=${encodeURIComponent(u.telegramId ?? '')}`}>
                        {u.username ? `@${u.username}` : (u.telegramId ?? u.userId)}
                      </a>
                      {u.isBlocked && (
                        <span className="critical" style={{ marginLeft: 8, fontSize: 12 }}>
                          заблокирован
                        </span>
                      )}
                    </td>
                    <td className="muted">{u.plan}</td>
                    <td className="muted">{u.calls}</td>
                    <td style={{ textAlign: 'right' }}>{usd(u.costMicroUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Суточные потолки</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Сколько один пользователь может потратить за сутки (окно — от
          полуночи UTC). У анонимных потолок ОБЩИЙ на всех: персонального у
          них быть не может, а без общего достаточно выйти из аккаунта,
          чтобы обойти лимит. Значения задаются переменными окружения{' '}
          <code>DAILY_SPEND_LIMIT_USD_*</code>.
        </p>
        <div className="table-scroll">
          <table className="table-narrow" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {Object.entries(report.limits.byPlan).map(([plan, limit]) => (
                <tr key={plan} style={{ borderTop: '1px solid #333' }}>
                  <td style={{ padding: '6px 0' }}>{plan}</td>
                  <td style={{ textAlign: 'right' }}>{usd(limit)} / сутки</td>
                </tr>
              ))}
              <tr style={{ borderTop: '1px solid #333' }}>
                <td style={{ padding: '6px 0' }}>
                  Анонимные (все вместе)
                  <div className="muted" style={{ fontSize: 12 }}>
                    сегодня выбрано {usd(report.anonymousSpentTodayMicroUsd)}
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {usd(report.limits.anonymous)} / сутки
                </td>
              </tr>
              {/* Тестовые аккаунты (TODO §III п.37): потолок у них свой,
                  и в таблице потолков он должен стоять рядом с
                  остальными — иначе «почему этот тратит больше Lite»
                  ищут в тарифах. */}
              <tr style={{ borderTop: '1px solid #333' }}>
                <td style={{ padding: '6px 0' }}>
                  Тестовые аккаунты
                  <div className="muted" style={{ fontSize: 12 }}>
                    на отмеченных им сценариях, вместо тарифного
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  {usd(report.limits.testUser)} / сутки
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Действующий прайс</h2>
        <p className="muted" style={{ fontSize: 13 }}>
          Ставка, помеченная как переопределённая, задана переменной
          окружения и в коде выглядит иначе. Примечание говорит, откуда
          ставка взята и стоит ли ей верить.
        </p>
        <div className="table-scroll">
          <table className="table-narrow" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Модель</th>
                <th style={{ textAlign: 'left' }}>Ставка</th>
                <th style={{ textAlign: 'left' }}>Откуда</th>
              </tr>
            </thead>
            <tbody>
              {report.pricing.map((p) => (
                <tr key={p.model} style={{ borderTop: '1px solid #333' }}>
                  <td style={{ padding: '6px 0' }}>
                    {p.model}
                    <div className="muted" style={{ fontSize: 12 }}>
                      {p.provider}
                    </div>
                  </td>
                  <td style={{ fontSize: 13 }}>
                    {p.inputPerMTokUsd !== null && (
                      <div>${p.inputPerMTokUsd} / 1M вход</div>
                    )}
                    {p.cachedInputPerMTokUsd !== null && (
                      <div>${p.cachedInputPerMTokUsd} / 1M вход из кеша</div>
                    )}
                    {p.outputPerMTokUsd !== null && (
                      <div>${p.outputPerMTokUsd} / 1M выход</div>
                    )}
                    {p.perSecondUsd !== null && (
                      <div>${p.perSecondUsd} / секунда</div>
                    )}
                    {p.perCallUsd !== null && <div>${p.perCallUsd} / вызов</div>}
                    {p.perMCharsUsd !== null && (
                      <div>${p.perMCharsUsd} / 1M символов</div>
                    )}
                    {p.overridden && (
                      <div className="warning" style={{ fontSize: 12 }}>
                        переопределена переменной окружения
                      </div>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 12, maxWidth: 320 }}>
                    {p.note}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
