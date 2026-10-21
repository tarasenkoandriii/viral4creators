/**
 * Ops-клиент вкладки «FFmpeg»: очистка ответов сервера и классификация
 * ошибок (определённый отказ ↔ неизвестный исход). Плюс срок журнала.
 */
import {
  FfmpegOpsClient,
  FfmpegOpsRejected,
  FfmpegOpsUnavailable,
  isSecretField,
  sanitizeOps,
} from './ffmpeg-ops.client';
import {
  FFMPEG_OPERATOR_RETENTION_DAYS,
  ffmpegOperatorCutoff,
  pruneFfmpegFallbackEvents,
  pruneFfmpegOperatorActions,
  pruneFfmpegSubmissions,
} from './ffmpeg-operator-journal';
import { adminOwnerTelegramIds } from './ffmpeg-admin-access';

describe('sanitizeOps', () => {
  it('выкидывает поля с секретными именами, оставляет лимиты и хеши', () => {
    const out = sanitizeOps({
      api_key: 'k',
      idempotencyKey: 'ik',
      download_url: 'u',
      token: 't',
      ffmpeg_commands: ['ffmpeg -i x'],
      maxCommands: 10,
      maxCommandsTextBytes: 131072,
      sha256: 'abc',
      outputs_metadata: { 'a.mp4': { sha256: 'def', bytes: 5 } },
    });
    expect(out).toEqual({
      maxCommands: 10,
      maxCommandsTextBytes: 131072,
      sha256: 'abc',
      outputs_metadata: { 'a.mp4': { sha256: 'def', bytes: 5 } },
    });
  });

  it('URL и Bearer в тексте заменяются; входы и выходы — только имена', () => {
    const out = sanitizeOps({
      error_message:
        'fetch https://s.test/a.mp4?token=SECRET failed; Bearer abc.def',
      input_files: { base: 'https://s.test/a?sig=1', subs: 'https://s.test/b' },
      output_files: { 'out.mp4': 'https://f.test/out?token=T' },
    }) as Record<string, unknown>;
    expect(out).toEqual({
      error_message: 'fetch [url] failed; [auth]',
      input_names: ['base', 'subs'],
      output_names: ['out.mp4'],
    });
  });

  it('stderr ограничен 64 KiB', () => {
    const out = sanitizeOps({ stderr: 'я'.repeat(100_000) }) as {
      stderr: string;
    };
    expect(Buffer.byteLength(out.stderr)).toBeLessThanOrEqual(64 * 1024 + 64);
  });

  it('isSecretField не задевает обычные поля', () => {
    for (const ok of [
      'status',
      'revision',
      'maxInputs',
      'image_digest',
      'stage',
    ])
      expect(isSecretField(ok)).toBe(false);
    for (const bad of [
      'url',
      'signedUrl',
      'opsKey',
      'keySha256',
      'Authorization',
      'commands',
    ])
      expect(isSecretField(bad)).toBe(true);
  });
});

describe('FfmpegOpsClient.request — ошибки', () => {
  const realFetch = global.fetch;
  const env = { ...process.env };
  beforeEach(() => {
    process.env.FFMPEG_SELFHOSTED_BASE_URL = 'https://f.test/api';
    process.env.FFMPEG_SELFHOSTED_OPS_KEY = 'ops';
  });
  afterAll(() => {
    global.fetch = realFetch;
    process.env = env;
  });
  const respond = (status: number, body: unknown) => {
    global.fetch = jest.fn(async () => ({
      ok: status < 300,
      status,
      text: async () => JSON.stringify(body),
    })) as unknown as typeof fetch;
  };

  it('4xx — определённый отказ с кодом', async () => {
    respond(409, { error: { code: 'STALE_REVISION', message: 'rev' } });
    await expect(
      new FfmpegOpsClient().request('POST', '/ops/limits', { role: 'ops' }),
    ).rejects.toMatchObject({ status: 409, code: 'STALE_REVISION' });
    await expect(
      new FfmpegOpsClient().request('POST', '/ops/limits', { role: 'ops' }),
    ).rejects.toBeInstanceOf(FfmpegOpsRejected);
  });

  it('5xx и сетевой сбой — исход неизвестен', async () => {
    respond(502, {});
    await expect(
      new FfmpegOpsClient().request('GET', '/ops/overview', { role: 'ops' }),
    ).rejects.toMatchObject({ kind: 'upstream' });
    global.fetch = jest.fn(async () => {
      throw Object.assign(new Error('t'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(
      new FfmpegOpsClient().request('GET', '/ops/overview', { role: 'ops' }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('нет ключа роли — not-configured, без запроса', async () => {
    const f = jest.fn();
    global.fetch = f as unknown as typeof fetch;
    delete process.env.FFMPEG_SELFHOSTED_KEY;
    const err = await new FfmpegOpsClient()
      .request('GET', '/jobs/x', { role: 'client' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegOpsUnavailable);
    expect(err).toMatchObject({ kind: 'not-configured' });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('журнал оператора: срок 90 дней', () => {
  it('граница и уборка', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    expect(FFMPEG_OPERATOR_RETENTION_DAYS).toBe(90);
    expect(ffmpegOperatorCutoff(now).toISOString()).toBe(
      '2026-07-23T00:00:00.000Z',
    );
    const deleteMany = jest.fn(async () => ({ count: 3 }));
    await expect(
      pruneFfmpegOperatorActions(
        { ffmpegOperatorAction: { deleteMany } } as never,
        now,
      ),
    ).resolves.toBe(3);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: ffmpegOperatorCutoff(now) } },
    });
  });
});

describe('события fallback: срок 30 дней', () => {
  it('уборка по границе', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const deleteMany = jest.fn(async () => ({ count: 1 }));
    await expect(
      pruneFfmpegFallbackEvents(
        { ffmpegFallbackEvent: { deleteMany } } as never,
        now,
      ),
    ).resolves.toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date('2026-09-21T00:00:00Z') } },
    });
  });
});

describe('отправки и учтённые задачи breaker: срок 30 дней', () => {
  it('уборка обеих таблиц по одной границе', async () => {
    const now = new Date('2026-10-21T00:00:00Z');
    const a = jest.fn(async () => ({ count: 2 }));
    const b = jest.fn(async () => ({ count: 1 }));
    await expect(
      pruneFfmpegSubmissions(
        {
          ffmpegSubmission: { deleteMany: a },
          ffmpegBreakerJob: { deleteMany: b },
        } as never,
        now,
      ),
    ).resolves.toBe(3);
    const where = {
      where: { createdAt: { lt: new Date('2026-09-21T00:00:00Z') } },
    };
    expect(a).toHaveBeenCalledWith(where);
    expect(b).toHaveBeenCalledWith(where);
  });
});

describe('ADMIN_OWNER_TELEGRAM_IDS', () => {
  it('пусто по умолчанию; пробелы и пустые элементы отброшены', () => {
    expect(adminOwnerTelegramIds({} as NodeJS.ProcessEnv).size).toBe(0);
    expect([
      ...adminOwnerTelegramIds({
        ADMIN_OWNER_TELEGRAM_IDS: ' 1, ,2 ',
      } as NodeJS.ProcessEnv),
    ]).toEqual(['1', '2']);
  });
});
