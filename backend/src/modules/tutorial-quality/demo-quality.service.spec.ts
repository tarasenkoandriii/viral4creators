/**
 * Очередь проверки качества демо: постановка и дедупликация, захват с
 * арендой и её восстановление, повторы с паузой, бюджет, фазы между
 * тиками, техпроверка без Gemini, вердикт. База — в памяти (ниже,
 * `FakeModel`: `updateMany` атомарен, как UPDATE … WHERE), Gemini —
 * фейк, разбор MP4 — подменён (сам он проверен в `mp4-probe.spec.ts`,
 * техпроверка — в `demo-quality-preflight.spec.ts`).
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { probeMp4 } from '../tutorial-runner/mp4-probe';
import { TUTORIAL_MANIFEST_VERSION } from '../tutorial-runner/tutorial-manifest';
import {
  DemoQualityGemini,
  DemoQualityGeminiFile,
  DemoQualityGenerateRequest,
  DemoQualityGenerateResult,
} from './demo-quality-gemini';
import {
  BACKOFF_BASE_MS,
  demoQualityDedupeKey,
  LEASE_MS,
  MIN_ANALYZE_MS,
  sha256Hex,
} from './demo-quality-queue';
import { DEMO_QUALITY_RUBRIC_VERSION } from './demo-quality-rubric';
import { GEMINI_MODEL } from '../../common/gemini-model';
import { TutorialDemoQualityService } from './demo-quality.service';

jest.mock('../tutorial-runner/mp4-probe', () => ({ probeMp4: jest.fn() }));
const probeMock = probeMp4 as jest.Mock;

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
let now = T0;
const BYTES = Buffer.from('mp4-bytes-of-asset-1');
const URL1 =
  'https://store.blob.vercel-storage.com/tutorial-videos/2/dark/a1.mp4';

/** Ролик 10 с, 720×1560, со звуком. */
const GOOD_PROBE = {
  durationSeconds: 10,
  tracks: [
    {
      kind: 'video',
      timescale: 15360,
      duration: 153600,
      durationSeconds: 10,
      samples: 300,
      width: 720,
      height: 1560,
    },
    {
      kind: 'audio',
      timescale: 44100,
      duration: 441000,
      durationSeconds: 10,
      samples: 431,
      width: null,
      height: null,
    },
  ],
};

const MANIFEST = {
  manifestVersion: TUTORIAL_MANIFEST_VERSION,
  sourceAssetId: 'a1',
  owner: { kind: 'scenario', scenarioId: 's1', subjectKey: '2' },
  sourceHash: 'h',
  locale: 'ru',
  theme: 'dark',
  fps: 30,
  motion: 'none',
  captions: true,
  narration: 'per-frame',
  storage: 'sources',
  frames: [
    {
      frameId: 'f1',
      stepIndex: 1,
      image: { url: 'u1' },
      baseSeconds: 5,
      speech: null,
      caption: 'Нажмите «Загрузить»',
      readingSeconds: 2,
      pointer: null,
    },
    {
      frameId: 'f2',
      stepIndex: 2,
      image: { url: 'u2' },
      baseSeconds: 5,
      speech: null,
      caption: 'Готово',
      readingSeconds: 2,
      pointer: null,
    },
  ],
};

const GOOD_ANSWER = {
  summary: 'Демо читается, шаги на месте',
  scores: { readability: 90, stepMatch: 88, pacing: 85, consistency: 92 },
  themeObserved: 'dark',
  speechLanguage: 'ru',
  captionLanguage: 'ru',
  issues: [
    {
      category: 'pacing',
      severity: 'minor',
      startSec: 4.2,
      endSec: 5,
      explanation: 'короткая пауза',
      confidence: 0.6,
    },
  ],
  missingEvidence: [],
};

class FakeGemini extends DemoQualityGemini {
  files = new Map<string, DemoQualityGeminiFile>();
  seq = 0;
  /** Состояние, которое `getFile` вернёт загруженному файлу. */
  nextState: DemoQualityGeminiFile['state'] = 'ACTIVE';
  answer: () => Promise<DemoQualityGenerateResult> = async () => ({
    text: JSON.stringify(GOOD_ANSWER),
    response: {
      usageMetadata: { promptTokenCount: 10_000, candidatesTokenCount: 500 },
    },
    refusal: null,
  });
  upload = jest.fn(async (_bytes: Buffer, mimeType: string) => {
    const f: DemoQualityGeminiFile = {
      name: `files/f${++this.seq}`,
      state: 'PROCESSING',
      uri: null,
      mimeType,
      error: null,
    };
    this.files.set(f.name, f);
    return f;
  });
  getFile = jest.fn(async (name: string) => {
    const f = this.files.get(name);
    if (!f) throw Object.assign(new Error('not found'), { status: 404 });
    return {
      ...f,
      state: this.nextState,
      uri: this.nextState === 'ACTIVE' ? `https://gen/${name}` : null,
      error: this.nextState === 'FAILED' ? 'кодек' : null,
    };
  });
  generate = jest.fn((req: DemoQualityGenerateRequest) => {
    void req;
    return this.answer();
  });
  deleteFile = jest.fn(async (name: string) => {
    this.files.delete(name);
  });
}

let checks: FakeModel;
let assets: FakeModel;
let versions: FakeModel;
let gemini: FakeGemini;
let blob: { downloadBuffer: jest.Mock };
let aiUsage: { recordGemini: jest.Mock; spentTodayForOperation: jest.Mock };
let svc: TutorialDemoQualityService;

