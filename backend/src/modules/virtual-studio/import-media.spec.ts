import { importedImageType, importedWavSeconds } from './import-media';

function wav(seconds = 1) {
  const b = Buffer.alloc(44 + 48000 * 2 * seconds);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(48000, 24);
  b.writeUInt32LE(96000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
describe('approved studio imports', () => {
  it('measures actual PCM data and preserves six-second approved source', () => {
    expect(importedWavSeconds(wav(6))).toBe(6);
  });
  it('rejects truncated media', () => {
    expect(() => importedWavSeconds(wav().subarray(0, 100))).toThrow();
  });
  it('rejects compressed or float WAV', () => {
    const b = wav();
    b.writeUInt16LE(3, 20);
    expect(() => importedWavSeconds(b)).toThrow();
  });
  it('rejects lying sample rate', () => {
    const b = wav();
    b.writeUInt32LE(1, 28);
    expect(() => importedWavSeconds(b)).toThrow();
  });
  it('rejects clips longer than thirty seconds', () => {
    expect(() => importedWavSeconds(wav(31))).toThrow();
  });
  it('rejects non-image bytes despite image extension', () => {
    expect(() => importedImageType(Buffer.from('not an image'))).toThrow();
  });
});

import {
  VirtualStudioService,
  STUDIO_QUALITY_PROMPT,
} from './virtual-studio.service';

describe('studio quality feedback', () => {
  const fetchBefore = global.fetch;
  afterEach(() => {
    global.fetch = fetchBefore;
  });

  function setup() {
    const generateContent = jest
      .fn()
      .mockResolvedValue({ text: 'WARN: проверить липсинк' });
    const recordGemini = jest.fn();
    const deleteFile = jest.fn().mockResolvedValue(undefined);
    global.fetch = jest.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        headers: { 'content-type': 'video/mp4' },
      }),
    );
    const service = Object.assign(
      Object.create(VirtualStudioService.prototype),
      {
        genai: { models: { generateContent } },
        geminiFiles: {
          uploadAndWaitActive: jest.fn().mockResolvedValue({
            uri: 'gemini://test',
            mimeType: 'video/mp4',
            name: 'test',
          }),
          deleteFile,
        },
        aiUsage: { recordGemini },
        settings: { get: jest.fn().mockResolvedValue('gemini-4-argon') },
      },
    ) as {
      assessVideo(
        url: string,
        purpose?: 'content' | 'quality',
      ): Promise<string>;
    };
    return { service, generateContent, recordGemini, deleteFile };
  }

  it('uses quality rubric and selected model, records actual model and cleans uploaded media', async () => {
    const t = setup();
    const result = await t.service.assessVideo(
      'https://example.test/own.mp4',
      'quality',
    );
    expect(t.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-4-argon',
        contents: expect.arrayContaining([{ text: STUDIO_QUALITY_PROMPT }]),
      }),
    );
    expect(t.recordGemini).toHaveBeenCalledWith(expect.anything(), {
      operation: 'virtual-studio-analysis',
      model: 'gemini-4-argon',
    });
    expect(result).toContain('Модель: gemini-4-argon');
    expect(
      t.generateContent.mock.calls[0][0].contents[0].videoMetadata,
    ).toEqual({ fps: 10 });
    expect(t.deleteFile).toHaveBeenCalledWith('test');
  });

  it('preserves content analysis when purpose is omitted', async () => {
    const t = setup();
    await t.service.assessVideo('https://example.test/own.mp4');
    expect(t.generateContent.mock.calls[0][0].contents[1].text).not.toBe(
      STUDIO_QUALITY_PROMPT,
    );
  });

  it('removes uploaded media even when Gemini fails, without inventing a quality result', async () => {
    const t = setup();
    t.generateContent.mockRejectedValue(new Error('unavailable'));
    await expect(
      t.service.assessVideo('https://example.test/own.mp4', 'quality'),
    ).rejects.toThrow('unavailable');
    expect(t.deleteFile).toHaveBeenCalledWith('test');
    expect(t.recordGemini).not.toHaveBeenCalled();
  });
});

