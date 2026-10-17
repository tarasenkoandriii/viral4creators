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