function asset(over: Record<string, unknown> = {}) {
  return {
    id: 'a1',
    createdAt: new Date(T0 - 3_600_000),
    subjectKey: '2',
    title: 'Как загрузить референс',
    locale: 'ru',
    theme: 'dark',
    durationMs: 10_000,
    width: 720,
    height: 1560,
    captureBuild: 'build-1',
    capturedAt: new Date(T0 - 3_600_000),
    tempoManifest: MANIFEST,
    clientSiteDraftId: null,
    activeVersionId: null,
    assemblyStatus: 'complete',
    blobUrl: URL1,
    reviewed: false,
    ...over,
  };
}

function setup() {
  now = T0;
  process.env.TUTORIAL_DEMO_QUALITY_ENABLED = '1';
  delete process.env.TUTORIAL_DEMO_QUALITY_DAILY_USD;
  delete process.env.TUTORIAL_DEMO_QUALITY_DAILY_VIDEO_MINUTES;
  delete process.env.TUTORIAL_DEMO_QUALITY_BACKFILL_CAP;
  delete process.env.TUTORIAL_DEMO_QUALITY_MODEL;
  const clock = () => new Date(now);
  checks = new FakeModel('chk', CHECK_DEFAULTS, clock);
  assets = new FakeModel('asset', {}, clock);
  versions = new FakeModel('ver', {}, clock);
  assets.rows.push(asset());
  gemini = new FakeGemini();
  blob = { downloadBuffer: jest.fn(async () => BYTES) };
  aiUsage = {
    recordGemini: jest.fn(async () => undefined),
    spentTodayForOperation: jest.fn(async () => 0),
  };
  probeMock.mockReset();
  probeMock.mockReturnValue(GOOD_PROBE);
  const prisma = {
    tutorialDemoQualityCheck: checks,
    tutorialVideoAsset: assets,
    tutorialVideoVersion: versions,
  };
  svc = new TutorialDemoQualityService(
    prisma as never,
    blob as never,
    gemini,
    aiUsage as never,
  );
  svc.clock = () => now;
  svc.sleep = async (ms: number) => {
    now += ms;
  };
}

beforeEach(setup);
afterAll(() => {
  delete process.env.TUTORIAL_DEMO_QUALITY_ENABLED;
});

const only = () => {
  expect(checks.rows).toHaveLength(1);
  return checks.rows[0];
};

// ── постановка ───────────────────────────────────────────────────────

