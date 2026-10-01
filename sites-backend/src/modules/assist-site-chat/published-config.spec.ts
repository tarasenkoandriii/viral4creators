/**
 * Интеграция Э2 (стык W2/W3/W4): опубликованную строку версий публичный
 * код читает ОДНИМ способом — `readPublishedConfig` (сырой SQL). Модель
 * Prisma под логин-ролью assist_public получает 42501 (GRANT без `id`) —
 * это и фиксируем, плюс скан: в публичном коде модели нет.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { describeDb } from '../assist-sandbox/testing/k3-stack.testing';
import {
  domain,
  startWidgetStack,
  widgetFixture,
  type WidgetStack,
} from '../assist-widget/testing/widget-stack.testing';
import { readPublishedConfig } from './published-config';

describe('публичный код не читает assist_site_config_versions моделью Prisma', () => {
  it('assist-widget (кроме cabinet/) и assist-site-chat (кроме system/, testing/) — только readPublishedConfig', () => {
    const roots = ['assist-widget', 'assist-site-chat'].map((d) =>
      path.resolve(__dirname, '..', d),
    );
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (!['cabinet', 'system', 'testing'].includes(e.name)) walk(p);
        } else if (/\.ts$/.test(e.name) && !/\.spec\.ts$/.test(e.name)) {
          const code = fs.readFileSync(p, 'utf8');
          if (/\.assistSiteConfigVersion\b/.test(code)) hits.push(p);
          if (
            /assist_site_config_versions/.test(
              code.replace(/\/\*[\s\S]*?\*\//g, ''),
            ) &&
            !p.endsWith(`${path.sep}published-config.ts`)
          )
            hits.push(`${p} (свой SQL)`);
        }
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});

describeDb('readPublishedConfig под логин-ролью assist_public', () => {
  let stack: WidgetStack;

  beforeAll(async () => {
    Logger.overrideLogger(false);
    stack = await startWidgetStack();
  });
  afterAll(async () => {
    await stack?.close();
  });

  it('вид и персона читаются; модель Prisma той же роли — 42501 (поэтому сырой SQL)', async () => {
    const f = await widgetFixture(stack, [{ host: domain() }]);
    const widget = await readPublishedConfig(
      stack.publicDb,
      f.siteId,
      'widget',
      1,
    );
    expect(widget).toMatchObject({ schema: 1 });
    await stack.prisma.assistSiteConfigVersion.create({
      data: {
        accountId: f.accountId,
        siteId: f.siteId,
        kind: 'persona',
        version: 3,
        config: { tone: 'friendly' },
      },
    });
    expect(
      await readPublishedConfig(stack.publicDb, f.siteId, 'persona', 3),
    ).toEqual({ tone: 'friendly' });
    expect(
      await readPublishedConfig(stack.publicDb, f.siteId, 'persona', 1),
    ).toBeNull();
    expect(
      await readPublishedConfig(stack.publicDb, f.siteId, 'widget', 0),
    ).toBeNull();
    await expect(
      stack.publicDb.assistSiteConfigVersion.findFirst({
        where: { siteId: f.siteId, kind: 'widget', version: 1 },
        select: { config: true },
      }),
    ).rejects.toThrow(/permission denied|42501/i);
  });
});
