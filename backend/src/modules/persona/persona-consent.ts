/**
 * Текст согласия режима «Я в кадре» (ТЗ Greeting 2.0 §4.1 п.1, §4.3).
 *
 * ТРЕБУЕТ ПРОВЕРКИ ЮРИСТОМ до выпуска (§4.10, юридический шлюз): тексты
 * написаны нейтрально и перечисляют только то, что код действительно
 * делает, — но это не юридическая редакция. Любое изменение смысла —
 * новая `PERSONA_CONSENT_VERSION`: версия сохраняется в строке персоны
 * вместе с текстом, который человек видел (`Persona.consentText`), и
 * клиент, приславший старую версию, получает отказ «перечитайте».
 *
 * Что текст обязан говорить и почему (сверено с кодом модуля persona):
 * - что берём: фото лица и ролик 3 с — только камерой приложения;
 * - зачем: образы, скетчи, ведущий в СВОИХ роликах; сходство не
 *   гарантировано (режим на референс-изображениях, §4 вступление);
 * - автопроверка: одно лицо, анфас, не экран, тот же человек — и что
 *   это НЕ подтверждение личности (Т-16: слова «подтверждена» нет);
 * - оценка возраста диапазоном: только для допуска (младше 18 — отказ,
 *   В-4), не для аналитики и рекламы (§4.4);
 * - кому передаётся: ИИ-провайдерам проверки и генерации;
 * - хранение: селфи и ролик — 30 дней после последнего образа (В-3,
 *   `PERSONA_SOURCES_RETENTION_DAYS`), образы — пока их не удалят;
 * - удаление: одной кнопкой, что удаляется и что остаётся (§4.9);
 * - только своё лицо (Т-21).
 * Голос — отдельная запись с фразой согласия вслух (§4.6), здесь только
 * упомянут, чтобы человек знал о нём заранее.
 */

import { normalizeLocale, SupportedLocale } from '../../common/locale';

/** Меняется при любом изменении смысла текста в любой локали. */
export const PERSONA_CONSENT_VERSION = '2026-09-30';

/** Срок хранения селфи и ролика живости после последнего образа (В-3). */
export const PERSONA_SOURCES_RETENTION_DAYS = 30;