describe('постановка в очередь', () => {
  it('выключено — сборка не ставит, кнопки отвечают 400, тик пропускает', async () => {
    delete process.env.TUTORIAL_DEMO_QUALITY_ENABLED;
    expect(await svc.enqueueAssembled('a1', BYTES)).toBe(false);
    await expect(svc.enqueueByOperator('a1', 'op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.enqueueApproved('op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await svc.processQueue()).toMatchObject({
      skipped: 'выключено',
      processed: 0,
    });
    expect(checks.rows).toHaveLength(0);
    expect(checks.findMany).not.toHaveBeenCalled();
  });

  it('новая сборка — запись с ключом по sha содержимого и снимком метаданных', async () => {
    expect(await svc.enqueueAssembled('a1', BYTES)).toBe(true);
    const r = only();
    expect(r).toMatchObject({
      assetId: 'a1',
      versionId: null,
      videoUrl: URL1,
      trigger: 'assembly',
      contentSha: sha256Hex(BYTES),
      dedupeKey: demoQualityDedupeKey(
        'a1',
        sha256Hex(BYTES),
        DEMO_QUALITY_RUBRIC_VERSION,
        GEMINI_MODEL,
      ),
      rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
      modelId: GEMINI_MODEL,
      status: 'pending',
      phase: 'upload',
      theme: 'dark',
      locale: 'ru',
      captureBuild: 'build-1',
      durationMs: 10_000,
      captureMode: null,
    });
  });

  it('повтор той же сборки и кнопка — без второй записи', async () => {
    await svc.enqueueAssembled('a1', BYTES);
    expect(await svc.enqueueAssembled('a1', BYTES)).toBe(false);
    const res = await svc.enqueueByOperator('a1', 'op');
    expect(res).toMatchObject({ created: false, reason: 'already-queued' });
    expect(checks.rows).toHaveLength(1);
  });

  it('проверенный файл — «уже проверено», не платим второй раз', async () => {
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'old',
      createdAt: new Date(T0 - 1000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'assembly',
      rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
      modelId: GEMINI_MODEL,
      locale: 'ru',
      status: 'complete',
      verdict: 'ok',
    });
    const res = await svc.enqueueByOperator('a1', 'op');
    expect(res).toMatchObject({ created: false, reason: 'already-checked' });
    expect(res.check.id).toBe('old');
    expect(checks.rows).toHaveLength(1);
  });

  it('смена рубрики или модели — новая проверка (явная переоценка)', async () => {
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'old',
      createdAt: new Date(T0 - 1000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'assembly',
      rubricVersion: 'demo-quality-v0',
      modelId: GEMINI_MODEL,
      locale: 'ru',
      status: 'complete',
      verdict: 'ok',
    });
    expect((await svc.enqueueByOperator('a1', 'op')).created).toBe(true);
    process.env.TUTORIAL_DEMO_QUALITY_MODEL = 'gemini-2.5-pro';
    expect((await svc.enqueueByOperator('a1', 'op')).created).toBe(true);
    expect(checks.rows).toHaveLength(3);
  });

  it('ошибочная проверка — кнопка запускает её заново, сборка — нет', async () => {
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'bad',
      createdAt: new Date(T0 - 1000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'assembly',
      rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
      modelId: GEMINI_MODEL,
      locale: 'ru',
      status: 'error',
      attempts: 3,
      error: 'после 3 попыток',
      phase: 'analyze',
      providerFileName: 'files/x',
    });
    expect(await svc.enqueueAssembled('a1')).toBe(false);
    expect(checks.get('bad')!.status).toBe('error');
    const res = await svc.enqueueByOperator('a1', 'op');
    expect(res).toMatchObject({ created: false, reason: 'retry' });
    expect(checks.get('bad')).toMatchObject({
      status: 'pending',
      attempts: 0,
      error: null,
      phase: 'upload',
      providerFileName: null,
      requestedBy: 'op',
    });
  });

  it('не собран / по сайту заказчика / нет ролика — отказ', async () => {
    assets.rows.push(
      asset({ id: 'p', assemblyStatus: 'pending', blobUrl: null }),
    );
    assets.rows.push(asset({ id: 'c', clientSiteDraftId: 'd1' }));
    await expect(svc.enqueueByOperator('p', 'op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.enqueueByOperator('c', 'op')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.enqueueByOperator('nope', 'op')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await svc.enqueueAssembled('c', BYTES)).toBe(false);
    expect(checks.rows).toHaveLength(0);
  });

  it('версия темпа — свой файл и длительность; несобранная — отказ', async () => {
    versions.rows.push({
      id: 'v1',
      assetId: 'a1',
      status: 'complete',
      blobUrl: 'https://s/tutorial-videos/versions/a1/v1.mp4',
      videoMs: 14_000,
    });
    versions.rows.push({
      id: 'v2',
      assetId: 'a1',
      status: 'pending',
      blobUrl: null,
      videoMs: null,
    });
    const res = await svc.enqueueByOperator('a1', 'op', 'v1');
    expect(res.created).toBe(true);
    expect(only()).toMatchObject({
      versionId: 'v1',
      videoUrl: 'https://s/tutorial-videos/versions/a1/v1.mp4',
      durationMs: 14_000,
    });
    await expect(
      svc.enqueueByOperator('a1', 'op', 'v2'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('активная версия ролика записывается как проверяемая', async () => {
    assets.rows[0] = asset({ activeVersionId: 'v9' });
    await svc.enqueueByOperator('a1', 'op');
    expect(only().versionId).toBe('v9');
  });

  it('«Проверить все одобренные» — только одобренные демо, с потолком, без уже проверенных', async () => {
    process.env.TUTORIAL_DEMO_QUALITY_BACKFILL_CAP = '2';
    assets.rows = [
      asset({
        id: 'r1',
        reviewed: true,
        blobUrl: 'https://s/tutorial-videos/r1.mp4',
        createdAt: new Date(T0 - 1),
      }),
      asset({
        id: 'r2',
        reviewed: true,
        blobUrl: 'https://s/tutorial-videos/r2.mp4',
        createdAt: new Date(T0 - 2),
      }),
      asset({
        id: 'r3',
        reviewed: true,
        blobUrl: 'https://s/tutorial-videos/r3.mp4',
        createdAt: new Date(T0 - 3),
      }),
      asset({
        id: 'r4',
        reviewed: true,
        blobUrl: 'https://s/tutorial-videos/r4.mp4',
        createdAt: new Date(T0 - 4),
      }),
      asset({ id: 'n1', reviewed: false }),
      asset({ id: 'c1', reviewed: true, clientSiteDraftId: 'd' }),
    ];
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'done',
      createdAt: new Date(T0 - 5),
      assetId: 'r1',
      videoUrl: 'https://s/tutorial-videos/r1.mp4',
      trigger: 'assembly',
      rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
      modelId: GEMINI_MODEL,
      locale: 'ru',
      status: 'complete',
      verdict: 'ok',
    });
    const res = await svc.enqueueApproved('op');
    expect(res).toEqual({ queued: 2, skipped: 1, remaining: 1, cap: 2 });
    expect(
      checks.rows
        .filter((r) => r.trigger === 'approved-backfill')
        .map((r) => r.assetId),
    ).toEqual(['r2', 'r3']);
    // Повторное нажатие берёт следующий, а не те же.
    const again = await svc.enqueueApproved('op');
    expect(again).toEqual({ queued: 1, skipped: 3, remaining: 0, cap: 2 });
  });
});

// ── тик ──────────────────────────────────────────────────────────────

describe('тик очереди', () => {
  beforeEach(async () => {
    await svc.enqueueAssembled('a1', BYTES);
  });

  it('загрузка → ожидание → анализ за один тик; вердикт, расход, уборка файла; одобрение не трогается', async () => {
    const res = await svc.processQueue();
    expect(res).toEqual({
      processed: 1,
      completed: 1,
      deferred: 0,
      retried: 0,
      errors: 0,
    });
    const r = only();
    expect(r).toMatchObject({
      status: 'complete',
      verdict: 'ok',
      phase: 'analyze',
      leaseOwner: null,
      leaseUntil: null,
      providerFileName: null,
      attempts: 0,
      unpriced: false,
    });
    expect(typeof r.costMicroUsd).toBe('number');
    expect(r.costMicroUsd as number).toBeGreaterThan(0);
    expect(r.checkedAt).toEqual(new Date(now));
    const report = r.report as {
      issues: Array<{ startMs: number }>;
      freshness: string;
      theme: { result: string };
    };
    expect(report.issues[0].startMs).toBe(4200);
    expect(report.freshness).toBe('current');
    expect(report.theme.result).toBe('match');
    expect(gemini.upload).toHaveBeenCalledTimes(1);
    expect(gemini.deleteFile).toHaveBeenCalledWith('files/f1');
    expect(aiUsage.recordGemini).toHaveBeenCalledWith(
      expect.objectContaining({ usageMetadata: expect.any(Object) }),
      { operation: 'tutorial-demo-quality', model: GEMINI_MODEL, userId: null },
    );
    // Запрос: ожидаемый сценарий, схема, таймаут из остатка бюджета.
    const req = gemini.generate.mock.calls[0][0];
    expect(req.fileUri).toBe('https://gen/files/f1');
    expect(req.prompt).toContain('step 1 [0.0s–5.0s]: "Нажмите «Загрузить»"');
    expect(req.schema).toBeDefined();
    expect(req.timeoutMs).toBeLessThanOrEqual(55_000);
    // Ролик не тронут: ни одной записи в таблицу роликов.
    expect(assets.update).not.toHaveBeenCalled();
    expect(assets.updateMany).not.toHaveBeenCalled();
  });

  it('файл ещё обрабатывается — фаза «ожидание» сохраняется, следующий тик доводит без повторной загрузки', async () => {
    gemini.nextState = 'PROCESSING';
    const first = await svc.processQueue();
    expect(first).toMatchObject({ processed: 1, deferred: 1, completed: 0 });
    expect(only()).toMatchObject({
      status: 'pending',
      phase: 'wait',
      providerFileName: 'files/f1',
      leaseOwner: null,
      attempts: 0,
    });
    expect(gemini.generate).not.toHaveBeenCalled();
    gemini.nextState = 'ACTIVE';
    now += 120_000;
    const second = await svc.processQueue();
    expect(second).toMatchObject({ completed: 1 });
    expect(gemini.upload).toHaveBeenCalledTimes(1);
    expect(blob.downloadBuffer).toHaveBeenCalledTimes(1);
    expect(only().status).toBe('complete');
  });

  it('мало времени на анализ — фаза «анализ» ждёт следующего тика, попытка не тратится', async () => {
    const res = await svc.processQueue({ budgetMs: MIN_ANALYZE_MS - 1 });
    expect(res).toMatchObject({ deferred: 1 });
    expect(only()).toMatchObject({
      status: 'pending',
      phase: 'analyze',
      attempts: 0,
    });
    expect(gemini.generate).not.toHaveBeenCalled();
    await svc.processQueue();
    expect(only().status).toBe('complete');
    expect(gemini.upload).toHaveBeenCalledTimes(1);
  });

  it('таймаут вызова — из остатка бюджета тика минус запас', async () => {
    await svc.processQueue({ budgetMs: 30_000 });
    expect(gemini.generate.mock.calls[0][0].timeoutMs).toBe(25_000);
  });

  it('техпроверка не пройдена — fail без Gemini и без расхода', async () => {
    probeMock.mockReturnValue({
      ...GOOD_PROBE,
      tracks: [GOOD_PROBE.tracks[0]],
    });
    const res = await svc.processQueue();
    expect(res).toMatchObject({ completed: 1 });
    const r = only();
    expect(r).toMatchObject({
      status: 'complete',
      verdict: 'fail',
      costMicroUsd: 0,
    });
    const report = r.report as {
      issues: Array<{ category: string; source: string; explanation: string }>;
    };
    expect(report.issues).toEqual([
      expect.objectContaining({
        category: 'technical',
        source: 'preflight',
        explanation: 'нет звуковой дорожки, хотя озвучка заказана',
      }),
    ]);
    expect((r.preflight as { ok: boolean }).ok).toBe(false);
    expect(gemini.upload).not.toHaveBeenCalled();
    expect(gemini.generate).not.toHaveBeenCalled();
    expect(aiUsage.recordGemini).not.toHaveBeenCalled();
  });

  it('тема съёмки не совпадает с заявленной — fail техпроверки', async () => {
    assets.rows[0] = asset({ theme: 'light' });
    await svc.processQueue();
    expect(only().verdict).toBe('fail');
    expect(gemini.upload).not.toHaveBeenCalled();
  });

  it('то же содержимое уже проверено — результат копируется, Gemini не зовётся', async () => {
    const key = demoQualityDedupeKey(
      'a1',
      sha256Hex(BYTES),
      DEMO_QUALITY_RUBRIC_VERSION,
      GEMINI_MODEL,
    );
    checks.rows[0].videoUrl = 'https://s/tutorial-videos/2/dark/a1-copy.mp4';
    checks.rows.unshift({
      ...CHECK_DEFAULTS,
      id: 'prev',
      createdAt: new Date(T0 - 10_000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'assembly',
      rubricVersion: DEMO_QUALITY_RUBRIC_VERSION,
      modelId: GEMINI_MODEL,
      locale: 'ru',
      status: 'complete',
      verdict: 'warn',
      dedupeKey: key,
      report: { summary: 'старый' },
      durationMs: 10_000,
    });
    const res = await svc.processQueue();
    expect(res.completed).toBe(1);
    const r = checks.rows.find((x) => x.id !== 'prev')!;
    expect(r).toMatchObject({
      status: 'complete',
      verdict: 'warn',
      reusedFromId: 'prev',
      costMicroUsd: 0,
      report: { summary: 'старый' },
    });
    expect(gemini.upload).not.toHaveBeenCalled();
    expect(gemini.generate).not.toHaveBeenCalled();
  });

  it('повторный тик не оплачивает завершённую проверку', async () => {
    await svc.processQueue();
    now += 600_000;
    const again = await svc.processQueue();
    expect(again.processed).toBe(0);
    expect(gemini.generate).toHaveBeenCalledTimes(1);
  });

  it('невалидный ответ модели — warn, не ok', async () => {
    gemini.answer = async () => ({
      text: 'не json',
      response: {},
      refusal: null,
    });
    await svc.processQueue();
    expect(only()).toMatchObject({ status: 'complete', verdict: 'warn' });
    expect((only().report as { invalid: string }).invalid).toMatch(/не JSON/);
  });

  it('отказ модели (safety) — warn с причиной', async () => {
    gemini.answer = async () => ({
      text: '',
      response: {},
      refusal: 'модель прервала ответ (SAFETY)',
    });
    await svc.processQueue();
    expect(only().verdict).toBe('warn');
    expect((only().report as { invalid: string }).invalid).toContain('SAFETY');
  });

  it('модель без ставки — расход unpriced, не ноль-правда', async () => {
    checks.rows[0].modelId = 'gemini-unknown-model';
    await svc.processQueue();
    expect(only()).toMatchObject({ status: 'complete', unpriced: true });
  });
});

describe('повторы и ошибки', () => {
  beforeEach(async () => {
    await svc.enqueueAssembled('a1', BYTES);
  });

  it('429 — повтор с паузой 2 → 4 мин, на третьей — error и уборка файла', async () => {
    gemini.answer = async () => {
      throw Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 });
    };
    expect(await svc.processQueue()).toMatchObject({ retried: 1 });
    expect(only()).toMatchObject({
      status: 'pending',
      phase: 'analyze',
      attempts: 1,
      nextAttemptAt: new Date(now + BACKOFF_BASE_MS),
      providerFileName: 'files/f1',
      leaseOwner: null,
    });
    // До срока — не берётся.
    now += BACKOFF_BASE_MS - 1;
    expect((await svc.processQueue()).processed).toBe(0);
    now += 1;
    expect(await svc.processQueue()).toMatchObject({ retried: 1 });
    expect(only()).toMatchObject({
      attempts: 2,
      nextAttemptAt: new Date(now + 2 * BACKOFF_BASE_MS),
    });
    now += 2 * BACKOFF_BASE_MS;
    expect(await svc.processQueue()).toMatchObject({ errors: 1 });
    const r = only();
    expect(r).toMatchObject({
      status: 'error',
      attempts: 3,
      verdict: null,
      providerFileName: null,
      leaseOwner: null,
    });
    expect(r.error).toMatch(/после 3 попыток/);
    expect(gemini.deleteFile).toHaveBeenCalledWith('files/f1');
    expect(gemini.upload).toHaveBeenCalledTimes(1);
    // Ошибка — не вердикт и больше не берётся.
    now += 3_600_000;
    expect((await svc.processQueue()).processed).toBe(0);
  });

  it('постоянная ошибка (400) — сразу error, без повторов', async () => {
    gemini.answer = async () => {
      throw Object.assign(new Error('invalid argument'), { status: 400 });
    };
    expect(await svc.processQueue()).toMatchObject({ errors: 1 });
    expect(only()).toMatchObject({
      status: 'error',
      attempts: 1,
      error: 'invalid argument',
    });
  });

  it('сбой скачивания — временный, фаза загрузки остаётся', async () => {
    blob.downloadBuffer.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await svc.processQueue()).toMatchObject({ retried: 1 });
    expect(only()).toMatchObject({
      status: 'pending',
      phase: 'upload',
      attempts: 1,
    });
  });

  it('Gemini не обработал файл — файл удаляется, следующая попытка загружает заново', async () => {
    gemini.nextState = 'FAILED';
    expect(await svc.processQueue()).toMatchObject({ retried: 1 });
    expect(only()).toMatchObject({
      phase: 'upload',
      providerFileName: null,
      attempts: 1,
    });
    expect(gemini.deleteFile).toHaveBeenCalledWith('files/f1');
    gemini.nextState = 'ACTIVE';
    now += BACKOFF_BASE_MS;
    await svc.processQueue();
    expect(only().status).toBe('complete');
    expect(gemini.upload).toHaveBeenCalledTimes(2);
  });

  it('файл не стал ACTIVE за 10 мин — попытка и повторная загрузка', async () => {
    gemini.nextState = 'PROCESSING';
    await svc.processQueue();
    now += 11 * 60_000;
    expect(await svc.processQueue()).toMatchObject({ retried: 1 });
    expect(only()).toMatchObject({
      phase: 'upload',
      attempts: 1,
      providerFileName: null,
    });
  });
});

