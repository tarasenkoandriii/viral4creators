/**
 * Т-1, уровень `transcript-live` (заход 9; TODO Э6-бис-хвост (4)): ЖИВАЯ
 * модель плана вместо фикстуры стенда — тот же промпт и тот же строгий
 * разбор, что у сервера (`assist-ui-core/plan-prompt.ts`: `buildPlanPrompt`,
 * `parseModelPlan`), те же параметры вызова, что `SiteUiPlanService`
 * (JSON-ответ, temperature 0, модель `GEMINI_MODEL` или умолчание сервера).
 * Проверки кодом (`checkPlan`) после модели — как всегда, в моке стенда.
 *
 * Включается ТОЛЬКО `T1_LIVE_MODEL=1` и ключом `GEMINI_API_KEY`
 * (или `GOOGLE_GEMINI_API_KEY`): прогон — у владельца (П), в CI и песочнице
 * ключа нет (`scripts/t1/run.mjs transcript-live` без ключа — понятный
 * отказ, код 2). Ключ — только в заголовке запроса, не в адресе и не в логе.
 */
import * as promptNs from '../../../sites-backend/src/modules/assist-ui-core/plan-prompt';
import type { RawStep } from '../../../sites-backend/src/modules/assist-ui-core/plan-checks';
import type { UiSnapshot } from '../../../sites-backend/src/modules/assist-ui-core/types';

const cjs = <T>(ns: T): T => (ns as T & { default?: T }).default ?? ns;
const { buildPlanPrompt, parseModelPlan } = cjs(promptNs);

/** Модель плана сервера по умолчанию (`shared/gemini-model.ts`). */
export const LIVE_DEFAULT_MODEL = 'gemini-3.6-flash';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';

export function liveKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.GEMINI_API_KEY || env.GOOGLE_GEMINI_API_KEY || null;
}

export function liveModelOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.T1_LIVE_MODEL === '1' && !!liveKey(env);
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * План живой моделью: шаги (до проверок кодом), `not_command` или null
 * (сбой провайдера/мусор — план не строится, как `upstream` сервера).
 */
export async function liveModelPlan(
  p: { text: string; snapshot: UiSnapshot; lang: string },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<RawStep[] | 'not_command' | null> {
  const key = liveKey(env);
  if (!key) return null;
  const model = env.GEMINI_MODEL || LIVE_DEFAULT_MODEL;
  const prompt = buildPlanPrompt({
    transcript: p.text,
    snapshot: p.snapshot,
    map: [],
    lang: p.lang,
  });
  try {
    const r = await fetchImpl(
      `${API}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt.system }] },
          contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: 'application/json',
            maxOutputTokens: 4096,
          },
        }),
      }
    );
    if (!r.ok) return null;
    const j = (await r.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const out = (j.candidates?.[0]?.content?.parts ?? [])
      .map((x) => x.text ?? '')
      .join('');
    const plan = parseModelPlan(out);
    if (!plan) return null;
    return plan.command ? plan.steps : 'not_command';
  } catch {
    return null;
  }
}
