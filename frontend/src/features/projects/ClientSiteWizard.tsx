/**
 * ClientSiteWizard — визард обучалки по САЙТУ ЗАКАЗЧИКА (§11
 * doc/CLIENT-SITE-TUTORIAL-SPEC.md, этап 115).
 *
 * Три состояния одного экрана, а не три маршрута: между ними нельзя
 * ходить свободно — они строго последовательны, и адрес, по которому
 * можно «вернуться на экран 2», без черновика ничего не значит.
 *
 * ## Что здесь принципиально
 *
 * 1. **Кадр — не украшение, а единственный способ понять, что
 *    происходит.** Пользователь не видит сайт заказчика напрямую:
 *    браузер живёт на сервере. Поэтому `<img>` со скриншотом идёт
 *    первым, а форма — под ним.
 * 2. **Форма собирается из того, что РЕАЛЬНО нашлось на странице.**
 *    Никаких «введите логин и пароль» вслепую: поля приходят с
 *    сервера вместе со своими подписями и селекторами, и обратно
 *    уезжают те же селекторы. Фронтенд их не строит и не разбирает.
 * 3. **Раунд ≠ шаг.** Лента миниатюр зеркалит `stepsPerRound` (по
 *    одному кадру на раунд), а не `steps`: форма из трёх полей и
 *    кнопки — это один кадр, а не четыре (§15 п.3).
 * 4. **Предупреждение про необратимое приходит ДО нажатия.** Стоп-лист
 *    §8.3 помечает кнопки в `elements[].danger`, то есть раундом
 *    раньше, — поэтому «вы уверены?» спрашивается в момент выбора, а
 *    не после того, как заказ оформлен.
 * 5. **Обычная форма НЕ шифруется.** Значения обычных полей уезжают в
 *    сценарий как есть; шифруются только те, что прошли через вход.
 *    Об этом сказано прямо под формой, а не в справке: для
 *    self-service, где человек гоняет свой же чек-аут, вероятность
 *    случайно ввести настоящие данные не нулевая (§14 п.3).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Download,
  Globe,
  KeyRound,
  Search,
  Send,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  Field,
  Input,
  Select,
  Spinner,
} from '../../components/ui';
import {
  completeLiveLogin,
  deleteSiteTutorial,
  exploreSite,
  finishSiteTutorial,
  getSiteTutorial,
  loginSite,
  refreshSiteTutorial,
  resumeSiteTutorial,
  startLiveLogin,
  stepSite,
  undoSiteRound,
} from '../../services/client-site-tutorial-api';
import { errorMessage } from '../../services/projects-api';
import { navigate, routes } from '../../lib/router';
import { useI18n } from '../../lib/i18n-context';
import type {
  ClientSiteDraftView,
  ClientSiteRoundResult,
  LiveLoginStart,
  PageElement,
  PageExploration,
} from '../../types/client-site-tutorial';
import { LiveLoginSession } from './LiveLoginSession';
import { ScreenHeader } from './shared';
import { Stepper } from '../../components/ui';
import { ReadinessPanel } from '../../components/ReadinessPanel';
import { HintLine } from '../../components/HintLine';
import {
  getWizardGuide,
  setWizardGuide,
} from '../../services/wizard-guide-api';
import type { WizardGuideState } from '../../types';
import { toStepsView } from '../../lib/wizard-steps';
import {
  clientSiteFactsOf,
  clientSiteStageFromUrl,
  clientSiteStepOfStage,
  clientSiteSteps,
  clientSiteUrlStep,
  type ClientSiteStage,
  type ClientSiteStepId,
} from '../../lib/client-site-steps';
import {
  clickCandidates,
  fieldLabel,
  fillableFields,
  liveLoginVisible,
} from './client-site-elements';

/** Состояния экрана. Тип переехал в `lib/client-site-steps.ts` — там же
 * живут правила шагов, и держать два определения одного и того же было
 * бы приглашением им разойтись. */
type Stage = ClientSiteStage;

/** Пауза между опросами готовности ролика (Б-4). Пятнадцать секунд —
 * сборка слайд-шоу занимает минуты, а не секунды, и чаще спрашивать
 * значит только греть сеть. */
const VIDEO_POLL_INTERVAL_MS = 15_000;
/** Сорок попыток по пятнадцать секунд — десять минут. Дальше опрос
 * прекращается: застрявшую сборку фоновый цикл всё равно не оживит. */
const VIDEO_POLL_MAX_ATTEMPTS = 40;

