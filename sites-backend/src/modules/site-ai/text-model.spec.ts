/**
 * GeminiText (K3): запрос к SDK собран как надо (system, JSON, лимит
 * выхода с запасом на размышления, сигнал отмены), токены — по правилам
 * assist-chat-core, ошибки провайдера наружу не утекают, таймаут — свой
 * код, ответ, упёршийся в потолок (MAX_TOKENS), в дело не идёт.
 */
import { Logger } from '@nestjs/common';
import { GEMINI_THINKING_HEADROOM } from './gemini-output';
import {
  GeminiText,
  TextModelClient,
  TextModelError,
  spentOf,
} from './text-model';

function fakeClient(
  impl: (params: Record<string, unknown>) => Promise<unknown>,
): { client: TextModelClient; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    models: {
      generateContent: (p: Record<string, unknown>) => {
        calls.push(p);
        return impl(p);
      },
    },
  } as unknown as TextModelClient;
  return { client, calls };
}

describe('GeminiText', () => {
  beforeAll(() => Logger.overrideLogger(false));

  it('JSON-режим, system и лимит — в конфиг SDK; токены с «мыслями»', async () => {
    const { client, calls } = fakeClient(async () => ({
      text: '{"answer":"ok"}',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 20,
        thoughtsTokenCount: 5,
        cachedContentTokenCount: 40,
      },
    }));
    const r = await new GeminiText().useClient(client).generate({
      system: 'SYS',
      user: 'USER',
      maxOutputTokens: 800,
      json: true,
    });
    expect(r).toMatchObject({
      text: '{"answer":"ok"}',
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
    });
    const cfg = calls[0].config as Record<string, unknown>;
    expect(cfg).toMatchObject({
      systemInstruction: 'SYS',
      // Видимый ответ 800 + запас на размышления (тратят тот же потолок).
      maxOutputTokens: 800 + GEMINI_THINKING_HEADROOM,
      responseMimeType: 'application/json',
      temperature: 0.2,
    });
    expect(cfg.abortSignal).toBeInstanceOf(AbortSignal);
    expect(calls[0].contents).toEqual([
      { role: 'user', parts: [{ text: 'USER' }] },
    ]);
  });

  it('ошибка провайдера — TextModelError без его текста', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('API key AIzaSECRET invalid; prompt: <секрет>');
    });
    const p = new GeminiText()
      .useClient(client)
      .generate({ system: 's', user: 'u', maxOutputTokens: 10 });
    await expect(p).rejects.toBeInstanceOf(TextModelError);
    await expect(p).rejects.not.toThrow(/AIza|секрет/);
  });

  it('таймаут — kind=timeout (сигнал отмены дошёл до запроса)', async () => {
    const { client } = fakeClient(
      (p) =>
        new Promise((_, reject) => {
          const sig = (p.config as { abortSignal: AbortSignal }).abortSignal;
          sig.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      new GeminiText().useClient(client).generate({
        system: 's',
        user: 'u',
        maxOutputTokens: 10,
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('пустой ответ — kind=empty', async () => {
    const { client } = fakeClient(async () => ({ text: '  ' }));
    await expect(
      new GeminiText()
        .useClient(client)
        .generate({ system: 's', user: 'u', maxOutputTokens: 10 }),
    ).rejects.toMatchObject({ kind: 'empty' });
  });

  it('потолок провайдеру = видимый ответ + запас на размышления, у любой модели (и lite)', async () => {
    const { client, calls } = fakeClient(async () => ({ text: 'ok' }));
    const m = new GeminiText().useClient(client);
    await m.generate({ system: 's', user: 'u', maxOutputTokens: 200 });
    await m.generate({
      system: 's',
      user: 'u',
      maxOutputTokens: 400,
      model: 'gemini-2.5-flash-lite',
    });
    const ceil = calls.map(
      (c) => (c.config as { maxOutputTokens: number }).maxOutputTokens,
    );
    expect(ceil).toEqual([
      200 + GEMINI_THINKING_HEADROOM,
      400 + GEMINI_THINKING_HEADROOM,
    ]);
    expect(calls[1].model).toBe('gemini-2.5-flash-lite');
  });

  it('MAX_TOKENS без текста (всё ушло на размышления) — kind=empty, расход в spent, в лог — без промпта', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const { client } = fakeClient(async () => ({
        text: undefined,
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 50,
          candidatesTokenCount: 0,
          thoughtsTokenCount: 1224,
        },
      }));
      const err = await new GeminiText()
        .useClient(client)
        .generate({
          system: 'СЕКРЕТ-СИСТЕМЫ',
          user: 'ВОПРОС-ПОСЕТИТЕЛЯ',
          maxOutputTokens: 200,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TextModelError);
      expect(err).toMatchObject({
        kind: 'empty',
        spent: { inputTokens: 50, outputTokens: 1224 },
      });
      const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toMatch(/empty/);
      expect(line).toMatch(/finishReason=MAX_TOKENS/);
      expect(line).toMatch(/thoughts=1224/);
      expect(line).not.toMatch(/СЕКРЕТ|ВОПРОС/);
    } finally {
      warn.mockRestore();
    }
  });

  it('обрезанный ответ (MAX_TOKENS с текстом) — kind=truncated, текст не уходит в дело; лог — модель, finishReason, мысли, длина', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    try {
      const cutText = '{"answer":"Доставка коштує 8';
      const { client } = fakeClient(async () => ({
        text: cutText,
        candidates: [{ finishReason: 'MAX_TOKENS' }],
        usageMetadata: {
          promptTokenCount: 70,
          candidatesTokenCount: 30,
          thoughtsTokenCount: 994,
        },
      }));
      const err = await new GeminiText()
        .useClient(client)
        .generate({
          system: 's',
          user: 'u',
          maxOutputTokens: 30,
          json: true,
          model: 'gemini-3.6-flash',
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TextModelError);
      expect(err).toMatchObject({
        kind: 'truncated',
        spent: { model: 'gemini-3.6-flash', outputTokens: 1024 },
      });
      expect(String((err as Error).message)).not.toMatch(/Доставка/);
      const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toMatch(/gemini-3\.6-flash: truncated/);
      expect(line).toMatch(/finishReason=MAX_TOKENS/);
      expect(line).toMatch(/thoughts=994/);
      expect(line).toContain(`chars=${cutText.length}`);
      expect(line).not.toMatch(/Доставка/);
    } finally {
      warn.mockRestore();
    }
  });

  it('finishReason=STOP — обычный ответ', async () => {
    const { client } = fakeClient(async () => ({
      text: 'готово',
      candidates: [{ finishReason: 'STOP' }],
    }));
    await expect(
      new GeminiText()
        .useClient(client)
        .generate({ system: 's', user: 'u', maxOutputTokens: 10 }),
    ).resolves.toMatchObject({ text: 'готово' });
  });
});

describe('spentOf', () => {
  const spent = {
    model: 'gemini-2.5-flash-lite',
    inputTokens: 900,
    cachedInputTokens: 100,
    outputTokens: 1024,
  };

  it('empty/truncated со spent — расход; timeout/unavailable и чужая ошибка — null', () => {
    expect(spentOf(new TextModelError('truncated', spent))).toEqual(spent);
    expect(spentOf(new TextModelError('empty', spent))).toEqual(spent);
    expect(spentOf(new TextModelError('empty'))).toBeNull();
    expect(spentOf(new TextModelError('timeout'))).toBeNull();
    expect(spentOf(new TextModelError('unavailable'))).toBeNull();
    expect(spentOf(Object.assign(new Error('x'), { spent }))).toBeNull();
    expect(spentOf(null)).toBeNull();
  });
});