// ТРЕБУЕТ ПРОВЕРКИ ЮРИСТОМ (§4.10) — все пять редакций ниже.
const TEXTS: Record<SupportedLocale, string> = {
  ru: [
    'Согласие на обработку изображения лица в режиме «Я в кадре»',
    '',
    '1. Что вы передаёте. Фотографию своего лица и видеоролик длительностью около 3 секунд с поворотом головы. Съёмка — только камерой приложения. Позже, по желанию и отдельно, — запись своего голоса с фразой согласия.',
    '2. Зачем. Чтобы создавать ваши изображения («образы») и скетч-аватары и ставить вас ведущим в роликах, которые вы делаете сами. Изображения создаёт ИИ по вашему фото; сходство близкое, но не гарантировано.',
    '3. Автоматическая проверка. ИИ проверяет, что на фото одно лицо, оно снято анфас и при достаточном свете, это не снимок экрана или распечатки, а в ролике — тот же человек и живое движение. Это защита от использования чужой фотографии, а не проверка вашей личности.',
    '4. Оценка возраста. ИИ оценивает возраст по фото диапазоном (например, 28–34). Оценка используется только для допуска к этому режиму: если нижняя граница меньше 18 лет, режим недоступен. Для аналитики, сегментации и рекламы оценка не используется. Если оценка ошибочна, напишите в поддержку.',
    '5. Кому передаются данные. Фото и ролик передаются ИИ-провайдерам, которые выполняют проверку и создают изображения и ролики по вашему запросу, — только для этих действий.',
    '6. Хранение. Фото и ролик хранятся в нашем облачном хранилище и удаляются автоматически через 30 дней после создания вашего последнего образа; после этого новые образы создаются из базового образа, и сходство может постепенно снижаться. Образы и скетчи хранятся, пока вы их не удалите.',
    '7. Удаление. Вы можете в любой момент удалить себя из сервиса в разделе «Я в кадре»: будут удалены фото, ролик, все образы, скетчи и голос, созданный для этого режима. Готовые ролики остаются в вашем аккаунте; опубликованные страницы с вами можно снять одним нажатием.',
    '8. Только своё лицо. Этот режим — только для вашего собственного лица. Не используйте фото других людей.',
    '',
    'Нажимая «Согласен(на)», вы подтверждаете, что вам есть 18 лет и что на фото и в ролике будете вы сами.',
  ].join('\n'),
  uk: [
    'Згода на обробку зображення обличчя в режимі «Я в кадрі»',
    '',
    '1. Що ви передаєте. Фотографію свого обличчя та відеоролик тривалістю близько 3 секунд із поворотом голови. Зйомка — лише камерою застосунку. Пізніше, за бажанням і окремо, — запис свого голосу з фразою згоди.',
    '2. Навіщо. Щоб створювати ваші зображення («образи») і скетч-аватари та ставити вас ведучим у роликах, які ви робите самі. Зображення створює ШІ за вашим фото; схожість близька, але не гарантована.',
    '3. Автоматична перевірка. ШІ перевіряє, що на фото одне обличчя, воно зняте анфас і за достатнього світла, це не знімок екрана чи роздруківки, а в ролику — та сама людина і живий рух. Це захист від використання чужої фотографії, а не перевірка вашої особи.',
    '4. Оцінка віку. ШІ оцінює вік за фото діапазоном (наприклад, 28–34). Оцінка використовується лише для допуску до цього режиму: якщо нижня межа менша за 18 років, режим недоступний. Для аналітики, сегментації та реклами оцінка не використовується. Якщо оцінка помилкова, напишіть у підтримку.',
    '5. Кому передаються дані. Фото і ролик передаються ШІ-провайдерам, які виконують перевірку та створюють зображення й ролики на ваш запит, — лише для цих дій.',
    '6. Зберігання. Фото і ролик зберігаються в нашому хмарному сховищі та видаляються автоматично через 30 днів після створення вашого останнього образу; після цього нові образи створюються з базового образу, і схожість може поступово знижуватися. Образи й скетчі зберігаються, доки ви їх не видалите.',
    '7. Видалення. Ви можете будь-коли видалити себе із сервісу в розділі «Я в кадрі»: буде видалено фото, ролик, усі образи, скетчі та голос, створений для цього режиму. Готові ролики залишаються у вашому акаунті; опубліковані сторінки з вами можна зняти одним натисканням.',
    '8. Лише своє обличчя. Цей режим — лише для вашого власного обличчя. Не використовуйте фото інших людей.',
    '',
    'Натискаючи «Погоджуюсь», ви підтверджуєте, що вам виповнилося 18 років і що на фото та в ролику будете ви самі.',
  ].join('\n'),
  en: [
    'Consent to processing of your face image in the “Me on screen” mode',
    '',
    '1. What you provide. A photo of your face and a video of about 3 seconds in which you turn your head. Both are taken with the in-app camera only. Later, optionally and separately, a recording of your voice with a spoken consent phrase.',
    '2. Why. To create images of you (“looks”) and sketch avatars and to feature you as the presenter in videos you make yourself. The images are generated by AI from your photo; the likeness is close but not guaranteed.',
    '3. Automatic check. AI checks that the photo shows one face, taken from the front in sufficient light, that it is not a picture of a screen or a printout, and that the video shows the same person moving live. This protects against the use of someone else’s photo; it is not a verification of your identity.',
    '4. Age estimate. AI estimates your age from the photo as a range (for example, 28–34). The estimate is used only to decide access to this mode: if the lower bound is under 18, the mode is unavailable. It is not used for analytics, segmentation or advertising. If the estimate is wrong, please contact support.',
    '5. Who receives the data. The photo and video are sent to the AI providers that perform the check and generate images and videos at your request, only for those actions.',
    '6. Storage. The photo and video are kept in our cloud storage and are deleted automatically 30 days after you create your latest look; after that, new looks are generated from your base look, and the likeness may gradually decrease. Looks and sketches are kept until you delete them.',
    '7. Deletion. You can remove yourself from the service at any time in the “Me on screen” section: the photo, the video, all looks, sketches and the voice created for this mode will be deleted. Finished videos remain in your account; published pages featuring you can be taken down with one tap.',
    '8. Your own face only. This mode is for your own face only. Do not use photos of other people.',
    '',
    'By tapping “I agree” you confirm that you are at least 18 years old and that the photo and video will show you.',
  ].join('\n'),
  de: [
    'Einwilligung in die Verarbeitung Ihres Gesichtsbildes im Modus „Ich im Bild“',
    '',
    '1. Was Sie übermitteln. Ein Foto Ihres Gesichts und ein etwa 3 Sekunden langes Video, in dem Sie den Kopf drehen. Aufgenommen wird ausschließlich mit der Kamera der App. Später, freiwillig und gesondert, eine Aufnahme Ihrer Stimme mit einem gesprochenen Einwilligungssatz.',
    '2. Wozu. Um Bilder von Ihnen („Looks“) und Skizzen-Avatare zu erstellen und Sie als Moderator in Videos zu zeigen, die Sie selbst erstellen. Die Bilder erzeugt eine KI aus Ihrem Foto; die Ähnlichkeit ist hoch, aber nicht garantiert.',
    '3. Automatische Prüfung. Eine KI prüft, dass das Foto genau ein Gesicht zeigt, frontal und bei ausreichendem Licht aufgenommen, dass es sich nicht um eine Bildschirmaufnahme oder einen Ausdruck handelt und dass im Video dieselbe Person sich live bewegt. Das schützt vor der Verwendung fremder Fotos; es ist keine Überprüfung Ihrer Identität.',
    '4. Altersschätzung. Eine KI schätzt Ihr Alter anhand des Fotos als Spanne (zum Beispiel 28–34). Die Schätzung dient ausschließlich der Zulassung zu diesem Modus: Liegt die Untergrenze unter 18 Jahren, ist der Modus nicht verfügbar. Für Analysen, Segmentierung oder Werbung wird sie nicht verwendet. Ist die Schätzung falsch, wenden Sie sich bitte an den Support.',
    '5. Empfänger der Daten. Foto und Video werden an die KI-Anbieter übermittelt, die die Prüfung durchführen und auf Ihre Anfrage Bilder und Videos erzeugen, ausschließlich für diese Vorgänge.',
    '6. Speicherung. Foto und Video werden in unserem Cloud-Speicher aufbewahrt und automatisch 30 Tage nach der Erstellung Ihres letzten Looks gelöscht; danach werden neue Looks aus Ihrem Basis-Look erzeugt, und die Ähnlichkeit kann allmählich abnehmen. Looks und Skizzen bleiben gespeichert, bis Sie sie löschen.',
    '7. Löschung. Sie können sich jederzeit im Bereich „Ich im Bild“ aus dem Dienst entfernen: Foto, Video, alle Looks, Skizzen und die für diesen Modus erstellte Stimme werden gelöscht. Fertige Videos bleiben in Ihrem Konto; veröffentlichte Seiten mit Ihnen können Sie mit einem Tippen entfernen.',
    '8. Nur Ihr eigenes Gesicht. Dieser Modus ist nur für Ihr eigenes Gesicht bestimmt. Verwenden Sie keine Fotos anderer Personen.',
    '',
    'Mit „Ich stimme zu“ bestätigen Sie, dass Sie mindestens 18 Jahre alt sind und dass Foto und Video Sie selbst zeigen werden.',
  ].join('\n'),
  es: [
    'Consentimiento para el tratamiento de la imagen de tu rostro en el modo «Yo en pantalla»',
    '',
    '1. Qué nos das. Una foto de tu rostro y un vídeo de unos 3 segundos en el que giras la cabeza. Ambos se toman solo con la cámara de la aplicación. Más adelante, de forma opcional y por separado, una grabación de tu voz con una frase de consentimiento en voz alta.',
    '2. Para qué. Para crear imágenes tuyas («looks») y avatares en boceto y para que aparezcas como presentador en los vídeos que tú mismo creas. Las imágenes las genera una IA a partir de tu foto; el parecido es cercano, pero no está garantizado.',
    '3. Comprobación automática. Una IA comprueba que la foto muestra un solo rostro, de frente y con luz suficiente, que no es una foto de una pantalla ni de una impresión, y que en el vídeo aparece la misma persona moviéndose en vivo. Esto protege contra el uso de la foto de otra persona; no es una verificación de tu identidad.',
    '4. Estimación de edad. Una IA estima tu edad a partir de la foto como un rango (por ejemplo, 28–34). La estimación se usa solo para decidir el acceso a este modo: si el límite inferior es menor de 18 años, el modo no está disponible. No se usa para analítica, segmentación ni publicidad. Si la estimación es errónea, escribe al soporte.',
    '5. Quién recibe los datos. La foto y el vídeo se envían a los proveedores de IA que realizan la comprobación y generan imágenes y vídeos a petición tuya, solo para esas acciones.',
    '6. Conservación. La foto y el vídeo se guardan en nuestro almacenamiento en la nube y se eliminan automáticamente 30 días después de que crees tu último look; a partir de entonces, los nuevos looks se generan desde tu look base y el parecido puede disminuir poco a poco. Los looks y bocetos se conservan hasta que los elimines.',
    '7. Eliminación. Puedes eliminarte del servicio en cualquier momento en la sección «Yo en pantalla»: se eliminarán la foto, el vídeo, todos los looks, los bocetos y la voz creada para este modo. Los vídeos terminados permanecen en tu cuenta; las páginas publicadas contigo se pueden retirar con un toque.',
    '8. Solo tu propio rostro. Este modo es solo para tu propio rostro. No uses fotos de otras personas.',
    '',
    'Al pulsar «Acepto» confirmas que tienes al menos 18 años y que la foto y el vídeo te mostrarán a ti.',
  ].join('\n'),
};

export interface PersonaConsentText {
  version: string;
  locale: SupportedLocale;
  text: string;
}

/** Неизвестная локаль — русская (как везде в бэкенде, `normalizeLocale`). */
export function personaConsentText(
  locale: string | null | undefined,
): PersonaConsentText {
  const l = normalizeLocale(locale);
  return { version: PERSONA_CONSENT_VERSION, locale: l, text: TEXTS[l] };
}
