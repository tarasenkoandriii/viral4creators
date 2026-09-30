/**
 * Проверка у денег — волна CONTRACT6 (G-B2): голос персоны на Hedra без
 * образа (п.3) и голос бренд-бука, удалённый или чужой (п.4).
 */
import {
  BRAND_VOICE_GONE_AT_RENDER,
  personaRenderProblem,
} from './persona-render-check';
import { PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE } from '../../common/greeting-persona';
import { RESEMBLE_PENDING_DELETE_PREFIX } from '../tts/resemble.service';

const USABLE = {
  id: 'p1',
  livenessCheckedAt: new Date(),
  revokedAt: null,
  verifyResult: { status: 'ok' },
};

type VoiceRow = { id: string; userId: string; personaId?: string | null };

/** База: строки голосов по `resembleVoiceId` и список ожидания удаления. */
function db(
  opts: {
    voices?: Record<string, VoiceRow[]>;
    pending?: string[];
    noPendingTable?: boolean;
  } = {},
) {
  const voices = opts.voices ?? {};
  return {
    persona: { findFirst: jest.fn().mockResolvedValue(USABLE) },
    personaLook: { findFirst: jest.fn().mockResolvedValue({ id: 'l1' }) },
    userVoice: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        const w = args.where;
        if (w.OR) {
          // `isPersonaVoice`: свой голос персоны по id/resembleVoiceId.
          const ids = (w.OR as Array<Record<string, string>>).map(
            (o) => o.id ?? o.resembleVoiceId,
          );
          const hit = ids
            .flatMap((id) => voices[id] ?? [])
            .find((v) => v.userId === w.userId && v.personaId);
          return hit ? { id: hit.id } : null;
        }
        if (typeof w.resembleVoiceId === 'string') {
          const rows = voices[w.resembleVoiceId] ?? [];
          const row = w.userId
            ? rows.find((v) => v.userId === w.userId)
            : rows[0];
          return row ? { id: row.id, userId: row.userId } : null;
        }
        // Голос отправителя по id — есть.
        return { id: String(w.id) };
      }),
    },
    ...(opts.noPendingTable
      ? {}
      : {
          platformSetting: {
            findUnique: jest.fn(async (args: { where: { key: string } }) =>
              (opts.pending ?? []).some(
                (id) => RESEMBLE_PENDING_DELETE_PREFIX + id === args.where.key,
              )
                ? { key: args.where.key }
                : null,
            ),
          },
        }),
  };
}

const brand = (over: Record<string, unknown> = {}) => ({
  kind: 'COMPANY',
  ttsVoiceId: 'rv1',
  ttsProvider: 'resemble',
  ...over,
});

const session = (over: Record<string, unknown> = {}) =>
  ({
    userId: 'u1',
    greetingBriefSnapshot: {
      presenter: null,
      senderVoice: null,
      resolvedPresenterProvider: 'grok',
    },
    brandManifestSnapshot: undefined,
    ...over,
  }) as never;

const OLD_FLAG = process.env.PERSONA_ENABLED;
beforeEach(() => {
  process.env.PERSONA_ENABLED = 'true';
});
afterEach(() => {
  process.env.PERSONA_ENABLED = OLD_FLAG;
});

describe('голос бренд-бука (CONTRACT6 п.4)', () => {
  const GONE = {
    code: 'GREETING_BRAND_VOICE_UNAVAILABLE',
    message: BRAND_VOICE_GONE_AT_RENDER,
  };

  it('свой клон жив — можно', async () => {
    const d = db({ voices: { rv1: [{ id: 'uv1', userId: 'u1' }] } });
    await expect(
      personaRenderProblem(d, session({ brandManifestSnapshot: brand() })),
    ).resolves.toBeNull();
  });

  it('клон ждёт удаления у Resemble — отказ, даже если строка ещё есть', async () => {
    const d = db({
      voices: { rv1: [{ id: 'uv1', userId: 'u1' }] },
      pending: ['rv1'],
    });
    await expect(
      personaRenderProblem(d, session({ brandManifestSnapshot: brand() })),
    ).resolves.toEqual(GONE);
  });

  it('клон другого пользователя — отказ', async () => {
    const d = db({ voices: { rv1: [{ id: 'uv9', userId: 'u9' }] } });
    await expect(
      personaRenderProblem(d, session({ brandManifestSnapshot: brand() })),
    ).resolves.toEqual(GONE);
  });

  it('голос каталога аккаунта (строки UserVoice нет, не в списке ожидания) — можно', async () => {
    const d = db();
    await expect(
      personaRenderProblem(d, session({ brandManifestSnapshot: brand() })),
    ).resolves.toBeNull();
  });

  it('другой провайдер — список Resemble не читается', async () => {
    const d = db({ pending: ['rv1'] });
    await expect(
      personaRenderProblem(
        d,
        session({
          brandManifestSnapshot: brand({ ttsProvider: 'elevenlabs' }),
        }),
      ),
    ).resolves.toBeNull();
    expect(d.platformSetting!.findUnique).not.toHaveBeenCalled();
  });

  it('проверить нечем (нет базы) — отказ, а не пропуск', async () => {
    await expect(
      personaRenderProblem(null, session({ brandManifestSnapshot: brand() })),
    ).resolves.toEqual(GONE);
  });

  it('и при выключенном режиме — голос озвучит ролик и без «Я в кадре»', async () => {
    process.env.PERSONA_ENABLED = 'false';
    const d = db({ pending: ['rv1'] });
    await expect(
      personaRenderProblem(d, session({ brandManifestSnapshot: brand() })),
    ).resolves.toEqual(GONE);
  });
});

describe('голос персоны на Hedra без образа (CONTRACT6 п.3)', () => {
  const personaVoice = {
    userVoiceId: 'uv-p',
    resembleVoiceId: 'rv-p',
    label: 'Я',
    personaVoice: true,
  };

  it('Hedra без образа — отказ с кодом', async () => {
    const problem = await personaRenderProblem(
      db(),
      session({
        greetingBriefSnapshot: {
          presenter: null,
          senderVoice: personaVoice,
          resolvedPresenterProvider: 'hedra',
        },
      }),
    );
    expect(problem).toEqual({
      code: 'GREETING_PERSONA_VOICE_NEEDS_PRESENTER',
      message: PERSONA_VOICE_NEEDS_PRESENTER_MESSAGE,
    });
  });

  it('Grok без образа — оставлено (лицо голосом не движется)', async () => {
    await expect(
      personaRenderProblem(
        db(),
        session({
          greetingBriefSnapshot: {
            presenter: null,
            senderVoice: personaVoice,
            resolvedPresenterProvider: 'grok',
          },
        }),
      ),
    ).resolves.toBeNull();
  });
});
