/**
 * Стенд тестов K3 на НАСТОЯЩЕМ Postgres (образец — prisma/assist-public-
 * role.spec.ts): без `SITES_DIRECT_URL` наборы пропускаются с причиной, при
 * `CI=true` — проваливаются. Публичная песочница идёт под отдельной
 * ЛОГИН-ролью, входящей в `assist_public` (как в проде), — её создаёт сам
 * тест (CI — суперпользователь), так что отказ Postgres по правам здесь
 * виден так же, как в проде.
 *
 * ИИ — подделки с детерминированными ответами (контракт Э1 §7): эмбеддинг —
 * «мешок слов» в 768 измерениях (похожие тексты — близкие векторы), текстовая
 * модель — ответ первым предложением источника S1 с маркером [S1].
 */
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { KNOWLEDGE_DEFAULTS } from '../../../config/assist-defaults';
import type { PrismaService } from '../../../prisma/prisma.service';
import { SITES_DB_SCHEMA } from '../../../prisma/prisma.service';
import type { AssistPublicDb } from '../../../prisma/assist-public-db.service';
import type { SearchHit, SearchQuery } from '../../assist-knowledge-core/types';
import type { EmbedTransport } from '../../site-ai/embedder';
import {
  GeminiText,
  GenerateRequest,
  GenerateResult,
} from '../../site-ai/text-model';

export const RAW_DB_URL = process.env.SITES_DIRECT_URL;
const IN_CI = process.env.CI === 'true';

/** Логин-роль публичной песочницы в тестах (в проде — своя, doc/DEPLOYMENT.md §6.4). */
export const TEST_PUBLIC_LOGIN = 'k3_sandbox_public_test';
const TEST_PUBLIC_PASSWORD = 'k3-sandbox-public-test-pw';

export function pgUrl(url: string): string {
  const u = new URL(url);
  u.searchParams.delete('schema');
  return u.toString();
}

export function describeDb(name: string, body: () => void): void {
  if (!RAW_DB_URL) {
    describe(name, () => {
      (IN_CI ? it : it.skip)(
        'ПРОПУЩЕНО: нет SITES_DIRECT_URL (песочница без базы) — проверка идёт в CI, джоба sites-backend',
        () => {
          throw new Error(
            `CI=true, но SITES_DIRECT_URL не задана — «${name}» не выполнился`,
          );
        },
      );
    });
    return;
  }
  describe(name, body);
}

export function ownerPrisma(): PrismaService {
  return new PrismaClient({
    adapter: new PrismaPg(pgUrl(RAW_DB_URL as string), {
      schema: SITES_DB_SCHEMA,
    }),
  }) as unknown as PrismaService;
}

/** Строка подключения под логин-ролью assist_public (создаёт роль при нужде). */
export async function publicDbUrl(owner: PrismaService): Promise<string> {
  await owner.$executeRawUnsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TEST_PUBLIC_LOGIN}') THEN
      CREATE ROLE ${TEST_PUBLIC_LOGIN} LOGIN PASSWORD '${TEST_PUBLIC_PASSWORD}' IN ROLE assist_public;
    END IF;
  END $$;`);
  const u = new URL(pgUrl(RAW_DB_URL as string));
  u.username = TEST_PUBLIC_LOGIN;
  u.password = TEST_PUBLIC_PASSWORD;
  return u.toString();
}

export async function publicPrisma(
  owner: PrismaService,
): Promise<AssistPublicDb> {
  const url = await publicDbUrl(owner);
  return new PrismaClient({
    adapter: new PrismaPg(url, { schema: SITES_DB_SCHEMA }),
  }) as unknown as AssistPublicDb;
}

/** «Мешок слов» → 768 измерений: одинаковые слова — близкие векторы. */
export function bagOfWordsVector(text: string): number[] {
  const v = new Array<number>(KNOWLEDGE_DEFAULTS.embedDimensions).fill(0);
  v[0] = 0.01; // не нулевой даже для пустого текста
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}-]+/gu) ?? []) {
    let h = 2166136261;
    for (const ch of w) h = Math.imul(h ^ (ch.codePointAt(0) ?? 0), 16777619);
    v[Math.abs(h) % v.length] += 1;
  }
  return v;
}

export function fakeEmbedTransport(calls: string[][] = []): EmbedTransport {
  return async ({ texts }) => {
    calls.push(texts);
    return {
      vectors: texts.map(bagOfWordsVector),
      inputTokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
    };
  };
}

/** Текстовая модель без сети: ответ — первое предложение S1 с маркером. */
export class FakeText extends GeminiText {
  readonly calls: GenerateRequest[] = [];
  fail: Error | null = null;

  override async generate(req: GenerateRequest): Promise<GenerateResult> {
    this.calls.push(req);
    if (this.fail) throw this.fail;
    const usage = {
      model: 'gemini-3.6-flash',
      inputTokens: 1200,
      cachedInputTokens: 0,
      outputTokens: 40,
    };
    if (/"questions"/.test(req.system)) {
      return {
        ...usage,
        text: JSON.stringify({
          questions: [
            'Сколько стоит доставка?',
            'Есть ли самовывоз?',
            'Где купить ABC-1234?',
          ],
        }),
      };
    }
    const s1 = /<source id="S1"[^>]*>\n([\s\S]*?)\n<\/source>/.exec(req.user);
    if (!s1) {
      return {
        ...usage,
        text: JSON.stringify({ answer: 'Не знаю', sources: [], refused: true }),
      };
    }
    const first = s1[1].split(/(?<=[.!?])\s/)[0].slice(0, 300);
    return {
      ...usage,
      text: JSON.stringify({
        answer: `${first} [S1]`,
        sources: [1],
        refused: false,
      }),
    };
  }
}

/** Поиск «Сайта» (K2) — подделка: записывает вызовы, отдаёт заданное. */
export class FakeSiteSearch {
  readonly calls: SearchQuery[] = [];
  hits: SearchHit[] = [];
  async search(q: SearchQuery): Promise<SearchHit[]> {
    this.calls.push(q);
    return this.hits;
  }
}

/** Уникальная метка для доменов/ключей теста: параллельные наборы не мешают. */
export function uniq(prefix = 'k3'): string {
  return `${prefix}${randomUUID().slice(0, 8)}`;
}

/** Случайный IPv6 /64 — свой лимит у каждого теста. */
export function randomV6Prefix(): string {
  const h = () => Math.floor(Math.random() * 0xffff).toString(16);
  return `2001:db8:${h()}:${h()}`;
}
