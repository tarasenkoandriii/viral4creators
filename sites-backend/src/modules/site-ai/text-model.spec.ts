/**
 * GeminiText (K3): запрос к SDK собран как надо (system, JSON, лимит
 * выхода, сигнал отмены), токены — по правилам assist-chat-core, ошибки
 * провайдера наружу не утекают, таймаут — свой код.
 */
import { Logger } from '@nestjs/common';
import { GeminiText, TextModelClient, TextModelError } from './text-model';

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
      maxOutputTokens: 800,
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
});
