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
      return 'upload';
    default:
      return 'upload';
  }
}
