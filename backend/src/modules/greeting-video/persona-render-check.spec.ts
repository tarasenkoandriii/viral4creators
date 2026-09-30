/**
 * Повторная проверка персоны у денег (CONTRACT5 п.14): режим, образ,
 * персона и голос персоны — по базе, а не по копии в снимке.
 */
import {
  PERSONA_NOT_USABLE_AT_RENDER,
  PERSONA_VOICE_GONE_AT_RENDER,
  personaRenderProblem,
} from './persona-render-check';
import {
  PERSONA_VOICE_ONLY_PERSONAL,
  PRESENTER_LOOK_NOT_FOUND,
} from '../../common/greeting-persona';

const PRESENTER = {
  lookId: 'l1',
  label: 'Я',
  url: 'https://blob/l1.png',
  pathname: 'x',
  variant: 'photo' as const,
};
const USABLE = {
  id: 'p1',
  livenessCheckedAt: new Date(),
  revokedAt: null,
  verifyResult: { status: 'ok' },
};

function db(
  over: {
    persona?: unknown;
    look?: unknown;
    voice?: unknown;
    personaVoiceIds?: string[];
  } = {},
) {
  return {
    persona: {
      findFirst: jest
        .fn()
        .mockResolvedValue('persona' in over ? over.persona : USABLE),
    },
    personaLook: {
      findFirst: jest
        .fn()
        .mockResolvedValue('look' in over ? over.look : { id: 'l1' }),
    },
    userVoice: {
      findFirst: jest.fn(
        async (args: {
          where: Record<string, unknown>;
        }): Promise<{ id: string } | null> => {
          // `isPersonaVoice` ищет по OR id/resembleVoiceId.
          if (args.where.OR) {
            const ids = (args.where.OR as Array<Record<string, string>>).map(
              (o) => o.id ?? o.resembleVoiceId,
            );
            return ids.some((id) => over.personaVoiceIds?.includes(id))
              ? { id: 'uv-p' }
              : null;
          }
          return 'voice' in over
            ? (over.voice as { id: string } | null)
            : { id: 'uv-p' };
        },
      ),
    },
  };
}

const session = (over: Record<string, unknown> = {}) =>
  ({
    userId: 'u1',
    greetingBriefSnapshot: { presenter: null, senderVoice: null },
    brandManifestSnapshot: undefined,
    ...over,
  }) as never;

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterAll(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

describe('personaRenderProblem', () => {
  it('без персоны — можно, база не читается', async () => {
    const d = db();
    await expect(personaRenderProblem(d, session())).resolves.toBeNull();
    expect(d.persona.findFirst).not.toHaveBeenCalled();
    await expect(personaRenderProblem(null, session())).resolves.toBeNull();
  });

  it('образ: всё на месте — можно; образ удалён — отказ', async () => {
    const s = session({
      greetingBriefSnapshot: { presenter: PRESENTER, senderVoice: null },
    });
    await expect(personaRenderProblem(db(), s)).resolves.toBeNull();
    await expect(personaRenderProblem(db({ look: null }), s)).resolves.toEqual({
      message: PRESENTER_LOOK_NOT_FOUND,
    });
  });

  it('образ ищется у ЭТОЙ персоны и среди не удалённых', async () => {
    const d = db();
    await personaRenderProblem(
      d,
      session({
        greetingBriefSnapshot: { presenter: PRESENTER, senderVoice: null },
      }),
    );
    expect(d.personaLook.findFirst).toHaveBeenCalledWith({
      where: { id: 'l1', deletedAt: null, personaId: 'p1' },
      select: { id: true },
    });
  });

  it.each([
    ['удалена', null],
    ['отозвана', { ...USABLE, revokedAt: new Date() }],
    ['не проверена', { ...USABLE, livenessCheckedAt: null }],
    [
      'с отказом',
      {
        ...USABLE,
        verifyResult: { status: 'refused', refusals: ['under-18'] },
      },
    ],
  ])('персона %s — отказ', async (_n, persona) => {
    await expect(
      personaRenderProblem(
        db({ persona }),
        session({
          greetingBriefSnapshot: { presenter: PRESENTER, senderVoice: null },
        }),
      ),
    ).resolves.toEqual({ message: PERSONA_NOT_USABLE_AT_RENDER });
  });

  it('режим выключен — отказ с кодом, в том числе для личного бренд-бука', async () => {
    process.env.PERSONA_ENABLED = 'false';
    await expect(
      personaRenderProblem(
        db(),
        session({ brandManifestSnapshot: { kind: 'PERSONAL' } }),
      ),
    ).resolves.toMatchObject({ code: 'PERSONA_DISABLED' });
  });

  it('голос персоны отправителем: удалён — отказ', async () => {
    const s = session({
      greetingBriefSnapshot: {
        presenter: null,
        senderVoice: {
          userVoiceId: 'uv-p',
          resembleVoiceId: 'r',
          label: 'Я',
          personaVoice: true,
        },
      },
    });
    await expect(personaRenderProblem(db(), s)).resolves.toBeNull();
    await expect(personaRenderProblem(db({ voice: null }), s)).resolves.toEqual(
      { message: PERSONA_VOICE_GONE_AT_RENDER },
    );
  });

  it('голос персоны в корпоративном бренд-буке (старая запись) — отказ', async () => {
    await expect(
      personaRenderProblem(
        db({ personaVoiceIds: ['rv-p'] }),
        session({
          brandManifestSnapshot: { kind: 'COMPANY', ttsVoiceId: 'rv-p' },
        }),
      ),
    ).resolves.toEqual({ message: PERSONA_VOICE_ONLY_PERSONAL });
  });

  it('личный бренд-бук с голосом персоны — нужна годная персона', async () => {
    const s = session({
      brandManifestSnapshot: { kind: 'PERSONAL', ttsVoiceId: 'rv-p' },
    });
    await expect(
      personaRenderProblem(db({ personaVoiceIds: ['rv-p'] }), s),
    ).resolves.toBeNull();
    await expect(
      personaRenderProblem(db({ personaVoiceIds: ['rv-p'], persona: null }), s),
    ).resolves.toEqual({ message: PERSONA_NOT_USABLE_AT_RENDER });
  });

  it('корпоративный бренд-бук с обычным голосом — можно', async () => {
    await expect(
      personaRenderProblem(
        db(),
        session({
          brandManifestSnapshot: { kind: 'COMPANY', ttsVoiceId: 'rv-plain' },
        }),
      ),
    ).resolves.toBeNull();
  });

  it('образ есть, а Prisma нет — отказ (проверить нечем)', async () => {
    await expect(
      personaRenderProblem(
        null,
        session({
          greetingBriefSnapshot: { presenter: PRESENTER, senderVoice: null },
        }),
      ),
    ).resolves.toEqual({ message: PERSONA_NOT_USABLE_AT_RENDER });
  });
});