describe('аренда', () => {
  beforeEach(async () => {
    await svc.enqueueAssembled('a1', BYTES);
  });

  it('живая аренда другого тика — запись не берётся', async () => {
    Object.assign(checks.rows[0], {
      status: 'running',
      leaseOwner: 'other',
      leaseUntil: new Date(now + 60_000),
    });
    expect((await svc.processQueue()).processed).toBe(0);
    expect(only().leaseOwner).toBe('other');
  });

  it('истёкшая аренда — упавший тик: запись подбирается с той же фазы, попытка засчитана', async () => {
    Object.assign(checks.rows[0], {
      status: 'running',
      phase: 'analyze',
      leaseOwner: 'dead',
      leaseUntil: new Date(now - 1),
      providerFileName: 'files/old',
      providerFileUri: 'https://gen/files/old',
      uploadedAt: new Date(now - 60_000),
    });
    gemini.files.set('files/old', {
      name: 'files/old',
      state: 'ACTIVE',
      uri: 'https://gen/files/old',
      mimeType: 'video/mp4',
      error: null,
    });
    const res = await svc.processQueue();
    expect(res.completed).toBe(1);
    expect(only()).toMatchObject({ status: 'complete', attempts: 1 });
    expect(gemini.upload).not.toHaveBeenCalled();
    expect(gemini.generate.mock.calls[0][0].fileUri).toBe(
      'https://gen/files/old',
    );
  });

  it('третье падение тика подряд — error, без анализа', async () => {
    Object.assign(checks.rows[0], {
      status: 'running',
      attempts: 2,
      leaseOwner: 'dead',
      leaseUntil: new Date(now - 1),
      providerFileName: 'files/old',
    });
    const res = await svc.processQueue();
    expect(res.processed).toBe(0);
    expect(only()).toMatchObject({
      status: 'error',
      attempts: 3,
      leaseOwner: null,
    });
    expect(only().error).toMatch(/обрывалась 3/);
    expect(gemini.generate).not.toHaveBeenCalled();
    expect(gemini.deleteFile).toHaveBeenCalledWith('files/old');
  });

  it('захват атомарен: проигравший гонку тик запись не трогает', async () => {
    // Между выборкой кандидата и захватом запись взял другой тик.
    const realUpdateMany = checks.updateMany.getMockImplementation()!;
    checks.updateMany.mockImplementationOnce(async (args) => {
      Object.assign(checks.rows[0], {
        status: 'running',
        leaseOwner: 'other',
        leaseUntil: new Date(now + LEASE_MS),
      });
      return realUpdateMany(args);
    });
    const res = await svc.processQueue();
    expect(res.processed).toBe(0);
    expect(only().leaseOwner).toBe('other');
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
  });

  it('аренду перехватили во время анализа — результат не записывается поверх', async () => {
    gemini.answer = async () => {
      Object.assign(checks.rows[0], { leaseOwner: 'thief' });
      return { text: JSON.stringify(GOOD_ANSWER), response: {}, refusal: null };
    };
    await svc.processQueue();
    expect(only()).toMatchObject({
      status: 'running',
      leaseOwner: 'thief',
      verdict: null,
    });
  });

  it('аренда дольше любого тика функции', () => {
    expect(LEASE_MS).toBeGreaterThan(300_000);
  });
});