export function ClientSiteWizard({
  projectId,
  step: urlStep,
}: {
  projectId: string;
  /** Сегмент адреса; `undefined` — первый шаг (ввод ссылки). */
  step?: string;
}) {
  const { dict } = useI18n();
  const t = dict.clientSiteWizard;

  const [stage, setStage] = useState<Stage>('loading');
  const [draft, setDraft] = useState<ClientSiteDraftView | null>(null);
  const [exploration, setExploration] = useState<PageExploration | null>(null);
  const [url, setUrl] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState<string | null>(null);
  /** Открытая живая сессия: адрес потока, токен канала и квитанция —
   * её, а не `sessionId`, сервер ждёт обратно (подставленный клиентом
   * идентификатор указал бы на чужую сессию). */
  const [live, setLive] = useState<LiveLoginStart | null>(null);

  /**
   * Шаг из адреса на момент открытия экрана.
   *
   * Через ref, а не через зависимость эффекта: адрес после монтирования
   * пишем мы сами (см. синхронизацию ниже), и попади он в зависимости —
   * загрузка черновика пошла бы по кругу на каждый переход.
   */
  const initialStepRef = useRef(urlStep);

  /** Состояние чекбокса «использовать ИИ» (§3). `null` — ещё не
   * спросили; фича может быть выключена глобально, и тогда чекбокса
   * не будет вовсе. */
  const [guide, setGuide] = useState<WizardGuideState | null>(null);

  /**
   * Лента кадров. Копится в памяти ради мгновенного показа на экране
   * просмотра, но единственной копией НЕ является: сервер держит ту же
   * историю в черновике, и после перезагрузки вкладки она приезжает
   * оттуда (§15 п.1).
   */
  const frames = draft?.roundScreenshots ?? [];

  const applyRound = useCallback((result: ClientSiteRoundResult) => {
    setDraft(result.draft);
    setExploration(result.exploration);
    setValues({});
    setStage('page');
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Отдельным запросом и молча: чекбокс — украшение пути, и его
    // недоступность не должна мешать открыть визард.
    void getWizardGuide(projectId)
      .then((g) => {
        if (!cancelled) setGuide(g);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const toggleGuide = async (next: boolean): Promise<void> => {
    // Выключение необратимо до конца сценария, поэтому спрашиваем.
    // Без этой фразы правило превращается в ловушку: человек снимет
    // галочку «посмотреть, как без неё» и потеряет советы до конца
    // работы (§3.2).
    if (!next && !window.confirm(t.guideDisableConfirm)) return;
    const updated = await run(() => setWizardGuide(projectId, next));
    if (updated) setGuide(updated);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await getSiteTutorial(projectId);
        if (cancelled) return;
        if (!existing) {
          setStage('url');
          return;
        }
        setDraft(existing);
        setTitle(existing.title ?? '');
        // Свежего кадра у нас нет — он приходит только ответом на
        // раунд, и отрисовать экран страницы без него нечем. Поэтому
        // адрес `…/record` тоже открывается на просмотре: там лента
        // кадров, которую сервер сохранил сам, и она полная (§15 п.1),
        // а запись продолжается одной кнопкой. Звать `refresh` самим
        // значило бы поднять браузерную сессию на сервере без просьбы
        // человека.
        setStage(
          clientSiteStageFromUrl(
            initialStepRef.current,
            clientSiteFactsOf(existing)
          )
        );
      } catch (err) {
        if (cancelled) return;
        setError(errorMessage(err));
        // Иначе экран навсегда залипал в спиннере с красным алертом и
        // без единой кнопки (аудит этапа 116). Экран ссылки — рабочее
        // состояние: если черновик всё-таки есть, сервер ответит 409 и
        // скажет об этом.
        setStage('url');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Сборка ролика идёт во внешнем ffmpeg-api и подхватывается кроном —
   * то есть заканчивается через минуты после одобрения, когда экран уже
   * открыт. Без опроса человек видел бы «собирается» до тех пор, пока
   * сам не догадается перезайти, — а догадываться не обязан.
   *
   * Зависимость — БУЛЕВО `awaitingVideo`, а не сам черновик: иначе
   * каждый успешный опрос менял бы `draft`, перезапускал эффект и
   * заводил новый таймер поверх старого.
   *
   * Потолок попыток есть намеренно. Застрявшая сборка (внешний сервис
   * не ответил, задача потерялась) иначе опрашивалась бы вечно на
   * открытой вкладке. Десять минут — заметно больше типичной сборки
   * слайд-шоу из кадров; дальше честнее, чтобы человек вернулся сам,
   * чем чтобы фоновый цикл работал впустую.
   */
  const awaitingVideo =
    draft?.status === 'APPROVED' &&
    (draft.video === null || draft.video.status === 'pending');

  useEffect(() => {
    if (!awaitingVideo) return;
    let cancelled = false;
    let attempts = 0;
    const timer = window.setInterval(() => {
      attempts += 1;
      if (attempts > VIDEO_POLL_MAX_ATTEMPTS) {
        window.clearInterval(timer);
        return;
      }
      void (async () => {
        try {
          const fresh = await getSiteTutorial(projectId);
          if (!cancelled && fresh) setDraft(fresh);
        } catch {
          // Опрос фоновый: разовая сетевая неудача не должна рисовать
          // красный алерт поверх экрана, на котором человек ничего не
          // делал. Следующий тик попробует снова.
        }
      })();
    }, VIDEO_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [awaitingVideo, projectId]);

  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorMessage(err));
      // Любая неудача могла случиться ПОСЛЕ того, как сервер уже
      // записал раунд (оборвалась связь, клиентский таймаут короче
      // серверного). Тогда наш `version` устарел, и все следующие
      // вызовы получали бы 409 «обновите экран» — а обновить было
      // нечем (аудит этапа 116). Перечитываем состояние сами.
      try {
        const fresh = await getSiteTutorial(projectId);
        if (fresh) setDraft(fresh);
      } catch {
        // Сеть лежит целиком — сообщение об исходной ошибке важнее.
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  const explore = async () => {
    const trimmed = url.trim();
    // Клиентская проверка — только чтобы поймать явную опечатку. Она НЕ
    // заменяет серверную: публичность адреса проверяет SSRF-guard.
    try {
      const parsed = new URL(trimmed);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('scheme');
    } catch {
      setError(t.urlInvalid);
      return;
    }
    const result = await run(() => exploreSite(projectId, trimmed));
    if (result) applyRound(result);
  };

  const submitStep = async (clickSelector?: string) => {
    if (!draft) return;
    const fills = Object.entries(values)
      .filter(([, v]) => v.length > 0)
      .map(([selector, value]) => ({ selector, value }));
    if (fills.length === 0 && !clickSelector) {
      setError(t.nothingToDo);
      return;
    }
    const result = await run(() =>
      stepSite(projectId, {
        expectedVersion: draft.version,
        fills,
        clickSelector,
      })
    );
    if (result) applyRound(result);
  };

  const submitLogin = async (submitSelector: string) => {
    if (!draft || !exploration) return;
    const fields = fillableFields(exploration)
      .map((el) => ({
        selector: el.selector,
        value: values[el.selector] ?? '',
        // Пароль — всегда секретный; остальные поля формы входа тоже
        // считаем секретными: это часть учётных данных, а не данные
        // сценария.
        sensitive: true,
      }))
      .filter((f) => f.value.length > 0);
    if (fields.length === 0) {
      setError(t.loginEmpty);
      return;
    }
    const result = await run(() =>
      loginSite(projectId, {
        expectedVersion: draft.version,
        submitSelector,
        fields,
      })
    );
    if (result) applyRound(result);
  };

  const undo = async () => {
    if (!draft) return;
    const result = await run(() => undoSiteRound(projectId, draft.version));
    if (result) applyRound(result);
  };

  const liveLogin = async () => {
    const started = await run(() => startLiveLogin(projectId));
    if (!started) return;
    // Пультом живой сессии служит НАШ экран (`LiveLoginSession`), а не
    // отдельная вкладка: у реле нет HTML-страницы вовсе, `relayWsUrl` —
    // точка апгрейда WS. Этап 115 открывал её через `window.open`, и
    // живой вход не работал никогда — найдено аудитом этапа 116.
    setLive(started);
  };

  const finishLive = async () => {
    if (!live || !draft) return;
    const result = await run(() =>
      completeLiveLogin(projectId, live.ticket, draft.version)
    );
    if (result) {
      setLive(null);
      applyRound(result);
    }
  };

  const finish = async () => {
    if (!draft) return;
    const updated = await run(() =>
      finishSiteTutorial(projectId, {
        expectedVersion: draft.version,
        title: title.trim(),
      })
    );
    if (updated) {
      setDraft(updated);
      setNotice(t.sentForReview);
    }
  };

  /** Продолжить запись после перезагрузки вкладки: кадр приходит только
   * ответом на раунд, поэтому его надо снять заново. */
  const continueRecording = async () => {
    const result = await run(() => refreshSiteTutorial(projectId));
    if (result) applyRound(result);
  };

  const resume = async () => {
    const updated = await run(() => resumeSiteTutorial(projectId));
    if (updated) {
      setDraft(updated);
      setStage('review');
    }
  };

  const discard = async () => {
    // Единственный путь назад к вводу ссылки — и он не навигация:
    // черновик хранит шифрованные учётные данные и кадры в хранилище
    // (§4.4). Спрашиваем ровно потому, что отменить это нечем.
    if (!window.confirm(t.discardConfirm)) return;
    const done = await run(async () => {
      await deleteSiteTutorial(projectId);
      return true;
    });
    if (done) navigate(routes.project(projectId), true);
  };

  const canUndo = useMemo(
    () =>
      Boolean(draft) &&
      (draft?.stepsPerRound.length ?? 0) > 1 &&
      !(draft?.requiresLiveLoginReplay ?? false),
    [draft]
  );

  const editable = draft?.status === 'DRAFTING';

  const facts = clientSiteFactsOf(draft);
  const currentStepId = clientSiteStepOfStage(stage);

  /**
   * Адрес следует за состоянием, а не наоборот.
   *
   * Наоборот не выходит: переход на запись делает СЕРВЕР (`applyRound`),
   * и адрес, из которого визард пытался бы вывести состояние, вечно
   * отставал бы на один ответ. Поэтому состояние ведущее, а адрес —
   * его отражение, и `replace`, чтобы каждый шаг не оставлял записи в
   * истории браузера: «назад» должен уводить из визарда, а не
   * отматывать его по шагу.
   */
  useEffect(() => {
    if (stage === 'loading') return;
    const next = clientSiteUrlStep(stage);
    if (next !== urlStep) navigate(routes.siteTutorial(projectId, next), true);
  }, [stage, urlStep, projectId]);

  const goToStep = (id: ClientSiteStepId): void => {
    if (id === 'record') setStage('page');
    else if (id === 'review') setStage('review');
    else setStage('url');
  };

  // Подписи шагов в одном месте: их рисует степпер, ими же
  // подписываются кнопки советника (§5.7 — подпись берётся у нас, а не
  // из ответа модели).
  const stepLabels: Record<ClientSiteStepId, string> = {
    url: t.stepUrl,
    record: t.stepRecord,
    review: t.stepReview,
  };

  const stepsView = toStepsView(
    clientSiteSteps(facts, stepLabels),
    currentStepId === 'loading' ? 'url' : currentStepId
  );

  return (
    <div className="animate-fadeIn">
      <ScreenHeader
        title={t.title}
        back={routes.project(projectId)}
        hint={t.hint}
      />

      {/* Верхний уровень степпера: три состояния. Раунды записи
          нумеруются лентой внутри просмотра — их число заранее
          неизвестно, и степпер, обещающий конечный путь, врал бы. */}
      {stage !== 'loading' && (
        <Stepper
          steps={stepsView.steps}
          current={stepsView.current}
          selectable={stepsView.selectable}
          done={stepsView.done}
          onSelect={(i) => {
            const target = stepsView.targets[i];
            if (target) goToStep(target);
          }}
        />
      )}

      {/* Строка «до готового ролика» под степпером и на любом шаге:
          человек должен видеть остаток пути всё время, а не узнавать о
          нём, нажав «Готово» (§7.4). Считает её сервер той же функцией,
          которой проверяет барьер `finish()`. */}
      {stage !== 'loading' && draft && (
        <ReadinessPanel
          readiness={draft.readiness}
          onGoToStep={(stepId) => {
            const target = stepsView.targets.find((x) => x === stepId);
            if (target) goToStep(target);
          }}
        />
      )}

      {/* Совет на текущем шаге (§5.11). Лениво: строка рисуется
          свёрнутой, запрос уходит по клику или после простоя. Ключ по
          шагу не нужен — смену шага машина состояний обрабатывает
          сама, а перемонтирование теряло бы прочитанный текст. */}
      {stage !== 'loading' && currentStepId !== 'loading' && (
        <HintLine
          projectId={projectId}
          stepId={currentStepId}
          enabled={!!guide?.available && !!guide?.enabled}
          stepLabels={stepLabels}
          onGoToStep={(id) => {
            const target = stepsView.targets.find((x) => x === id);
            if (target) goToStep(target);
          }}
        />
      )}

      {error && (
        <Alert tone="error" className="mb-3">
          {error}
        </Alert>
      )}
      {notice && (
        <Alert tone="success" className="mb-3">
          {notice}
        </Alert>
      )}

      {stage === 'loading' && (
        <Card className="p-8 flex justify-center">
          <Spinner />
        </Card>
      )}

      {/* Чекбокс живёт на первом шаге и только там: включить советы
          можно ТОЛЬКО в начале сценария (§3.2). Дальше он исчезает —
          показывать недоступный переключатель значило бы обещать. */}
      {stage === 'url' && guide?.available && guide.canEnable && (
        <Card className="p-4 mb-3">
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={guide.enabled}
              disabled={busy}
              onChange={(e) => void toggleGuide(e.target.checked)}
            />
            <span>
              <span className="font-medium">{t.guideLabel}</span>
              <span className="block text-sm text-[var(--muted)]">
                {t.guideHint}
              </span>
            </span>
          </label>
        </Card>
      )}

      {/* Дальше по сценарию остаётся только выключатель — и только
          если советы включены. */}
      {stage !== 'url' &&
        stage !== 'loading' &&
        guide?.available &&
        guide.enabled && (
          <div className="mb-3 text-right">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => void toggleGuide(false)}
            >
              {t.guideDisable}
            </Button>
          </div>
        )}

      {stage === 'url' && (
        <Card className="p-5">
          <div className="space-y-5">
            <Field label={t.urlLabel} htmlFor="site-url" hint={t.urlHint}>
              <Input
                id="site-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://cabinet.example.com"
                disabled={busy}
                autoFocus
              />
            </Field>
            <Alert tone="info">{t.ownSiteOnly}</Alert>
            <Button
              block
              size="lg"
              icon={<Search size={16} />}
              disabled={busy || url.trim().length === 0}
              loading={busy}
              onClick={() => void explore()}
            >
              {t.exploreButton}
            </Button>
          </div>
        </Card>
      )}

      {stage === 'page' && exploration && (
        <PageStage
          t={t}
          exploration={exploration}
          values={values}
          setValues={setValues}
          busy={busy || !editable}
          canUndo={canUndo && editable}
          liveAvailable={liveLoginVisible(exploration, {
            relayConfigured: draft?.liveLoginAvailable ?? false,
            editable,
          })}
          live={live}
          onStep={submitStep}
          onLogin={submitLogin}
          onUndo={undo}
          onLive={liveLogin}
          onFinishLive={finishLive}
          onCancelLive={() => setLive(null)}
          onReview={() => setStage('review')}
        />
      )}

      {stage === 'review' && draft && (
        <ReviewStage
          t={t}
          draft={draft}
          frames={frames}
          title={title}
          setTitle={setTitle}
          busy={busy}
          editable={editable}
          onZoom={setZoomed}
          onBack={() => setStage('page')}
          canContinue={editable}
          hasExploration={Boolean(exploration)}
          onContinue={continueRecording}
          onFinish={finish}
          onResume={resume}
          onDiscard={discard}
        />
      )}

      {zoomed && (
        <button
          type="button"
          className="fixed inset-0 z-50 bg-black/90 flex items-center justify-center p-4"
          onClick={() => setZoomed(null)}
          aria-label={t.closePreview}
        >
          <img src={zoomed} alt="" className="max-h-full max-w-full" />
        </button>
      )}
    </div>
  );
}

type Dict = ReturnType<typeof useI18n>['dict']['clientSiteWizard'];

/**
 * Поле формы страницы заказчика. `<select>` рисуется настоящим
 * выпадающим списком: `fill` сопоставляет строку со ЗНАЧЕНИЕМ опции, а
 * не с видимой надписью, — человек, вводящий «Москва» в текстовое поле,
 * получал отказ «поле не заполняется» и не мог угадать, что нужно
 * `msk` (найдено аудитом этапа 116, закрыто этапом 117).
 */
function PageField(props: {
  id: string;
  element: PageElement;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  type?: string;
  placeholder: string;
}) {
  const { element } = props;
  if (element.tag === 'select' && element.options?.length) {
    return (
      <Select
        id={props.id}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.disabled}
      >
        <option value="">{props.placeholder}</option>
        {element.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <Input
      id={props.id}
      type={props.type}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value)}
      disabled={props.disabled}
    />
  );
}

function PageStage(props: {
  t: Dict;
  exploration: PageExploration;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  busy: boolean;
  canUndo: boolean;
  liveAvailable: boolean;
  live: LiveLoginStart | null;
  onStep: (clickSelector?: string) => void;
  onLogin: (submitSelector: string) => void;
  onUndo: () => void;
  onLive: () => void;
  onFinishLive: () => void;
  onCancelLive: () => void;
  onReview: () => void;
}) {
  const {
    t,
    exploration,
    values,
    setValues,
    busy,
    canUndo,
    liveAvailable,
    live,
  } = props;
  const fields = fillableFields(exploration);
  const candidates = clickCandidates(exploration);
  const [confirming, setConfirming] = useState<PageElement | null>(null);
  // Карточка «вы уверены?» не должна пережить смену страницы: селектор
  // в ней относится к УЖЕ показанному кадру, а после раунда DOM другой
  // (аудит этапа 116).
  useEffect(() => {
    setConfirming(null);
    setLoginSubmit(null);
  }, [exploration]);

  const set = (selector: string, value: string) =>
    setValues({ ...values, [selector]: value });

  /**
   * Кнопка отправки формы входа выбирается ЧЕЛОВЕКОМ, а не берётся
   * первой попавшейся (аудит этапа 116). `candidates[0]` — это первый
   * кликабельный элемент по DOM, то есть чаще всего ссылка из шапки
   * («На главную»), а не «Войти»: креды при этом уже зашифрованы и
   * сохранены, а вход не происходит.
   */
  const [loginSubmit, setLoginSubmit] = useState<string | null>(null);
  const submitSelector = loginSubmit ?? candidates[0]?.selector;

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <img
          src={exploration.screenshotDataUrl}
          alt=""
          className="w-full rounded border border-[var(--border)]"
        />
        <p className="mt-2 text-xs text-[var(--muted)] break-all">
          {exploration.currentUrl}
        </p>
      </Card>

      {exploration.dangerWarning && (
        <Alert tone="warning">{exploration.dangerWarning}</Alert>
      )}

      {exploration.looksLikeLogin ? (
        <Card className="p-5 space-y-4">
          <h3 className="font-semibold flex items-center gap-2">
            <KeyRound size={16} /> {t.loginTitle}
          </h3>
          <Alert tone="info">{t.loginNote}</Alert>
          {fields.map((el, i) => (
            <Field
              key={el.selector}
              label={fieldLabel(el, `${t.fieldFallback} ${i + 1}`)}
              htmlFor={`f-${i}`}
            >
              <PageField
                id={`f-${i}`}
                element={el}
                type={el.type === 'password' ? 'password' : 'text'}
                value={values[el.selector] ?? ''}
                onChange={(v) => set(el.selector, v)}
                disabled={busy}
                placeholder={t.selectPlaceholder}
              />
            </Field>
          ))}
          {candidates.length > 0 ? (
            <>
              <p className="text-sm text-[var(--muted)]">{t.loginPickButton}</p>
              <div className="flex flex-wrap gap-2">
                {candidates.map((el) => (
                  <Button
                    key={el.selector}
                    size="sm"
                    variant={
                      el.selector === submitSelector ? 'solid' : 'outline'
                    }
                    disabled={busy}
                    onClick={() => setLoginSubmit(el.selector)}
                  >
                    {el.visibleText}
                  </Button>
                ))}
              </div>
              <Button
                block
                disabled={busy || !submitSelector}
                loading={busy}
                onClick={() => submitSelector && props.onLogin(submitSelector)}
              >
                {t.loginButton}
              </Button>
            </>
          ) : (
            // Кнопка входа не распозналась (частый случай:
            // `<input type="submit">` или кнопка из одной иконки).
            // Честно говорим об этом, а не оставляем «Войти» вечно
            // серой без объяснений.
            <Alert tone="warning">{t.loginNoButton}</Alert>
          )}
        </Card>
      ) : (
        fields.length > 0 && (
          <Card className="p-5 space-y-4">
            <h3 className="font-semibold">{t.formTitle}</h3>
            {fields.map((el, i) => (
              <Field
                key={el.selector}
                label={fieldLabel(el, `${t.fieldFallback} ${i + 1}`)}
                htmlFor={`f-${i}`}
              >
                <PageField
                  id={`f-${i}`}
                  element={el}
                  value={values[el.selector] ?? ''}
                  onChange={(v) => set(el.selector, v)}
                  disabled={busy}
                  placeholder={t.selectPlaceholder}
                />
              </Field>
            ))}
            {/* §14 п.3: обычная форма уезжает в сценарий как есть. */}
            <Alert tone="warning">{t.plainValuesWarning}</Alert>
          </Card>
        )
      )}

      {/*
        Живой вход НЕ спрятан под `exploration.looksLikeLogin` — и это
        осознанно. Тот флаг выставляется ровно одним признаком: видимым
        `<input type="password">` (см. `page-exploration.ts`). А живой
        вход существует именно ради логинов, где пароля на странице нет:
        первый экран Google SSO — это кнопка «Continue with Google»,
        Telegram Login Widget живёт в кроссдоменном iframe и в DOM
        верхнего фрейма не виден вовсе, magic link по почте поля пароля
        не имеет никогда. То есть под старым условием кнопка не
        появлялась ровно в тех случаях, ради которых фича и сделана.

        Расширять сам `looksLikeLogin` эвристиками («есть кнопка Войти»,
        «URL вида /login») здесь нельзя: он переключает ВЕТКУ выше —
        форму учётных данных вместо списка шагов. На SSO-странице полей
        нет, и такая ветка показала бы пустую форму с предупреждением
        «кнопка входа не распозналась» вместо рабочего списка шагов,
        то есть сделала бы хуже.

        Цена ложного показа: одна живая сессия из суточного лимита
        (`reserveLiveSession`, §15.7), и только если человек СПЕЦИАЛЬНО
        нажмёт кнопку. Цена пропуска — неработающая фича. Поэтому блок
        живёт отдельной карточкой и зависит только от того, настроено
        ли реле.
      */}
      {liveAvailable && (
        <Card className="p-5 space-y-2">
          <p className="text-sm text-[var(--muted)]">{t.liveHint}</p>
          {live ? (
            <LiveLoginSession
              wsUrl={live.relayWsUrl}
              streamToken={live.streamToken}
              busy={busy}
              onDone={props.onFinishLive}
              // Сессия могла истечь (потолок реле — три минуты) или
              // закончиться не на том домене; без выхода отсюда
              // «Я вошёл» отвечала бы 409 вечно, а начать заново
              // было нечем (аудит этапа 116).
              onCancel={props.onCancelLive}
            />
          ) : (
            <Button
              block
              variant="outline"
              icon={<Globe size={16} />}
              disabled={busy}
              onClick={props.onLive}
            >
              {t.liveButton}
            </Button>
          )}
        </Card>
      )}

      {/*
        На странице входа этот блок НЕ показывается (аудит этапа 116).
        Он повторяет надписи с реальной страницы, среди которых и
        настоящая «Войти» — нажав её здесь, человек отправлял бы
        `/step`, а не `/login`, то есть пароль уезжал бы в сценарий
        открытым текстом и попадал бы на экран оператора. Выбор кнопки
        входа живёт в блоке входа выше.
      */}
      {!exploration.looksLikeLogin && candidates.length > 0 && (
        <Card className="p-5 space-y-3">
          <h3 className="font-semibold">{t.continueWith}</h3>
          <div className="flex flex-wrap gap-2">
            {candidates.map((el) => (
              <Button
                key={el.selector}
                size="sm"
                variant={el.danger ? 'danger' : 'outline'}
                icon={el.danger ? <AlertTriangle size={14} /> : undefined}
                disabled={busy}
                onClick={() =>
                  el.danger ? setConfirming(el) : props.onStep(el.selector)
                }
              >
                {el.visibleText}
              </Button>
            ))}
          </div>
          <Button
            block
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => props.onStep(undefined)}
          >
            {t.fillOnlyButton}
          </Button>
        </Card>
      )}

      {confirming && (
        <Card className="p-5 space-y-3 border-[var(--danger)]">
          <p className="text-sm">{confirming.danger}</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => {
                const el = confirming;
                setConfirming(null);
                props.onStep(el.selector);
              }}
            >
              {t.dangerConfirm}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setConfirming(null)}
            >
              {t.dangerCancel}
            </Button>
          </div>
        </Card>
      )}

      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          icon={<Undo2 size={14} />}
          disabled={busy || !canUndo}
          onClick={props.onUndo}
        >
          {t.undoButton}
        </Button>
        <Button size="sm" onClick={props.onReview} disabled={busy}>
          {t.doneButton}
        </Button>
      </div>
    </div>
  );
}

function ReviewStage(props: {
  t: Dict;
  draft: ClientSiteDraftView;
  frames: string[];
  title: string;
  setTitle: (v: string) => void;
  busy: boolean;
  editable: boolean;
  canContinue: boolean;
  hasExploration: boolean;
  onZoom: (src: string) => void;
  onBack: () => void;
  onContinue: () => void;
  onFinish: () => void;
  onResume: () => void;
  onDiscard: () => void;
}) {
  const { t, draft, frames, busy, editable } = props;
  /** Ролик показывается только у одобренного черновика — у остальных
   * статусов его не существует, и сервер отдаёт `null` (Б-4). */
  const ready = draft.video;

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <h3 className="font-semibold mb-2">{t.previewTitle}</h3>
        {frames.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">{t.previewEmpty}</p>
        ) : (
          <div className="flex gap-2 overflow-x-auto pb-2">
            {frames.map((src, i) => (
              <button
                key={`${i}-${src.slice(-16)}`}
                type="button"
                onClick={() => props.onZoom(src)}
                className="shrink-0 relative"
                aria-label={`${t.frameLabel} ${i + 1}`}
              >
                <img
                  src={src}
                  alt=""
                  className="h-40 rounded border border-[var(--border)]"
                />
                {/* Номер прямо на кадре — нижний уровень степпера
                    (§4.4). Отдельным компонентом-степпером его не
                    нарисовать: кадров бывает полтора десятка, и на
                    телефоне такой степпер нечитаем (§4.7). */}
                <span className="absolute left-1 top-1 grid h-5 w-5 place-items-center rounded-full bg-black/70 text-[11px] font-semibold text-white tabular">
                  {i + 1}
                </span>
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-[var(--muted)]">
          {t.previewHint.replace('{count}', String(frames.length))}
        </p>
      </Card>

      {draft.status === 'PENDING_REVIEW' && (
        <Alert tone="info">{t.statusPending}</Alert>
      )}
      {/* Находка Б-4 аудита лендинга: раньше здесь заканчивалось всё —
          «ролик собирается» и больше ничего, никогда. Теперь у
          одобренного черновика три исхода, и у каждого свой экран. */}
      {draft.status === 'APPROVED' &&
        ready?.status === 'complete' &&
        ready.url && (
          <Card className="p-5 space-y-3">
            <div>
              <strong className="block">{t.videoReadyTitle}</strong>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {t.videoReadyHint}
                {ready.durationMs
                  ? ` ${t.videoDuration.replace(
                      '{seconds}',
                      String(Math.round(ready.durationMs / 1000))
                    )}`
                  : ''}
              </p>
            </div>
            {/* Тот же приём, что у готового рекламного ролика
              (`GenerationWizard`, «Скачать»): `window.open`, а не
              `<a download>`. Файл лежит в Blob на чужом origin, где
              атрибут `download` браузером игнорируется, — кнопка,
              обещающая скачивание и открывающая вкладку, хуже честной. */}
            <Button
              variant="outline"
              icon={<Download size={14} />}
              onClick={() => window.open(ready.url ?? '', '_blank')}
            >
              {t.videoOpen}
            </Button>
          </Card>
        )}
      {draft.status === 'APPROVED' && ready?.status === 'failed' && (
        <Alert tone="warning">{t.videoFailed}</Alert>
      )}
      {draft.status === 'APPROVED' &&
        ready?.status !== 'complete' &&
        ready?.status !== 'failed' && (
          <Alert tone="success">{t.statusApproved}</Alert>
        )}
      {draft.status === 'REJECTED' && (
        <Alert tone="warning">
          {t.statusRejected}
          {draft.rejectionReason ? ` ${draft.rejectionReason}` : ''}
        </Alert>
      )}

      {editable && (
        <Card className="p-5 space-y-4">
          <Field label={t.titleLabel} htmlFor="site-title" hint={t.titleHint}>
            <Input
              id="site-title"
              value={props.title}
              onChange={(e) => props.setTitle(e.target.value)}
              disabled={busy}
            />
          </Field>
          <Button
            block
            size="lg"
            icon={<Send size={16} />}
            disabled={busy || props.title.trim().length < 3}
            loading={busy}
            onClick={props.onFinish}
          >
            {t.submitButton}
          </Button>
        </Card>
      )}

      {draft.status === 'REJECTED' && (
        <Button
          block
          variant="outline"
          disabled={busy}
          onClick={props.onResume}
        >
          {t.resumeButton}
        </Button>
      )}

      <div className="flex gap-2">
        {props.hasExploration ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowLeft size={14} />}
            disabled={busy}
            onClick={props.onBack}
          >
            {t.backButton}
          </Button>
        ) : (
          props.canContinue && (
            // После перезагрузки вкладки свежего кадра нет — его надо
            // снять заново, и это стоит раунда. Поэтому отдельная
            // кнопка, а не молчаливый запрос при открытии экрана.
            <Button
              variant="ghost"
              size="sm"
              icon={<ArrowLeft size={14} />}
              disabled={busy}
              loading={busy}
              onClick={props.onContinue}
            >
              {t.continueButton}
            </Button>
          )
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Trash2 size={14} />}
          disabled={busy}
          onClick={props.onDiscard}
        >
          {t.discardButton}
        </Button>
      </div>
    </div>
  );
}
