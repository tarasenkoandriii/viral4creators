/**
 * Поддельная сеть для тестов проверки владения: два DoH-резолвера со
 * своими зонами и «интернет» из заранее заданных ответов. Настоящие
 * `DohClient`/`fetchSameOrigin`/`OwnershipChecker` работают поверх них без
 * изменений — подменяется только транспорт.
 */

import { DohClient, DohResolver } from '../ownership/doh.client';
import { OwnershipChecker } from '../ownership/ownership-checker';
import type { SafeHttpDeps } from '../ownership/safe-http';
import { UnsafeExternalUrlError } from '../../../shared/external-url-guard';

export const RESOLVERS: DohResolver[] = [
  {
    name: 'r1',
    url: (n) => `https://doh-one.test/q?name=${encodeURIComponent(n)}`,
  },
  {
    name: 'r2',
    url: (n) => `https://doh-two.test/q?name=${encodeURIComponent(n)}`,
  },
];

export type Zone = Map<string, string[]>;

export interface Page {
  status: number;
  body?: string;
  location?: string;
}

export class FakeNet {
  /** Зона каждого резолвера: имя → значения TXT. */
  readonly zones: Record<'r1' | 'r2', Zone> = { r1: new Map(), r2: new Map() };
  /** Резолвер «лежит»: отвечает 503. */
  readonly down = new Set<'r1' | 'r2'>();
  readonly pages = new Map<string, Page>();
  /** Хосты, которые резолвятся в приватные адреса (SSRF). */
  readonly privateHosts = new Set<string>();
  readonly fetched: string[] = [];
  readonly asserted: string[] = [];

  /** TXT у обоих резолверов. */
  txt(name: string, ...values: string[]): this {
    this.zones.r1.set(name, values);
    this.zones.r2.set(name, values);
    return this;
  }

  page(url: string, p: Page): this {
    this.pages.set(url, p);
    return this;
  }

  private dohFetch = async (url: string): Promise<Response> => {
    const u = new URL(url);
    const r = u.hostname === 'doh-one.test' ? 'r1' : 'r2';
    if (this.down.has(r)) return new Response('down', { status: 503 });
    const name = u.searchParams.get('name') ?? '';
    const values = this.zones[r].get(name);
    if (!values) {
      return Response.json({ Status: 3 });
    }
    return Response.json({
      Status: 0,
      Answer: values.map((v) => ({ name, type: 16, data: `"${v}"` })),
    });
  };

  readonly http: SafeHttpDeps = {
    timeoutMs: 1000,
    assertUrl: async (url: string) => {
      this.asserted.push(url);
      if (this.privateHosts.has(new URL(url).hostname)) {
        throw new UnsafeExternalUrlError('private');
      }
    },
    fetch: async (url: string) => {
      this.fetched.push(url);
      const p = this.pages.get(url);
      if (!p) return new Response('not found', { status: 404 });
      const headers = new Headers();
      if (p.location) headers.set('location', p.location);
      return new Response(p.body ?? '', { status: p.status, headers });
    },
  };

  doh(): DohClient {
    return new DohClient(RESOLVERS, (u) => this.dohFetch(u), 1000);
  }

  checker(): OwnershipChecker {
    return new OwnershipChecker(this.doh(), this.http);
  }
}
