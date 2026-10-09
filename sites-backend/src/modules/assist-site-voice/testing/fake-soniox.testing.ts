/**
 * Провайдер-мок Soniox для тестов голоса Э5: отвечает по маршрутам API
 * (`shared/soniox.ts`), записывает ВСЕ вызовы — по ним тесты проверяют
 * обещание «запись удаляется у провайдера при успехе, отказе и таймауте».
 * Сети нет: живой Soniox — только у владельца (doc/DEPLOYMENT.md §6.13).
 */
import { SONIOX_API_BASE, SONIOX_TTS_BASE } from '../../../shared/soniox';

export interface FakeCall {
  method: string;
  path: string;
  body?: unknown;
}

export type SttScenario =
  | 'ok'
  | 'silence'
  | 'upload-fails'
  | 'create-fails'
  | 'status-error'
  | 'never-completes'
  | 'network-drop'
  | 'busy-delete';

export class FakeSoniox {
  readonly calls: FakeCall[] = [];
  stt: SttScenario = 'ok';
  /** Текст распознавания (токенами, как отдаёт Soniox). */
  transcript = 'Скільки коштує доставка?';
  language = 'uk';
  /**
   * №113 (заход 11): уверенность слов (слово без пробелов → 0…1); слова
   * без записи — без поля `confidence` (как старые ответы).
   */
  confidence: Record<string, number> = {};
  audioMs = 2_400;
  tts: 'ok' | 'fail' = 'ok';
  ttsAudio = Buffer.from('ID3-fake-mp3-bytes');
  voices = [
    { id: 'Maya', gender: 'female', description: 'warm' },
    { id: 'Adrian', gender: 'male', description: 'calm' },
  ];
  private seq = 0;
  private deleteBusy = 0;

  reset(): void {
    this.calls.length = 0;
    this.stt = 'ok';
    this.tts = 'ok';
    this.deleteBusy = 0;
    this.confidence = {};
  }

  count(method: string, prefix: string): number {
    return this.calls.filter(
      (c) => c.method === method && c.path.startsWith(prefix),
    ).length;
  }

  readonly fetch = (async (
    input: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const path = url.startsWith(SONIOX_TTS_BASE)
      ? `tts:${url.slice(SONIOX_TTS_BASE.length)}`
      : url.replace(SONIOX_API_BASE, '');
    let body: unknown = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body instanceof FormData) {
      const f = init.body.get('file');
      body = {
        file: f instanceof Blob ? { size: f.size, type: f.type } : null,
      };
    }
    this.calls.push({ method, path, body });
    const json = (status: number, data: unknown) =>
      new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    if (
      this.stt === 'network-drop' &&
      method === 'GET' &&
      path.startsWith('/transcriptions/')
    ) {
      throw new TypeError('fetch failed');
    }
    if (method === 'POST' && path === '/files') {
      if (this.stt === 'upload-fails') return json(500, { error: 'boom' });
      return json(200, { id: `f${++this.seq}` });
    }
    if (method === 'POST' && path === '/transcriptions') {
      if (this.stt === 'create-fails') return json(400, { error: 'bad' });
      return json(200, { id: `t${++this.seq}`, status: 'queued' });
    }
    if (method === 'GET' && /^\/transcriptions\/[^/]+$/.test(path)) {
      if (this.stt === 'status-error')
        return json(200, { status: 'error', error_message: 'audio decode' });
      if (this.stt === 'never-completes')
        return json(200, {
          status: 'processing',
          audio_duration_ms: this.audioMs,
        });
      return json(200, {
        status: 'completed',
        audio_duration_ms: this.audioMs,
      });
    }
    if (
      method === 'GET' &&
      /^\/transcriptions\/[^/]+\/transcript$/.test(path)
    ) {
      if (this.stt === 'silence')
        return json(200, { tokens: [{ text: '<end>', end_ms: 100 }] });
      const words = this.transcript.split(/(?=\s)/);
      return json(200, {
        tokens: [
          ...words.map((w, i) => ({
            text: w,
            language: this.language,
            end_ms: (i + 1) * 300,
            ...(this.confidence[w.trim()] !== undefined
              ? { confidence: this.confidence[w.trim()] }
              : {}),
          })),
          { text: '<end>', end_ms: words.length * 300 + 10 },
        ],
      });
    }
    if (method === 'DELETE') {
      if (
        this.stt === 'busy-delete' &&
        path.startsWith('/transcriptions/') &&
        this.deleteBusy < 2
      ) {
        this.deleteBusy++;
        return new Response('', { status: 409 });
      }
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && path === 'tts:/tts') {
      if (this.tts === 'fail') return json(500, { error: 'tts down' });
      return new Response(new Uint8Array(this.ttsAudio), {
        status: 200,
        headers: { 'Content-Type': 'audio/mpeg' },
      });
    }
    if (method === 'GET' && path === '/tts-models') {
      return json(200, {
        models: [
          {
            id: 'tts-rt-v2',
            languages: [{ code: 'uk' }, { code: 'ru' }, { code: 'en' }],
            voices: this.voices,
          },
        ],
      });
    }
    return json(404, { error: 'unknown route' });
  }) as typeof fetch;
}

/** «Запись» нужного формата: заголовок webm + шум (длина ≥ minAudioBytes). */
export function fakeRecording(bytes = 4_096): Buffer {
  const b = Buffer.alloc(bytes);
  b.set([0x1a, 0x45, 0xdf, 0xa3], 0);
  for (let i = 4; i < bytes; i++) b[i] = (i * 31) & 0xff;
  return b;
}