describe('бюджет', () => {
  it('денежный потолок выбран — запись ждёт следующих суток, файл не загружается, попытка не тратится; тик дальше не качает', async () => {
    assets.rows.push(
      asset({ id: 'a2', blobUrl: 'https://s/tutorial-videos/a2.mp4' }),
    );
    await svc.enqueueAssembled('a1', BYTES);
    await svc.enqueueAssembled('a2', Buffer.from('other'));
    aiUsage.spentTodayForOperation.mockResolvedValue(1_000_000);
    const res = await svc.processQueue();
    expect(res).toMatchObject({ processed: 1, deferred: 1 });
    expect(blob.downloadBuffer).toHaveBeenCalledTimes(1);
    expect(aiUsage.spentTodayForOperation).toHaveBeenCalledWith(
      'tutorial-demo-quality',
      new Date(T0),
    );
    const r = checks.rows[0];
    expect(r).toMatchObject({
      status: 'pending',
      phase: 'upload',
      attempts: 0,
      nextAttemptAt: new Date('2026-10-07T00:00:00.000Z'),
    });
    expect(r.error).toMatch(/потолок расходов/);
    expect(gemini.upload).not.toHaveBeenCalled();
    // Следующие сутки — бюджет снова открыт.
    aiUsage.spentTodayForOperation.mockResolvedValue(0);
    now = Date.parse('2026-10-07T00:02:00.000Z');
    expect((await svc.processQueue()).completed).toBe(2);
  });

  it('лимит минут видео за сутки — тоже ждёт', async () => {
    process.env.TUTORIAL_DEMO_QUALITY_DAILY_VIDEO_MINUTES = '1';
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'today',
      createdAt: new Date(T0 - 1000),
      assetId: 'zz',
      videoUrl: 'x',
      trigger: 'assembly',
      rubricVersion: 'r',
      modelId: 'm',
      locale: 'ru',
      status: 'complete',
      uploadedAt: new Date(T0 - 1000),
      durationMs: 55_000,
    });
    await svc.enqueueAssembled('a1', BYTES);
    await svc.processQueue();
    const r = checks.rows.find((x) => x.id !== 'today')!;
    expect(r.status).toBe('pending');
    expect(r.error).toMatch(/лимит 1 мин/);
    expect(gemini.upload).not.toHaveBeenCalled();
  });

  it('журнал расходов недоступен — не тратим, пробуем через паузу', async () => {
    aiUsage.spentTodayForOperation.mockRejectedValue(new Error('db down'));
    await svc.enqueueAssembled('a1', BYTES);
    await svc.processQueue();
    expect(only()).toMatchObject({
      status: 'pending',
      nextAttemptAt: new Date(T0 + BACKOFF_BASE_MS),
    });
    expect(gemini.upload).not.toHaveBeenCalled();
  });
});

