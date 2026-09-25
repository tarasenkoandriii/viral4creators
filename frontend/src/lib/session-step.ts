/**
 * На каком шаге мастера продолжить сохранённую сессию (этап 39, А-2.7).
 *
 * ## Что чинится
 *
 * Мастер всегда стартовал с шага «Видео», сколько бы состояния ни лежало
 * в сессии. Свернули Mini App на время рендера, вернулись — и вы на шаге
 * 1, а готовый оплаченный ролик недостижим интерфейсом никак. Ролик при
 * этом жив: он лежит в хранилище, и сессия про него знает.
 *
 * ## Почему по `status`, а не по наличию полей
 *
 * `status` ведёт сервер, и он же — источник истины для остальной логики.
 * Восстанавливать шаг по «есть ли `generationPrompt`» значит завести
 * вторую, независимую машину состояний, которая рано или поздно разойдётся
 * с первой. Поля читаются только там, где `status` заведомо огрубляет:
 * `generating_video` не различает «идёт» и «уже готов», а между ними
 * пропасть — во втором случае показывать спиннер нельзя.
 *
 * ## Чего эта функция НЕ делает
 *
 * Не пропускает вперёд. Если сессия дошла до промпта, вернуться к разбору
 * пользователь сможет сам; а вот отправить его на шаг «Генерация» с
 * кнопкой «Сгенерировать», когда рендер уже идёт, было бы прямым
 * приглашением заплатить дважды — поэтому идущий рендер возвращает свой
 * шаг, а вызывающий обязан возобновить опрос (см. `useWorkflow`).
 */

export type WorkflowStep =
  | 'upload'
  | 'analyzing'
  | 'analysis-complete'
  | 'product-input'
  | 'prompt-generation'
  | 'video-generation'
  | 'complete';

export interface RestorableSession {
  status?: string;
  generatedVideo?: { status?: string } | null;
  generationPrompt?: { approvedAt?: string } | null;
  videoAnalysis?: { status?: string } | null;
  /** Приём сцены вместо референса (этап 150, TODO §III п.11). */
  sceneTemplate?: { templateId?: string } | null;
}

/**
 * Сессия идёт по приёму, а не по референсу.
 *
 * Зеркало серверного `usesTemplate` (`common/scene-templates.ts`), и
 * ключ тот же — ЗАВЕРШЁННОСТЬ разбора, а не наличие записи: у сессии с
 * провалившимся разбором и выбранным приёмом промпт собирается по
 * приёму, и экран обязан говорить то же самое, что сервер.
 */
export function onSceneTemplate(
  session: RestorableSession | null | undefined
): boolean {
  return usesSceneTemplate(
    session?.videoAnalysis?.status,
    !!session?.sceneTemplate?.templateId
  );
}

/**
 * То же правило по двум фактам, а не по сессии.
 *
 * Нужно отдельно, потому что экран держит эти два факта в РАЗНЫХ местах
 * состояния и они меняются независимо: приём приходит от выбора, разбор
 * — от загрузки референса. Хранить готовый ответ значило бы хранить
 * производную величину, которая устаревает молча, — ровно это и
 * случилось (аудит этапа 151, А-1): человек выбирал приём, потом всё
 * же загружал референс, и степпер оставался укороченным навсегда, то
 * есть без позиции «Анализ» и без доступа к разбору, за который
 * заплачено.
 */
export function usesSceneTemplate(
  analysisStatus: string | null | undefined,
  templateChosen: boolean
): boolean {
  if (analysisStatus === 'complete') return false;
  return templateChosen;
}

/** Рендер идёт прямо сейчас: опрос надо возобновить, кнопку — не показывать. */
export function isRenderInFlight(
  session: RestorableSession | null | undefined
): boolean {
  const s = session?.generatedVideo?.status;
  return s === 'pending' || s === 'processing';
}

