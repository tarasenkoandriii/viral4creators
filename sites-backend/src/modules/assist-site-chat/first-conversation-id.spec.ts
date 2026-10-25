import { firstConversationId } from './first-conversation-id';
describe('first request identity', () => {
  it('is stable, opaque and separated by account, site, visitor and request', () => {
    const values = ['account', 'site', 'visitor', 'request'] as const;
    const id = firstConversationId(...values);
    expect(firstConversationId(...values)).toBe(id);
    expect(id).toMatch(/^c[a-f0-9]{40}$/);
    values.forEach((_, i) => {
      const changed = [...values] as string[];
      changed[i] += '-other';
      expect(
        firstConversationId(changed[0], changed[1], changed[2], changed[3]),
      ).not.toBe(id);
    });
  });
});