describe('Greeting profile in Tutorial studio', () => {
  it('uses server-owned performance instructions and existing voice, rejects Grok before payment', async () => {
    const submit = jest.fn().mockResolvedValue({ jobId: 'job' });
    const create = jest.fn().mockImplementation(({ data }) => data);
    const service = Object.assign(
      Object.create(VirtualStudioService.prototype),
      {
        getStudioOrThrow: jest
          .fn()
          .mockResolvedValue({ selectedVariantId: 'portrait' }),
        getHedraEnabled: jest.fn().mockResolvedValue(true),
        prisma: {
          virtualStudioVariant: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ id: 'portrait', imageUrl: 'portrait.jpg' }),
          },
          virtualStudioFragment: {
            findFirst: jest
              .fn()
              .mockResolvedValue({ resultUrl: 'approved-nova.mp3' }),
            create,
          },
        },
        hedra: { configured: () => true, submit },
      },
    ) as VirtualStudioService;
    await service.createVideoFragment('studio', {
      provider: 'hedra',
      prompt: 'Do not speak',
      performanceProfile: 'greeting-tutorial-v1',
      voiceFragmentId: 'voice',
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          'supplied audio as the sole timing reference',
        ),
        audioUrl: 'approved-nova.mp3',
      }),
    );
    expect(submit.mock.calls[0][0].prompt).not.toContain('Do not speak');
    expect(create.mock.calls[0][0].data.text).toBe(
      submit.mock.calls[0][0].prompt,
    );
    await expect(
      service.createVideoFragment('studio', {
        provider: 'grok',
        prompt: '',
        performanceProfile: 'greeting-tutorial-v1',
      }),
    ).rejects.toThrow('только с Hedra');
    expect(submit).toHaveBeenCalledTimes(1);
  });
  it('cleans speech like Greeting and preserves explicit Ukrainian and selected Nova', async () => {
    const synthesize = jest.fn().mockResolvedValue({
      ok: true,
      audio: Buffer.from('audio'),
      mimeType: 'audio/mpeg',
      characters: 20,
    });
    const service = Object.assign(
      Object.create(VirtualStudioService.prototype),
      {
        getStudioOrThrow: jest.fn(),
        tts: {
          resolveByKey: () => ({
            providerKey: 'resemble',
            configured: () => true,
            synthesize,
          }),
        },
        aiUsage: { record: jest.fn() },
        blob: {
          uploadBuffer: jest.fn().mockResolvedValue({ url: 'nova.mp3' }),
        },
        prisma: {
          virtualStudioFragment: {
            create: jest.fn().mockImplementation(({ data }) => data),
          },
        },
      },
    ) as VirtualStudioService;
    const result = await service.createVoiceFragment('studio', {
      provider: 'resemble',
      voiceId: 'a9fc5a41',
      language: 'uk',
      text: 'Scene 1 (0:00–0:03): Вітаю! Зараз покажу, як надіслати заявку.',
    });
    expect(synthesize).toHaveBeenCalledWith({
      text: 'Вітаю! Зараз покажу, як надіслати заявку.',
      language: 'uk',
      voiceId: 'a9fc5a41',
    });
    expect(result.text).toBe('Вітаю! Зараз покажу, як надіслати заявку.');
  });
});

