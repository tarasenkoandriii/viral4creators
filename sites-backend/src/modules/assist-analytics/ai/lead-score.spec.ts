/**
 * Э3-бис: lead score кодом (§5-тер.4, Р-44) — объяснимость, корзины,
 * калибровка Platt, метрики, отсутствие демографических признаков.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  LEAD_FEATURES,
  auc,
  brier,
  bucketOf,
  ece,
  fitPlatt,
  leadScore,
  plattProb,
  type LeadInput,
} from './lead-score';

const base: LeadInput = {
  stage: 'explore',
  intent: 'product_info',
  buyingSignals: [],
  llmLikelihood: null,
  visitorTurns: 1,
  assistClick: false,
  pagePath: '/',
  voice: false,
  repeatVisit: false,
};

describe('lead score (Э3-бис)', () => {
  it('горячий: готов купить, сигналы, корзина, клик помощника; холодный — спам', () => {
    const hot = leadScore(
      {
        ...base,
        stage: 'decide',
        buyingSignals: [
          'asked_price',
          'asked_how_to_order',
          'opened_lead_form',
        ],
        llmLikelihood: 90,
        visitorTurns: 4,
        assistClick: true,
        pagePath: '/cart',
      },
      'shop',
    );
    expect(hot.bucket).toBe('hot');
    const cold = leadScore({ ...base, intent: 'offtopic_spam' }, 'shop');
    expect(cold.bucket).toBe('cold');
    expect(hot.score).toBeGreaterThan(cold.score);
  });

  it('объяснимость: каждый вклад — признак из белого списка, по убыванию модуля', () => {
    const r = leadScore(
      {
        ...base,
        stage: 'compare',
        buyingSignals: ['asked_price'],
        llmLikelihood: 80,
      },
      'services',
    );
    expect(r.features.length).toBeGreaterThan(0);
    for (const f of r.features) expect(LEAD_FEATURES).toContain(f.f);
    const mags = r.features.map((f) => Math.abs(f.c));
    expect(mags).toEqual([...mags].sort((a, b) => b - a));
  });

  it('модель — малый вес: оценка 100 vs 0 не меняет корзину сама по себе', () => {
    const lo = leadScore({ ...base, llmLikelihood: 0 }, 'shop');
    const hi = leadScore({ ...base, llmLikelihood: 100 }, 'shop');
    expect(hi.score - lo.score).toBeLessThan(25);
    expect(lo.bucket).toBe(hi.bucket);
  });

  it('не дискриминирует: в признаках нет языка, страны, устройства, имени, источника', () => {
    const src = fs.readFileSync(path.join(__dirname, 'lead-score.ts'), 'utf8');
    const iface = src.slice(
      src.indexOf('export interface LeadInput'),
      src.indexOf('export interface LeadScore'),
    );
    for (const banned of [
      'lang',
      'locale',
      'country',
      'city',
      'device',
      'browser',
      'name',
      'email',
      'phone',
      'source',
      'utm',
      'ip',
    ]) {
      expect(iface.toLowerCase()).not.toMatch(
        new RegExp(`\\b${banned}\\w*\\s*:`),
      );
    }
  });

  it('корзины по порогам 60/30', () => {
    expect([bucketOf(60), bucketOf(59), bucketOf(30), bucketOf(29)]).toEqual([
      'hot',
      'warm',
      'warm',
      'cold',
    ]);
  });

  it('Platt: монотонен, улучшает калибровку на смещённых данных; AUC/Brier/ECE', () => {
    // Истинная вероятность = score/200 (score завышен вдвое).
    const rows: Array<{ score: number; y: 0 | 1 }> = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2000; i++) {
      const score = 5 + Math.floor(rnd() * 90);
      rows.push({ score, y: rnd() < score / 200 ? 1 : 0 });
    }
    const p = fitPlatt(rows);
    expect(p).not.toBeNull();
    expect(plattProb(80, p!)).toBeGreaterThan(plattProb(20, p!));
    const raw = rows.map((r) => ({ p: r.score / 100, y: r.y }));
    const cal = rows.map((r) => ({ p: plattProb(r.score, p!), y: r.y }));
    expect(ece(cal)!).toBeLessThan(ece(raw)!);
    expect(brier(cal)!).toBeLessThan(brier(raw)!);
    expect(auc(cal)!).toBeGreaterThan(0.6);
    expect(fitPlatt([{ score: 50, y: 1 }])).toBeNull();
    expect(auc([{ p: 0.5, y: 1 }])).toBeNull();
  });
});
