'use client';

// «Кадры лендинга поздравлений» (заход 8, TODO стр. 5329; ТЗ Greeting 2.0
// §5.3; порядок работы — doc/GREETING-FRAMES-CAPTURE.md).
//
// До этой страницы владелец снимал кадры «Как это работает» сырыми POST
// по документу: заводил фикстуру, раз в 20–30 секунд повторял вызов
// рендера, следил, чтобы не нажать платный шаг второй раз, и копировал
// адреса PNG из ответа. Здесь те же три шага кнопками:
//
// 1. Ролик фикстуры под кадр 4 — состояние читается GET-ом, который
//    ничего не двигает и не платит; платный шаг (первый рендер, повтор
//    упавшего, «переснять») — только через подтверждение «платно, ~$X»,
//    где X — расход прошлого прогона по журналу расходов. Идущий рендер
//    страница опрашивает сама, и только если СЛЕДУЮЩИЙ шаг сервера —
//    бесплатный опрос (решает `shouldAutoPoll`, перечитав состояние).
// 2. Съёмка четырёх кадров — по одной локали за вызов (так советует
//    документ: четыре браузера × пять локалей не влезают в предел времени
//    функции); «все локали» — те же вызовы по очереди.
// 3. Превью и скачивание PNG. Обработка (`tutorial-frames-process.mjs
//    --greeting`) и коммит в landing — НЕ здесь: это решение человека
//    после отбора глазами, страница только подсказывает команду.
//
// Адреса последней съёмки каждой локали запоминаются в браузере
// оператора: сервер немаскированных прогонов не хранит (строк UiSnapshot
// они не пишут), а файлы в Blob публичные и живут, пока их не удалят.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  captureGreetingFrames,
  getGreetingFixtureVideoState,
  seedFixtureUser,
  stepGreetingFixtureVideo,
} from '../../lib/endpoints';
import type { GreetingFixtureVideoResult, GreetingFixtureVideoState } from '../../lib/types';
import { ApiRequestError } from '../../lib/admin-api';
import { usd } from '../../lib/money';
import {
  ACTION_LABEL,
  blobDownloadUrl,
  costText,
  expectedAction,
  FIXTURE_POLL_INTERVAL_MS,
  frame4Warning,
  frameFileName,
  FRAMES_STORAGE_KEY,
  GREETING_FRAME_CARDS,
  GREETING_FRAME_LOCALES,
  GREETING_LOCALE_LABEL,
  missingCards,
  paidConfirmText,
  parseStoredFrames,
  processCommand,
  shouldAutoPoll,
  STAGE_LABEL,
  stageTone,
  type GreetingFrameLocale,
  type StoredLocaleFrames,
} from '../../lib/greeting-frames';