import { tutorialPreamblePromptV2 } from '../../common/presenter-performance';
import * as mp4Probe from '../tutorial-runner/mp4-probe';
describe('measured preamble delivery', () => {
  afterEach(() => jest.restoreAllMocks());
  it('locks the v2 request, preserves the chosen Nova audio, and rejects incompatible settings before payment', async () => {
    const submit = jest.fn().mockResolvedValue({
      jobId: 'trial',
      receipt: { model: 'hedra-character-3' },
    });
    const create = jest.fn(async ({ data }) => data);
    const service = Object.assign(
      Object.create(VirtualStudioService.prototype),
      {
        getStudioOrThrow: jest
          .fn()
          .mockResolvedValue({ selectedVariantId: 'portrait' }),
        getHedraEnabled: jest.fn().mockResolvedValue(true),
        prisma: {
          virtualStudioVariant: {
            findFirst: jest.fn().mockResolvedValue({
              id: 'portrait',
              imageUrl: 'same-portrait.jpg',
            }),
          },
          virtualStudioFragment: {
            findFirst: jest.fn().mockResolvedValue({
              resultUrl: 'same-nova.mp3',
              voiceId: 'a9fc5a41',
            }),
            create,
          },
        },
        hedra: { configured: () => true, submit },
      },
    ) as VirtualStudioService;
    await service.createVideoFragment('studio', {
      provider: 'hedra',
      performanceProfile: 'tutorial-preamble-v2',
      prompt: '',
      voiceFragmentId: 'voice',
    });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'hedra-character-3',
        prompt: tutorialPreamblePromptV2(),
        startImage: 'same-portrait.jpg',
        audioUrl: 'same-nova.mp3',
        aspectRatio: '9:16',
        resolution: '720p',
        maxAudioSeconds: 10,
        singleAttempt: true,
        captureReceipt: true,
      }),
    );
    expect(create.mock.calls[0][0].data.durationSec).toBeNull();
    expect(JSON.parse(create.mock.calls[0][0].data.resultText)).toMatchObject({
      voiceId: 'a9fc5a41',
      artisticStatus: 'unreviewed',
    });
    await expect(
      service.createVideoFragment('studio', {
        provider: 'hedra',
        performanceProfile: 'tutorial-preamble-v2',
        prompt: '',
        resolution: '1080p',
      }),
    ).rejects.toThrow('фиксирует');
    expect(submit).toHaveBeenCalledTimes(1);
    expect(tutorialPreamblePromptV2()).not.toContain('warm wish');
  });
  function finalizer(probe: ReturnType<typeof mp4Probe.probeMp4>) {
    jest.spyOn(mp4Probe, 'probeMp4').mockReturnValue(probe);
    const record = jest.fn();
    const update = jest.fn(async ({ data }) => data);
    const service = Object.assign(
      Object.create(VirtualStudioService.prototype),
      {
        download: jest.fn().mockResolvedValue(Buffer.from('output')),
        blob: {
          uploadBuffer: jest.fn().mockResolvedValue({ url: 'result.mp4' }),
        },
        prisma: {
          virtualStudioFragment: {
            findUniqueOrThrow: jest.fn().mockResolvedValue({
              provider: 'hedra',
              durationSec: 12,
              resultText: JSON.stringify({
                schema: 'hedra-request-v1',
                sourceAudio: { sha256: 'unchanged' },
              }),
            }),
            update,
          },
        },
        aiUsage: { record },
      },
    ) as unknown as {
      finalizeVideo(id: string, url: string): Promise<unknown>;
    };
    return { service, record, update };
  }
  it('stores and accounts measured output duration instead of the 12-second form default', async () => {
    const probe = {
      durationSeconds: 8.76,
      tracks: [{ kind: 'video' }, { kind: 'audio' }],
    } as unknown as NonNullable<ReturnType<typeof mp4Probe.probeMp4>>;
    const w = finalizer(probe);
    await w.service.finalizeVideo('trial', 'output');
    expect(w.record).toHaveBeenCalledWith(
      expect.objectContaining({ seconds: 9 }),
    );
    expect(w.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'complete', durationSec: 9 }),
      }),
    );
    expect(JSON.parse(w.update.mock.calls[0][0].data.resultText)).toMatchObject(
      {
        sourceAudio: { sha256: 'unchanged' },
        output: { durationMs: 8760 },
        artisticStatus: 'unreviewed',
      },
    );
  });
  it('does not label a broken provider MP4 complete', async () => {
    const w = finalizer(null);
    await w.service.finalizeVideo('trial', 'output');
    expect(w.record).not.toHaveBeenCalled();
    expect(w.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });
});
