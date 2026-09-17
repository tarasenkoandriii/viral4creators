import {
  DomainLockError,
  DraftRoundMismatchError,
  DraftRoundsState,
  DraftStatusError,
  DraftStepLimitError,
  MAX_DRAFT_STEPS,
  UndoNotPossibleError,
  appendRound,
  assertEditable,
  assertRoundsConsistent,
  assertSameOrigin,
  replaceLastScreenshot,
  undoLastRound,
} from './draft-rounds';
import { ScenarioStep } from '../tutorial-scenario/scenario-steps.types';

/**
 * Центральное различие всего модуля — раунд (один HTTP-вызов, один кадр)
 * против шага (один элемент steps[]). Один `/step` с формой из трёх
 * полей и кнопкой — это ОДИН раунд и ЧЕТЫРЕ шага. Путаница этих единиц
 * — ровно тот баг, который аудит ТЗ уже ловил: отмена «последнего
 * элемента массива» отрезала бы только `click`, оставив осиротевшие
 * `fill` без пары.
 */

const GOTO: ScenarioStep = { kind: 'goto', route: 'https://shop.example.com' };
const FILL = (selector: string): ScenarioStep => ({
  kind: 'fill',
  selector,
  value: 'x',
});
const CLICK: ScenarioStep = { kind: 'click', selector: '#submit' };

function emptyState(): DraftRoundsState {
  return {
    steps: [],
    stepsPerRound: [],
    roundScreenshots: [],
    requiresLiveLoginReplay: false,
  };
}

function firstRound(): DraftRoundsState {
  return appendRound(emptyState(), { steps: [GOTO], screenshot: 'кадр-1' });
}

describe('appendRound', () => {
  it('раунд из нескольких шагов даёт ОДИН кадр и одну запись stepsPerRound', () => {
    const state = appendRound(firstRound(), {
      steps: [FILL('#email'), FILL('#pass'), CLICK],
      screenshot: 'кадр-2',
    });

    expect(state.steps).toHaveLength(4);
    expect(state.stepsPerRound).toEqual([1, 3]);
    expect(state.roundScreenshots).toEqual(['кадр-1', 'кадр-2']);
    assertRoundsConsistent(state);
  });

  it('live-раунд помечает весь черновик как непересобираемый', () => {
    const state = appendRound(firstRound(), {
      steps: [{ kind: 'assertVisible', selector: '#account' }],
      screenshot: 'кадр-2',
      live: true,
    });
    expect(state.requiresLiveLoginReplay).toBe(true);
  });

  it('пустой раунд запрещён — кадр без действия потом нечем отменять', () => {
    expect(() =>
      appendRound(firstRound(), { steps: [], screenshot: 'кадр' }),
    ).toThrow(DraftRoundMismatchError);
  });

  it('потолок шагов не даёт черновику расти бесконечно', () => {
    let state = firstRound();
    // Добиваем ровно до потолка.
    state = appendRound(state, {
      steps: Array.from({ length: MAX_DRAFT_STEPS - 1 }, (_, i) =>
        FILL(`#f${i}`),
      ),
      screenshot: 'кадр-2',
    });
    expect(state.steps).toHaveLength(MAX_DRAFT_STEPS);

    expect(() =>
      appendRound(state, { steps: [CLICK], screenshot: 'кадр-3' }),
    ).toThrow(DraftStepLimitError);
  });

  it('не мутирует исходное состояние', () => {
    const before = firstRound();
    appendRound(before, { steps: [CLICK], screenshot: 'кадр-2' });
    expect(before.steps).toHaveLength(1);
    expect(before.stepsPerRound).toEqual([1]);
  });
});