function errText(e: unknown): string {
  return e instanceof ApiRequestError ? e.message : 'Не удалось выполнить запрос';
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

type StoredFrames = Partial<Record<GreetingFrameLocale, StoredLocaleFrames>>;

function readStoredFrames(): StoredFrames {
  try {
    return parseStoredFrames(window.localStorage.getItem(FRAMES_STORAGE_KEY));
  } catch {
    return {};
  }
}

function writeStoredFrames(value: StoredFrames): void {
  try {
    window.localStorage.setItem(FRAMES_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Приватное окно или запрет хранилища — адреса останутся до перезагрузки.
  }
}

/**
 * Скачать PNG под именем кадра. Blob лежит на чужом домене, и атрибут
 * `download` у прямой ссылки браузер там не уважает — поэтому байты
 * через fetch; не дали (CORS, сеть) — ссылка Blob «скачать файлом»
 * (`?download=1`) в новой вкладке, имя тогда будет хранилища.
 */
async function downloadPng(url: string, name: string): Promise<boolean> {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    const href = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return true;
  } catch {
    window.open(blobDownloadUrl(url), '_blank', 'noopener');
    return false;
  }
}

export default function GreetingFramesPage() {
  // ── Шаг 1: ролик фикстуры ──
  const [fixture, setFixture] = useState<GreetingFixtureVideoState | null>(null);
  const [fixtureError, setFixtureError] = useState<string | null>(null);
  const [fixtureBusy, setFixtureBusy] = useState<'load' | 'step' | 'seed' | null>(null);
  const [lastStep, setLastStep] = useState<GreetingFixtureVideoResult | null>(null);
  const [lastPollAt, setLastPollAt] = useState<string | null>(null);
  const [autoPoll, setAutoPoll] = useState(true);
  const [seedLog, setSeedLog] = useState<string[] | null>(null);

  // ── Шаги 2–3: съёмка и файлы ──
  const [locale, setLocale] = useState<GreetingFrameLocale>('ru');
  const [frames, setFrames] = useState<StoredFrames>({});
  const [capturing, setCapturing] = useState<{ locale: GreetingFrameLocale; startedAt: number; queue: string } | null>(
    null,
  );
  const [elapsed, setElapsed] = useState(0);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

  useEffect(() => {
    setFrames(readStoredFrames());
  }, []);

  // Ответ, пришедший после более нового запроса состояния, выбрасывается.
  const fixtureReq = useRef(0);
  const loadFixture = useCallback(async (): Promise<GreetingFixtureVideoState | null> => {
    const req = ++fixtureReq.current;
    setFixtureError(null);
    try {
      const s = await getGreetingFixtureVideoState();
      if (req === fixtureReq.current) setFixture(s);
      return s;
    } catch (e) {
      if (req === fixtureReq.current) setFixtureError(errText(e));
      return null;
    }
  }, []);

  useEffect(() => {
    setFixtureBusy('load');
    void loadFixture().finally(() => setFixtureBusy(null));
  }, [loadFixture]);

  /**
   * Шаг ролика по кнопке. Состояние перечитывается прямо перед вызовом:
   * за минуту на странице рендер мог упасть, и «Опросить» превратилось бы
   * в платный повтор без вопроса.
   */
  const runStep = async (rerender: boolean) => {
    setFixtureBusy('step');
    setFixtureError(null);
    try {
      const fresh = await loadFixture();
      if (!fresh) return;
      if (fresh.skipped) {
        setFixtureError(fresh.skipped);
        return;
      }
      const expect = expectedAction(fresh, rerender);
      if (!expect) {
        setFixtureError(
          rerender ? 'Переснимать сейчас нечего: ролик не готов или идёт постобработка.' : 'Состояние ролика неизвестно.',
        );
        return;
      }
      const question = paidConfirmText(fresh, rerender);
      if (question && !window.confirm(question)) return;
      // Сервер получает подтверждённый шаг: изменись состояние за время
      // вопроса на платное другое — 409, а не списание без подтверждения.
      const r = await stepGreetingFixtureVideo(rerender, expect);
      setLastStep(r);
      setLastPollAt(new Date().toISOString());
      if (r.skipped) setFixtureError(r.skipped);
      await loadFixture();
    } catch (e) {
      setFixtureError(errText(e));
      await loadFixture();
    } finally {
      setFixtureBusy(null);
    }
  };

  // Автоопрос идущего рендера: только бесплатный шаг, только после
  // перечитывания состояния; платное страница сама не нажимает никогда.
  useEffect(() => {
    if (!autoPoll || fixtureBusy || !shouldAutoPoll(fixture)) return;
    const timer = window.setTimeout(async () => {
      setFixtureBusy('step');
      try {
        const fresh = await loadFixture();
        if (!fresh?.next || !shouldAutoPoll(fresh)) return;
        // `expect` — тот самый бесплатный опрос: упади рендер между двумя
        // запросами, сервер ответит 409 вместо платного повтора.
        const r = await stepGreetingFixtureVideo(false, fresh.next.action);
        setLastStep(r);
        setLastPollAt(new Date().toISOString());
        await loadFixture();
      } catch (e) {
        setFixtureError(errText(e));
        setAutoPoll(false);
        await loadFixture();
      } finally {
        setFixtureBusy(null);
      }
    }, FIXTURE_POLL_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [autoPoll, fixture, fixtureBusy, loadFixture]);

  const reseed = async () => {
    if (
      !window.confirm(
        'Пересеять фикстуру? Бесплатно и идемпотентно: обновит фикстурного пользователя и его проекты. Готовый ролик под кадр 4 пересев не стирает — его сессия не перезаписывается.',
      )
    ) {
      return;
    }
    setFixtureBusy('seed');
    setFixtureError(null);
    try {
      const r = await seedFixtureUser();
      setSeedLog(r.log);
      await loadFixture();
    } catch (e) {
      setFixtureError(errText(e));
    } finally {
      setFixtureBusy(null);
    }
  };

  // Секундомер съёмки: ответ приходит одним куском через минуту-другую,
  // и без счётчика страница выглядела бы зависшей.
  useEffect(() => {
    if (!capturing) return;
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - capturing.startedAt) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [capturing]);

  const confirmFrame4 = async (): Promise<boolean> => {
    const fresh = await loadFixture();
    const warning = frame4Warning(fresh);
    return !warning || window.confirm(`${warning}\n\nСнимать всё равно?`);
  };

  const captureLocales = async (list: readonly GreetingFrameLocale[]) => {
    setCaptureError(null);
    if (!(await confirmFrame4())) return;
    let stored = readStoredFrames();
    for (const [i, loc] of list.entries()) {
      setCapturing({ locale: loc, startedAt: Date.now(), queue: list.length > 1 ? `${i + 1} из ${list.length}` : '' });
      try {
        const r = await captureGreetingFrames(loc);
        if (r.skipped) {
          setCaptureError(`Съёмка не началась: ${r.skipped}`);
          break;
        }
        const got = r.locales.find((l) => l.locale === loc);
        if (!got) {
          setCaptureError(`Сервер не вернул кадры для «${loc}»`);
          break;
        }
        stored = { ...stored, [loc]: { at: new Date().toISOString(), cards: got.cards, problems: got.problems } };
        writeStoredFrames(stored);
        setFrames(stored);
        setLocale(loc);
      } catch (e) {
        setCaptureError(`${GREETING_LOCALE_LABEL[loc]}: ${errText(e)}`);
        break;
      }
    }
    setCapturing(null);
  };

  const current = frames[locale];
  const missing = missingCards(current?.cards);

  const downloadAll = async () => {
    if (!current) return;
    setDownloadNote(null);
    let fallback = 0;
    for (const { card } of GREETING_FRAME_CARDS) {
      const url = current.cards[String(card)];
      if (!url) continue;
      if (!(await downloadPng(url, frameFileName(locale, card)))) fallback++;
      // Пауза между файлами: часть браузеров молча режет пачку загрузок.
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
    if (fallback > 0) {
      setDownloadNote(
        `${fallback} файл(а) открыты ссылкой хранилища — переименуйте их в ${frameFileName(locale, 1)} … ${frameFileName(locale, 4)} по номеру кадра.`,
      );
    }
  };

  const downloadOne = async (card: number) => {
    const url = current?.cards[String(card)];
    if (!url) return;
    setDownloadNote(null);
    if (!(await downloadPng(url, frameFileName(locale, card)))) {
      setDownloadNote(`Файл открыт ссылкой хранилища — сохраните его как ${frameFileName(locale, card)}.`);
    }
  };

  const stage = fixture?.stage;
  const busy = fixtureBusy !== null;

  return (
    <main className="admin-main">
      <h1>Кадры лендинга поздравлений</h1>
      <p className="muted">
        Четыре настоящих кадра секции «Как это работает» страницы <code>/greetings</code>: бриф, «Характер ролика»,
        сценарий и готовый ролик — по пяти локалям. Порядок и чек-лист отбора — <code>doc/GREETING-FRAMES-CAPTURE.md</code>.
        Имена в кадрах размываются самим прогоном; ролик в кадре 4 — только фикстурный.
      </p>

      {/* ── Шаг 1 ── */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>1. Ролик фикстуры под кадр 4</h2>
        {fixtureError && <p className="critical">{fixtureError}</p>}
        {!fixture && fixtureBusy === 'load' && <p className="muted">Загружаю состояние…</p>}
        {fixture?.skipped && (
          <p className="critical">
            {fixture.skipped}. Нужны <code>FIXTURE_TELEGRAM_ID</code> (аккаунт помечен тестовым) и заведённая фикстура.
          </p>
        )}
        {fixture && !fixture.skipped && stage && (
          <>
            <p style={{ marginBottom: 6 }}>
              <span className={`badge-status badge-status-${stageTone(stage)}`}>{STAGE_LABEL[stage]}</span>
              {fixture.video?.resolution && (
                <span className="muted" style={{ marginLeft: 8 }}>
                  {fixture.video.resolution}
                </span>
              )}
            </p>
            <ul className="muted" style={{ fontSize: 13, marginTop: 6, paddingLeft: 18 }}>
              <li>
                Версия сессии от {formatDateTime(fixture.sessionCreatedAt)}
                {fixture.versions && fixture.versions > 1 ? ` (всего версий: ${fixture.versions})` : ''};
                сценарий {fixture.hasPrompt ? 'собран' : 'ещё не собран'}.
              </li>
              {fixture.video && (
                <li>
                  Рендер запущен {formatDateTime(fixture.video.initiatedAt)}
                  {fixture.video.completedAt ? `, готов ${formatDateTime(fixture.video.completedAt)}` : ''}.
                </li>
              )}
              {fixture.video?.error && <li className="critical">Отказ провайдера: {fixture.video.error}</li>}
              {fixture.video?.postError && (
                <li className="critical">
                  Постобработка упала: {fixture.video.postError} — в ролике нет своей озвучки, скорее всего, его придётся
                  переснять.
                </li>
              )}
              {fixture.next && (
                <li>
                  Следующее нажатие «Шаг ролика» {ACTION_LABEL[fixture.next.action]}
                  {fixture.next.paid ? ' — ПЛАТНО' : ' — бесплатно'}.
                </li>
              )}
              <li>
                {fixture.lastRun
                  ? `Прошлый прогон с рендером: ${usd(fixture.lastRun.costMicroUsd)}${
                      fixture.lastRun.unpriced ? ' (часть вызовов без ставки)' : ''
                    }, ${formatDateTime(fixture.lastRun.at)}.`
                  : 'Расход прошлого прогона журнал не знает.'}
              </li>
            </ul>

            {stage === 'complete' && fixture.video?.downloadUrl && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 13, marginBottom: 6 }}>
                  <strong>Посмотрите ролик целиком:</strong> ИИ-ведущий, ни одного имени человека, ни чужого бренда, голос
                  звучит.
                </p>
                <video
                  src={fixture.video.downloadUrl}
                  controls
                  preload="metadata"
                  style={{ maxWidth: 240, width: '100%', borderRadius: 8, background: '#000' }}
                />
              </div>
            )}
            {stage === 'post-processing' && (
              <p className="muted" style={{ fontSize: 13 }}>
                Картинка готова, своя озвучка ещё кладётся — слушать рано, снимать кадр 4 тоже.
              </p>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
          <button type="button" disabled={busy} onClick={() => void runStep(false)}>
            {fixtureBusy === 'step' ? 'Выполняю…' : fixture?.next?.paid ? 'Запустить рендер (платно)…' : 'Шаг ролика / опросить'}
          </button>
          <button type="button" disabled={busy || !fixture?.rerender} onClick={() => void runStep(true)}>
            Переснять ролик (платно)…
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setFixtureBusy('load');
              void loadFixture().finally(() => setFixtureBusy(null));
            }}
          >
            Обновить состояние
          </button>
          <button type="button" disabled={busy} onClick={() => void reseed()}>
            {fixtureBusy === 'seed' ? 'Пересеваю…' : 'Пересеять фикстуру'}
          </button>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={autoPoll} onChange={(e) => setAutoPoll(e.target.checked)} />
          опрашивать идущий рендер самой страницей раз в {FIXTURE_POLL_INTERVAL_MS / 1000} с (только бесплатные опросы)
        </label>
        {(lastStep || lastPollAt) && (
          <p className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            Последний шаг: {lastStep?.stage ? STAGE_LABEL[lastStep.stage] : lastStep?.skipped ?? '—'} ·{' '}
            {formatDateTime(lastPollAt)}
          </p>
        )}
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Любой платный шаг ({costText(fixture)}) спрашивает подтверждение. Повтор на идущем рендере не платит; упавший
          рендер запускается заново только руками. Ответ <code>skipped</code> про сессию — крон уборки снёс её до рендера:
          пересейте фикстуру и повторите.
        </p>
        {seedLog && (
          <ul className="muted" style={{ fontSize: 12, margin: '8px 0 0', paddingLeft: 18 }}>
            {seedLog.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Шаг 2 ── */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>2. Снять четыре кадра</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            aria-label="Локаль съёмки"
            value={locale}
            disabled={capturing !== null}
            onChange={(e) => setLocale(e.target.value as GreetingFrameLocale)}
          >
            {GREETING_FRAME_LOCALES.map((l) => (
              <option key={l} value={l}>
                {l} — {GREETING_LOCALE_LABEL[l]}
                {frames[l] ? ` (снято ${formatDateTime(frames[l]?.at)})` : ''}
              </option>
            ))}
          </select>
          <button type="button" disabled={capturing !== null} onClick={() => void captureLocales([locale])}>
            Снять «{locale}»
          </button>
          <button type="button" disabled={capturing !== null} onClick={() => void captureLocales(GREETING_FRAME_LOCALES)}>
            Снять все пять по очереди
          </button>
        </div>
        {capturing && (
          <p style={{ marginTop: 10 }}>
            <span className="badge-status badge-status-warning">идёт съёмка</span>{' '}
            {GREETING_LOCALE_LABEL[capturing.locale]}
            {capturing.queue ? ` (${capturing.queue})` : ''} — {elapsed} с. Четыре кадра — четыре прогона браузера, обычно
            одна-две минуты.
          </p>
        )}
        {captureError && <p className="critical">{captureError}</p>}
        <p className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          Тёмная тема, двойная плотность, по одной локали за вызов. Кадр 4 снимайте только после «готов» на шаге 1 — на
          постобработке в плеере окажется ролик без своей озвучки.
        </p>
      </section>

      {/* ── Шаг 3 ── */}
      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0 }}>
          3. Проверить и скачать — {locale} ({GREETING_LOCALE_LABEL[locale]})
        </h2>
        {!current ? (
          <p className="muted">Для этой локали в этом браузере съёмок ещё не было.</p>
        ) : (
          <>
            <p className="muted" style={{ fontSize: 13 }}>
              Снято {formatDateTime(current.at)}
              {missing.length > 0 ? ` · не сняты кадры: ${missing.join(', ')}` : ' · все четыре кадра'}.
            </p>
            {current.problems.length > 0 && (
              <ul className="critical" style={{ fontSize: 13, paddingLeft: 18 }}>
                {current.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 12,
                marginTop: 12,
              }}
            >
              {GREETING_FRAME_CARDS.map(({ card, label }) => {
                const url = current.cards[String(card)];
                return (
                  <figure key={card} style={{ margin: 0, minWidth: 0 }}>
                    {url ? (
                      <a href={url} target="_blank" rel="noopener noreferrer" title="Открыть в полном размере">
                        {/* eslint-disable-next-line @next/next/no-img-element -- публичный PNG из Blob, оптимизатор Next не нужен */}
                        <img
                          src={url}
                          alt={`Кадр ${card}: ${label}`}
                          loading="lazy"
                          style={{ width: '100%', borderRadius: 6, border: '1px solid var(--border)', display: 'block' }}
                        />
                      </a>
                    ) : (
                      <div
                        className="muted"
                        style={{
                          aspectRatio: '390 / 844',
                          border: '1px dashed var(--border)',
                          borderRadius: 6,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 12,
                        }}
                      >
                        не снят
                      </div>
                    )}
                    <figcaption style={{ fontSize: 12, marginTop: 6 }}>
                      {card}. {label}
                      {url && (
                        <div>
                          <button type="button" style={{ marginTop: 4 }} onClick={() => void downloadOne(card)}>
                            Скачать PNG
                          </button>
                        </div>
                      )}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
            <div style={{ marginTop: 12 }}>
              <button type="button" disabled={missing.length === GREETING_FRAME_CARDS.length} onClick={() => void downloadAll()}>
                Скачать все PNG локали
              </button>
            </div>
            {downloadNote && (
              <p className="muted" style={{ fontSize: 12 }}>
                {downloadNote}
              </p>
            )}
          </>
        )}

        <h3 style={{ fontSize: 14, marginTop: 20 }}>Перед обработкой — проверить каждый кадр</h3>
        <ul className="muted" style={{ fontSize: 13, paddingLeft: 18 }}>
          <li>ни одного читаемого имени, пожелания, текста сценария или титра — на их месте размытые строки;</li>
          <li>в кадре ровно своя секция, заголовок не спрятан под шапкой;</li>
          <li>кадр 4: в плеере кадр ролика с ведущим, а не чёрный прямоугольник; строки «голос не выбран» нет;</li>
          <li>интерфейс на языке прогона, тёмная тема, не спиннер и не ошибка, нет плашек лимита и советника.</li>
        </ul>

        <h3 style={{ fontSize: 14, marginTop: 16 }}>Куда отправить файлы</h3>
        <p className="muted" style={{ fontSize: 13 }}>
          Положите четыре PNG в корень монорепо и выполните (обрежет, приведёт к 780×1434 и уложит в 120 КБ —
          <code> landing/public/illustrations/greet-shot-{locale}-{'{1..4}'}.avif</code>):
        </p>
        <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{processCommand(locale)}</pre>
        <p className="muted" style={{ fontSize: 13 }}>
          Последним шагом допишите <code>{locale}</code> в <code>GREETING_REAL_FRAME_LOCALES</code> (
          <code>landing/src/lib/greeting-frames.ts</code>) и прогоните <code>node scripts/check-docs.mjs</code>: список
          раньше файлов — 404 на странице, файлы без списка — мёртвый груз.
        </p>
      </section>
    </main>
  );
}
