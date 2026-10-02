/**
 * Подпись вебхука целей (A, §5-тер.16 п.4): ОБЩИЕ векторы
 * `assist-integrations/fixtures/goal-webhook-vectors.json` — их же проверяют
 * npm-пакет и плагин WordPress (T); userHash — те же векторы.
 */
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { userHashOf } from './integrations.service';
import { signGoalWebhook, verifyGoalWebhook } from './webhook-signature';

interface Vectors {
  webhook: Array<{
    name: string;
    secret: string;
    body: string;
    t: number;
    header: string;
  }>;
  identity: Array<{ secret: string; externalId: string; userHash: string }>;
}

const vectors = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      '../../../../assist-integrations/fixtures/goal-webhook-vectors.json',
    ),
    'utf8',
  ),
) as Vectors;

describe('webhook-signature (A) — общие векторы с плагином и npm', () => {
  it.each(vectors.webhook.map((v) => [v.name, v] as const))(
    '%s: подпись совпадает с вектором и проходит проверку',
    (_n, v) => {
      expect(signGoalWebhook(v.secret, v.body, v.t)).toBe(v.header);
      expect(verifyGoalWebhook(v.secret, v.body, v.header, v.t + 10)).toBe(
        'ok',
      );
    },
  );

  it('нет / мусор / старая (> 5 мин) / чужой секрет / подменённое тело — отказ', () => {
    const v = vectors.webhook[0];
    expect(verifyGoalWebhook(v.secret, v.body, undefined, v.t)).toBe('missing');
    expect(verifyGoalWebhook(v.secret, v.body, 'garbage', v.t)).toBe(
      'malformed',
    );
    expect(verifyGoalWebhook(v.secret, v.body, `t=${v.t}`, v.t)).toBe(
      'malformed',
    );
    expect(verifyGoalWebhook(v.secret, v.body, v.header, v.t + 301)).toBe(
      'stale',
    );
    expect(verifyGoalWebhook(v.secret, v.body, v.header, v.t - 301)).toBe(
      'stale',
    );
    expect(verifyGoalWebhook(v.secret, v.body, v.header, v.t + 300)).toBe('ok');
    expect(verifyGoalWebhook('whsec_other', v.body, v.header, v.t)).toBe(
      'mismatch',
    );
    expect(
      verifyGoalWebhook(
        v.secret,
        v.body.replace('1299', '9999'),
        v.header,
        v.t,
      ),
    ).toBe('mismatch');
    // Несколько v1 (ротация на стороне отправителя) — достаточно одной верной.
    const two = `t=${v.t},v1=${'0'.repeat(64)},${v.header.split(',')[1]}`;
    expect(verifyGoalWebhook(v.secret, v.body, two, v.t)).toBe('ok');
  });

  it.each(vectors.identity.map((v) => [v.externalId, v] as const))(
    'userHash %s — как в векторе',
    (_n, v) => {
      expect(userHashOf(v.secret, v.externalId)).toBe(v.userHash);
    },
  );
});
