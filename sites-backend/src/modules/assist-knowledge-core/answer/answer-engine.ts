/**
 * Ответ по найденным фрагментам — K3 (песочница; его же зовут ворота
 * версии для инвариантного eval — K2). Нейтральный: получает фрагменты,
 * таблиц не знает.
 *
 * Промпт (§4.6, §6.5): каркас «отвечай только по источникам, иначе честно
 * “не знаю”»; фрагменты — размеченными блоками `<source n=…>` как ДАННЫЕ,
 * не инструкции; UGC — с пометкой «мнение посетителя»; ссылки в ответе —
 * только URL из метаданных фрагментов (номера [S#]), не из текста модели;
 * без markdown-картинок и HTML (лендинг-ТЗ §6.2: враждебный текст чужого
 * сайта не должен стать XSS/фишингом на нашем домене).
 *
 * «Без выдумывания» проверяется кодом после модели, а не верой в промпт:
 *  - нет фрагментов — отказ без вызова модели (и без денег);
 *  - число в ответе, которого нет в источниках и вопросе, — ответ заменяется
 *    честным «уточните цифры» (строгий режим §4.7 — в песочнице по
 *    умолчанию: результат показывается на НАШЕМ домене);
 *  - ответ без единой ссылки на источник, но с цифрами — то же;
 *  - источники ответа — только номера из промпта (чужой S# вырезается).
 */
import { Injectable } from '@nestjs/common';
import {
  containsAnyPhrase,
  splitActionsBlock,
} from '../../../shared/assist-chat-core';
import { GeminiText } from '../../site-ai/text-model';
import type { SearchHit } from '../types';
import {
  AnswerLang,
  REFUSAL_TEXT,
  UNSURE_NUMBER_TEXT,
  buildAnswerPrompt,
  questionLang,
} from './prompt';
import {
  FORBIDDEN_PROMISES,
  citedNumbers,
  numberTokens,
  sanitizeAnswerText,
  unsupportedNumbers,
} from './sanitize';

export interface AnswerRequest {
  question: string;
  hits: SearchHit[];
  /** Язык ответа — язык вопроса. */
  lang?: string | null;
  siteName?: string | null;
  maxOutputTokens?: number;
}

export interface AnswerSource {
  n: number;
  url: string | null;
  title: string | null;
}

/** Флаги для ревью/метрик (§4.7); наружу песочницы не отдаются. */
export type AnswerFlag =
  | 'no_hits'
  | 'unsupported_number'
  | 'no_citation'
  | 'forbidden_promise'
  | 'unparsed_json';

export interface AnswerResult {
  text: string;
  sources: AnswerSource[];
  refused: boolean;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Необязательное поле сверх заглушки: что поймала проверка (K3). */
  flags?: AnswerFlag[];
}

/** Фрагментов в промпт — как у поиска (§4.3: top-6). */
export const ANSWER_MAX_HITS = 6;

interface ModelJson {
  answer: string;
  sources: number[];
  refused: boolean;
}

/** JSON модели; не JSON (редко, но бывает) — текст как есть, номера из маркеров. */
export function parseModelJson(raw: string): ModelJson | null {
  const text = splitActionsBlock(raw).text.trim();
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    if (typeof o.answer !== 'string') return null;
    return {
      answer: o.answer,
      sources: Array.isArray(o.sources)
        ? o.sources
            .map((x) =>
              typeof x === 'string' ? Number(x.replace(/\D/g, '')) : x,
            )
            .filter((x): x is number => Number.isInteger(x))
        : [],
      refused: o.refused === true,
    };
  } catch {
    return null;
  }
}

@Injectable()
export class AnswerEngine {
  constructor(private readonly text: GeminiText) {}

  async answer(req: AnswerRequest): Promise<AnswerResult> {
    const lang: AnswerLang = questionLang(req.question, req.lang);
    const hits = req.hits.slice(0, ANSWER_MAX_HITS);
    if (hits.length === 0) {
      return {
        text: REFUSAL_TEXT[lang],
        sources: [],
        refused: true,
        model: '',
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        flags: ['no_hits'],
      };
    }

    const prompt = buildAnswerPrompt({
      question: req.question,
      hits,
      lang,
      siteName: req.siteName,
    });
    const gen = await this.text.generate({
      system: prompt.system,
      user: prompt.user,
      maxOutputTokens: req.maxOutputTokens ?? 800,
      json: true,
      temperature: 0.1,
    });
    const usage = {
      model: gen.model,
      inputTokens: gen.inputTokens,
      outputTokens: gen.outputTokens,
      cachedInputTokens: gen.cachedInputTokens,
    };

    const flags: AnswerFlag[] = [];
    const parsed = parseModelJson(gen.text);
    if (!parsed) flags.push('unparsed_json');
    const rawAnswer = parsed?.answer ?? gen.text;
    const allowed = new Set(prompt.sources.keys());
    const answer = sanitizeAnswerText(rawAnswer, allowed);

    const cited = [
      ...new Set([...citedNumbers(answer), ...(parsed?.sources ?? [])]),
    ].filter((n) => allowed.has(n));
    const sources: AnswerSource[] = cited
      .sort((a, b) => a - b)
      .map((n) => {
        const h = prompt.sources.get(n) as SearchHit;
        return { n, url: h.url, title: h.title };
      });

    const refuse = (text: string, flag?: AnswerFlag): AnswerResult => ({
      text,
      sources: [],
      refused: true,
      ...usage,
      flags: flag ? [...flags, flag] : flags,
    });

    if (parsed?.refused || !answer) return refuse(REFUSAL_TEXT[lang]);

    const citedTexts = (
      sources.length > 0
        ? cited.map((n) => prompt.sources.get(n) as SearchHit)
        : hits
    ).map((h) => `${h.title ?? ''} ${h.headingPath ?? ''} ${h.text}`);
    if (unsupportedNumbers(answer, citedTexts, req.question).length > 0) {
      return refuse(UNSURE_NUMBER_TEXT[lang], 'unsupported_number');
    }
    if (sources.length === 0) {
      flags.push('no_citation');
      const hasNumbers =
        numberTokens(answer).length > numberTokens(req.question).length;
      if (hasNumbers) return refuse(REFUSAL_TEXT[lang]);
    }
    if (containsAnyPhrase(answer, FORBIDDEN_PROMISES)) {
      flags.push('forbidden_promise');
    }
    return { text: answer, sources, refused: false, ...usage, flags };
  }
}