export function stepFromSession(
  session: RestorableSession | null | undefined
): WorkflowStep {
  if (!session) return 'upload';

  // М-7.5 седьмого аудита: промпт пересобран после готового ролика
  // (смена режима озвучки, ревизия) — сервер поставил `prompt_generated`
  // и снял одобрение, а старый ролик в сессии остался. Показывать после
  // reload экран СТАРОГО ролика — прятать новый непринятый промпт.
  if (
    session.status === 'prompt_generated' &&
    !session.generationPrompt?.approvedAt
  ) {
    return 'prompt-generation';
  }

  // Готовый ролик — вне зависимости от `status`: постобработка могла
  // оставить сессию в `generating_video`, а ролик у пользователя уже есть.
  if (session.generatedVideo?.status === 'complete') return 'complete';
  if (isRenderInFlight(session)) return 'video-generation';

  // Упавший рендер — тоже вне зависимости от `status` (Б-2.5).
  //
  // `markFailed` ставит сессии `status: 'error'`, а ветка `'error'` ниже
  // отправляет к выбору референса: она писалась под сбой РАЗБОРА
  // (А-2.8), но этот статус ставят оба сбоя. После падения Veo
  // пользователь оказывался на шаге 1, хотя разбор и утверждённый промпт
  // живы; интерфейс к ним не вёл, а новый референс сбрасывал их и
  // запускал новый платный разбор.
  if (session.generatedVideo?.status === 'failed') return 'video-generation';

  switch (session.status) {
    case 'video_complete':
      // Статус говорит «готово», а ролика в сессии нет: данные разошлись.
      // Отправлять на экран результата, где нечего показать, — худший из
      // вариантов; возвращаем на шаг генерации, оттуда есть выход.
      return 'video-generation';
    case 'generating_video':
      return 'video-generation';
    case 'prompt_generated':
      return session.generationPrompt?.approvedAt
        ? 'video-generation'
        : 'prompt-generation';
    case 'product_info_added':
      return 'prompt-generation';
    case 'analysis_complete':
      return 'analysis-complete';
    case 'analyzing':
      // Разбор мог закончиться, пока приложение было свёрнуто, — но
      // проверять это здесь нечем: экран разбора сам опрашивает статус.
      return 'analyzing';
    case 'error':
      // Сбой разбора: возвращаем к выбору референса, а не в пустой экран.
      //
      // Кроме случая, когда приём уже выбран (этап 150): разбор упал, но
      // ролик собирается по приёму, и отправлять человека выбирать
      // референс заново значило бы прятать от него живой путь вперёд.
      return onSceneTemplate(session) ? 'product-input' : 'upload';
    default:
      // Приём выбран, разбора нет и не будет — шага «Анализ» у этой
      // сессии не существует вовсе, следующий шаг сразу товар.
      return onSceneTemplate(session) ? 'product-input' : 'upload';
  }
}

/**
 * Позиции степпера товарки. Их пять, а состояний воркфлоу семь:
 * `analyzing` и `analysis-complete` делят одну позицию, а `complete`
 * не занимает ни одной — это состояние ПОСЛЕ последнего шага.
 */
export const STEPPER_IDS = [
  'upload',
  'analysis',
  'product',
  'prompt',
  'video',
] as const;
export type StepperId = (typeof STEPPER_IDS)[number];

/**
 * Позиции степпера у сессии на ПРИЁМЕ сцены (этап 151).
 *
 * «Анализа» здесь нет — не спрятан, а не существует: разбирать нечего,
 * позиция и так была некликабельной с этапа 150. Серая подпись шага,
 * которого у человека не будет никогда, — это обещание работы, которой
 * не случится, и вопрос «а почему он не идёт».
 */
export const TEMPLATE_STEPPER_IDS = [
  'upload',
  'product',
  'prompt',
  'video',
] as const;

export function stepperIdsFor(onTemplate: boolean): readonly StepperId[] {
  return onTemplate ? TEMPLATE_STEPPER_IDS : STEPPER_IDS;
}

/**
 * Подписи позиций.
 *
 * Общий список подписей ОДИН, и это не экономия: три из четырёх
 * подписей у обоих путей совпадают дословно, и второй массив в пяти
 * локалях был бы пятью местами, где они разойдутся. Отличается первая —
 * «Видео» у референса и «Сцена» у приёма, — и она одна и приходит
 * отдельным ключом.
 */
export function stepperLabels(
  onTemplate: boolean,
  labels: readonly string[],
  sourceLabel: string
): string[] {
  const byId: Record<StepperId, string> = {
    upload: onTemplate ? sourceLabel : labels[0],
    analysis: labels[1],
    product: labels[2],
    prompt: labels[3],
    video: labels[4],
  };
  // `?? id` достижим: подписи приходят массивом из словаря, и локаль с
  // коротким массивом дала бы `undefined` — пустой кружок без названия.
  // Английский идентификатор вместо пустоты уродлив, но читаем, а
  // счётчик подписей под отдельным тестом (`wizard-steps.test.ts`).
  return stepperIdsFor(onTemplate).map((id) => byId[id] ?? id);
}

/**
 * Состояние воркфлоу → позиция степпера. `null` означает «все шаги
 * пройдены»: до перехода на общий контракт это выражалось индексом 5
 * при пяти подписях, то есть выходом за границу массива
 * (docs-tz/TZ-Tonkaya-Krasnaya-Liniya.md §4.3).
 */
export function stepperIdOf(step: WorkflowStep): StepperId | null {
  switch (step) {
    case 'upload':
      return 'upload';
    case 'analyzing':
    case 'analysis-complete':
      return 'analysis';
    case 'product-input':
      return 'product';
    case 'prompt-generation':
      return 'prompt';
    case 'video-generation':
      return 'video';
    case 'complete':
      return null;
    default:
      return 'upload';
  }
}
