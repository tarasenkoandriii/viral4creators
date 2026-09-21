'use client';

import { useEffect, useRef, useState } from 'react';
import { getAuctionLiveState } from '../lib/client-api';
import type { PublicAuctionLiveState } from '../lib/api';
import type { AuctionCurrencyValue } from '../lib/fx-rates';
import { publishHighestBid } from '../lib/live-bid-bus';
import {
  createRotationState,
  pendingBidStatsSeq as pendingBidStatsSeqOf,
  pickNextCue,
  seedPlayed,
} from '../lib/live-cue-rotation';

/**
 * Живой аукцион (docs-tz/TZ-Virtualnaya-Studiya-i-AI-Vedushaya.md §7.1/
 * §7.5, Этап 5-7) — покупательский плеер эфира. Единственная
 * содержательная часть, которую ТЗ явно выносило «за границу этого
 * документа» (Этап 5, п.6): бэкенд (Этапы 5/6) уже отдаёт всё нужное
 * (`GET /auctions/:id/state` — полный плейлист готовых подсказок, не
 * только «последняя»), здесь — первый потребитель этого контракта на
 * стороне покупателя.
 *
 * Идея (§7.1) — ОДНО постоянное зацикленное видео (студийный
 * видео-фрагмент, назначенный оператором) + меняющаяся озвучка поверх:
 * ротация pregen-подсказок (LOT_DESC/INVITE/PRAISE) в перемешанном
 * порядке в паузах между ставками, немедленная вставка свежей
 * BID_STATS-подсказки, как только она готова.
 *
 * Транспорт — обычный поллинг, не SSE/EventSource, хотя бэкенд отдаёт
 * оба (`GET .../stream` — SSE-дельта). Осознанный выбор, не упрощение
 * «на скорую руку»: см. `docs-tz/AUDIT-Live-Auction-vs-SilverFinance.md`,
 * находка 4 — SilverFinance для точно той же задачи в итоге отдаёт
 * обычный `GET`, опрашиваемый раз в 4с (их код: «MVP uses polling,
 * matching the bidding model»), несмотря на то что их же исходное ТЗ
 * просило SSE/WS. Наш `GET .../state` спроектирован как самодостаточный
 * источник именно ради этого случая (полный `cues[]`, не «последняя
 * подсказка» — см. доккомментарий AuctionLiveStateView.cues) — платить
 * сложностью EventSource/переподключений здесь не нужно.
 *
 * Известное ограничение — не решается этим компонентом: автовоспроизведение
 * `<audio>` со звуком подчиняется политике браузера (Chrome/Safari могут
 * заблокировать звук без предварительного взаимодействия пользователя со
 * страницей) — тот же класс ограничения, с которым столкнулся бы любой
 * плеер этой идеи, включая референсный BlitzStream.tsx у SilverFinance;
 * добавлять отдельный «включить звук» UI — уже следующий этап полировки,
 * не часть этого прохода.
 */

const POLL_INTERVAL_MS = 4000;

/**
 * Сколько подряд неудачных `<audio>` подряд терпим, прежде чем
 * остановить ротацию до следующего успешного тика опроса (аудит L-7).
 * Без этого счётчика `onError -> advance -> следующий <audio> -> onError`
 * при недоступном хранилище превращается в плотный цикл перемонтирования.
 */
const MAX_AUDIO_ERRORS = 3;

export interface LiveAuctionLabels {
  live: string;
  newBid: string;
  /** Кнопка включения звука, когда автоплей заблокирован политикой браузера. */
  unmute: string;
}

type LiveCue = PublicAuctionLiveState['cues'][number];

