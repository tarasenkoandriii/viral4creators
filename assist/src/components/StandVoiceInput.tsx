import { useEffect, useRef, useState } from 'react';
import { Button } from '../kit/ui';
export function StandVoiceInput({
  transcribe,
  onText,
  disabled,
  onBusyChange,
}: {
  transcribe: (
    audio: string
  ) => Promise<{ text: string; confidence: number | null }>;
  onText: (text: string) => void;
  disabled: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [recording, setRecording] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const recorder = useRef<MediaRecorder | null>(null),
    stream = useRef<MediaStream | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    alive = useRef(true),
    chunks = useRef<Blob[]>([]);
  useEffect(() => {
    onBusyChange?.(recording || busy);
  }, [recording, busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  function release() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        recorder.current.ondataavailable = null;
        chunks.current = [];
        if (recorder.current.state !== 'inactive') recorder.current.stop();
      }
      release();
    };
  }, []);
  async function upload(blob: Blob) {
    if (blob.size > 1000000 || blob.size < 100) {
      setError('Запись должна быть до 1 МБ и содержать речь.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const buffer = await blob.arrayBuffer();
      if (!alive.current) return;
      let binary = '';
      new Uint8Array(buffer).forEach((b) => {
        binary += String.fromCharCode(b);
      });
      const result = await transcribe(btoa(binary));
      if (alive.current) {
        onText(result.text);
        if (result.confidence !== null && result.confidence < 0.75)
          setError(
            'Низкая уверенность распознавания — проверьте текст перед генерацией.'
          );
      }
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Ошибка распознавания');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function start() {
    setBusy(true);
    setError('');
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === 'undefined'
      )
        throw Error(
          'Запись не поддерживается. Загрузите аудио или введите текст.'
        );
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      const mime = [
        'audio/webm;codecs=opus',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ].find((x) => MediaRecorder.isTypeSupported(x));
      const r = new MediaRecorder(
        s,
        mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined
      );
      recorder.current = r;
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onerror = () => {
        r.onstop = null;
        r.ondataavailable = null;
        if (r.state !== 'inactive') r.stop();
        chunks.current = [];
        release();
        if (alive.current) {
          setRecording(false);
          setError('Не удалось записать звук.');
        }
      };
      r.onstop = () => {
        release();
        if (alive.current) {
          setRecording(false);
          void upload(new Blob(chunks.current, { type: r.mimeType }));
        }
        chunks.current = [];
      };
      r.start();
      setRecording(true);
      timer.current = setTimeout(() => {
        if (r.state === 'recording') r.stop();
      }, 60000);
    } catch (e) {
      release();
      if (alive.current)
        setError(e instanceof Error ? e.message : 'Нет доступа к микрофону');
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <Button
        disabled={busy || (disabled && !recording)}
        onClick={() => {
          if (recording) recorder.current?.stop();
          else void start();
        }}
      >
        {recording ? 'Остановить и распознать' : 'Описать голосом · Soniox'}
      </Button>
      <label className="block">
        Или загрузить запись (до 1 МБ)
        <input
          className="block w-full max-w-full text-sm"
          type="file"
          accept="audio/*"
          disabled={disabled || busy || recording}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void upload(file);
            e.target.value = '';
          }}
        />
      </label>
      <p>
        До 60 секунд. Аудио отправляется Soniox для распознавания; текст можно
        исправить. Создание стенда требует отдельного подтверждения.
      </p>
      {busy && <p role="status">Распознаём речь…</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