describe('undoLastRound', () => {
  it('снимает ВСЕ шаги последнего раунда, а не последний элемент массива', () => {
    const state = appendRound(firstRound(), {
      steps: [FILL('#email'), FILL('#pass'), CLICK],
      screenshot: 'кадр-2',
    });

    const { next, removedSteps } = undoLastRound(state, {
      lastRoundWasLive: false,
    });

    expect(removedSteps).toBe(3);
    expect(next.steps).toEqual([GOTO]);
    expect(next.stepsPerRound).toEqual([1]);
    expect(next.roundScreenshots).toEqual(['кадр-1']);
    assertRoundsConsistent(next);
  });

  it('отмена раунда живого входа запрещена — капчу заново не переиграть', () => {
    const state = appendRound(firstRound(), {
      steps: [{ kind: 'assertVisible', selector: '#account' }],
      screenshot: 'кадр-2',
      live: true,
    });

    expect(() => undoLastRound(state, { lastRoundWasLive: true })).toThrow(
      UndoNotPossibleError,
    );
  });

  it('первый раунд отменить нельзя — он задаёт исходную страницу', () => {
    expect(() =>
      undoLastRound(firstRound(), { lastRoundWasLive: false }),
    ).toThrow(UndoNotPossibleError);
  });

  it('пустой черновик отменять нечего', () => {
    expect(() =>
      undoLastRound(emptyState(), { lastRoundWasLive: false }),
    ).toThrow(UndoNotPossibleError);
  });

  it('рассогласованный черновик не «чинится» тихо', () => {
    const broken: DraftRoundsState = {
      steps: [GOTO],
      stepsPerRound: [1, 5],
      roundScreenshots: ['a', 'b'],
      requiresLiveLoginReplay: false,
    };
    expect(() => undoLastRound(broken, { lastRoundWasLive: false })).toThrow(
      DraftRoundMismatchError,
    );
  });

  it('флаг live не сбрасывается отменой более позднего обычного раунда', () => {
    let state = firstRound();
    state = appendRound(state, {
      steps: [{ kind: 'assertVisible', selector: '#account' }],
      screenshot: 'кадр-2',
      live: true,
    });
    state = appendRound(state, { steps: [CLICK], screenshot: 'кадр-3' });

    const { next } = undoLastRound(state, { lastRoundWasLive: false });
    expect(next.requiresLiveLoginReplay).toBe(true);
  });
});

describe('replaceLastScreenshot', () => {
  it('замещает последний кадр, а не дополняет ленту', () => {
    const state = replaceLastScreenshot(firstRound(), 'кадр-после-отмены');
    expect(state.roundScreenshots).toEqual(['кадр-после-отмены']);
  });

  it('без кадров — явная ошибка', () => {
    expect(() => replaceLastScreenshot(emptyState(), 'x')).toThrow(
      DraftRoundMismatchError,
    );
  });
});

describe('assertRoundsConsistent', () => {
  it('ловит расхождение числа кадров и раундов', () => {
    expect(() =>
      assertRoundsConsistent({
        steps: [GOTO],
        stepsPerRound: [1],
        roundScreenshots: [],
        requiresLiveLoginReplay: false,
      }),
    ).toThrow(DraftRoundMismatchError);
  });

  it('ловит расхождение суммы stepsPerRound и числа шагов', () => {
    expect(() =>
      assertRoundsConsistent({
        steps: [GOTO, CLICK],
        stepsPerRound: [1],
        roundScreenshots: ['a'],
        requiresLiveLoginReplay: false,
      }),
    ).toThrow(DraftRoundMismatchError);
  });
});

describe('assertSameOrigin — доменный замок §8.1', () => {
  const base = 'https://shop.example.com';

  it('пускает переходы внутри того же origin', () => {
    expect(() =>
      assertSameOrigin(base, 'https://shop.example.com/cabinet?tab=1'),
    ).not.toThrow();
  });

  it('другой хост, поддомен, схема и порт — всё за пределами замка', () => {
    for (const bad of [
      'https://evil.example.net/login',
      'https://www.shop.example.com/',
      'http://shop.example.com/',
      'https://shop.example.com:8443/',
    ]) {
      expect(() => assertSameOrigin(base, bad)).toThrow(DomainLockError);
    }
  });

  it('некорректные URL не проходят молча', () => {
    expect(() => assertSameOrigin(base, 'не url')).toThrow(DomainLockError);
    expect(() => assertSameOrigin('не url', base)).toThrow(DomainLockError);
  });
});

describe('assertEditable', () => {
  it('DRAFTING редактируется', () => {
    expect(() => assertEditable('DRAFTING')).not.toThrow();
  });

  it('остальные статусы — понятная причина отказа, а не общая ошибка', () => {
    for (const status of ['PENDING_REVIEW', 'APPROVED', 'REJECTED'] as const) {
      expect(() => assertEditable(status)).toThrow(DraftStatusError);
    }
    expect(() => assertEditable('PENDING_REVIEW')).toThrow(/оператора/);
    expect(() => assertEditable('APPROVED')).toThrow(/сборку/);
    expect(() => assertEditable('REJECTED')).toThrow(/верните/);
  });
});
