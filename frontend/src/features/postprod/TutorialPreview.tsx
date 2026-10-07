/**
 * Предпросмотр темпа обучалки в браузере (06.10.2026) — бесплатно и
 * по тому же монтажному плану, что уйдёт в платную сборку.
 *
 * Кадры и их границы приходят с сервера (`preview.frames[].start/end` —
 * та же сетка `frameSpansSeconds`, что у ffmpeg-команды), реплики
 * ставятся в расписание WebAudio — каждая в начале своего кадра, в
 * естественном темпе. `playbackRate` не трогается вовсе: изменение
 * скорости видео ускорило бы речь, а требование ровно обратное.
 *
 * Если WebAudio не может прочитать звук (нет CORS у хранилища, старый
 * браузер без WebAudio) — запасной путь: реплики играют `<audio>`-
 * элементы, которым CORS не нужен, по тем же часам `performance.now()`,
 * что двигают картинку и подписи (`lib/tutorial-preview-audio.ts`).
 * Честная пометка «без звука» — только если не сработал и он.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { Alert, Button } from '../../components/ui';
import {
  captionAt,
  formatDuration,
  previewAt,
  speechSchedule,
  type TempoPreview,
} from '../../lib/tutorial-tempo';
import {
  dueClips,
  previewAudioPath,
  primeClip,
  type PrimedClip,
} from '../../lib/tutorial-preview-audio';

type AudioCtor = typeof AudioContext;

interface Labels {
  play: string;
  stop: string;
  audioFallback: string;
}

export function TutorialPreview({
  preview,
  labels,
}: {
  preview: TempoPreview;
  labels: Labels;
}) {
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [audioFallback, setAudioFallback] = useState(false);
  const ctxRef = useRef<AudioContext | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const rafRef = useRef<number | null>(null);
  const buffersRef = useRef(new Map<string, AudioBuffer>());
  /** Запасной путь: `<audio>` на каждую реплику текущего проигрывания. */
  const elementsRef = useRef<HTMLAudioElement[]>([]);
  /** WebAudio уже не смог прочитать звук (CORS) — дальше сразу элементы,
   *  не теряя жест нажатия на повторный `fetch`. */
  const webAudioBlockedRef = useRef(false);
  /** Номер проигрывания: `stop()` во время загрузки отменяет старт. */
  const runRef = useRef(0);
  const duration = preview.durationMs / 1000;

  const stop = useCallback(() => {
    runRef.current += 1;
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    for (const s of sourcesRef.current) {
      try {
        s.stop();
      } catch {
        /* уже остановлен */
      }
    }
    sourcesRef.current = [];
    for (const el of elementsRef.current) {
      el.pause();
      el.removeAttribute('src');
    }
    elementsRef.current = [];
    const ctx = ctxRef.current;
    ctxRef.current = null;
    if (ctx) void ctx.close().catch(() => undefined);
    setPlaying(false);
  }, []);

  // Новый темп — новая сетка: старое расписание недействительно.
  useEffect(() => {
    stop();
    setT(0);
  }, [preview, stop]);
  useEffect(() => stop, [stop]);

  const play = async () => {
    stop();
    const run = runRef.current;
    const schedule = speechSchedule(preview);
    const Ctor: AudioCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor })
        .webkitAudioContext;
    const elementAudio = typeof Audio !== 'undefined';
    const failed = () => {
      if (runRef.current === run) setAudioFallback(true);
    };
    // Запасные элементы — СИНХРОННО, в жесте нажатия и до первого
    // `await`: WebKit пустит их `play()` из расписания, только если
    // в жесте их уже разблокировали (`primeClip`). Понадобятся ли они,
    // станет ясно после `fetch`; не понадобятся — гасятся ниже.
    const primed: PrimedClip<HTMLAudioElement>[] =
      elementAudio && schedule.length > 0
        ? schedule.map((s) => {
            const el = new Audio();
            el.preload = 'auto';
            el.addEventListener('error', failed);
            el.src = s.url;
            return primeClip(el);
          })
        : [];
    elementsRef.current = primed.map((p) => p.el);
    let webAudioFailed = webAudioBlockedRef.current;
    let ctx: AudioContext | null = null;
    if (Ctor && !webAudioFailed && schedule.length > 0) {
      ctx = new Ctor();
      ctxRef.current = ctx;
      const decoder = ctx;
      await Promise.all(
        schedule.map(async (s) => {
          if (buffersRef.current.has(s.url)) return;
          try {
            const res = await fetch(s.url);
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.arrayBuffer();
            buffersRef.current.set(s.url, await decoder.decodeAudioData(data));
          } catch {
            webAudioFailed = true;
          }
        })
      );
      if (runRef.current !== run) return; // остановили, пока грузили
      if (webAudioFailed) webAudioBlockedRef.current = true;
    }
    const path = previewAudioPath({
      webAudio: Boolean(Ctor),
      elementAudio,
      clips: schedule.length,
      webAudioFailed,
    });

    let clock: () => number;
    let onTick: (now: number) => void = () => undefined;
    let fallback = false;
    if (path === 'webaudio' && ctx) {
      const audio = ctx;
      const t0 = audio.currentTime + 0.1;
      for (const s of schedule) {
        const buffer = buffersRef.current.get(s.url);
        if (!buffer) continue;
        const src = audio.createBufferSource();
        src.buffer = buffer;
        src.connect(audio.destination);
        src.start(t0 + s.at);
        sourcesRef.current.push(src);
      }
      clock = () => audio.currentTime - t0;
      // WebAudio справился — разблокированные элементы не нужны.
      for (const p of primed) {
        p.el.pause();
        p.el.removeAttribute('src');
      }
      elementsRef.current = [];
    } else {
      // Контекст WebAudio дальше не нужен: часы — `performance.now()`.
      if (ctx) {
        ctxRef.current = null;
        void ctx.close().catch(() => undefined);
      }
      if (path === 'element') {
        const fired = new Set<number>();
        onTick = (now) => {
          const { start, skipped } = dueClips(schedule, fired, now);
          for (const i of skipped) fired.add(i);
          for (const i of start) {
            fired.add(i);
            void primed[i].start().catch(failed);
          }
        };
      } else {
        fallback = schedule.length > 0;
      }
      const started = performance.now();
      clock = () => (performance.now() - started) / 1000;
    }
    setAudioFallback(fallback);
    setPlaying(true);
    const tick = () => {
      const now = Math.max(0, clock());
      setT(now);
      if (now >= duration) {
        stop();
        return;
      }
      onTick(now);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const at = previewAt(preview, t);
  const current = preview.frames[at.index];
  const next = at.next !== null ? preview.frames[at.next] : null;
  const caption = captionAt(preview, t);

  return (
    <div className="space-y-2">
      <div
        className="relative mx-auto w-full max-w-[220px] overflow-hidden rounded-lg border border-[var(--border)] bg-black"
        style={{ aspectRatio: '720 / 1560' }}
        data-qa-mask="tutorial-preview"
      >
        {current && (
          <img
            src={current.imageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
          />
        )}
        {next && (
          <img
            src={next.imageUrl}
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            style={{ opacity: at.mix }}
          />
        )}
        {caption && (
          <div className="absolute inset-x-2 bottom-3 rounded bg-black/70 px-2 py-1 text-center text-[11px] leading-snug text-white">
            {caption}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          icon={playing ? <Pause size={14} /> : <Play size={14} />}
          onClick={() => (playing ? stop() : void play())}
        >
          {playing ? labels.stop : labels.play}
        </Button>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
          <div
            className="h-full bg-[var(--accent)]"
            style={{
              width: `${duration > 0 ? Math.min(100, (t / duration) * 100) : 0}%`,
            }}
          />
        </div>
        <span className="tabular text-xs text-[var(--muted)]">
          {formatDuration(t * 1000)} / {formatDuration(preview.durationMs)}
        </span>
      </div>
      {audioFallback && <Alert tone="warning">{labels.audioFallback}</Alert>}
    </div>
  );
}
