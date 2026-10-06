import {
  CLIENT_NARRATION_MAX_LENGTH,
  clientFrameNarrations,
  labelFromSelector,
  narrationLocale,
} from './client-site-narration';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';

const steps: ScenarioStep[] = [
  { kind: 'goto', route: 'https://www.shop.example/cabinet' },
  { kind: 'fill', selector: '[name="user_email"]', value: 'ivan@mail.ru' },
  { kind: 'fill', selector: '#password', value: '' },
  { kind: 'click', selector: '[aria-label="Войти"]' },
  { kind: 'click', selector: 'div > button:nth-of-type(2)' },
];
const stepsPerRound = [1, 3, 1];

describe('clientFrameNarrations', () => {
  it('кадр i говорит, что делать на нём дальше; первый — название и сайт, последний — «Готово»', () => {
    const texts = clientFrameNarrations({
      steps,
      stepsPerRound,
      frameCount: 3,
      locale: 'ru',
      title: 'Как войти в кабинет',
      baseUrl: 'https://www.shop.example',
    });
    expect(texts).toEqual([
      'Как войти в кабинет. Откройте сайт shop.example. Заполните поля «user email», «password». Нажмите «Войти».',
      'Нажмите кнопку.',
      'Готово.',
    ]);
  });

  it('значения полей не произносятся никогда', () => {
    const texts = clientFrameNarrations({
      steps,
      stepsPerRound,
      frameCount: 3,
      locale: 'en',
      title: null,
      baseUrl: 'https://shop.example',
    });
    expect(texts.join(' ')).not.toContain('ivan@mail.ru');
    expect(texts[0]).toBe(
      'Open shop.example. Fill in the fields “user email”, “password”. Click “Войти”.',
    );
  });

  it('ПД в названии и подписях полей маскируются на языке озвучки', () => {
    const texts = clientFrameNarrations({
      steps: [
        { kind: 'goto', route: 'https://s.example' },
        {
          kind: 'click',
          selector: '[aria-label="Позвонить +7 (999) 123-45-67"]',
        },
      ],
      stepsPerRound: [1, 1],
      frameCount: 2,
      locale: 'ru',
      title: 'Заказ для boss@corp.example, договор 1234567890',
      baseUrl: 'https://s.example',
    });
    const all = texts.join(' ');
    expect(all).not.toMatch(/boss@corp/);
    expect(all).not.toMatch(/1234567890/);
    expect(all).not.toMatch(/999/);
    expect(all).toContain('адрес почты');
    expect(all).toContain('номер телефона');
  });

  it('язык — locale черновика (uk/de/es), неизвестный и NULL — ru', () => {
    const base = {
      steps: steps.slice(0, 1),
      stepsPerRound: [1],
      frameCount: 1,
      title: null,
      baseUrl: 'https://a.example',
    };
    expect(clientFrameNarrations({ ...base, locale: 'uk' })[0]).toBe(
      'Відкрийте сайт a.example. Готово.',
    );
    expect(clientFrameNarrations({ ...base, locale: 'de' })[0]).toBe(
      'Öffnen Sie a.example. Fertig.',
    );
    expect(clientFrameNarrations({ ...base, locale: 'es' })[0]).toBe(
      'Abra a.example. Listo.',
    );
    expect(narrationLocale(null)).toBe('ru');
    expect(narrationLocale('uk-UA')).toBe('uk');
    expect(narrationLocale('fr')).toBe('ru');
  });

  it('раунды разошлись с кадрами — немы все кадры (реплика не ложится на чужой экран)', () => {
    expect(
      clientFrameNarrations({
        steps,
        stepsPerRound,
        frameCount: 4,
        locale: 'ru',
        title: 'x',
        baseUrl: 'https://a.example',
      }),
    ).toEqual([null, null, null, null]);
  });

  it('маркер живого входа озвучивается как вход в кабинет', () => {
    const texts = clientFrameNarrations({
      steps: [
        { kind: 'goto', route: 'https://a.example' },
        { kind: 'assertVisible', selector: '#dashboard' },
      ],
      stepsPerRound: [1, 1],
      frameCount: 2,
      locale: 'ru',
      title: null,
      baseUrl: 'https://a.example',
    });
    expect(texts[0]).toBe('Откройте сайт a.example. Войдите в личный кабинет.');
  });

  it('текст не длиннее потолка реплики', () => {
    const texts = clientFrameNarrations({
      steps: [
        { kind: 'goto', route: 'https://a.example' },
        ...Array.from({ length: 20 }, (_, i) => ({
          kind: 'fill' as const,
          selector: `[aria-label="Очень длинное поле номер ${String.fromCharCode(1072 + i)}"]`,
          value: 'v',
        })),
      ],
      stepsPerRound: [1, 20],
      frameCount: 2,
      locale: 'ru',
      title: null,
      baseUrl: 'https://a.example',
    });
    expect(Array.from(texts[0]!).length).toBeLessThanOrEqual(
      CLIENT_NARRATION_MAX_LENGTH,
    );
    expect(texts[0]!.endsWith('…')).toBe(true);
  });
});

describe('labelFromSelector', () => {
  it('человеческие атрибуты как есть, машинные — по словам', () => {
    expect(labelFromSelector('[aria-label="Корзина"]')).toBe('Корзина');
    expect(labelFromSelector('input[placeholder="Ваш город"]')).toBe(
      'Ваш город',
    );
    expect(labelFromSelector('[name="firstName"]')).toBe('first name');
    expect(labelFromSelector('#phone-number')).toBe('phone number');
    expect(labelFromSelector('[data-testid="submit_order"]')).toBe(
      'submit order',
    );
  });

  it('путь по тегам и машинные id — без имени', () => {
    expect(labelFromSelector('div > button:nth-of-type(2)')).toBeNull();
    expect(labelFromSelector('#f-8a3b9c')).toBeNull();
    expect(labelFromSelector('#field12345')).toBeNull();
  });
});
