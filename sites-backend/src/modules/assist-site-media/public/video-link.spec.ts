/**
 * Подписанная ссылка на ролик (Э6, §4.11): сайт и ролик — часть подписи,
 * срок — минуты, подделка и чужой ключ не проходят.
 */
import { signVideoLink, verifyVideoLink } from './video-link';

const KEY = Buffer.alloc(32, 7);
const NOW = 1_800_000_000;

describe('signVideoLink / verifyVideoLink', () => {
  const token = signVideoLink(KEY, {
    siteId: 'siteA',
    videoId: 'vid1',
    expUnix: NOW + 600,
  });

  it('своя ссылка в срок — сайт и ролик из подписи', () => {
    expect(verifyVideoLink(KEY, token, NOW)).toEqual({
      ok: true,
      siteId: 'siteA',
      videoId: 'vid1',
      expUnix: NOW + 600,
    });
  });

  it('просрочена — expired', () => {
    expect(verifyVideoLink(KEY, token, NOW + 600)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('подмена сайта, ролика или срока — signature', () => {
    const [v, , video, exp, sig] = token.split('.');
    for (const forged of [
      [v, 'siteB', video, exp, sig],
      [v, 'siteA', 'vid2', exp, sig],
      [v, 'siteA', video, String(NOW + 99999), sig],
    ]) {
      expect(verifyVideoLink(KEY, forged.join('.'), NOW).ok).toBe(false);
    }
    expect(verifyVideoLink(Buffer.alloc(32, 8), token, NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('мусор — malformed', () => {
    for (const t of [
      '',
      'v2.a.b.1.x',
      42,
      null,
      `${token}.x`,
      token.slice(1),
    ]) {
      expect(verifyVideoLink(KEY, t, NOW).ok).toBe(false);
    }
    expect(() =>
      signVideoLink(KEY, { siteId: 'a/b', videoId: 'v', expUnix: 1 }),
    ).toThrow();
  });
});
