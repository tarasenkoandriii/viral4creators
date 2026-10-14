/**
 * AI Publisher — стендовый fake-провайдер AI (P-R M2, раунд исправлений,
 * Р-RD-73; замечание экранов «E2E без SQL-вставки»). Действует ТОЛЬКО при
 * `publisherStandFakeAi().enabled` (`PUBLISHER_STAND_FAKE_AI=true` И
 * `NODE_ENV=development|test` И не Vercel — правило часов стенда
 * Р-PUB-Z2-21); в проде флаг игнорируется с предупреждением.
 *
 * Без сети. Отвечает на промпт `pub.reddit.draft` (узнаёт по
 * `<community_rules`): N вариантов нужного типа с раскрытием (бренд и
 * аффилированность брифа), тезисами брифа и `claim_map` с id источников
 * тезисов. Прочим генераторам — `unavailable` (их стенд не проверяет).
 * Модель в журнале — та же, что у шлюза (стоимость считается по прайсу).
 */
import {
  TextModelError,
  type GenerateRequest,
  type GenerateResult,
} from '../../site-ai/text-model';
import type { AiTextModel } from './gateway-core';

const field = (user: string, name: string): string | null => {
  const m = new RegExp(`^${name}: (.*)$`, 'm').exec(user);
  return m ? m[1].trim() : null;
};

/** Раскрытие по аффилированности (≥ 20 знаков, маркер и бренд). */
export function standDisclosure(affiliation: string, brand: string): string {
  switch (affiliation) {
    case 'founder':
      return `Disclosure: I'm the founder of ${brand}.`;
    case 'employee':
      return `Disclosure: I work at ${brand}.`;
    case 'agency':
      return `Disclosure: our agency works with ${brand}.`;
    case 'customer':
      return `Disclosure: I'm a paying customer of ${brand}.`;
    default:
      return '';
  }
}

const unescape = (t: string): string =>
  t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function standRedditDraft(user: string): string {
  const shape =
    /Тип: (post|comment)\. Варіантів: (\d)\./.exec(user) ?? undefined;
  const type = shape?.[1] === 'post' ? 'post' : 'comment';
  const n = Math.min(3, Math.max(2, Number(shape?.[2] ?? 3)));
  const brand = unescape(field(user, 'brand') ?? 'the product');
  const affiliation = field(user, 'affiliation') ?? 'founder';
  const objective = unescape(field(user, 'objective') ?? 'Help the author');
  const points = [...user.matchAll(/^\s+\d+\. (.*) \[([^\]]*)\]$/gm)].map(
    (m) => ({ text: unescape(m[1]), ids: m[2] }),
  );
  const sourced = points.filter((p) => p.ids && p.ids !== 'needs_verification');
  const disclosure = standDisclosure(affiliation, brand);
  const variants = Array.from({ length: n }, (_, i) => {
    const letter = 'ABC'[i];
    const lines = [
      disclosure,
      `${objective} (variant ${letter}).`,
      ...sourced.map((p) => p.text.replace(/\.?$/, '.')),
    ].filter(Boolean);
    return {
      title: type === 'post' ? `${objective} (${letter})`.slice(0, 300) : null,
      body: lines.join('\n\n'),
      disclosure,
      flair_suggestion: null,
      claim_map: sourced.map((p) => ({
        text: p.text.slice(0, 500),
        source_ids: p.ids
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(0, 10),
      })),
      uncertainties: points
        .filter((p) => p.ids === 'needs_verification')
        .map((p) => p.text.slice(0, 500)),
    };
  });
  return JSON.stringify({ variants });
}

export class StandFakeModel implements AiTextModel {
  constructor(private readonly modelName: string) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    if (!req.user.includes('<community_rules')) {
      throw new TextModelError('unavailable');
    }
    const text = standRedditDraft(req.user);
    return {
      text,
      model: req.model ?? this.modelName,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      cachedInputTokens: 0,
      outputTokens: Math.ceil(text.length / 4),
    };
  }
}
