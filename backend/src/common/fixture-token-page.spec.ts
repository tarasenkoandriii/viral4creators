import {
  attachFixtureToken,
  carriesFixtureToken,
  fixtureApiOrigin,
  FixtureTokenRequest,
} from './fixture-token-page';

describe('fixtureApiOrigin', () => {
  it('берёт origin из API_PUBLIC_URL с путём /api', () => {
    expect(
      fixtureApiOrigin({ API_PUBLIC_URL: 'https://api.example.com/api/' }),
    ).toBe('https://api.example.com');
  });

  it('нет адреса, мусор или чужая схема — null (fail-closed)', () => {
    expect(fixtureApiOrigin({})).toBeNull();
    expect(fixtureApiOrigin({ API_PUBLIC_URL: '   ' })).toBeNull();
    expect(fixtureApiOrigin({ API_PUBLIC_URL: 'api.example.com' })).toBeNull();
    expect(
      fixtureApiOrigin({ API_PUBLIC_URL: 'ftp://api.example.com' }),
    ).toBeNull();
  });
});

describe('carriesFixtureToken', () => {
  const api = 'https://api.example.com';

  it('только тот же origin, буква в букву', () => {
    expect(carriesFixtureToken('https://api.example.com/api/me', api)).toBe(
      true,
    );
    // Похожие, но чужие адреса — классика обхода сравнения по префиксу.
    expect(
      carriesFixtureToken('https://api.example.com.evil.io/api/me', api),
    ).toBe(false);
    expect(carriesFixtureToken('http://api.example.com/api/me', api)).toBe(
      false,
    );
    expect(carriesFixtureToken('https://api.example.com:8443/api', api)).toBe(
      false,
    );
    expect(carriesFixtureToken('https://fonts.gstatic.com/x.woff2', api)).toBe(
      false,
    );
    expect(carriesFixtureToken('data:image/png;base64,AAAA', api)).toBe(false);
  });
});

describe('attachFixtureToken', () => {
  function harness() {
    let handler: ((r: FixtureTokenRequest) => void) | undefined;
    const page = {
      setRequestInterception: jest.fn().mockResolvedValue(undefined),
      on: jest.fn((_e: 'request', h: (r: FixtureTokenRequest) => void) => {
        handler = h;
      }),
    };
    const send = (
      url: string,
      headers: Record<string, string> = {},
      handled = false,
    ) => {
      const cont = jest.fn().mockResolvedValue(undefined);
      handler!({
        url: () => url,
        headers: () => headers,
        isInterceptResolutionHandled: () => handled,
        continue: cont,
      });
      return cont;
    };
    return { page, send };
  }

  it('включает перехват до навигации и несёт токен только на API', async () => {
    const { page, send } = harness();
    await attachFixtureToken(page, 'sekret', 'https://api.example.com');
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);

    expect(send('https://api.example.com/api/me').mock.calls[0][0]).toEqual({
      headers: { 'x-fixture-token': 'sekret' },
    });
    expect(
      send('https://telegram.org/js/telegram-web-app.js').mock.calls[0][0],
    ).toEqual({ headers: {} });
  });

  it('снимает токен, выставленный кем-то ещё, с чужого запроса', async () => {
    const { page, send } = harness();
    await attachFixtureToken(page, 'sekret', 'https://api.example.com');
    const cont = send('https://fonts.googleapis.com/css2', {
      'x-fixture-token': 'sekret',
      accept: 'text/css',
    });
    expect(cont.mock.calls[0][0]).toEqual({ headers: { accept: 'text/css' } });
  });

  it('уже разрешённый запрос не трогает — второй continue бросил бы', async () => {
    const { page, send } = harness();
    await attachFixtureToken(page, 'sekret', 'https://api.example.com');
    const cont = send('https://api.example.com/api/me', {}, true);
    expect(cont).not.toHaveBeenCalled();
  });

  it('отказ continue (страница закрылась) не всплывает наружу', async () => {
    const { page } = harness();
    await attachFixtureToken(page, 'sekret', 'https://api.example.com');
    const handler = page.on.mock.calls[0][1];
    expect(() =>
      handler({
        url: () => 'https://api.example.com/api/me',
        headers: () => ({}),
        continue: jest.fn().mockRejectedValue(new Error('Target closed')),
      }),
    ).not.toThrow();
  });

  describe('blockMedia (счёт Blob, 01.10.2026)', () => {
    function mediaReq(type: string) {
      const cont = jest.fn().mockResolvedValue(undefined);
      const abort = jest.fn().mockResolvedValue(undefined);
      return {
        req: {
          url: () => 'https://x.public.blob.vercel-storage.com/v.mp4',
          headers: () => ({}),
          resourceType: () => type,
          continue: cont,
          abort,
        },
        cont,
        abort,
      };
    }

    it('с blockMedia медиа обрывается, остальное идёт как раньше', async () => {
      const { page } = harness();
      await attachFixtureToken(page, 's', 'https://api.example.com', {
        blockMedia: true,
      });
      const handler = page.on.mock.calls[0][1];
      const video = mediaReq('media');
      handler(video.req);
      expect(video.abort).toHaveBeenCalled();
      expect(video.cont).not.toHaveBeenCalled();
      const img = mediaReq('image');
      handler(img.req);
      expect(img.abort).not.toHaveBeenCalled();
      expect(img.cont).toHaveBeenCalled();
    });

    it('без blockMedia медиа качается (кадры лендинга, обучалка)', async () => {
      const { page } = harness();
      await attachFixtureToken(page, 's', 'https://api.example.com');
      const handler = page.on.mock.calls[0][1];
      const video = mediaReq('media');
      handler(video.req);
      expect(video.abort).not.toHaveBeenCalled();
      expect(video.cont).toHaveBeenCalled();
    });

    it('отказ abort не всплывает наружу', async () => {
      const { page } = harness();
      await attachFixtureToken(page, 's', 'https://api.example.com', {
        blockMedia: true,
      });
      const handler = page.on.mock.calls[0][1];
      const video = mediaReq('media');
      video.abort.mockRejectedValue(new Error('closed'));
      expect(() => handler(video.req)).not.toThrow();
    });
  });
});
