/**
 * resolveGreetingConfig — ТЗ TZ-Greeting-Video-Project-Type.md §7 table:
 *
 *  LITE     → grok (forced), max 480p
 *  STANDARD → grok (forced), max 720p
 *  PREMIUM  → grok OR hedra (user's choice), max 1080p
 *
 * Pure function, no DI — see file doc-comment for why.
 */

import { ForbiddenException } from '@nestjs/common';
import {
  maxGreetingResolutionFor,
  resolveGreetingConfig,
} from './greeting-config';

describe('resolveGreetingConfig', () => {
  it('defaults to grok at the plan cap when nothing was requested', () => {
    expect(resolveGreetingConfig('LITE', {})).toEqual({
      presenterProvider: 'grok',
      resolution: '480p',
    });
    expect(resolveGreetingConfig('STANDARD', {})).toEqual({
      presenterProvider: 'grok',
      resolution: '720p',
    });
    // §3.2 doc-comment: default stays 'grok' even on PREMIUM, so the
    // pricier hedra path is never applied without an explicit choice.
    expect(resolveGreetingConfig('PREMIUM', {})).toEqual({
      presenterProvider: 'grok',
      resolution: '1080p',
    });
  });

  // Was: "LITE/STANDARD silently clamp a too-high resolution request down
  // to their cap". The implementation refuses instead, and deliberately so
  // (see the file doc-comment of greeting-config.ts, §5.3/§7: a silent
  // substitution is cheaper to build but deceives a user who explicitly
  // picked the more expensive option in the form). The adjacent hedra test
  // below already asserted that principle for the provider — this one was
  // simply left behind when it was extended to resolution.
  it('rejects a too-high resolution on LITE/STANDARD with 403 — does not silently clamp', () => {
    expect(() =>
      resolveGreetingConfig('LITE', { resolution: '1080p' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveGreetingConfig('STANDARD', { resolution: '1080p' }),
    ).toThrow(ForbiddenException);
    // The message must name the cap: the form has to tell the user what
    // they may pick, not just that they may not pick this.
    expect(() =>
      resolveGreetingConfig('LITE', { resolution: '1080p' }),
    ).toThrow(/480p/);
  });

  it('a resolution AT the cap is accepted, not rejected', () => {
    expect(
      resolveGreetingConfig('STANDARD', { resolution: '720p' }).resolution,
    ).toBe('720p');
  });

  it('rejects hedra on LITE/STANDARD with 403 — does not silently fall back to grok', () => {
    expect(() =>
      resolveGreetingConfig('LITE', { presenterProvider: 'hedra' }),
    ).toThrow(ForbiddenException);
    expect(() =>
      resolveGreetingConfig('STANDARD', { presenterProvider: 'hedra' }),
    ).toThrow(ForbiddenException);
  });

  it('PREMIUM may explicitly choose hedra and 1080p together', () => {
    expect(
      resolveGreetingConfig('PREMIUM', {
        presenterProvider: 'hedra',
        resolution: '1080p',
      }),
    ).toEqual({ presenterProvider: 'hedra', resolution: '1080p' });
  });

  it('maxGreetingResolutionFor matches the §7 table', () => {
    expect(maxGreetingResolutionFor('LITE')).toBe('480p');
    expect(maxGreetingResolutionFor('STANDARD')).toBe('720p');
    expect(maxGreetingResolutionFor('PREMIUM')).toBe('1080p');
  });
});
