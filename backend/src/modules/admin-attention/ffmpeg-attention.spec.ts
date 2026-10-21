/**
 * Правило дашборда внимания для своего FFmpeg-сервера (FF-INT-04) — на
 * НАСТОЯЩЕМ ответе `GET /api/ops/overview`: фикстура снята с ffmpeg-server
 * (test/core helpers, две задачи с OOM), а не придумана. Ссылки — `/ffmpeg`.
 */
import { ffmpegItems, FfmpegAttentionInput } from './attention-rules';
import * as fixture from './__fixtures__/ffmpeg-ops-overview.json';

const now = new Date('2026-10-21T12:00:00Z');
const real = () =>
  JSON.parse(JSON.stringify((fixture as { data: unknown }).data)) as Record<
    string,
    Record<string, unknown>
  >;
const input = (
  data: Record<string, unknown> | null,
  over: Partial<FfmpegAttentionInput> = {},
): FfmpegAttentionInput => ({
  state: 'ok',
  fetchedAt: now.toISOString(),
  error: null,
  data,
  breaker: { open: false, openUntil: null, failures: 0 },
  ...over,
});

describe('ffmpegItems на настоящей сводке ffmpeg-server', () => {
  it('сводка здоровая и без OOM — карточек нет; не настроен — тоже', () => {
    const d = real();
    d.queue.errors_24h = {};
    d.queue.oom_24h = 0;
    expect(ffmpegItems(input(d), now)).toEqual([]);
    expect(ffmpegItems(input(null, { state: 'not-configured' }), now)).toEqual(
      [],
    );
  });

  it('ready.ready=false — блокер с reasons[] (форма README)', () => {
    const d = real();
    d.ready = {
      ready: false,
      checks: { sqlite: true, executor: false },
      reasons: ['executor_heartbeat_stale', 'disk_low'],
      checked_at: now.toISOString(),
    };
    d.queue.errors_24h = {};
    d.queue.oom_24h = 0;
    const items = ffmpegItems(input(d), now);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'ffmpeg-not-ready',
        severity: 'blocker',
        href: '/ffmpeg',
        reason: expect.stringContaining('executor_heartbeat_stale, disk_low'),
      }),
    ]);
  });

  it('повторные OOM из queue.errors_24h (фикстура: две задачи OOM) — решение', () => {
    const items = ffmpegItems(input(real()), now);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'ffmpeg-oom-repeated',
        href: '/ffmpeg?state=failed&period=24h',
        count: 2,
      }),
    ]);
  });

  it('очередь без прогресса по queue.oldest_queued_age_sec', () => {
    const d = real();
    d.queue.oldest_queued_age_sec = 25 * 60;
    d.queue.errors_24h = {};
    d.queue.oom_24h = 0;
    expect(ffmpegItems(input(d), now)).toEqual([
      expect.objectContaining({
        kind: 'ffmpeg-queue-stuck',
        href: '/ffmpeg?state=queued',
      }),
    ]);
  });

  it('breaker открыт — блокер', () => {
    const d = real();
    d.queue.errors_24h = {};
    d.queue.oom_24h = 0;
    const items = ffmpegItems(
      input(d, {
        breaker: { open: true, openUntil: '2026-10-21T12:10:00Z', failures: 3 },
      }),
      now,
    );
    expect(items.map((i) => i.kind)).toEqual(['ffmpeg-breaker-open']);
  });

  it('сервер недоступен — блокер, а не «всё нормально»; текст ошибки очищен', () => {
    const items = ffmpegItems(
      input(null, {
        state: 'error',
        fetchedAt: null,
        error: 'FFmpeg-сервер недоступен https://ffmpeg.example/api?token=abc',
      }),
      now,
    );
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'ffmpeg-unavailable',
        severity: 'blocker',
      }),
    ]);
    expect(items[0].reason).not.toContain('token=abc');
  });
});
