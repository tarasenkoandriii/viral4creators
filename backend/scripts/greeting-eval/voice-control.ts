/** TTS → реальные STT и K3 → ожидаемое действие; безопасная память вместо клиентской БД. */
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import { VOICE_CONTROL_SET } from './voice-control-set';
import { encodeWav, framed, noisyFramed, RATE } from './audio';
import { Budget } from './runner';
import { estimateCost } from '../../src/common/ai-pricing';
import type { VoiceUnderstandResult } from '../../src/common/greeting-voice-intent';
export function matchesControl(
  result: VoiceUnderstandResult,
  expected: Record<string, unknown>,
): boolean {
  const i = result.intent;
  if (result.status !== 'ok' || !i || i.kind !== expected.kind) return false;
  if ('to' in expected && (!('to' in i) || i.to !== expected.to)) return false;
  if (
    'command' in expected &&
    (!('command' in i) || i.command !== expected.command)
  )
    return false;
  if (
    'target' in expected &&
    (i.kind !== 'fill' ||
      !i.fields.some(
        (f) => f.target === expected.target && f.value === expected.value,
      ))
  )
    return false;
  return true;
}
export async function main(argv: string[]): Promise<number> {
  const apply = argv.includes('--apply');
  const outArg = argv.find((a) => a.startsWith('--out='));
  const capArg = argv.find((a) => a.startsWith('--max-usd='));
  for (const arg of argv)
    if (
      arg !== '--apply' &&
      !arg.startsWith('--out=') &&
      !arg.startsWith('--max-usd=')
    )
      throw new Error('Неизвестный флаг: ' + arg);
  const cap = capArg ? Number(capArg.slice(10)) : 2;
  if (!Number.isFinite(cap) || cap <= 0 || cap > 2)
    throw new Error('Потолок должен быть >0 и <= $2.');
  const out = resolve(
    outArg?.slice(6) || join(process.cwd(), 'voice-control-eval'),
  );
  console.log(
    `${VOICE_CONTROL_SET.length} команд × чистый звук/шум SNR 10 = ${VOICE_CONTROL_SET.length * 2} семантические проверки + тишина. Потолок $${cap}. ${apply ? 'Живой режим' : 'Сухой режим, без платных вызовов'}`,
  );
  if (!apply) return 0;
  const valid = (key: string | undefined) =>
    !!key?.trim() && !key.includes('[SENSITIVE]');
  if (
    !valid(process.env.SONIOX_API_KEY) ||
    !valid(process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY)
  )
    throw new Error(
      'Нужны доступные SONIOX_API_KEY и GEMINI_API_KEY; защищённые placeholders не являются ключами.',
    );
  const { liveProviders, geminiMicro, keyStatus } = await import('./providers');
  if (!keyStatus().ffmpeg)
    throw new Error('Нужен ffmpeg для синтезированного аудио.');
  const { GreetingVoiceUnderstandService } =
    await import('../../src/modules/voice/greeting-voice-understand.service');
  const budget = new Budget(Math.round(cap * 1e6));
  let telemetry:
    | import('../../src/modules/soniox-observability/soniox-observability.service').SonioxObservability
    | undefined;
  let telemetryDb:
    import('../../src/prisma/prisma.service').PrismaService | undefined;
  if (process.env.DATABASE_URL) {
    const { PrismaService } = await import('../../src/prisma/prisma.service');
    const { SonioxObservability, sonioxContext } =
      await import('../../src/modules/soniox-observability/soniox-observability.service');
    telemetryDb = new PrismaService();
    telemetry = new SonioxObservability(telemetryDb);
    sonioxContext.enterWith({
      source: 'qa/voice-control-synthetic',
      actorRole: 'qa',
      actorId: null,
      accountId: null,
      siteId: null,
    });
  }
  const providers = await liveProviders(telemetry);
  let recognized: Record<string, unknown> = {};
  const brief = {
    occasion: 'BIRTHDAY',
    scriptLanguage: 'ru',
    recipientName: 'Марина',
    senderName: 'Тарас',
    tone: 'WARM',
    resolution: '720p',
    presenterProvider: 'grok',
    personalMessage: null,
    occasionDate: null,
  };
  const guard = async () => {
    if (!budget.allows(30_000)) throw new Error('VOICE_EVAL_BUDGET');
  };
  const service = new GreetingVoiceUnderstandService(
    { userVoice: { findMany: async () => [] } } as never,
    {
      getSession: async () => ({
        sessionId: 'synthetic',
        userId: 'synthetic',
        locale: 'ru',
        greetingBriefSnapshot: brief,
        generationPrompt: { finalText: 'test' },
      }),
    } as never,
    { deleteBlob: async () => true } as never,
    { recognizeRecording: async () => recognized } as never,
    { assertCanSpendSession: guard, planOfUser: async () => 'LITE' } as never,
    { assertCanSpendVoice: guard } as never,
    {
      recordGemini: async (r: unknown) => budget.add(geminiMicro(r as never)),
    } as never,
    {
      get: async () => null,
      listPresetVoicesQuick: async () => [],
      listSonioxVoicesQuick: async () => [],
    } as never,
    { view: async () => null } as never,
    { view: async () => null } as never,
    { view: async () => null } as never,
    { get: async () => null } as never,
    { available: async () => true } as never,
    { forget: async () => undefined } as never,
  );
  const rows: unknown[] = [];
  let failures = 0,
    stopped = false;
  try {
    for (const c of VOICE_CONTROL_SET) {
      await guard();
      const synth = await providers.synthesize(c.text, c.lang, 'Maya');
      budget.add(synth.micro);
      for (const snr of [null, 10]) {
        await guard();
        const pcm =
          snr === null
            ? framed(synth.pcm)
            : noisyFramed(synth.pcm, 'pink', 10, 10);
        const stt = await providers.recognize('soniox', encodeWav(pcm), {
          hints: c.lang === 'ru' ? ['ru', 'uk'] : ['uk', 'ru'],
          names: ['Марина', 'Тарас'],
          strict: false,
        });
        budget.add(stt.micro);
        recognized = {
          status: stt.text ? 'ok' : 'not-heard',
          text: stt.text,
          language: stt.language ?? null,
          scriptMismatch: false,
          hints: ['ru', 'uk'],
          speechConfidence: stt.speechConfidence ?? null,
        };
        const result = await service.understandForSession(
          'synthetic',
          {
            pathname: 'sessions/synthetic/voice-eval.wav',
            screen: { step: c.kind === 'fill' ? 'brief' : 'script' },
            ...('pending' in c
              ? {
                  pending: {
                    kind: 'fill',
                    fields: [
                      { target: 'greeting-field-recipient', value: 'Марина' },
                    ],
                  },
                }
              : {}),
          } as never,
          c.lang,
        );
        const passed = matchesControl(result, c);
        if (!passed) failures++;
        rows.push({
          id: c.id,
          snr,
          passed,
          transcript: stt.text,
          speechConfidence: stt.speechConfidence ?? null,
          intent: result.intent,
          status: result.status,
        });
        console.log(c.id, snr ?? 'clean', passed ? 'PASS' : 'FAIL');
      }
    }
    await guard();
    const stt = await providers.recognize(
      'soniox',
      encodeWav(new Float32Array(RATE * 2)),
      { hints: ['ru', 'uk'], names: [], strict: false },
    );
    budget.add(stt.micro);
    const passed = !stt.text;
    rows.push({ id: 'silence', passed });
    if (!passed) failures++;
  } catch (e) {
    if (e instanceof Error && e.message === 'VOICE_EVAL_BUDGET') stopped = true;
    else {
      rows.push({ error: e instanceof Error ? e.message : 'upstream failed' });
      failures++;
    }
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(
    join(out, 'summary.json'),
    JSON.stringify(
      {
        rows,
        failures,
        stopped,
        spentUsd: budget.spent / 1e6,
        synthetic: true,
        clientSessionMutations: false,
        telemetryWrites: !!telemetry,
      },
      null,
      2,
    ),
  );
  console.log(
    `Отчёт: ${out}; расход по прайсу проекта $${(budget.spent / 1e6).toFixed(4)}. Синтетические голоса не заменяют проверку WebView.`,
  );
  await telemetryDb?.$disconnect();
  return stopped ? 3 : failures ? 1 : 0;
}
if (require.main === module)
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : 'failed');
      process.exitCode = 2;
    });
