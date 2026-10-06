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
 * Если звук не грузится (CORS хранилища, старый браузер без WebAudio) —
 * картинка и подписи идут по часам `performance.now()`, и человек видит
 * честную пометку «без звука», а не тишину без объяснений.
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
  const duration = preview.durationMs / 1000;

  const stop = useCallback(() => {
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
    const schedule = speechSchedule(preview);
    const Ctor: AudioCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioCtor })
        .webkitAudioContext;
    let fallback = false;
    let clock: () => number;
    if (Ctor) {
      const ctx = new Ctor();
      ctxRef.current = ctx;
      await Promise.all(
        schedule.map(async (s) => {
          if (buffersRef.current.has(s.url)) return;
          try {
            const res = await fetch(s.url);
            if (!res.ok) throw new Error(String(res.status));
            const data = await res.arrayBuffer();
            buffersRef.current.set(s.url, await ctx.decodeAudioData(data));
          } catch {
            fallback = true;
          }
        })
      );
      if (ctxRef.current !== ctx) return; // остановили, пока грузили
      const t0 = ctx.currentTime + 0.1;
      for (const s of schedule) {
        const buffer = buffersRef.current.get(s.url);
        if (!buffer) continue;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(t0 + s.at);
        sourcesRef.current.push(src);
      }
      clock = () => ctx.currentTime - t0;
    } else {
      fallback = schedule.length > 0;
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