describe('кусок работы за тик', () => {
  it('не больше двух заданий за тик', async () => {
    for (const id of ['b1', 'b2', 'b3']) {
      assets.rows.push(
        asset({ id, blobUrl: `https://s/tutorial-videos/${id}.mp4` }),
      );
      await svc.enqueueAssembled(id, Buffer.from(id));
    }
    const res = await svc.processQueue();
    expect(res).toMatchObject({ processed: 2, completed: 2 });
    expect(checks.rows.filter((r) => r.status === 'pending')).toHaveLength(1);
  });

  it('бюджет тика исчерпан — новых заданий не берёт', async () => {
    await svc.enqueueAssembled('a1', BYTES);
    expect((await svc.processQueue({ budgetMs: 0 })).processed).toBe(0);
  });

  it('никогда не бросает', async () => {
    checks.findMany.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.processQueue()).resolves.toMatchObject({ processed: 0 });
  });
});

describe('версии и актуальность', () => {
  it('версия темпа: таймкоды шагов не угадываются, план — длительность версии', async () => {
    versions.rows.push({
      id: 'v1',
      assetId: 'a1',
      status: 'complete',
      blobUrl: 'https://s/tutorial-videos/versions/a1/v1.mp4',
      videoMs: 10_000,
    });
    await svc.enqueueByOperator('a1', 'op', 'v1');
    await svc.processQueue();
    expect(blob.downloadBuffer).toHaveBeenCalledWith(
      'tutorial-videos/versions/a1/v1.mp4',
    );
    expect(gemini.generate.mock.calls[0][0].prompt).toContain('step 1 [?s–?s]');
    expect(only().status).toBe('complete');
  });

  it('удалённая версия — error проверки, не вердикт', async () => {
    versions.rows.push({
      id: 'v1',
      assetId: 'a1',
      status: 'complete',
      blobUrl: 'https://s/tutorial-videos/versions/a1/v1.mp4',
      videoMs: 10_000,
    });
    await svc.enqueueByOperator('a1', 'op', 'v1');
    versions.rows = [];
    expect(await svc.processQueue()).toMatchObject({ errors: 1 });
    expect(only()).toMatchObject({ status: 'error', verdict: null });
  });

  it('сборка интерфейса старее текущей — stale_candidate в отчёте, вердикт не меняет', async () => {
    assets.rows.push(
      asset({
        id: 'fresh',
        captureBuild: 'build-2',
        capturedAt: new Date(T0 - 60_000),
      }),
    );
    await svc.enqueueAssembled('a1', BYTES);
    await svc.processQueue();
    expect((only().report as { freshness: string }).freshness).toBe(
      'stale_candidate',
    );
    expect(only().verdict).toBe('ok');
  });

  it('ссылка не из хранилища роликов — error', async () => {
    await svc.enqueueAssembled('a1', BYTES);
    checks.rows[0].videoUrl = 'https://evil.example/x.mp4';
    expect(await svc.processQueue()).toMatchObject({ errors: 1 });
    expect(blob.downloadBuffer).not.toHaveBeenCalled();
  });
});

