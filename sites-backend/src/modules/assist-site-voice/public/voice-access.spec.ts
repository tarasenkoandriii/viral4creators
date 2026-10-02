import { voiceAccess, type VoiceAccessInput } from './voice-access';

const on: VoiceAccessInput = {
  platformEnabled: true,
  providerConfigured: true,
  planId: 'business',
  siteActive: true,
  voiceConfig: { schema: 1, input: true, output: false, voiceId: 'Maya' },
  capOverrideMicroUsd: null,
};

describe('доступность голоса (Э5, §4.10)', () => {
  it('всё включено — микрофон по настройке, голос владельца, потолок тарифа', () => {
    expect(voiceAccess(on)).toMatchObject({
      input: true,
      output: false,
      voiceId: 'Maya',
      capMicroUsd: 1_500_000,
      reason: null,
    });
  });

  it.each([
    ['platform_off', { platformEnabled: false }],
    ['no_provider', { providerConfigured: false }],
    ['plan', { planId: 'start' }],
    ['plan', { planId: 'trial' }],
    ['plan', { planId: null }],
    ['site_off', { siteActive: false }],
    [
      'owner_off',
      {
        voiceConfig: { schema: 1, input: false, output: false, voiceId: null },
      },
    ],
    ['owner_off', { voiceConfig: 'мусор' }],
  ] as const)('%s — голос выключен целиком', (reason, patch) => {
    const a = voiceAccess({ ...on, ...(patch as Partial<VoiceAccessInput>) });
    expect(a).toMatchObject({ input: false, output: false, reason });
  });
});
