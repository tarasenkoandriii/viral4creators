/**
 * Метка Soniox «Админки» (заход 8): в acceptance: правило графа
 * §4.3-бис слой 2 запрещает коду «Сайта» импортировать «Админку».
 */
import { Logger } from '@nestjs/common';
import {
  FakeSoniox,
  fakeRecording,
} from '../../modules/assist-site-voice/testing/fake-soniox.testing';
import { AdminSonioxStt } from '../../modules/assist-admin-voice/admin-stt';

describe('AdminSonioxStt — метка своих объектов у Soniox', () => {
  afterEach(() => jest.restoreAllMocks());

  it('«Админка» тоже помечена меткой сайтов; 409 после ожидания — честный лог, без «срока хранения провайдера»', async () => {
    const fake = new FakeSoniox();
    const bodies: Array<{ path: string; method: string; body: unknown }> = [];
    const base = fake.fetch;
    const a = new AdminSonioxStt();
    a.env = { SONIOX_API_KEY: 'sx' };
    a.pollDelayMs = 0;
    a.cleanupGraceMs = 0;
    a.fetch = (async (url: string, init: RequestInit = {}) => {
      const method = (init.method ?? 'GET').toUpperCase();
      bodies.push({ path: String(url), method, body: init.body });
      if (method === 'DELETE' && String(url).includes('/transcriptions/')) {
        return { ok: false, status: 409 } as Response;
      }
      return base(url, init);
    }) as typeof fetch;
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await a.transcribe({
        audio: fakeRecording(),
        mimeType: 'audio/webm',
        languageHints: [],
      });
      const upload = bodies.find((b) => b.path.endsWith('/files'))!
        .body as FormData;
      expect(upload.get('client_reference_id')).toBe('v4c-sites:admin');
      expect((upload.get('file') as File).name).toBe('v4c-sites-admin');
      const created = bodies.find(
        (b) => b.method === 'POST' && b.path.endsWith('/transcriptions'),
      )!;
      expect(JSON.parse(String(created.body))).toMatchObject({
        client_reference_id: 'v4c-sites:admin',
      });
      const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('assist-retention');
      expect(text).not.toContain('до срока хранения провайдера');
    } finally {
      warn.mockRestore();
    }
  });
});
