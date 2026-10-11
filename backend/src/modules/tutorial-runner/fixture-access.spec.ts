import { checkFixtureAccess } from './fixture-access';

describe('checkFixtureAccess', () => {
  it('uses only the API origin, refuses redirects and limits waiting', async () => {
    const request = jest.fn().mockResolvedValue(new Response('{}'));
    await checkFixtureAccess('https://api.example.com', 'secret', request);
    expect(request).toHaveBeenCalledWith(
      new URL('https://api.example.com/api/sessions/fixture-tutorial-session'),
      expect.objectContaining({
        headers: { 'x-fixture-token': 'secret' },
        redirect: 'error',
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it.each([401, 403, 404, 500])(
    'reports HTTP %i without the body or secret',
    async (status) => {
      const request = jest
        .fn()
        .mockResolvedValue(new Response('private secret', { status }));
      await expect(
        checkFixtureAccess('https://api.example.com', 'secret', request),
      ).rejects.toThrow(`Tutorial fixture API HTTP ${status}`);
    },
  );
});
