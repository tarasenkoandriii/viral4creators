jest.mock('../../prisma/prisma.service', () => ({ PrismaService: class {} }));
import {
  SonioxObservability,
  sonioxContext,
  sonioxRequestContext,
  sonioxResultMetrics,
} from './soniox-observability.service';
function build() {
  const db = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
  };
  return { db, service: new SonioxObservability(db as never) };
}
describe('Soniox observability', () => {
  it('classifies callers from guarded route context, ignores forged actor header on public routes', () => {
    expect(
      sonioxRequestContext({
        route: { path: '/api/admin/audio' },
        userId: 'op',
      }).actorRole,
    ).toBe('operator');
    expect(
      sonioxRequestContext({
        route: { path: '/assist/sites/:siteId/admin/voice' },
        identity: { telegramId: 123n },
      }),
    ).toMatchObject({ actorRole: 'administrator', actorId: '123' });
    expect(
      sonioxRequestContext({
        route: { path: '/assist/sites/:id/voice-config/sample' },
        identity: { telegramId: 123n },
      }),
    ).toMatchObject({ actorRole: 'administrator', actorId: '123' });
    expect(
      sonioxRequestContext({ route: { path: '/cron/assist-retention' } })
        .actorRole,
    ).toBe('cron');
    expect(
      sonioxRequestContext({
        route: { path: '/public/voice' },
        headers: { 'x-admin-actor': 'fake' },
      }).actorId,
    ).toBeNull();
  });
  it('records running before completion, volumes and confidence without transcripts/audio', async () => {
    const { service, db } = build();
    let finish!: (v: unknown) => void;
    const provider = new Promise((resolve) => (finish = resolve));
    const run = sonioxContext.run(
      {
        source: 'voice/:id',
        actorRole: 'client',
        actorId: 'u1',
        accountId: null,
        siteId: null,
      },
      () => service.track('stt', 'system', () => provider),
    );
    await Promise.resolve();
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain('INSERT');
    expect(db.$executeRawUnsafe.mock.calls).toHaveLength(1);
    finish({
      text: 'Марина привет',
      seconds: 2,
      speechConfidence: 0.9,
      language: 'ru',
    });
    await run;
    expect(db.$executeRawUnsafe.mock.calls[1][0]).toContain('UPDATE');
    expect(db.$executeRawUnsafe.mock.calls[1].slice(2)).toEqual([
      'ok',
      null,
      expect.any(Number),
      2,
      0,
      2,
      'ru',
      0.9,
    ]);
    expect(JSON.stringify(db.$executeRawUnsafe.mock.calls)).not.toContain(
      'Марина',
    );
  });
  it('telemetry database failure does not mask the provider result or exception', async () => {
    const { service, db } = build();
    db.$executeRawUnsafe.mockRejectedValue(Error('db'));
    expect(
      await service.track('tts', 'system', async () => ({ ok: true })),
    ).toEqual({ ok: true });
    await expect(
      service.track('tts', 'system', async () => {
        throw Error('provider');
      }),
    ).rejects.toThrow('provider');
  });
  it('marks thrown provider errors completed and rethrows', async () => {
    const { service, db } = build();
    await expect(
      service.track('stt', 'system', async () => {
        throw Error('upstream secret');
      }),
    ).rejects.toThrow('upstream secret');
    expect(db.$executeRawUnsafe.mock.calls[1][2]).toBe('error');
    expect(JSON.stringify(db.$executeRawUnsafe.mock.calls)).not.toContain(
      'secret',
    );
  });
  it.each([
    ['timeout', 'timeout'],
    ['no_key', 'not-configured'],
    ['SONIOX_API_KEY not set', 'not-configured'],
    ['no_speech', 'empty'],
    ['no speech recognised', 'empty'],
    ['Soniox TTS ответил 429: sensitive body', 'error'],
  ])('safe failure reason %s', (reason, status) => {
    expect(sonioxResultMetrics('stt', { reason }).status).toBe(status);
    expect(
      JSON.stringify(sonioxResultMetrics('stt', { reason })),
    ).not.toContain('sensitive');
  });
  it('captures TTS volume and maintenance failures/skips', () => {
    expect(
      sonioxResultMetrics('tts', {
        ok: true,
        characters: 123,
        durationSeconds: 7,
      }),
    ).toMatchObject({ status: 'ok', characters: 123, seconds: 7 });
    expect(sonioxResultMetrics('cleanup', { sonioxFailed: 2 }).status).toBe(
      'error',
    );
    expect(sonioxResultMetrics('cleanup', { sonioxSkipped: true }).status).toBe(
      'skipped',
    );
  });
  it('preserves safe TTS language, timeout and HTTP codes without provider bodies', () => {
    expect(sonioxResultMetrics('tts', { ok: true, lang: 'uk' }).language).toBe(
      'uk',
    );
    expect(sonioxResultMetrics('tts', { reason: 'timeout' })).toMatchObject({
      status: 'timeout',
      reasonCode: 'timeout',
    });
    expect(
      sonioxResultMetrics('tts', { reason: 'error', reasonCode: 'http-429' }),
    ).toMatchObject({ status: 'error', reasonCode: 'http-429' });
    expect(
      sonioxResultMetrics('tts', {
        reason: 'error',
        reasonCode: 'secret transcript',
      }).reasonCode,
    ).toBe('error');
    expect(
      sonioxResultMetrics('stt', { speechConfidence: 2 }).confidence,
    ).toBeNull();
  });
  it('reports bounded recent and active tasks, marks interrupted separately, and limits retention deletion', async () => {
    const { service, db } = build();
    expect((await service.report()).available).toBe(true);
    expect(db.$queryRawUnsafe.mock.calls).toHaveLength(6);
    const sql = JSON.stringify(db.$queryRawUnsafe.mock.calls);
    expect(sql).toContain('interrupted');
    expect(sql).toContain('percentile_cont');
    expect(sql).toContain('LIMIT 100');
    await service.prune();
    expect(db.$executeRawUnsafe.mock.calls[0][0]).toContain('LIMIT 5000');
  });
  it('does not present absent database as zero successful calls', async () => {
    const { service, db } = build();
    db.$queryRawUnsafe.mockRejectedValue(Error('migration'));
    expect((await service.report()).available).toBe(false);
  });
  it('keeps financial history when operational table is not installed', async () => {
    const { service, db } = build();
    db.$queryRawUnsafe.mockImplementation(async (query: string) => {
      if (query.includes('FROM sites.site_ai_usage')) return [{ calls: 42 }];
      throw Error('migration');
    });
    expect(await service.report()).toMatchObject({
      available: false,
      billingAvailable: true,
      usage: [{ calls: 42 }],
    });
  });
});