describe('чтение для админки', () => {
  it('последняя проверка каждого ролика, без файлов провайдера и аренды', async () => {
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'c1',
      createdAt: new Date(T0 - 2000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'assembly',
      rubricVersion: 'r',
      modelId: 'm',
      locale: 'ru',
      status: 'complete',
      verdict: 'fail',
      providerFileName: 'files/secret',
      leaseOwner: 'x',
    });
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'c2',
      createdAt: new Date(T0 - 1000),
      assetId: 'a1',
      videoUrl: URL1,
      trigger: 'operator',
      rubricVersion: 'r',
      modelId: 'm',
      locale: 'ru',
      status: 'pending',
    });
    checks.rows.push({
      ...CHECK_DEFAULTS,
      id: 'c3',
      createdAt: new Date(T0 - 1000),
      assetId: 'b',
      videoUrl: 'u',
      trigger: 'operator',
      rubricVersion: 'r',
      modelId: 'm',
      locale: 'en',
      status: 'complete',
      verdict: 'warn',
    });
    const res = await svc.latestForAssets(['a1', 'b', 'a1', '']);
    expect(res.enabled).toBe(true);
    expect(Object.keys(res.checks).sort()).toEqual(['a1', 'b']);
    expect(res.checks.a1.id).toBe('c2');
    expect(res.checks.b.verdict).toBe('warn');
    const text = JSON.stringify(res);
    expect(text).not.toContain('files/secret');
    expect(text).not.toContain('leaseOwner');
    expect(text).not.toContain('videoUrl');
  });

  it('пустой список — без запроса', async () => {
    expect(await svc.latestForAssets([])).toEqual({
      enabled: true,
      checks: {},
    });
    expect(checks.findMany).not.toHaveBeenCalled();
  });
});

// ── база в памяти ────────────────────────────────────────────────────

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

