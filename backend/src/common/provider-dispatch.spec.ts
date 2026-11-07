import {
  dispatchOutcomeUnknown,
  guardProviderDispatch,
  ProviderDispatchUnknownError,
} from './provider-dispatch';

describe('provider dispatch outcome classification', () => {
  it.each([400, 401, 403, 404, 422, 429])(
    'explicit HTTP %s is a rejection',
    (status) => {
      expect(dispatchOutcomeUnknown({ status })).toBe(false);
      expect(dispatchOutcomeUnknown({ response: { status } })).toBe(false);
    },
  );
  it.each([408, 409, 499, 500, 502, 503, 504, 0, undefined])(
    'HTTP %s cannot prove a rejection',
    (status) => {
      expect(dispatchOutcomeUnknown({ status })).toBe(true);
    },
  );
  it('untyped errors are not guessed safe from message wording', () => {
    expect(
      dispatchOutcomeUnknown(new Error('invalid aspect ratio after timeout')),
    ).toBe(true);
  });
  it('sends once and exposes no raw provider details on uncertain outcome', async () => {
    const send = jest
      .fn()
      .mockRejectedValue(new Error('secret token/provider payload'));
    const error = await guardProviderDispatch(send).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderDispatchUnknownError);
    expect(send).toHaveBeenCalledTimes(1);
    expect(String(error)).not.toMatch(/secret|payload/);
  });
});