export function LiveAuctionStream({
  listingId,
  initialState,
  fallbackVideoUrl,
  poster,
  payoutCurrency,
  labels,
}: {
  listingId: string;
  /**
   * Снимок с серверного рендера страницы (тот же вызов, что уже питает
   * JSON-LD BroadcastEvent, §7.8) — только для первой отрисовки без
   * лишнего "мигания". `null`, если серверный запрос не удался — тогда
   * компонент стартует в режиме "эфир не активен" и уточняет на первом
   * же тике поллинга.
   */
  initialState: PublicAuctionLiveState | null;
  /** Обычное видео лота из портфолио — показывается, когда эфир сейчас не активен. */
  fallbackVideoUrl: string;
  poster: string | null;
  /**
   * Валюта лота (§22, «Три разные цены»). Без неё оверлей показывал
   * голое число, тогда как форма ставки двумя блоками ниже — ту же сумму
   * с валютой (аудит L-3).
   */
  payoutCurrency: AuctionCurrencyValue;
  labels: LiveAuctionLabels;
}) {
  const [state, setState] = useState<PublicAuctionLiveState | null>(initialState);
  const [currentCue, setCurrentCue] = useState<LiveCue | null>(null);
  /** Автоплей звука заблокирован браузером — показываем кнопку (аудит L-10). */
  const [needsUnmute, setNeedsUnmute] = useState(false);

  // Мутable-бухгалтерия ротации — не должна вызывать лишних ре-рендеров.
  const cuesRef = useRef<LiveCue[]>(initialState?.cues ?? []);
  const rotationRef = useRef(createRotationState());
  const audioErrorsRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  /**
   * АУДИТ L-1 (критично). `GET /state` отдаёт последние до 50 подсказок
   * без фильтра по времени, включая все `BID_STATS`, случившиеся ДО того,
   * как этот зритель открыл страницу. Текст реплики — «Новая ставка —
   * <сумма>» — впечатан в аудио при генерации, поэтому проигрывать их
   * задним числом значит называть человеку неверную, заниженную цену
   * прямо перед тем, как он решает, сколько ставить.
   *
   * Поэтому всё, что уже лежало в плейлисте на момент подключения,
   * помечается проигранным ОДИН раз при первом же наборе подсказок. С
   * этого момента звучат только те `BID_STATS`, которые появились при
   * этом зрителе.
   */
  if ((initialState?.cues.length ?? 0) > 0) {
    seedPlayed(rotationRef.current, initialState!.cues);
  }

  // Поллинг состояния эфира — останавливается вместе с размонтированием.
  useEffect(() => {
    let alive = true;
    async function tick() {
      // Не тратим запросы на фоновую вкладку — тот же приём, что уже
      // применён в AuctionBidForm.tsx для обычного опроса ставок.
      if (document.hidden) return;
      const fresh = await getAuctionLiveState(listingId).catch(() => null);
      if (!alive || !fresh) return;
      seedPlayed(rotationRef.current, fresh.cues);
      cuesRef.current = fresh.cues;
      audioErrorsRef.current = 0; // связь жива — снимаем стоп-кран L-7
      // Лишний ре-рендер каждые 4 секунды на ровном месте не нужен:
      // сравниваем то, что реально влияет на отрисовку.
      // Сравнивать длину `cues` недостаточно: сервер отдаёт последние 50
      // (`take: 50`), и на горячем лоте длина упирается в потолок — новые
      // подсказки вытесняют старые, а длина не меняется. Сравниваем
      // максимальный `seq`, он монотонный.
      const lastSeq = (c: PublicAuctionLiveState) => (c.cues.length ? c.cues[c.cues.length - 1].seq : 0);
      setState((prev) =>
        prev &&
        prev.liveStreamActive === fresh.liveStreamActive &&
        prev.videoUrl === fresh.videoUrl &&
        prev.highestBidAmount === fresh.highestBidAmount &&
        prev.status === fresh.status &&
        lastSeq(prev) === lastSeq(fresh)
          ? prev
          : fresh,
      );
      // Единая точка истины по текущей ставке для формы ставки (аудит
      // L-2): она опрашивает реже, и без этого две суммы на одном экране
      // расходились между собой до восьми секунд.
      publishHighestBid(listingId, fresh.highestBidAmount);
    }

    void tick(); // первый запрос сразу, а не через POLL_INTERVAL_MS (аудит L-8)
    const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
    // Возврат на вкладку — обновляемся немедленно, не дожидаясь тика
    // (аудит L-9): на аукционе с антиснайпером это те самые секунды.
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [listingId]);

  /**
   * Следующая подсказка для проигрывания: непроигранная BID_STATS —
   * приоритет (самая свежая, если их накопилось несколько за один тик
   * поллинга — редко, но возможно на горячем лоте), иначе — следующая по
   * кругу из перемешанного набора pregen-подсказок. Перемешивание
   * пересчитывается заново, когда набор pregen-подсказок меняется
   * (например, LOT_DESC подтянулся из ANALYSIS-фрагмента чуть позже
   * PRAISE/INVITE) или круг закончился.
   */
  function pickNext(): LiveCue | null {
    return pickNextCue(rotationRef.current, cuesRef.current);
  }

  /**
   * Самая свежая ГОТОВАЯ и ещё не прозвучавшая ставка — признак того,
   * что реплику надо вставить немедленно, не дожидаясь конца текущей
   * (аудит L-6: доккомментарий выше обещает «немедленную вставку», а
   * условие `if (!currentCue)` откладывало её на длину текущей реплики).
   */
  const pendingBidStatsSeq = state ? pendingBidStatsSeqOf(rotationRef.current, state.cues) : null;

  // Стартуем ротацию, как только эфир активен и подсказки уже есть; при
  // сворачивании эфира (авто-сворачивание §7.5 или конец торгов) —
  // останавливаем немедленно (см. ветку рендера ниже — видео/аудио
  // размонтируются, а не просто «на паузу»).
  useEffect(() => {
    if (!state?.liveStreamActive) {
      setCurrentCue(null);
      return;
    }
    if (audioErrorsRef.current >= MAX_AUDIO_ERRORS) return; // стоп-кран L-7
    // Свежая ставка перебивает текущую реплику; иначе — только если
    // сейчас ничего не играет. Цикла здесь нет: `pickNext` помечает
    // выбранную подсказку проигранной, и признак гаснет сам.
    if (pendingBidStatsSeq !== null || !currentCue) setCurrentCue(pickNext());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.liveStreamActive, state?.cues, pendingBidStatsSeq]);

  function advance() {
    if (audioErrorsRef.current >= MAX_AUDIO_ERRORS) {
      setCurrentCue(null);
      return;
    }
    setCurrentCue(pickNext());
  }

  /** Реплика доиграла штатно — сбрасываем счётчик неудач. */
  function onCueEnded() {
    audioErrorsRef.current = 0;
    advance();
  }

  function onCueError() {
    audioErrorsRef.current += 1;
    advance();
  }

  /**
   * Автоплей звука без жеста пользователя блокируют и Chrome, и Safari.
   * Ловим отказ и показываем кнопку — до этой правки у зрителя не было
   * вообще никакого способа вернуть звук (аудит L-10).
   */
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !currentCue) return;
    const started = el.play();
    if (started && typeof started.catch === 'function') {
      started.then(() => setNeedsUnmute(false)).catch(() => setNeedsUnmute(true));
    }
  }, [currentCue]);

  function unmute() {
    setNeedsUnmute(false);
    void audioRef.current?.play().catch(() => setNeedsUnmute(true));
  }

  // Эфир сейчас не активен (не начинался или свернулся) либо студия ещё
  // не назначена — обычное статичное видео лота, без каких-либо
  // надстроек. Тот же UI, что был на странице лота ДО этого компонента.
  if (!state?.liveStreamActive || !state.videoUrl) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- пользовательский UGC-ролик, как остальные плееры проекта
      <video
        src={fallbackVideoUrl}
        controls
        playsInline
        poster={poster ?? undefined}
        style={{ maxHeight: '70vh', margin: '0 auto', display: 'block', width: '100%' }}
      />
    );
  }

  return (
    <div style={{ position: 'relative', maxHeight: '70vh', margin: '0 auto' }}>
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- видео немое по построению (§7.1), озвучка — отдельный <audio> поверх */}
      {/* `controls` — чтобы зритель мог хотя бы поставить паузу и уйти в
          полный экран: до правки в режиме эфира не было ни одного органа
          управления (аудит L-10). Видео немое по построению, громкость
          здесь ни при чём — её несёт <audio> ниже. */}
      <video
        key={state.videoUrl}
        src={state.videoUrl}
        autoPlay
        muted
        loop
        controls
        playsInline
        style={{ maxHeight: '70vh', margin: '0 auto', display: 'block', width: '100%', background: '#000' }}
      />
      {currentCue && (
        <audio
          key={currentCue.id}
          ref={audioRef}
          src={currentCue.audioUrl}
          autoPlay
          onEnded={onCueEnded}
          onError={onCueError}
        />
      )}
      {needsUnmute && (
        <button
          type="button"
          onClick={unmute}
          style={{
            position: 'absolute',
            top: 10,
            right: 10,
            background: 'rgba(0,0,0,0.7)',
            color: '#fff',
            border: 0,
            borderRadius: 999,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          🔊 {labels.unmute}
        </button>
      )}
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(224,41,62,0.92)',
          color: '#fff',
          borderRadius: 999,
          padding: '4px 10px',
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        ● {labels.live}
      </div>
      {/* Мгновенный текстовый оверлей (§7.4/§7.5) — highestBidAmount и есть
          сумма самой последней принятой ставки (ставка обязана превышать
          прежний максимум, см. AuctionService.placeBid), отдельного поля
          "последняя ставка" не требуется. Обновляется тем же поллингом,
          что и остальное состояние — не ждёт готовности голосовой
          подсказки по этой ставке. */}
      {state.highestBidAmount != null && (
        <div
          style={{
            position: 'absolute',
            bottom: 10,
            left: 10,
            right: 10,
            background: 'rgba(0,0,0,0.6)',
            color: '#fff',
            borderRadius: 8,
            padding: '6px 10px',
            fontSize: 13,
          }}
        >
          {labels.newBid}:{' '}
          <strong>
            {state.highestBidAmount} {payoutCurrency}
          </strong>
        </div>
      )}
    </div>
  );
}