function cmp(a: unknown, b: unknown): number {
  const va = a instanceof Date ? a.getTime() : (a as number | string);
  const vb = b instanceof Date ? b.getTime() : (b as number | string);
  if (va === vb) return 0;
  if (va === null || va === undefined) return -1;
  if (vb === null || vb === undefined) return 1;
  return va < vb ? -1 : 1;
}

function same(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return (
      a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
    );
  }
  return (a ?? null) === (b ?? null);
}

function matchField(value: unknown, cond: unknown): boolean {
  if (
    cond !== null &&
    typeof cond === 'object' &&
    !(cond instanceof Date) &&
    !Array.isArray(cond)
  ) {
    const c = cond as Record<string, unknown>;
    for (const [op, arg] of Object.entries(c)) {
      switch (op) {
        case 'in':
          if (!(arg as unknown[]).some((x) => same(value, x))) return false;
          break;
        case 'notIn':
          if ((arg as unknown[]).some((x) => same(value, x))) return false;
          break;
        case 'not':
          if (same(value, arg)) return false;
          break;
        case 'lt':
          if (value == null || cmp(value, arg) >= 0) return false;
          break;
        case 'lte':
          if (value == null || cmp(value, arg) > 0) return false;
          break;
        case 'gte':
          if (value == null || cmp(value, arg) < 0) return false;
          break;
        default:
          throw new Error(`fake prisma: оператор ${op} не поддержан`);
      }
    }
    return true;
  }
  return same(value, cond);
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, cond] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matches(row, w))) return false;
    } else if (key === 'AND') {
      if (!(cond as Where[]).every((w) => matches(row, w))) return false;
    } else if (!matchField(row[key], cond)) {
      return false;
    }
  }
  return true;
}

function applyData(row: Row, data: Row): Row {
  const next = { ...row };
  for (const [k, v] of Object.entries(data)) {
    if (
      v !== null &&
      typeof v === 'object' &&
      !(v instanceof Date) &&
      'increment' in (v as Row)
    ) {
      next[k] = ((next[k] as number) ?? 0) + ((v as Row).increment as number);
    } else {
      next[k] = v;
    }
  }
  return next;
}

function sorted(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const [[field, dir]] = Object.entries(orderBy as Row);
  return [...rows].sort(
    (a, b) => cmp(a[field], b[field]) * (dir === 'desc' ? -1 : 1),
  );
}

class FakeModel {
  rows: Row[] = [];
  private seq = 0;
  constructor(
    private readonly prefix: string,
    private readonly defaults: Row = {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(id: string): Row | undefined {
    return this.rows.find((r) => r.id === id);
  }

  findMany = jest.fn(
    async (args: { where?: Where; orderBy?: unknown; take?: number } = {}) => {
      const out = sorted(
        this.rows.filter((r) => matches(r, args.where)),
        args.orderBy,
      );
      return (args.take === undefined ? out : out.slice(0, args.take)).map(
        (r) => ({ ...r }),
      );
    },
  );

  findFirst = jest.fn(
    async (args: { where?: Where; orderBy?: unknown } = {}) => {
      const [first] = await this.findMany({ ...args, take: 1 });
      return first ?? null;
    },
  );

  findUnique = jest.fn(async (args: { where: Where }) => {
    const r = this.rows.find((x) => matches(x, args.where));
    return r ? { ...r } : null;
  });

  create = jest.fn(async (args: { data: Row }) => {
    const at = this.now();
    const row: Row = {
      id: `${this.prefix}${++this.seq}`,
      createdAt: new Date(at.getTime() + this.seq),
      updatedAt: at,
      ...this.defaults,
      ...args.data,
    };
    this.rows.push(row);
    return { ...row };
  });

  update = jest.fn(async (args: { where: Where; data: Row }) => {
    const i = this.rows.findIndex((r) => matches(r, args.where));
    if (i < 0) throw new Error('fake prisma: запись не найдена');
    this.rows[i] = applyData(this.rows[i], {
      ...args.data,
      updatedAt: this.now(),
    });
    return { ...this.rows[i] };
  });

  updateMany = jest.fn(async (args: { where: Where; data: Row }) => {
    let count = 0;
    this.rows = this.rows.map((r) => {
      if (!matches(r, args.where)) return r;
      count++;
      return applyData(r, { ...args.data, updatedAt: this.now() });
    });
    return { count };
  });

  aggregate = jest.fn(
    async (args: { where?: Where; _sum?: Record<string, boolean> }) => {
      const rows = this.rows.filter((r) => matches(r, args.where));
      const _sum: Record<string, number | null> = {};
      for (const k of Object.keys(args._sum ?? {})) {
        const vals = rows
          .map((r) => r[k])
          .filter((v): v is number => typeof v === 'number');
        _sum[k] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      }
      return { _sum };
    },
  );
}

/** Значения по умолчанию строки проверки — как в schema.prisma. */
const CHECK_DEFAULTS: Row = {
  versionId: null,
  requestedBy: null,
  contentSha: null,
  dedupeKey: null,
  reusedFromId: null,
  status: 'pending',
  phase: 'upload',
  attempts: 0,
  nextAttemptAt: null,
  leaseOwner: null,
  leaseUntil: null,
  providerFileName: null,
  providerFileUri: null,
  providerFileMime: null,
  uploadedAt: null,
  verdict: null,
  report: null,
  preflight: null,
  error: null,
  costMicroUsd: null,
  unpriced: false,
  tokenUsage: null,
  durationMs: null,
  theme: null,
  captureBuild: null,
  captureMode: null,
  checkedAt: null,
};
