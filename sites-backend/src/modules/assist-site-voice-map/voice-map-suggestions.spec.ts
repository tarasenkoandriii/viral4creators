/**
 * Заход 13 (Р-З13-Б3) — чистая часть карточек TMA «Обучение → Голос»:
 * операции перепривязки (через НАСТОЯЩЕЕ ядро карты `applyMapOps`) и их
 * обратные операции («Отменить» возвращает черновик как был), «уже
 * перепривязали» и «фраза — имя старой цели» (Р-З11-Б9).
 */
import {
  applyMapOps,
  emptyVoiceMap,
  type VoiceMapContent,
  type VoiceMapTarget,
} from '../assist-ui-core/voice-map';
import { nameClash, rebindOps, rebound } from './voice-map-suggestions.service';

function target(over: Partial<VoiceMapTarget>): VoiceMapTarget {
  return {
    key: 'gift',
    scope: 'site',
    templateId: null,
    pagePath: null,
    descriptor: {
      tag: 'button',
      role: 'button',
      text: 'Кнопка',
      hiddenLabel: null,
      assistId: over.key ?? 'gift',
      testId: null,
      elId: null,
      hrefPath: null,
      hrefHost: null,
      offHost: false,
      heading: null,
      landmark: null,
      formName: null,
      inputType: null,
      submit: false,
      inForm: false,
      pd: false,
      toggle: false,
      gesture: null,
      neverAttr: false,
      confirmZone: false,
      clickableDiv: false,
      editable: false,
      closedShadow: false,
      unique: true,
      css: null,
    },
    stability: 'strong',
    samples: [],
    names: {},
    synonyms: {},
    semanticType: null,
    riskComputed: 'now',
    riskReason: 'default',
    riskOwner: null,
    denylisted: false,
    control: false,
    undo: null,
    origin: 'owner',
    status: 'active',
    ...over,
  } as VoiceMapTarget;
}

function map(...targets: VoiceMapTarget[]): VoiceMapContent {
  return { ...emptyVoiceMap(), targets };
}

const apply = (c: VoiceMapContent, ops: unknown[]) => {
  const r = applyMapOps(c, ops, {
    hosts: [],
    newId: () => 't-1',
    source: 'tma',
  });
  expect(r.issues).toEqual([]);
  return r.content;
};

const phrases = (c: VoiceMapContent, key: string) =>
  Object.values(c.targets.find((t) => t.key === key)!.synonyms)
    .flat()
    .map((s) => s!.text);

describe('Заход 13 — карточки TMA «Обучение → Голос» (чистая часть)', () => {
  const cart = () =>
    target({
      key: 'cart',
      names: { uk: 'В кошик' },
      synonyms: {
        uk: [
          { text: 'доставку', origin: 'owner' },
          { text: 'купити', origin: 'owner' },
        ],
        ru: [{ text: 'Доставку!', origin: 'queue' }],
      },
    });
  const ship = () =>
    target({
      key: 'shipping',
      names: { uk: 'Доставка' },
      synonyms: { uk: [{ text: 'умови', origin: 'owner' }] },
    });

  it('перепривязка: фраза — синоним новой цели, со старой снимается во всех языках (по норме); «Отменить» — черновик как был', () => {
    const before = map(cart(), ship());
    const plan = rebindOps(before, 'cart', 'shipping', 'доставку', 'uk');
    expect(plan.detached).toBe(true);
    const after = apply(structuredClone(before), plan.ops);
    expect(phrases(after, 'shipping')).toEqual(['умови', 'доставку']);
    // «Доставку!» (ru) — та же норма: снимается тоже; прочие синонимы целы.
    expect(phrases(after, 'cart')).toEqual(['купити']);
    expect(rebound(after, 'cart', 'доставку')).toBe(true);
    const undone = apply(after, plan.undo);
    expect(phrases(undone, 'shipping')).toEqual(['умови']);
    expect(phrases(undone, 'cart')).toEqual([
      'доставку',
      'купити',
      'Доставку!',
    ]);
    expect(rebound(undone, 'cart', 'доставку')).toBe(false);
  });

  it('фраза не была синонимом старой цели (план модели) — старую не трогаем; неактивную старую цель не «оживляем»', () => {
    const before = map(
      target({ key: 'cart', names: { uk: 'В кошик' } }),
      ship(),
    );
    const plan = rebindOps(before, 'cart', 'shipping', 'оплату', 'uk');
    expect(plan.detached).toBe(false);
    expect(plan.ops).toEqual([
      { op: 'add-synonym', key: 'shipping', lang: 'uk', text: 'оплату' },
    ]);
    const removed = map(cart(), ship());
    removed.targets[0].status = 'removed';
    const p2 = rebindOps(removed, 'cart', 'shipping', 'доставку', 'uk');
    expect(p2.detached).toBe(false);
    const after = apply(structuredClone(removed), p2.ops);
    expect(after.targets.find((t) => t.key === 'cart')!.status).toBe('removed');
  });

  it('«уже перепривязали» — фраза есть у ДРУГОЙ активной цели (имя или синоним); своя цель и удалённые — не в счёт', () => {
    const c = map(cart(), ship());
    expect(rebound(c, 'cart', 'доставку')).toBe(false);
    expect(rebound(c, 'cart', 'Доставка')).toBe(true);
    expect(rebound(c, 'cart', 'умови')).toBe(true);
    c.targets[1].status = 'removed';
    expect(rebound(c, 'cart', 'умови')).toBe(false);
  });

  it('Р-З11-Б9: фраза — ИМЯ старой цели (норма, любой язык) — `nameClash`; синоним — нет', () => {
    const c = map(cart(), ship());
    expect(nameClash(c, 'cart', 'в кошик')).toBe(true);
    expect(nameClash(c, 'cart', 'В КОШИК!')).toBe(true);
    expect(nameClash(c, 'cart', 'доставку')).toBe(false);
    expect(nameClash(c, 'nope', 'в кошик')).toBe(false);
  });
});
