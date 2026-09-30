/**
 * Три состояния мастера поздравления — какой проект какому экрану
 * (29.09.2026).
 *
 * Проверяется чистая функция без базы, потому что ошибка здесь молчит:
 * маршрут откроется, кадр снимется, ролик соберётся — и покажет не тот
 * экран. Падения не будет ни на одном шаге.
 */

import { SessionStatus } from '../../common/types/session.types';
import { GenerationStatus } from '../../common/types/generation.types';
import { FIXTURE_IDS } from './fixture-seed';
import { greetingContext } from './tutorial-scenario-runner.service';

const p = (id: string, ...statuses: SessionStatus[]) => ({
  id,
  sessions: statuses.map((status) => ({ status })),
});

describe('greetingContext', () => {
  it('проект без сессий — экран брифа', () => {
    expect(greetingContext([p('a')])).toEqual({ greetingProjectId: 'a' });
  });

  it('последняя сессия без сценария — экран «собрать сценарий»', () => {
    expect(greetingContext([p('a', SessionStatus.CREATED)])).toEqual({
      greetingDraftingProjectId: 'a',
    });
  });

  it('последняя сессия со сценарием — экран всех девяти карточек', () => {
    expect(greetingContext([p('a', SessionStatus.PROMPT_GENERATED)])).toEqual({
      greetingReadyProjectId: 'a',
    });
  });

  /**
   * Статус сессии только растёт: готовый ролик — это тоже «сценарий
   * собран», и карточки на экране те же. Отнести его к «сценария нет»
   * значило бы открыть сценарию экран, где кнопки «собрать сценарий»
   * давно нет.
   */
  it('статус сессии дальше сценария, а рендера нет (generationStatus null) — экран со сценарием', () => {
    // Статус мастера и статус рендера — разные колонки: здесь `status`
    // ушёл вперёд, а `generationStatus` пуст — готового ролика нет, и
    // экран тот же, что у «сценарий собран».
    for (const status of [
      SessionStatus.VIDEO_COMPLETE,
      SessionStatus.GENERATING_VIDEO,
    ]) {
      expect(
        greetingContext([
          { id: 'a', sessions: [{ status, generationStatus: null }] },
        ]),
      ).toEqual({ greetingReadyProjectId: 'a' });
    }
  });

  it('три проекта дают три разных поля — это и есть три экрана', () => {
    expect(
      greetingContext([
        p('fresh'),
        p('draft', SessionStatus.CREATED),
        p('ready', SessionStatus.PROMPT_GENERATED),
      ]),
    ).toEqual({
      greetingProjectId: 'fresh',
      greetingDraftingProjectId: 'draft',
      greetingReadyProjectId: 'ready',
    });
  });

  it('состояние читает ПОСЛЕДНЯЯ сессия, а не любая подходящая', () => {
    // Запрос отдаёт сессии от новых к старым и берёт одну. Если бы
    // состояние выводилось из «была когда-нибудь сессия со статусом X»,
    // проект со сценарием попал бы и в «сценария нет» тоже — и сценарий
    // ждал бы кнопку, которой на экране давно нет.
    expect(
      greetingContext([
        p('a', SessionStatus.PROMPT_GENERATED, SessionStatus.CREATED),
      ]),
    ).toEqual({ greetingReadyProjectId: 'a' });
  });

  it('первый подходящий занимает поле, остальные не перетирают', () => {
    expect(greetingContext([p('first'), p('second')])).toEqual({
      greetingProjectId: 'first',
    });
  });

  it('проектов нет — контекст пуст, маршрут откажет НАЗВАННОЙ причиной', () => {
    expect(greetingContext([])).toEqual({});
  });

  /**
   * Четвёртое состояние — «ролик готов» (этап I ТЗ Greeting 2.0, кадр 4
   * лендинга). Рендер поздравления `status` НЕ двигает, готовность видна
   * только в `generationStatus`. Без этого различия фикстурный проект с
   * роликом — самый свежий — забирал бы «сценарий собран», и сценарий
   * хука `greeting-render` ждал бы кнопку, которую ролик прячет.
   */
  it('готовый ролик — отдельное состояние, а не «сценарий собран»', () => {
    const done = {
      id: 'done',
      sessions: [
        {
          status: SessionStatus.PROMPT_GENERATED,
          generationStatus: GenerationStatus.COMPLETE,
        },
      ],
    };
    const ready = {
      id: 'ready',
      sessions: [
        { status: SessionStatus.PROMPT_GENERATED, generationStatus: null },
      ],
    };
    expect(greetingContext([done, ready])).toEqual({
      greetingDoneProjectId: 'done',
      greetingReadyProjectId: 'ready',
    });
  });

  it('рендер в пути или упал — ни одно состояние: кнопки уже нет, ролика ещё нет', () => {
    for (const generationStatus of [
      GenerationStatus.PENDING,
      GenerationStatus.PROCESSING,
      GenerationStatus.FAILED,
    ]) {
      expect(
        greetingContext([
          {
            id: 'busy',
            sessions: [
              { status: SessionStatus.PROMPT_GENERATED, generationStatus },
            ],
          },
          {
            id: 'ready',
            sessions: [{ status: SessionStatus.PROMPT_GENERATED }],
          },
        ]),
      ).toEqual({ greetingReadyProjectId: 'ready' });
    }
  });

  /**
   * Аудит этапа I: фикстурный проект под кадр 4 заведён ПОСЛЕДНИМ, и
   * отбор «самый свежий первым» отдавал его чужим полям — ночные хуки
   * писали бы в сессию, из которой рендерится ролик лендинга.
   */
  describe('проект под кадр «готовый ролик» — только своё поле', () => {
    const DONE = FIXTURE_IDS.greetingDoneProject;
    // Порядок как у запроса: самый свежий первым — done впереди.
    const older = [
      { id: 'fresh', sessions: [] },
      { id: 'draft', sessions: [{ status: SessionStatus.CREATED }] },
      {
        id: 'ready',
        sessions: [
          { status: SessionStatus.PROMPT_GENERATED, generationStatus: null },
        ],
      },
    ];
    const three = {
      greetingProjectId: 'fresh',
      greetingDraftingProjectId: 'draft',
      greetingReadyProjectId: 'ready',
    };

    it('сессия CREATED — не «сценария нет»', () => {
      expect(
        greetingContext([
          { id: DONE, sessions: [{ status: SessionStatus.CREATED }] },
          ...older,
        ]),
      ).toEqual(three);
    });

    it('сессию снёс крон уборки — не «сессии нет»', () => {
      expect(greetingContext([{ id: DONE, sessions: [] }, ...older])).toEqual(
        three,
      );
    });

    it('сценарий собран, ролика нет — не «сценарий собран»', () => {
      expect(
        greetingContext([
          {
            id: DONE,
            sessions: [
              {
                status: SessionStatus.PROMPT_GENERATED,
                generationStatus: null,
              },
            ],
          },
          ...older,
        ]),
      ).toEqual(three);
    });

    it('ролик готов — своё поле, остальные три не тронуты', () => {
      expect(
        greetingContext([
          {
            id: DONE,
            sessions: [
              {
                status: SessionStatus.PROMPT_GENERATED,
                generationStatus: GenerationStatus.COMPLETE,
              },
            ],
          },
          ...older,
        ]),
      ).toEqual({ ...three, greetingDoneProjectId: DONE });
    });

    it('других проектов нет — три поля пусты, а не заняты им', () => {
      expect(greetingContext([{ id: DONE, sessions: [] }])).toEqual({});
    });
  });
});
