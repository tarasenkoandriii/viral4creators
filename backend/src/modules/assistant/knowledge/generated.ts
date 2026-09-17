/**
 * ГЕНЕРИРУЕТСЯ автоматически — backend/scripts/build-assistant-knowledge.ts.
 * Не редактировать руками: правки уйдут при следующей сборке. Правки
 * содержания — в knowledge/manual.<locale>.md (ручной слой) или в самих
 * источниках (landing/frontend dictionaries, common/plans.ts и соседние).
 */

export const ASSISTANT_KNOWLEDGE_BUILT_AT = '2026-09-17T04:23:05.511Z';
export const ASSISTANT_KNOWLEDGE_COMMIT = 'local';

export interface ProactiveTips {
  step: Record<string, string>;
  plans: string;
  exitIntent: string;
}

export interface AssistantStepItem {
  title: string;
  text: string;
  details: string[];
  badge?: string;
}

export const ASSISTANT_KNOWLEDGE: Record<string, string> = {
  ru: '# База знаний ИИ-консультанта viral4creators\n\n_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._\n\n## Разделы мини-аппа\n\n- **Проекты** — Товар или линейка, под которые генерируется реклама\n- **Бренд** — Единый стиль и персонажи для всех проектов бренда\n- **Продакшн** — мастер генерации ролика — от выбора референса до готового видео (см. шаги обучалки ниже)\n- **Постпрод** — Все ваши готовые ролики: переозвучка, экспорт, публикация и шаринг.\n\n## Шаги обучалки\n\n### 1. Заведите товар\nПроект и товар: фото (категория, целевая аудитория и цены аналогов определяются по нему), описание текстом или голосом, цена. Быстрый путь без проекта тоже работает — тогда товар описывается прямо в мастере.\n\n### 2. Выберите референс\nЧетыре способа: поиск по YouTube, ссылка, свой файл до 100МБ и — в режиме Premium — готовый разбор из библиотеки сервиса, мгновенно и без нового ИИ-вызова.\n(доступно с тарифа: Premium)\n- Библиотека готовых разборов — без нового ИИ-вызова (Premium)\n- Поиск по YouTube — нужен вход\n- Ссылка на YouTube или свой файл до 100 МБ\n\n### 3. ИИ разбирает ролик\nGemini выделяет сцены с таймкодами, действующих лиц и массовку, визуальный стиль, темп и формат кадра — и оценивает, кому этот ролик адресован и что он продаёт.\n- Ничего вводить не нужно — ИИ сам покажет разбор по сценам\n\n### 4. Проверьте релевантность\nОтдельная проверка сравнивает аудиторию ролика с покупателями вашего товара: оценка, объяснение логики и конкретные правки — стоит ли вообще клонировать этот референс.\n(доступно с тарифа: Standard+)\n- Чекбокс «Учитывать при генерации» — включает совет в промпт\n- Кнопка «Проверить ещё раз» — новый анализ релевантности\n- Кнопка «Выбрать другой референс» — назад к шагу 2\n\n### 5. Соберите состав кадра\nСнимите лишних персонажей, сцены и массовку — клик по любому из них подсвечивает нужные строки разбора. Персонажа можно заменить своим фото, описанием или персонажем бренда.\n(доступно с тарифа: Standard+)\n- Клик по персонажу — включить или выключить его в ролике\n- Замена персонажа: как есть, своим фото (Standard+), текстом или персонажем бренда\n- Клик по сцене или массовке — включить или выключить в кадре\n- Голос, субтитры и движение камеры — из манифеста бренда (для товаров с проектом)\n\n### 6. Получите промпт\nGPT-5 собирает text-to-video промпт из разбора, товара, манифеста бренда, языка озвучки и советов по релевантности. Промпт можно поправить руками.\n- Кнопка «Сгенерировать промпт» — готовый текст из разбора и товара\n- Промпт можно поправить вручную перед сохранением\n- Отдельное поле текста для озвучки — если выбран свой голос\n\n### 7. Выберите формат и референс-картинки\nСоотношение сторон — 16:9 и 9:16 в любом режиме, 3:4, 1:1 или своё начиная со Standard — и то, какие три изображения модель получит референсами: персонажи, ваши сцены, сцены бренда, фото товара. Остальное уходит в промпт текстом.\n(доступно с тарифа: Standard+)\n- Качество рендера: «Быстрое» или «Кинематографичное» (Standard+)\n- До трёх референс-картинок для модели генерации — свои сцены и фото (Standard+)\n- Соотношение кадра: 16:9 и 9:16 всем, остальные форматы — со Standard\n\n### 8. Сгенерируйте видео\nGrok или Google Veo 3.1 рендерит новое рекламное видео — на выбор движок и качество рендера, быстрее или более кинематографично.\n- Фото товара обязательно — без него кнопка генерации не появится\n- Кнопка «Сгенерировать рекламный ролик»\n- При неудаче — «Сгенерировать ещё раз»\n\n### 9. Проверьте результат\nОтдельная проверка на артефакты предложит исправленный промпт для повторной генерации. Для товара из проекта — тут же партия на всю линейку и три A/B-варианта хука. Готовый ролик — прямой ссылкой на файл, а дальше кнопка «Открыть в Постпрод».\n(доступно с тарифа: Standard+)\n- Проверка на артефакты и саундчек (Standard+)\n- Партия для всей линейки товаров и 3 варианта A/B (Premium, только для товаров с проектом)\n- Кнопка «Открыть в Постпрод» — тот же ролик, среди всех остальных ваших роликов\n\n### 10. Управляйте в Постпродакшене\nОтдельная вкладка «Постпрод» — все ваши готовые ролики, а не только последний. Смените текст реплик и голос — с явным выбором провайдера синтеза и честной пред-прослушкой до оплаты — без нового рендера. Экспортируйте под несколько площадок и опубликуйте со страницей для шеринга.\n(доступно с тарифа: Standard+)\n- Переозвучка без нового рендера — меняются звук, субтитры и текст реплик (Standard+)\n- Провайдер синтеза голоса — явно ElevenLabs или Resemble, либо «как сейчас»\n- Пред-прослушать точную комбинацию текста, голоса и провайдера — до оплаты переозвучки\n- Экспорт под несколько площадок сразу — без повторной оплаты рендера (Standard+)\n- Публикация и страница для шеринга (Standard+, нужен вход)\n\n## Частые вопросы\n\n**Нужна ли регистрация?**\nНет. Сессия анонимная и создаётся автоматически при первом заходе — нужно только один раз принять оферту и условия использования перед первым разбором. Вход через Telegram доступен, но опционален: он нужен для проектов, каталога товаров, манифеста бренда и чтобы вернуться к своим сессиям позже.\n\n**Какие форматы видео поддерживаются?**\nMP4, MOV и AVI размером до 100МБ, либо просто ссылка на публичное YouTube-видео — тогда файл вообще не нужно скачивать и загружать самостоятельно.\n\n**Сколько времени занимает генерация видео?**\nПосле того как промпт одобрен, видео обычно готово за 3–5 минут — точное время зависит от выбранного движка генерации (по умолчанию Grok, доступен и Google Veo 3.1 с режимами Fast/Standard) и текущей нагрузки.\n\n**Сколько это стоит?**\nСейчас ничего: все три режима — Lite, Standard и Premium — бесплатны и переключаются прямо в приложении. Это период обкатки; когда появится оплата, уже сделанное останется при вас. Позже Lite станет условно-бесплатным — за лайк каналу проекта на YouTube и несколько отправленных ссылок на сервис.\n\n**Чем режимы отличаются друг от друга?**\nLite — минимальный путь: разбор референса и генерация ролика в 16:9 или 9:16. Standard добавляет проверку релевантности, аудит ролика, манифест бренда, свои сцены, замену персонажей фото, любые форматы кадра и публикацию. Premium — это Standard плюс библиотека готовых разборов. Режим меняется в любой момент и не трогает уже созданные проекты, ролики и разборы.\n\n**Где хранятся мои файлы и когда удаляются?**\nВ Vercel Blob — референс, фото товара и готовый ролик лежат в одном хранилище. У каждого файла есть владелец в базе: истёкшая сессия уносит свои файлы, удалённый товар — своё фото, удалённый манифест — фото персонажей и сцен. Уборка идёт ежедневно, а осиротевшие файлы подбирает отдельный проход.\n\n**Кому принадлежат разборы и готовые ролики?**\nРазбор референса создаёт сервис, и по условиям использования разборы принадлежат ему — именно поэтому библиотека может предлагать их другим. Ваш товар, ваши загруженные материалы и сгенерированный ролик остаются вашими. Разборы роликов, загруженных файлом, приватны: их видит только автор.\n\n**Можно ли пользоваться из Telegram?**\nДа — тот же продукт работает и как обычный сайт в браузере, и как Telegram Mini App внутри Telegram, с одинаковым набором возможностей.\n\n**Можно ли отредактировать разбор видео или промпт вручную?**\nДа, на обоих шагах: после автоматического анализа референса и после автоматической генерации промпта — оба результата можно поправить перед тем, как двигаться дальше.\n\n**Это открытый проект?**\nДа — исходный код доступен на GitHub, разработка велась по методологии GitHub Spec Kit.\n\n## Тарифы и возможности\n\nВсе тарифы сейчас бесплатны и переключаются пользователем самостоятельно в мини-аппе (это временный период обкатки продукта, оплата ещё не включена).\n\n### Lite\nРазбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.\n16:9/9:16 only\n\n### Standard\nВесь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.\nОценка релевантности референса, Аудит готового ролика, Публикация через сервис, Манифест бренда, Свои сцены и слоты референсов, Замена персонажей фото, Любой формат кадра, Полная модель Veo, Клонирование своего голоса, Обучающее видео по сайту заказчика\nany aspect ratio\n\n### Premium\nВсё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.\nБиблиотека готовых разборов, Оценка релевантности референса, Аудит готового ролика, Публикация через сервис, Манифест бренда, Свои сцены и слоты референсов, Замена персонажей фото, Любой формат кадра, Полная модель Veo, Клонирование своего голоса, Дубляж (полная замена голоса модели), Обучающее видео по сайту заказчика\nany aspect ratio\n\n## Правила пайплайна\n\nVeo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.\nGrok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.\nРеференс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.\nОзвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».\nФорматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.\nФото товара — до 10 МБ.\n\n## Подсказки полей мастера\n\n**Загрузка референса**: Успешная UGC-реклама, которую клонируем под ваш товар — возьмите готовый разбор из библиотеки, найдите ролик на YouTube, вставьте ссылку или загрузите файл.\n\n**Файл референса**: MP4, MOV, AVI · до 100 МБ\n\n**Референс — файл слишком большой**: Видео больше 100 МБ.\n\n**Манифест бренда — голос**: Характер голоса, темп, манера — попадёт в промпт; язык реплик задаётся на шаге «Товар».\n\n**Манифест бренда — по умолчанию**: Копия для этого ролика: правьте стиль под конкретную генерацию — сам манифест не меняется.\n\n**Клонирование голоса — лимит**: Достигнут лимит {{max}} голосов — удалите один, чтобы клонировать новый.\n\n## Дополнительно\n\n<!--\n  Ручной слой базы знаний консультанта (ТЗ §5.2, п.6) — то, чего нет в\n  коде как структура: как выбрать референс, что делать при неудаче,\n  разница Veo/Grok на практике, позиционирование, ссылки на юр. документы.\n  Переводится вручную вместе со словарями лендинга (§5.2), не собирается\n  скриптом. Правится редко — раз в несколько недель, по итогам ревью\n  (doc/LANDING-TUTORIAL-AI-CONSULTANT-SPEC.md §10), а не при каждой\n  сборке.\n-->\n\n## Как выбрать хороший референс\n\nГодится любой рекламный или обзорный ролик, где виден темп, монтаж и\nподача — а не обязательно тот же товар. Разбор извлекает структуру\n(сцены, действующих лиц, стиль, формат кадра), а не переносит чужой\nтовар на экран: подставить свой товар и фото можно на шаге 5, даже если\nреференс был про кроссовки, а товар — косметика. Плохой референс — тот,\nгде почти нет действия (статичный говорящий на камеру десять минут) или\nгде разбор явно не находит то, что продаётся (нет продукта в кадре\nвовсе). Один и тот же референс можно разобрать один раз и использовать\nдля нескольких товаров, если платит режим это позволяет.\n\n## Если рендер не удался\n\nРолик автоматически помечается как проваленный, причина видна в\nинтерфейсе, и обычно доступна кнопка «Повторить» — новая попытка с теми\nже настройками. Если ролик проваливается несколько раз подряд с одной и\nтой же причиной — вероятно, дело в самом референсе или составе кадра\n(слишком длинная цепочка сцен, необычный формат), а не во временном\nсбое; стоит упростить состав кадра на шаге 5 и повторить разбор.\n\n## Veo и Grok на практике\n\nVeo — основной движок, до 56 секунд суммарно (по 8 секунд за вызов, до\nсеми вызовов), качество стабильно выше, генерация обычно занимает\nнесколько минут. Grok — альтернативный движок, до 25 секунд (15 секунд\nбазовый ролик плюс одно расширение до 10 секунд), разрешение до 1080p\n(720p, если используются референс-изображения или расширение) — обычно\nчуть дешевле и с другим визуальным характером. Какой движок используется\nдля конкретной сессии, решает мастер и настройки бренда — консультант\nне переключает движок сам.\n\n## Позиционирование\n\nСервис — инструмент для тех, кто уже снял или нашёл ролик-пример и\nхочет получить похожий, но под свой товар, без съёмочной группы и\nмонтажа с нуля: разбор референса → генерация нового видео на основе\nструктуры разбора. Это не конструктор рекламы с нуля и не банк готовых\nшаблонов — обязательно нужен референс (найденный по YouTube, по ссылке,\nсвоим файлом или — на Premium — уже готовый разбор из библиотеки).\n\n## Поддержка и документы\n\nОтдельного канала поддержки, кроме самого Telegram-бота сервиса, сейчас\nнет (открытый вопрос владельца, ТЗ §12.3) — по вопросам, на которые\nконсультант не может ответить по продукту, предложить открыть мини-апп.\nУсловия использования и оферта — на страницах `/legal/offer` и\n`/legal/terms-of-use`; консультант не пересказывает их дословно и не\nдаёт юридических гарантий (ТЗ §5.1), а ссылается на документ.\n',
  uk: "# База знань ІІ-консультанта viral4creators\n\n_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._\n\n## Розділи міні-застосунку\n\n- **Проєкти** — Товар або лінійка, під які генерується реклама\n- **Бренд** — Єдиний стиль і персонажі для всіх проєктів бренду\n- **Продакшн** — майстер генерації ролика — від вибору референсу до готового відео (див. кроки обучалки нижче)\n- **Постпрод** — Усі ваші готові ролики: переозвучка, експорт, публікація та шаринг.\n\n## Кроки навчалки\n\n### 1. Заведіть товар\nПроєкт і товар: фото (категорія, цільова аудиторія та ціни аналогів визначаються за ним), опис текстом або голосом, ціна. Швидкий шлях без проєкту теж працює — тоді товар описується прямо в майстрі.\n\n### 2. Оберіть референс\nЧотири способи: пошук на YouTube, посилання, свій файл до 100МБ і — в режимі Premium — готовий розбір із бібліотеки сервісу, миттєво і без нового ІІ-виклику.\n(доступно з тарифу: Premium)\n- Бібліотека готових розборів — без нового ІІ-виклику (Premium)\n- Пошук на YouTube — потрібен вхід\n- Посилання на YouTube або свій файл до 100 МБ\n\n### 3. ІІ розбирає ролик\nGemini виділяє сцени з таймкодами, дійових осіб і масовку, візуальний стиль, темп і формат кадру — і оцінює, кому адресований цей ролик і що він продає.\n- Нічого вводити не потрібно — ІІ сам покаже розбір по сценах\n\n### 4. Перевірте релевантність\nОкрема перевірка порівнює аудиторію ролика з покупцями вашого товару: оцінка, пояснення логіки і конкретні правки — чи варто взагалі клонувати цей референс.\n(доступно з тарифу: Standard+)\n- Чекбокс «Враховувати під час генерації» — додає пораду в промпт\n- Кнопка «Перевірити ще раз» — новий аналіз релевантності\n- Кнопка «Обрати інший референс» — назад до кроку 2\n\n### 5. Зберіть склад кадру\nЗніміть зайвих персонажів, сцени та масовку — клік по будь-якому з них підсвічує потрібні рядки розбору. Персонажа можна замінити своїм фото, описом або персонажем бренду.\n(доступно з тарифу: Standard+)\n- Клік по персонажу — увімкнути або вимкнути його в ролику\n- Заміна персонажа: як є, своїм фото (Standard+), текстом або персонажем бренду\n- Клік по сцені або масовці — увімкнути або вимкнути в кадрі\n- Голос, субтитри та рух камери — з маніфесту бренду (для товарів з проєктом)\n\n### 6. Отримайте промпт\nGPT-5 збирає text-to-video промпт із розбору, товару, маніфесту бренду, мови озвучки та порад щодо релевантності. Промпт можна поправити руками.\n- Кнопка «Згенерувати промпт» — готовий текст із розбору та товару\n- Промпт можна поправити вручну перед збереженням\n- Окреме поле тексту для озвучення — якщо обрано свій голос\n\n### 7. Оберіть формат і референс-зображення\nСпіввідношення сторін — 16:9 і 9:16 у будь-якому режимі, 3:4, 1:1 або своє починаючи зі Standard — і те, які три зображення модель отримає референсами: персонажі, ваші сцени, сцени бренду, фото товару. Решта йде в промпт текстом.\n(доступно з тарифу: Standard+)\n- Якість рендеру: «Швидка» або «Кінематографічна» (Standard+)\n- До трьох референс-зображень для моделі генерації — свої сцени та фото (Standard+)\n- Співвідношення кадру: 16:9 і 9:16 усім, решта форматів — від Standard\n\n### 8. Згенеруйте відео\nGrok або Google Veo 3.1 рендерить нове рекламне відео — на вибір рушій і якість рендеру, швидше або більш кінематографічно.\n- Фото товару обов’язкове — без нього кнопка генерації не з’явиться\n- Кнопка «Згенерувати рекламний ролик»\n- У разі невдачі — «Згенерувати ще раз»\n\n### 9. Перевірте результат\nОкрема перевірка на артефакти запропонує виправлений промпт для повторної генерації. Для товару з проєкту — одразу партія на всю лінійку і три A/B-варіанти хука. Готовий ролик — прямим посиланням на файл, а далі кнопка «Відкрити в Постпрод».\n(доступно з тарифу: Standard+)\n- Перевірка на артефакти та саундчек (Standard+)\n- Партія для всієї лінійки товарів і 3 варіанти A/B (Premium, лише для товарів із проєктом)\n- Кнопка «Відкрити в Постпрод» — той самий ролик, серед усіх інших ваших роликів\n\n### 10. Керуйте в Постпродакшні\nОкрема вкладка «Постпрод» — усі ваші готові ролики, а не лише останній. Змініть текст реплік і голос — з явним вибором провайдера синтезу та чесним попереднім прослуховуванням до оплати — без нового рендеру. Експортуйте під кілька площадок і опублікуйте зі сторінкою для шерингу.\n(доступно з тарифу: Standard+)\n- Переозвучка без нового рендеру — змінюються звук, субтитри і текст реплік (Standard+)\n- Провайдер синтезу голосу — явно ElevenLabs або Resemble, або «як зараз»\n- Попередньо прослухати точну комбінацію тексту, голосу і провайдера — до оплати переозвучки\n- Експорт під кілька площадок одразу — без повторної оплати рендеру (Standard+)\n- Публікація та сторінка для шерингу (Standard+, потрібен вхід)\n\n## Часті запитання\n\n**Чи потрібна реєстрація?**\nНі. Сесія анонімна і створюється автоматично при першому заході — потрібно лише один раз прийняти оферту й умови використання перед першим розбором. Вхід через Telegram доступний, але опційний: він потрібен для проєктів, каталогу товарів, маніфесту бренду і щоб повернутись до своїх сесій пізніше.\n\n**Які формати відео підтримуються?**\nMP4, MOV і AVI розміром до 100МБ, або просто посилання на публічне YouTube-відео — тоді файл взагалі не потрібно завантажувати самостійно.\n\n**Скільки часу займає генерація відео?**\nПісля того як промпт схвалено, відео зазвичай готове за 3–5 хвилин — точний час залежить від обраного рушія генерації (за замовчуванням Grok, доступний і Google Veo 3.1 з режимами Fast/Standard) і поточного навантаження.\n\n**Скільки це коштує?**\nЗараз нічого: усі три режими — Lite, Standard і Premium — безкоштовні й перемикаються прямо в застосунку. Це період обкатки; коли з'явиться оплата, вже зроблене залишиться при вас. Пізніше Lite стане умовно-безкоштовним — за лайк каналу проєкту на YouTube і кілька надісланих посилань на сервіс.\n\n**Чим режими відрізняються один від одного?**\nLite — мінімальний шлях: розбір референсу і генерація ролика в 16:9 або 9:16. Standard додає перевірку релевантності, аудит ролика, маніфест бренду, свої сцени, заміну персонажів фото, будь-які формати кадру і публікацію. Premium — це Standard плюс бібліотека готових розборів. Режим змінюється в будь-який момент і не зачіпає вже створені проєкти, ролики та розбори.\n\n**Де зберігаються мої файли і коли видаляються?**\nУ Vercel Blob — референс, фото товару і готовий ролик лежать в одному сховищі. У кожного файлу є власник у базі: сесія, що закінчилась, забирає свої файли, видалений товар — своє фото, видалений маніфест — фото персонажів і сцен. Прибирання йде щодня, а осиротілі файли підбирає окремий прохід.\n\n**Кому належать розбори і готові ролики?**\nРозбір референсу створює сервіс, і за умовами використання розбори належать йому — саме тому бібліотека може пропонувати їх іншим. Ваш товар, ваші завантажені матеріали і згенерований ролик залишаються вашими. Розбори роликів, завантажених файлом, приватні: їх бачить лише автор.\n\n**Чи можна користуватись із Telegram?**\nТак — той самий продукт працює і як звичайний сайт у браузері, і як Telegram Mini App усередині Telegram, з однаковим набором можливостей.\n\n**Чи можна відредагувати розбір відео чи промпт вручну?**\nТак, на обох кроках: після автоматичного аналізу референсу і після автоматичної генерації промпту — обидва результати можна поправити перед тим, як рухатись далі.\n\n**Це відкритий проєкт?**\nТак — вихідний код доступний на GitHub, розробка велась за методологією GitHub Spec Kit.\n\n## Тарифи та можливості\n\nУсі тарифи зараз безкоштовні й перемикаються користувачем самостійно в міні-застосунку (це тимчасовий період обкатки продукту, оплата ще не увімкнена).\n\n### Lite\nРазбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.\n16:9/9:16 only\n\n### Standard\nВесь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.\nОцінка релевантності референсу, Аудит готового ролика, Публікація через сервіс, Маніфест бренду, Власні сцени і слоти референсів, Заміна персонажів фото, Будь-який формат кадру, Повна модель Veo, Клонування власного голосу, Навчальне відео по сайту замовника\nany aspect ratio\n\n### Premium\nВсё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.\nБібліотека готових розборів, Оцінка релевантності референсу, Аудит готового ролика, Публікація через сервіс, Маніфест бренду, Власні сцени і слоти референсів, Заміна персонажів фото, Будь-який формат кадру, Повна модель Veo, Клонування власного голосу, Дубляж (повна заміна голосу моделі), Навчальне відео по сайту замовника\nany aspect ratio\n\n## Правила пайплайну\n\nVeo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.\nGrok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.\nРеференс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.\nОзвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».\nФорматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.\nФото товара — до 10 МБ.\n\n## Підказки полів майстра\n\n**Загрузка референса**: Успішна UGC-реклама, яку клонуємо під ваш товар — візьміть готовий розбір із бібліотеки, знайдіть ролик на YouTube, вставте посилання або завантажте файл.\n\n**Файл референса**: MP4, MOV, AVI · до 100 МБ\n\n**Референс — файл слишком большой**: Відео більше 100 МБ.\n\n**Манифест бренда — голос**: Характер голосу, темп, манера — потрапить у промпт; мова реплік задається на кроці «Товар».\n\n**Манифест бренда — по умолчанию**: Копія для цього ролика: редагуйте стиль під конкретну генерацію — сам маніфест не змінюється.\n\n**Клонирование голоса — лимит**: Досягнуто ліміту {{max}} голосів — видаліть один, щоб клонувати новий.\n\n## Додатково\n\n<!-- Ручний шар бази знань консультанта (ТЗ §5.2, п.6) — переклад ru-версії. -->\n\n## Як обрати гарний референс\n\nПідійде будь-який рекламний або оглядовий ролик, де видно темп, монтаж і\nподачу — не обов'язково той самий товар. Розбір видобуває структуру\n(сцени, персонажів, стиль, формат кадру), а не переносить чужий товар на\nекран: підставити свій товар і фото можна на кроці 5, навіть якщо\nреференс був про кросівки, а товар — косметика. Поганий референс — той,\nде майже немає дії (статичний спікер на камеру десять хвилин) або де\nрозбір явно не знаходить, що продається (товару в кадрі взагалі немає).\n\n## Якщо рендер не вдався\n\nРолик автоматично позначається як провалений, причина видна в\nінтерфейсі, зазвичай доступна кнопка «Повторити» — нова спроба з тими ж\nналаштуваннями. Якщо ролик провалюється кілька разів поспіль з однією й\nтією ж причиною — ймовірно, справа в самому референсі чи складі кадру,\nа не у тимчасовому збої; варто спростити склад кадру на кроці 5 і\nповторити розбір.\n\n## Veo і Grok на практиці\n\nVeo — основний рушій, до 56 секунд сумарно (по 8 секунд за виклик, до\nсеми викликів), якість стабільно вища, генерація зазвичай триває кілька\nхвилин. Grok — альтернативний рушій, до 25 секунд (15 секунд базовий\nролик плюс одне розширення до 10 секунд), роздільна здатність до 1080p\n(720p, якщо використовуються референс-зображення або розширення) —\nзазвичай трохи дешевший і з іншим візуальним характером. Який рушій\nвикористовується для конкретної сесії, вирішує майстер і налаштування\nбренду — консультант не перемикає рушій сам.\n\n## Позиціонування\n\nСервіс — інструмент для тих, хто вже зняв або знайшов ролик-приклад і\nхоче отримати схожий, але під свій товар, без знімальної групи й\nмонтажу з нуля: розбір референсу → генерація нового відео на основі\nструктури розбору. Обов'язково потрібен референс (знайдений на YouTube,\nза посиланням, власним файлом або — на Premium — вже готовий розбір із\nбібліотеки).\n\n## Підтримка та документи\n\nОкремого каналу підтримки, крім самого Telegram-бота сервісу, наразі\nнемає (відкрите питання власника, ТЗ §12.3) — щодо питань, на які\nконсультант не може відповісти по продукту, запропонувати відкрити\nміні-застосунок. Умови використання й оферта — на сторінках\n`/legal/offer` і `/legal/terms-of-use`; консультант не переказує їх\nдослівно і не дає юридичних гарантій, а посилається на документ.\n",
  en: "# viral4creators AI consultant knowledge base\n\n_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._\n\n## Mini-app sections\n\n- **Projects** — A product or line for which ads are generated\n- **Brand** — A single style and characters for all of a brand's projects\n- **Production** — the generation wizard — from choosing a reference to a finished video (see the tutorial steps below)\n- **Postprod** — All your finished videos: re-voice, export, publish and share.\n\n## Tutorial steps\n\n### 1. Add a product\nA project and a product: a photo (used to determine category, target audience and comparable prices), a description as text or voice, and a price. The quick path without a project also works — then the product is described right inside the wizard.\n\n### 2. Pick a reference\nFour ways: search YouTube, paste a link, upload your own file up to 100MB, or — on the Premium plan — a ready-made breakdown from the service's library, instant and with no new AI call.\n(available from plan: Premium)\n- A library of ready-made breakdowns — no new AI call (Premium)\n- YouTube search — sign-in required\n- A YouTube link or your own file up to 100MB\n\n### 3. AI breaks down the video\nGemini extracts timestamped scenes, cast and extras, visual style, pacing and aspect ratio — and assesses who the video is aimed at and what it's selling.\n- Nothing to enter — the AI shows you the scene-by-scene breakdown on its own\n\n### 4. Check relevance\nA separate check compares the video's audience with your product's buyers: a score, the reasoning behind it, and concrete edits — whether cloning this reference is even worth it.\n(available from plan: Standard+)\n- \"Use in generation\" checkbox — adds the suggestion to the prompt\n- \"Check again\" button — a fresh relevance check\n- \"Pick another reference\" button — back to step 2\n\n### 5. Assemble the shot list\nRemove unwanted characters, scenes and extras — clicking any of them highlights the relevant lines of the breakdown. A character can be swapped for your own photo, a description, or a brand character.\n(available from plan: Standard+)\n- Click a character — turn it on or off in the video\n- Replace a character: keep as-is, your own photo (Standard+), a text description, or a brand character\n- Click a scene or extras group — turn it on or off in frame\n- Voice, subtitles and camera movement — from the brand manifest (for products with a project)\n\n### 6. Get the prompt\nGPT-5 assembles a text-to-video prompt from the breakdown, the product, the brand manifest, the voice-over language and the relevance suggestions. The prompt can be edited by hand.\n- \"Generate prompt\" button — a ready text built from the breakdown and the product\n- The prompt can be edited by hand before saving\n- A separate voice-over script field — when a custom voice is selected\n\n### 7. Choose the format and reference images\nAspect ratio — 16:9 and 9:16 on any plan, plus 3:4, 1:1 or a custom one from Standard up — and which three images the model will get as references: characters, your scenes, brand scenes, product photo. Everything else goes into the prompt as text.\n(available from plan: Standard+)\n- Render quality: \"Fast\" or \"Cinematic\" (Standard+)\n- Up to three reference images for the generation engine — your own scenes and photos (Standard+)\n- Aspect ratio: 16:9 and 9:16 on any plan, the rest from Standard up\n\n### 8. Generate the video\nGrok or Google Veo 3.1 renders the new ad video — pick the engine and render quality, faster or more cinematic.\n- A product photo is required — the generate button stays hidden without it\n- \"Generate the ad video\" button\n- On failure — \"Generate again\"\n\n### 9. Review the result\nA separate artifact check will propose a fixed prompt for a re-generation. For a product from a project, a batch run for the whole line and three A/B hook variants are right there. The finished video is a direct file link, then an “Open in Postprod” button.\n(available from plan: Standard+)\n- Artifact check and sound check (Standard+)\n- A batch run for a whole product line, and 3 A/B variants (Premium, products with a project only)\n- An “Open in Postprod” button — the same video, alongside all your other ones\n\n### 10. Manage it in Postprod\nA separate Postprod tab with all your finished videos, not just the latest one. Change the script and the voice — with an explicit synthesis provider and an honest pre-listen before you pay — without a new render. Export to several platforms and publish with a shareable page.\n(available from plan: Standard+)\n- Re-voice without a new render — only the audio, subtitles and script change (Standard+)\n- Voice synthesis provider — ElevenLabs or Resemble explicitly, or “as is”\n- Pre-listen to the exact text, voice and provider combination — before paying for the re-voice\n- Export to several platforms at once — no extra render charge (Standard+)\n- Publication and a shareable page (Standard+, sign-in required)\n\n## Frequently asked questions\n\n**Do I need to sign up?**\nNo. The session is anonymous and created automatically on your first visit — you only need to accept the public offer and terms of use once, before your first breakdown. Signing in through Telegram is available but optional: it's needed for projects, the product catalog, the brand manifest, and to come back to your sessions later.\n\n**Which video formats are supported?**\nMP4, MOV and AVI up to 100MB, or simply a link to a public YouTube video — in which case there's nothing to download or upload at all.\n\n**How long does video generation take?**\nOnce the prompt is approved, the video is usually ready in 3–5 minutes — the exact time depends on the chosen generation engine (Grok by default, Google Veo 3.1 with Fast/Standard modes is also available) and current load.\n\n**How much does it cost?**\nRight now, nothing: all three plans — Lite, Standard and Premium — are free and switch right inside the app. This is a rollout period; whatever you've already made stays yours once paid plans arrive. Later, Lite is planned to become conditionally free — in exchange for liking the project's YouTube channel and sending a few links to the service.\n\n**What's the difference between the plans?**\nLite is the minimal path: reference breakdown and video generation in 16:9 or 9:16. Standard adds a relevance check, a video artifact audit, a brand manifest, your own scenes, photo character swap, any aspect ratio, and publishing. Premium is Standard plus the library of ready-made breakdowns. You can switch plans at any time without affecting projects, videos or breakdowns you've already made.\n\n**Where are my files stored, and when are they deleted?**\nIn Vercel Blob — the reference, product photos and the finished video all live in the same storage. Every file has an owner in the database: an expired session takes its files with it, a deleted product takes its photo, a deleted manifest takes its character and scene photos. Cleanup runs daily, and a separate pass picks up orphaned files.\n\n**Who owns the breakdowns and the finished videos?**\nThe service creates the reference breakdown, and under the terms of use the breakdowns belong to it — that's exactly what lets the library offer them to other users. Your product, your uploaded materials and the generated video remain yours. Breakdowns of videos uploaded as a file are private: only the author sees them.\n\n**Can I use it from Telegram?**\nYes — the same product works both as a regular website in a browser and as a Telegram Mini App inside Telegram, with the same set of features.\n\n**Can I manually edit the video breakdown or the prompt?**\nYes, at both steps: after the automatic reference analysis and after the automatic prompt generation, both results can be edited before moving on.\n\n**Is this an open-source project?**\nYes — the source code is available on GitHub, and development followed the GitHub Spec Kit methodology.\n\n## Plans and features\n\nAll plans are currently free and switched by the user themselves in the mini-app (this is a temporary trial period, billing is not enabled yet).\n\n### Lite\nРазбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.\n16:9/9:16 only\n\n### Standard\nВесь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.\nReference relevance scoring, Audit of a finished video, Publishing through the service, Brand manifest, Your own scenes and reference slots, Photo character replacement, Any aspect ratio, Full Veo model, Clone your own voice, Tutorial video for the client's website\nany aspect ratio\n\n### Premium\nВсё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.\nLibrary of ready-made breakdowns, Reference relevance scoring, Audit of a finished video, Publishing through the service, Brand manifest, Your own scenes and reference slots, Photo character replacement, Any aspect ratio, Full Veo model, Clone your own voice, Dub (full replacement of the model's voice), Tutorial video for the client's website\nany aspect ratio\n\n## Pipeline rules\n\nVeo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.\nGrok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.\nРеференс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.\nОзвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».\nФорматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.\nФото товара — до 10 МБ.\n\n## Wizard field hints\n\n**Загрузка референса**: A successful UGC ad we'll clone for your product — grab a ready-made breakdown from the library, find a video on YouTube, paste a link, or upload a file.\n\n**Файл референса**: MP4, MOV, AVI · up to 100 MB\n\n**Референс — файл слишком большой**: The video is larger than 100 MB.\n\n**Манифест бренда — голос**: Voice character, pace, manner — goes into the prompt; the line language is set on the “Product” step.\n\n**Манифест бренда — по умолчанию**: Copy for this clip: adjust the style for this specific generation — the manifest itself doesn't change.\n\n**Клонирование голоса — лимит**: Reached the limit of {{max}} voices — delete one to clone a new one.\n\n## Additional notes\n\n<!-- Manual knowledge layer (spec §5.2, item 6) — English translation. -->\n\n## Choosing a good reference\n\nAny ad or review video works, as long as it shows pacing, editing and\ndelivery — it does not need to feature the same kind of product. The\nanalysis extracts structure (scenes, cast, style, aspect ratio), it does\nnot transplant someone else's product onto the screen: you add your own\nproduct and photo at step 5, even if the reference was about sneakers\nand your product is cosmetics. A poor reference is one with almost no\naction (a static talking head for ten minutes) or one where the analysis\nclearly can't find what is being sold (no product in frame at all).\n\n## If a render fails\n\nThe video is automatically marked as failed, the reason is shown in the\ninterface, and a \"Retry\" button is usually available — a new attempt\nwith the same settings. If a video keeps failing for the same reason,\nthe issue is likely the reference itself or the frame composition (too\nlong a scene chain, an unusual aspect ratio), not a transient error —\nsimplifying the frame composition at step 5 and re-running the analysis\nis worth trying first.\n\n## Veo vs. Grok in practice\n\nVeo is the primary engine, up to 56 seconds total (8 seconds per call,\nup to seven calls), consistently higher quality, generation usually\ntakes a few minutes. Grok is the alternative engine, up to 25 seconds\n(a 15-second base clip plus one extension of up to 10 seconds),\nresolution up to 1080p (capped at 720p when reference images or an\nextension are used) — usually a bit cheaper with a different visual\ncharacter. Which engine is used for a given session is decided by the\nwizard and the brand settings — the consultant does not switch engines\nitself.\n\n## Positioning\n\nThe service is a tool for people who already have (or found) an example\nvideo and want something similar for their own product, without a film\ncrew or editing from scratch: analyze the reference, then generate a new\nvideo based on the structure of that analysis. It is not a from-scratch\nad builder or a library of ready-made templates — a reference is always\nrequired (found on YouTube, by link, your own file, or — on Premium — an\nalready-analyzed entry from the library).\n\n## Support and documents\n\nThere is no separate support channel besides the service's own Telegram\nbot yet (open question for the product owner, spec §12.3) — for\nanything the consultant can't answer about the product itself, suggest\nopening the mini-app. The terms of use and the offer are at\n`/legal/offer` and `/legal/terms-of-use`; the consultant does not quote\nthem verbatim or give legal guarantees, it points to the document.\n",
  de: '# Wissensdatenbank des viral4creators-KI-Beraters\n\n_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._\n\n## Bereiche der Mini-App\n\n- **Projekte** — Produkt oder Produktlinie, für die Werbung generiert wird\n- **Marke** — Ein einheitlicher Stil und Charaktere für alle Projekte einer Marke\n- **Produktion** — der Generierungsassistent — von der Referenzauswahl bis zum fertigen Video (siehe die Anleitungsschritte unten)\n- **Postprod** — Alle Ihre fertigen Videos: Neuvertonung, Export, Veröffentlichung und Teilen.\n\n## Anleitungsschritte\n\n### 1. Produkt anlegen\nProjekt und Produkt: ein Foto (daraus werden Kategorie, Zielgruppe und Vergleichspreise bestimmt), eine Beschreibung als Text oder Sprache, ein Preis. Der schnelle Weg ohne Projekt funktioniert ebenfalls — dann wird das Produkt direkt im Assistenten beschrieben.\n\n### 2. Referenz wählen\nVier Wege: YouTube-Suche, ein Link, eine eigene Datei bis 100 MB und — im Premium-Tarif — eine fertige Analyse aus der Bibliothek des Dienstes, sofort und ohne neuen KI-Aufruf.\n(verfügbar ab Tarif: Premium)\n- Bibliothek fertiger Analysen — ohne neuen KI-Aufruf (Premium)\n- YouTube-Suche — Anmeldung nötig\n- Ein YouTube-Link oder eine eigene Datei bis 100 MB\n\n### 3. KI analysiert das Video\nGemini extrahiert Szenen mit Zeitstempeln, Darsteller und Statisten, visuellen Stil, Tempo und Seitenverhältnis — und beurteilt, an wen sich dieses Video richtet und was es bewirbt.\n- Keine Eingabe nötig — die KI zeigt die Szenen-für-Szene-Analyse von selbst\n\n### 4. Relevanz prüfen\nEine separate Prüfung vergleicht die Zielgruppe des Videos mit den Käufern Ihres Produkts: eine Bewertung, die Begründung dazu und konkrete Änderungen — ob es sich überhaupt lohnt, diese Referenz zu klonen.\n(verfügbar ab Tarif: Standard+)\n- Checkbox „Bei der Generierung berücksichtigen" — nimmt den Hinweis in den Prompt auf\n- Schaltfläche „Erneut prüfen" — eine neue Relevanzprüfung\n- Schaltfläche „Andere Referenz wählen" — zurück zu Schritt 2\n\n### 5. Bildaufbau zusammenstellen\nÜberflüssige Charaktere, Szenen und Statisten entfernen — ein Klick auf einen davon hebt die passenden Zeilen der Analyse hervor. Ein Charakter lässt sich durch ein eigenes Foto, eine Beschreibung oder einen Marken-Charakter ersetzen.\n(verfügbar ab Tarif: Standard+)\n- Klick auf einen Charakter — schaltet ihn im Video ein oder aus\n- Charakter ersetzen: unverändert, eigenes Foto (Standard+), Textbeschreibung oder Marken-Charakter\n- Klick auf eine Szene oder Statisten — schaltet sie im Bild ein oder aus\n- Stimme, Untertitel und Kamerabewegung — aus dem Markenmanifest (für Produkte mit Projekt)\n\n### 6. Prompt erhalten\nGPT-5 stellt einen Text-zu-Video-Prompt aus Analyse, Produkt, Markenmanifest, Sprache der Vertonung und Relevanz-Hinweisen zusammen. Der Prompt lässt sich von Hand anpassen.\n- Schaltfläche „Prompt generieren" — fertiger Text aus Analyse und Produkt\n- Der Prompt lässt sich vor dem Speichern von Hand anpassen\n- Ein eigenes Textfeld für die Vertonung — wenn eine eigene Stimme gewählt ist\n\n### 7. Format und Referenzbilder wählen\nSeitenverhältnis — 16:9 und 9:16 in jedem Tarif, 3:4, 1:1 oder ein eigenes ab Standard — sowie die drei Bilder, die das Modell als Referenz erhält: Charaktere, eigene Szenen, Markenszenen, Produktfoto. Alles Weitere fließt als Text in den Prompt.\n(verfügbar ab Tarif: Standard+)\n- Render-Qualität: „Schnell" oder „Kinematografisch" (Standard+)\n- Bis zu drei Referenzbilder für die Generierungs-Engine — eigene Szenen und Fotos (Standard+)\n- Seitenverhältnis: 16:9 und 9:16 in jedem Tarif, der Rest ab Standard\n\n### 8. Video generieren\nGrok oder Google Veo 3.1 rendert das neue Werbevideo — wahlweise Engine und Render-Qualität, schneller oder kinematografischer.\n- Ein Produktfoto ist Pflicht — ohne es erscheint der Generieren-Button nicht\n- Schaltfläche „Werbevideo generieren"\n- Bei Fehlschlag — „Erneut generieren"\n\n### 9. Ergebnis prüfen\nEine separate Artefaktprüfung schlägt einen korrigierten Prompt für eine erneute Generierung vor. Bei einem Produkt aus einem Projekt gibt es gleich einen Batch-Lauf für die ganze Produktlinie und drei A/B-Varianten des Hooks. Das fertige Video steht als direkter Datei-Link zur Verfügung, danach folgt die Schaltfläche „In Postprod öffnen“.\n(verfügbar ab Tarif: Standard+)\n- Artefaktprüfung und Sound-Check (Standard+)\n- Ein Batch-Lauf für die ganze Produktlinie und 3 A/B-Varianten (Premium, nur für Produkte mit Projekt)\n- Schaltfläche „In Postprod öffnen“ — dasselbe Video, zusammen mit all Ihren anderen\n\n### 10. In Postprod verwalten\nEin eigener Tab „Postprod“ mit all Ihren fertigen Videos, nicht nur dem letzten. Ändern Sie Text und Stimme — mit expliziter Wahl des Synthese-Anbieters und einem ehrlichen Vorab-Anhören vor der Zahlung — ganz ohne neues Rendering. Exportieren Sie für mehrere Plattformen und veröffentlichen Sie mit einer Seite zum Teilen.\n(verfügbar ab Tarif: Standard+)\n- Neu vertonen ohne neues Rendering — nur Ton, Untertitel und Text ändern sich (Standard+)\n- Sprachsynthese-Anbieter — explizit ElevenLabs oder Resemble, oder „wie bisher“\n- Die genaue Kombination aus Text, Stimme und Anbieter vorab anhören — vor der Zahlung für die Neuvertonung\n- Export für mehrere Plattformen zugleich — ohne erneute Render-Gebühr (Standard+)\n- Veröffentlichung und Seite zum Teilen (Standard+, Anmeldung nötig)\n\n## Häufige Fragen\n\n**Ist eine Registrierung erforderlich?**\nNein. Die Sitzung ist anonym und wird beim ersten Besuch automatisch erstellt — man muss nur einmal, vor der ersten Analyse, dem öffentlichen Angebot und den Nutzungsbedingungen zustimmen. Die Anmeldung über Telegram ist verfügbar, aber optional: Sie wird für Projekte, den Produktkatalog, das Markenmanifest und um später zu eigenen Sitzungen zurückzukehren benötigt.\n\n**Welche Videoformate werden unterstützt?**\nMP4, MOV und AVI bis 100 MB, oder einfach ein Link zu einem öffentlichen YouTube-Video — dann muss überhaupt keine Datei heruntergeladen oder hochgeladen werden.\n\n**Wie lange dauert die Videogenerierung?**\nSobald der Prompt bestätigt ist, ist das Video meist innerhalb von 3–5 Minuten fertig — die genaue Dauer hängt von der gewählten Generierungs-Engine ab (standardmäßig Grok, alternativ Google Veo 3.1 mit den Modi Fast/Standard) sowie der aktuellen Auslastung.\n\n**Was kostet das?**\nDerzeit nichts: Alle drei Tarife — Lite, Standard und Premium — sind kostenlos und lassen sich direkt in der App umschalten. Das ist eine Testphase; wenn eine Bezahlung eingeführt wird, bleibt bereits Erstelltes erhalten. Später soll Lite bedingt kostenlos werden — gegen ein Like des Projekt-YouTube-Kanals und einige an den Dienst gesendete Links.\n\n**Worin unterscheiden sich die Tarife?**\nLite ist der minimale Weg: Referenzanalyse und Videogenerierung in 16:9 oder 9:16. Standard ergänzt eine Relevanzprüfung, einen Video-Audit, ein Markenmanifest, eigene Szenen, Charakteraustausch per Foto, beliebige Seitenverhältnisse und die Veröffentlichung. Premium ist Standard plus die Bibliothek fertiger Analysen. Der Tarif lässt sich jederzeit wechseln, ohne bereits erstellte Projekte, Videos oder Analysen zu beeinträchtigen.\n\n**Wo werden meine Dateien gespeichert und wann werden sie gelöscht?**\nIn Vercel Blob — Referenz, Produktfoto und fertiges Video liegen im selben Speicher. Jede Datei hat einen Besitzer in der Datenbank: Eine abgelaufene Sitzung nimmt ihre Dateien mit, ein gelöschtes Produkt sein Foto, ein gelöschtes Manifest die Fotos von Charakteren und Szenen. Die Bereinigung läuft täglich, verwaiste Dateien erfasst ein separater Durchlauf.\n\n**Wem gehören die Analysen und die fertigen Videos?**\nDie Analyse der Referenz erstellt der Dienst, und laut Nutzungsbedingungen gehören die Analysen ihm — genau deshalb kann die Bibliothek sie anderen anbieten. Ihr Produkt, Ihre hochgeladenen Materialien und das generierte Video bleiben Ihnen. Analysen von als Datei hochgeladenen Videos sind privat: Nur der Autor sieht sie.\n\n**Kann man es über Telegram nutzen?**\nJa — dasselbe Produkt funktioniert sowohl als gewöhnliche Website im Browser als auch als Telegram Mini App innerhalb von Telegram, mit demselben Funktionsumfang.\n\n**Kann man die Videoanalyse oder den Prompt manuell bearbeiten?**\nJa, an beiden Stellen: nach der automatischen Analyse der Referenz und nach der automatischen Generierung des Prompts lassen sich beide Ergebnisse anpassen, bevor es weitergeht.\n\n**Ist das ein Open-Source-Projekt?**\nJa — der Quellcode ist auf GitHub verfügbar, die Entwicklung folgte der GitHub-Spec-Kit-Methodik.\n\n## Tarife und Funktionen\n\nAlle Tarife sind derzeit kostenlos und werden vom Nutzer selbst in der Mini-App umgeschaltet (dies ist eine vorübergehende Testphase, die Abrechnung ist noch nicht aktiviert).\n\n### Lite\nРазбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.\n16:9/9:16 only\n\n### Standard\nВесь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.\nBewertung der Referenzrelevanz, Audit eines fertigen Videos, Veröffentlichung über den Dienst, Marken-Manifest, Eigene Szenen und Referenz-Slots, Austausch von Personen im Foto, Beliebiges Seitenverhältnis, Vollständiges Veo-Modell, Eigene Stimme klonen, Tutorial-Video für die Website des Kunden\nany aspect ratio\n\n### Premium\nВсё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.\nBibliothek fertiger Analysen, Bewertung der Referenzrelevanz, Audit eines fertigen Videos, Veröffentlichung über den Dienst, Marken-Manifest, Eigene Szenen und Referenz-Slots, Austausch von Personen im Foto, Beliebiges Seitenverhältnis, Vollständiges Veo-Modell, Eigene Stimme klonen, Synchronisation (modelleigene Stimme vollständig ersetzt), Tutorial-Video für die Website des Kunden\nany aspect ratio\n\n## Pipeline-Regeln\n\nVeo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.\nGrok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.\nРеференс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.\nОзвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».\nФорматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.\nФото товара — до 10 МБ.\n\n## Hinweise zu Assistentenfeldern\n\n**Загрузка референса**: Eine erfolgreiche UGC-Werbung, die wir für Ihr Produkt klonen – nehmen Sie eine fertige Analyse aus der Bibliothek, suchen Sie ein Video auf YouTube, fügen Sie einen Link ein oder laden Sie eine Datei hoch.\n\n**Файл референса**: MP4, MOV, AVI · bis zu 100 MB\n\n**Референс — файл слишком большой**: Das Video ist größer als 100 MB.\n\n**Манифест бренда — голос**: Stimmcharakter, Tempo, Art — fließt in den Prompt ein; die Sprache der Repliken wird im Schritt „Produkt“ festgelegt.\n\n**Манифест бренда — по умолчанию**: Kopie für dieses Video: Passen Sie den Stil für diese Generierung an — das Manifest selbst bleibt unverändert.\n\n**Клонирование голоса — лимит**: Limit von {{max}} Stimmen erreicht — löschen Sie eine, um eine neue zu klonen.\n\n## Zusätzliches\n\n<!-- Manuelle Wissensebene (Spezifikation §5.2, Punkt 6) — deutsche Übersetzung. -->\n\n## Eine gute Referenz auswählen\n\nJedes Werbe- oder Rezensionsvideo eignet sich, solange Tempo, Schnitt und\nVortragsweise erkennbar sind — es muss nicht dieselbe Produktart zeigen.\nDie Analyse extrahiert die Struktur (Szenen, Besetzung, Stil,\nSeitenverhältnis), sie überträgt nicht das fremde Produkt auf den\nBildschirm: Ihr eigenes Produkt und Foto fügen Sie in Schritt 5 hinzu,\nauch wenn die Referenz Sneaker zeigte und Ihr Produkt Kosmetik ist. Eine\nschlechte Referenz hat kaum Handlung (ein zehnminütiger statischer\nSprecher) oder die Analyse findet gar kein verkauftes Produkt im Bild.\n\n## Wenn ein Rendering fehlschlägt\n\nDas Video wird automatisch als fehlgeschlagen markiert, der Grund wird\nin der Oberfläche angezeigt, und meist ist eine „Wiederholen“-Schaltfläche\nverfügbar — ein neuer Versuch mit denselben Einstellungen. Schlägt ein\nVideo wiederholt aus demselben Grund fehl, liegt es wahrscheinlich an der\nReferenz selbst oder an der Bildkomposition (zu lange Szenenkette,\nungewöhnliches Format), nicht an einer vorübergehenden Störung — zuerst\ndie Bildkomposition in Schritt 5 vereinfachen und die Analyse wiederholen.\n\n## Veo und Grok in der Praxis\n\nVeo ist die Haupt-Engine, bis zu 56 Sekunden insgesamt (8 Sekunden pro\nAufruf, bis zu sieben Aufrufe), durchgehend höhere Qualität, die\nGenerierung dauert meist einige Minuten. Grok ist die alternative\nEngine, bis zu 25 Sekunden (15 Sekunden Basisclip plus eine Erweiterung\nvon bis zu 10 Sekunden), Auflösung bis 1080p (auf 720p begrenzt bei\nReferenzbildern oder Erweiterung) — meist etwas günstiger und mit\nanderem visuellem Charakter. Welche Engine für eine bestimmte Sitzung\nverwendet wird, entscheiden der Assistent und die Markeneinstellungen —\nder Berater wechselt die Engine nicht selbst.\n\n## Positionierung\n\nDer Dienst ist ein Werkzeug für alle, die bereits ein Beispielvideo haben\n(oder gefunden haben) und etwas Ähnliches für ihr eigenes Produkt wollen,\nohne Filmteam oder Schnitt von Grund auf: Referenz analysieren, dann ein\nneues Video basierend auf der Struktur dieser Analyse generieren. Es ist\nkein Werbebaukasten von Grund auf und keine Bibliothek fertiger\nVorlagen — eine Referenz ist immer erforderlich (gefunden auf YouTube,\nper Link, eigene Datei oder — bei Premium — ein bereits analysierter\nEintrag aus der Bibliothek).\n\n## Support und Dokumente\n\nEs gibt derzeit noch keinen separaten Support-Kanal außer dem eigenen\nTelegram-Bot des Dienstes (offene Frage an den Produktverantwortlichen,\nSpezifikation §12.3) — bei allem, was der Berater zum Produkt nicht\nbeantworten kann, wird vorgeschlagen, die Mini-App zu öffnen. Nutzungs-\nbedingungen und Angebot stehen unter `/legal/offer` und\n`/legal/terms-of-use`; der Berater zitiert sie nicht wörtlich und gibt\nkeine rechtlichen Garantien, sondern verweist auf das Dokument.\n',
  es: '# Base de conocimiento del consultor de IA de viral4creators\n\n_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._\n\n## Secciones de la mini-app\n\n- **Proyectos** — Producto o línea para la que se genera publicidad\n- **Marca** — Un estilo y unos personajes unificados para todos los proyectos de la marca\n- **Producción** — el asistente de generación — desde elegir la referencia hasta el video terminado (ver los pasos del tutorial más abajo)\n- **Postprod** — Todos tus vídeos terminados: redoblaje, exportación, publicación y compartir.\n\n## Pasos del tutorial\n\n### 1. Agrega un producto\nUn proyecto y un producto: una foto (a partir de ella se determinan la categoría, la audiencia objetivo y los precios comparables), una descripción en texto o voz, y un precio. El camino rápido sin proyecto también funciona — entonces el producto se describe directamente en el asistente.\n\n### 2. Elige una referencia\nCuatro formas: búsqueda en YouTube, un enlace, tu propio archivo de hasta 100 MB y — en el plan Premium — un análisis ya listo de la biblioteca del servicio, al instante y sin una nueva llamada a la IA.\n(disponible desde el plan: Premium)\n- Biblioteca de análisis ya listos — sin una nueva llamada a la IA (Premium)\n- Búsqueda en YouTube — requiere inicio de sesión\n- Un enlace de YouTube o tu propio archivo de hasta 100 MB\n\n### 3. La IA analiza el video\nGemini extrae escenas con marcas de tiempo, elenco y extras, estilo visual, ritmo y formato de encuadre — y evalúa a quién está dirigido este video y qué está promocionando.\n- No hay que ingresar nada — la IA muestra el análisis por escenas por sí sola\n\n### 4. Verifica la relevancia\nUna verificación aparte compara la audiencia del video con los compradores de tu producto: una puntuación, la explicación del razonamiento y cambios concretos — si realmente vale la pena clonar esa referencia.\n(disponible desde el plan: Standard+)\n- Casilla «Tener en cuenta en la generación» — añade la sugerencia al prompt\n- Botón «Verificar de nuevo» — un nuevo análisis de relevancia\n- Botón «Elegir otra referencia» — volver al paso 2\n\n### 5. Arma la composición del video\nElimina personajes, escenas y extras innecesarios — al hacer clic en cualquiera de ellos se resaltan las líneas correspondientes del análisis. Un personaje puede reemplazarse por tu propia foto, una descripción o un personaje de marca.\n(disponible desde el plan: Standard+)\n- Clic en un personaje — lo activa o desactiva en el video\n- Reemplazar un personaje: tal cual, con tu propia foto (Standard+), con texto o con un personaje de marca\n- Clic en una escena o extras — la activa o desactiva en el cuadro\n- Voz, subtítulos y movimiento de cámara — desde el manifiesto de marca (para productos con proyecto)\n\n### 6. Obtén el prompt\nGPT-5 arma un prompt de texto a video a partir del análisis, el producto, el manifiesto de marca, el idioma de la locución y las sugerencias de relevancia. El prompt se puede editar a mano.\n- Botón «Generar prompt» — texto listo a partir del análisis y el producto\n- El prompt se puede ajustar a mano antes de guardar\n- Un campo de texto aparte para la locución — si se elige una voz propia\n\n### 7. Elige el formato y las imágenes de referencia\nRelación de aspecto — 16:9 y 9:16 en cualquier plan, además de 3:4, 1:1 o una personalizada desde Standard en adelante — y qué tres imágenes recibirá el modelo como referencia: personajes, tus escenas, escenas de marca, foto del producto. Todo lo demás se incluye como texto en el prompt.\n(disponible desde el plan: Standard+)\n- Calidad de renderizado: «Rápida» o «Cinematográfica» (Standard+)\n- Hasta tres imágenes de referencia para el motor de generación — tus propias escenas y fotos (Standard+)\n- Relación de aspecto: 16:9 y 9:16 en cualquier plan, el resto desde Standard\n\n### 8. Genera el video\nGrok o Google Veo 3.1 renderiza el nuevo video publicitario — a elección, motor y calidad de renderizado, más rápido o más cinematográfico.\n- La foto del producto es obligatoria — sin ella el botón de generar no aparece\n- Botón «Generar video publicitario»\n- Si falla — «Generar de nuevo»\n\n### 9. Revisa el resultado\nUna verificación aparte de artefactos propondrá un prompt corregido para una nueva generación. Para un producto de un proyecto, ahí mismo tienes un lote para toda la línea y tres variantes A/B del gancho. El video terminado se entrega como un enlace directo al archivo, y después el botón «Abrir en Postprod».\n(disponible desde el plan: Standard+)\n- Verificación de artefactos y de audio (Standard+)\n- Un lote para toda la línea de productos y 3 variantes A/B (Premium, solo productos con proyecto)\n- Botón «Abrir en Postprod» — el mismo video, junto con todos tus demás videos\n\n### 10. Gestiónalo en Postprod\nUna pestaña aparte, «Postprod», con todos tus videos terminados, no solo el último. Cambia el texto y la voz — con un proveedor de síntesis explícito y una escucha previa honesta antes de pagar — sin un nuevo renderizado. Exporta a varias plataformas y publica con una página para compartir.\n(disponible desde el plan: Standard+)\n- Redoblaje sin nuevo renderizado — solo cambian el audio, los subtítulos y el texto (Standard+)\n- Proveedor de síntesis de voz — ElevenLabs o Resemble de forma explícita, o «como está»\n- Escucha previa de la combinación exacta de texto, voz y proveedor — antes de pagar el redoblaje\n- Exportación a varias plataformas a la vez — sin pagar el renderizado otra vez (Standard+)\n- Publicación y página para compartir (Standard+, requiere inicio de sesión)\n\n## Preguntas frecuentes\n\n**¿Hace falta registrarse?**\nNo. La sesión es anónima y se crea automáticamente en la primera visita — solo hay que aceptar una vez la oferta pública y los términos de uso antes del primer análisis. Iniciar sesión con Telegram está disponible pero es opcional: se necesita para proyectos, el catálogo de productos, el manifiesto de marca y para volver más tarde a tus sesiones.\n\n**¿Qué formatos de video se admiten?**\nMP4, MOV y AVI de hasta 100 MB, o simplemente un enlace a un video público de YouTube — en ese caso no hace falta descargar ni subir ningún archivo.\n\n**¿Cuánto tarda la generación del video?**\nUna vez aprobado el prompt, el video suele estar listo en 3 a 5 minutos — el tiempo exacto depende del motor de generación elegido (Grok por defecto; también está disponible Google Veo 3.1 con los modos Fast/Standard) y de la carga actual.\n\n**¿Cuánto cuesta?**\nPor ahora, nada: los tres planes — Lite, Standard y Premium — son gratuitos y se cambian directamente desde la aplicación. Es un período de prueba; cuando se introduzcan los pagos, lo que ya hayas hecho seguirá siendo tuyo. Más adelante, Lite pasará a ser condicionalmente gratuito — a cambio de dar «me gusta» al canal de YouTube del proyecto y enviar algunos enlaces al servicio.\n\n**¿En qué se diferencian los planes entre sí?**\nLite es el camino mínimo: análisis de la referencia y generación del video en 16:9 o 9:16. Standard añade verificación de relevancia, auditoría del video, manifiesto de marca, escenas propias, reemplazo de personajes por foto, cualquier formato de encuadre y publicación. Premium es Standard más la biblioteca de análisis ya listos. El plan se puede cambiar en cualquier momento sin afectar los proyectos, videos o análisis ya creados.\n\n**¿Dónde se guardan mis archivos y cuándo se eliminan?**\nEn Vercel Blob — la referencia, la foto del producto y el video terminado se guardan en el mismo almacenamiento. Cada archivo tiene un propietario en la base de datos: una sesión vencida se lleva sus archivos, un producto eliminado se lleva su foto, un manifiesto eliminado se lleva las fotos de personajes y escenas. La limpieza se ejecuta a diario, y un proceso aparte recoge los archivos huérfanos.\n\n**¿A quién pertenecen los análisis y los videos terminados?**\nEl análisis de la referencia lo crea el servicio, y según los términos de uso los análisis le pertenecen — precisamente por eso la biblioteca puede ofrecerlos a otros usuarios. Tu producto, tus materiales subidos y el video generado siguen siendo tuyos. Los análisis de videos subidos como archivo son privados: solo los ve el autor.\n\n**¿Se puede usar desde Telegram?**\nSí — el mismo producto funciona tanto como un sitio web normal en el navegador como una Telegram Mini App dentro de Telegram, con el mismo conjunto de funciones.\n\n**¿Se puede editar manualmente el análisis del video o el prompt?**\nSí, en ambos pasos: después del análisis automático de la referencia y después de la generación automática del prompt, ambos resultados se pueden ajustar antes de continuar.\n\n**¿Es un proyecto de código abierto?**\nSí — el código fuente está disponible en GitHub, y el desarrollo siguió la metodología GitHub Spec Kit.\n\n## Planes y funciones\n\nTodos los planes son gratuitos por ahora y el propio usuario los cambia en la mini-app (es un período de prueba temporal, la facturación aún no está activada).\n\n### Lite\nРазбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.\n16:9/9:16 only\n\n### Standard\nВесь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.\nEvaluación de relevancia de la referencia, Auditoría de un vídeo terminado, Publicación a través del servicio, Manifiesto de marca, Escenas propias y espacios de referencia, Sustitución de personajes en la foto, Cualquier formato de imagen, Modelo Veo completo, Clonar tu propia voz, Vídeo tutorial del sitio del cliente\nany aspect ratio\n\n### Premium\nВсё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.\nBiblioteca de análisis listos, Evaluación de relevancia de la referencia, Auditoría de un vídeo terminado, Publicación a través del servicio, Manifiesto de marca, Escenas propias y espacios de referencia, Sustitución de personajes en la foto, Cualquier formato de imagen, Modelo Veo completo, Clonar tu propia voz, Doblaje (reemplazo completo de la voz del modelo), Vídeo tutorial del sitio del cliente\nany aspect ratio\n\n## Reglas del pipeline\n\nVeo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.\nGrok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.\nРеференс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.\nОзвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».\nФорматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.\nФото товара — до 10 МБ.\n\n## Sugerencias de los campos del asistente\n\n**Загрузка референса**: Un anuncio UGC exitoso que clonaremos para tu producto: toma un desglose ya listo de la biblioteca, busca un vídeo en YouTube, pega un enlace o sube un archivo.\n\n**Файл референса**: MP4, MOV, AVI · hasta 100 MB\n\n**Референс — файл слишком большой**: El vídeo supera los 100 MB.\n\n**Манифест бренда — голос**: Carácter de la voz, ritmo, estilo — se incluirá en el prompt; el idioma de las réplicas se define en el paso «Producto».\n\n**Манифест бренда — по умолчанию**: Copia para este video: ajusta el estilo para esta generación concreta — el manifiesto en sí no se modifica.\n\n**Клонирование голоса — лимит**: Se alcanzó el límite de {{max}} voces — elimina una para clonar otra.\n\n## Notas adicionales\n\n<!-- Capa manual de la base de conocimiento (spec §5.2, punto 6) — traducción. -->\n\n## Cómo elegir una buena referencia\n\nSirve cualquier video publicitario o de reseña, siempre que muestre\nritmo, montaje y estilo de presentación — no hace falta que sea el mismo\ntipo de producto. El análisis extrae la estructura (escenas, elenco,\nestilo, relación de aspecto), no traslada el producto ajeno a la\npantalla: tu propio producto y foto se agregan en el paso 5, aunque la\nreferencia fuera de zapatillas y tu producto sea cosmética. Una mala\nreferencia es la que casi no tiene acción (una persona hablando\nestáticamente diez minutos) o donde el análisis claramente no encuentra\nqué se está vendiendo (ningún producto en cuadro).\n\n## Si el renderizado falla\n\nEl video se marca automáticamente como fallido, el motivo se muestra en\nla interfaz y normalmente hay un botón "Reintentar" — un nuevo intento\ncon la misma configuración. Si un video falla varias veces seguidas por\nel mismo motivo, probablemente el problema esté en la referencia misma o\nen la composición del cuadro (cadena de escenas demasiado larga, formato\ninusual), no en un fallo pasajero — conviene simplificar la composición\ndel cuadro en el paso 5 y repetir el análisis.\n\n## Veo y Grok en la práctica\n\nVeo es el motor principal, hasta 56 segundos en total (8 segundos por\nllamada, hasta siete llamadas), calidad consistentemente más alta, la\ngeneración suele tardar unos minutos. Grok es el motor alternativo,\nhasta 25 segundos (un clip base de 15 segundos más una extensión de\nhasta 10 segundos), resolución hasta 1080p (limitada a 720p si se usan\nimágenes de referencia o extensión) — suele ser algo más económico y con\nun carácter visual distinto. Qué motor se usa para una sesión concreta\nlo deciden el asistente y la configuración de marca — el consultor no\ncambia el motor por sí mismo.\n\n## Posicionamiento\n\nEl servicio es una herramienta para quienes ya tienen (o encontraron) un\nvideo de ejemplo y quieren algo similar para su propio producto, sin\nequipo de filmación ni montaje desde cero: analizar la referencia y\nluego generar un nuevo video basado en la estructura de ese análisis. No\nes un generador de anuncios desde cero ni una biblioteca de plantillas\nlistas — siempre se necesita una referencia (encontrada en YouTube, por\nenlace, archivo propio o — en Premium — una entrada ya analizada de la\nbiblioteca).\n\n## Soporte y documentos\n\nPor ahora no hay un canal de soporte separado además del propio bot de\nTelegram del servicio (pregunta abierta para el dueño del producto, spec\n§12.3) — para todo lo que el consultor no pueda responder sobre el\nproducto, se sugiere abrir la mini-app. Los términos de uso y la oferta\nestán en `/legal/offer` y `/legal/terms-of-use`; el consultor no los cita\ntextualmente ni da garantías legales, remite al documento.\n',
};

export const ASSISTANT_PROACTIVE_TIPS: Record<string, ProactiveTips> = {
  ru: {
    step: {
      '2': 'Не понятно, что вводить на шаге «Выберите референс»? Спросите',
      '4': 'Не понятно, что делает проверка релевантности? Спросите',
      '5': 'Не понятно, как собрать состав кадра? Спросите',
      '7': 'Не понятно, какой формат выбрать? Спросите',
      '9': 'Не получилось с первого раза? Спросите, что можно поправить',
      '10': 'Не уверены, каким провайдером переозвучить? Спросите — и попробуйте пред-прослушку',
    },
    plans: 'Сомневаетесь, какой тариф нужен для вашей задачи? Опишите её',
    exitIntent: 'Если не нашли ответ — спросите, это быстрее, чем в Telegram',
  },
  uk: {
    step: {
      '2': 'Не зрозуміло, що вводити на кроці «Оберіть референс»? Запитайте',
      '4': 'Не зрозуміло, що робить перевірка релевантності? Запитайте',
      '5': 'Не зрозуміло, як зібрати склад кадру? Запитайте',
      '7': 'Не зрозуміло, який формат обрати? Запитайте',
      '9': 'Не вийшло з першого разу? Запитайте, що можна виправити',
      '10': 'Не впевнені, яким провайдером переозвучити? Запитайте — і спробуйте попереднє прослуховування',
    },
    plans:
      'Сумніваєтеся, який тариф потрібен для вашого завдання? Опишіть його',
    exitIntent:
      'Якщо не знайшли відповідь — запитайте, це швидше, ніж у Telegram',
  },
  en: {
    step: {
      '2': 'Not sure what to enter at the "Choose a reference" step? Ask',
      '4': 'Not sure what the relevance check does? Ask',
      '5': 'Not sure how to put the frame together? Ask',
      '7': 'Not sure which aspect ratio to pick? Ask',
      '9': "Didn't work on the first try? Ask what to fix",
      '10': 'Not sure which provider to re-voice with? Ask — and try the pre-listen',
    },
    plans: 'Not sure which plan fits your case? Describe it',
    exitIntent:
      "If you haven't found the answer — just ask, it's faster than Telegram",
  },
  de: {
    step: {
      '2': 'Unklar, was bei „Referenz wählen“ einzugeben ist? Fragen Sie',
      '4': 'Unklar, was die Relevanzprüfung macht? Fragen Sie',
      '5': 'Unklar, wie die Bildkomposition zusammengestellt wird? Fragen Sie',
      '7': 'Unklar, welches Format Sie wählen sollen? Fragen Sie',
      '9': 'Beim ersten Versuch nicht geklappt? Fragen Sie, was zu ändern ist',
      '10': 'Unsicher, mit welchem Anbieter neu vertonen? Fragen Sie — und probieren Sie das Vorab-Anhören',
    },
    plans:
      'Unsicher, welcher Tarif zu Ihrer Aufgabe passt? Beschreiben Sie sie',
    exitIntent:
      'Keine Antwort gefunden? Einfach fragen — schneller als Telegram',
  },
  es: {
    step: {
      '2': '¿No está claro qué poner en "Elige una referencia"? Pregunta',
      '4': '¿No está claro qué hace la verificación de relevancia? Pregunta',
      '5': '¿No está claro cómo componer el cuadro? Pregunta',
      '7': '¿No sabes qué formato elegir? Pregunta',
      '9': '¿No funcionó a la primera? Pregunta qué se puede ajustar',
      '10': '¿No sabes con qué proveedor redoblar? Pregunta — y prueba la escucha previa',
    },
    plans: '¿No sabes qué plan necesitas? Descríbelo',
    exitIntent:
      'Si no encontraste la respuesta, pregunta — es más rápido que Telegram',
  },
};

export const ASSISTANT_SUGGESTED_QUESTIONS: Record<string, string[]> = {
  ru: [
    'У меня косметика, а референс — про кроссовки, сработает?',
    'Что будет, если у товара нет фото?',
    'Сколько будет стоить 25-секундный ролик?',
  ],
  uk: [
    'У мене косметика, а референс — про кросівки, спрацює?',
    'Що буде, якщо у товару немає фото?',
    'Скільки коштуватиме 25-секундний ролик?',
  ],
  en: [
    'I sell cosmetics, but the reference is about sneakers — will it work?',
    'What happens if my product has no photo?',
    'How much would a 25-second video cost?',
  ],
  de: [
    'Ich verkaufe Kosmetik, aber die Referenz zeigt Sneaker — funktioniert das?',
    'Was passiert, wenn mein Produkt kein Foto hat?',
    'Was würde ein 25-sekündiges Video kosten?',
  ],
  es: [
    'Vendo cosmética, pero la referencia es de zapatillas, ¿funcionará?',
    '¿Qué pasa si mi producto no tiene foto?',
    '¿Cuánto costaría un video de 25 segundos?',
  ],
};

// Карточки шагов обучалки (§4.4, п.4) — по локали, индекс массива = stepId - 1.
export const ASSISTANT_STEPS: Record<string, AssistantStepItem[]> = {
  ru: [
    {
      title: 'Заведите товар',
      text: 'Проект и товар: фото (категория, целевая аудитория и цены аналогов определяются по нему), описание текстом или голосом, цена. Быстрый путь без проекта тоже работает — тогда товар описывается прямо в мастере.',
      details: [],
    },
    {
      title: 'Выберите референс',
      text: 'Четыре способа: поиск по YouTube, ссылка, свой файл до 100МБ и — в режиме Premium — готовый разбор из библиотеки сервиса, мгновенно и без нового ИИ-вызова.',
      details: [
        'Библиотека готовых разборов — без нового ИИ-вызова (Premium)',
        'Поиск по YouTube — нужен вход',
        'Ссылка на YouTube или свой файл до 100 МБ',
      ],
      badge: 'premium',
    },
    {
      title: 'ИИ разбирает ролик',
      text: 'Gemini выделяет сцены с таймкодами, действующих лиц и массовку, визуальный стиль, темп и формат кадра — и оценивает, кому этот ролик адресован и что он продаёт.',
      details: ['Ничего вводить не нужно — ИИ сам покажет разбор по сценам'],
    },
    {
      title: 'Проверьте релевантность',
      text: 'Отдельная проверка сравнивает аудиторию ролика с покупателями вашего товара: оценка, объяснение логики и конкретные правки — стоит ли вообще клонировать этот референс.',
      details: [
        'Чекбокс «Учитывать при генерации» — включает совет в промпт',
        'Кнопка «Проверить ещё раз» — новый анализ релевантности',
        'Кнопка «Выбрать другой референс» — назад к шагу 2',
      ],
      badge: 'standard',
    },
    {
      title: 'Соберите состав кадра',
      text: 'Снимите лишних персонажей, сцены и массовку — клик по любому из них подсвечивает нужные строки разбора. Персонажа можно заменить своим фото, описанием или персонажем бренда.',
      details: [
        'Клик по персонажу — включить или выключить его в ролике',
        'Замена персонажа: как есть, своим фото (Standard+), текстом или персонажем бренда',
        'Клик по сцене или массовке — включить или выключить в кадре',
        'Голос, субтитры и движение камеры — из манифеста бренда (для товаров с проектом)',
      ],
      badge: 'standard',
    },
    {
      title: 'Получите промпт',
      text: 'GPT-5 собирает text-to-video промпт из разбора, товара, манифеста бренда, языка озвучки и советов по релевантности. Промпт можно поправить руками.',
      details: [
        'Кнопка «Сгенерировать промпт» — готовый текст из разбора и товара',
        'Промпт можно поправить вручную перед сохранением',
        'Отдельное поле текста для озвучки — если выбран свой голос',
      ],
    },
    {
      title: 'Выберите формат и референс-картинки',
      text: 'Соотношение сторон — 16:9 и 9:16 в любом режиме, 3:4, 1:1 или своё начиная со Standard — и то, какие три изображения модель получит референсами: персонажи, ваши сцены, сцены бренда, фото товара. Остальное уходит в промпт текстом.',
      details: [
        'Качество рендера: «Быстрое» или «Кинематографичное» (Standard+)',
        'До трёх референс-картинок для модели генерации — свои сцены и фото (Standard+)',
        'Соотношение кадра: 16:9 и 9:16 всем, остальные форматы — со Standard',
      ],
      badge: 'standard',
    },
    {
      title: 'Сгенерируйте видео',
      text: 'Grok или Google Veo 3.1 рендерит новое рекламное видео — на выбор движок и качество рендера, быстрее или более кинематографично.',
      details: [
        'Фото товара обязательно — без него кнопка генерации не появится',
        'Кнопка «Сгенерировать рекламный ролик»',
        'При неудаче — «Сгенерировать ещё раз»',
      ],
    },
    {
      title: 'Проверьте результат',
      text: 'Отдельная проверка на артефакты предложит исправленный промпт для повторной генерации. Для товара из проекта — тут же партия на всю линейку и три A/B-варианта хука. Готовый ролик — прямой ссылкой на файл, а дальше кнопка «Открыть в Постпрод».',
      details: [
        'Проверка на артефакты и саундчек (Standard+)',
        'Партия для всей линейки товаров и 3 варианта A/B (Premium, только для товаров с проектом)',
        'Кнопка «Открыть в Постпрод» — тот же ролик, среди всех остальных ваших роликов',
      ],
      badge: 'standard',
    },
    {
      title: 'Управляйте в Постпродакшене',
      text: 'Отдельная вкладка «Постпрод» — все ваши готовые ролики, а не только последний. Смените текст реплик и голос — с явным выбором провайдера синтеза и честной пред-прослушкой до оплаты — без нового рендера. Экспортируйте под несколько площадок и опубликуйте со страницей для шеринга.',
      details: [
        'Переозвучка без нового рендера — меняются звук, субтитры и текст реплик (Standard+)',
        'Провайдер синтеза голоса — явно ElevenLabs или Resemble, либо «как сейчас»',
        'Пред-прослушать точную комбинацию текста, голоса и провайдера — до оплаты переозвучки',
        'Экспорт под несколько площадок сразу — без повторной оплаты рендера (Standard+)',
        'Публикация и страница для шеринга (Standard+, нужен вход)',
      ],
      badge: 'standard',
    },
  ],
  uk: [
    {
      title: 'Заведіть товар',
      text: 'Проєкт і товар: фото (категорія, цільова аудиторія та ціни аналогів визначаються за ним), опис текстом або голосом, ціна. Швидкий шлях без проєкту теж працює — тоді товар описується прямо в майстрі.',
      details: [],
    },
    {
      title: 'Оберіть референс',
      text: 'Чотири способи: пошук на YouTube, посилання, свій файл до 100МБ і — в режимі Premium — готовий розбір із бібліотеки сервісу, миттєво і без нового ІІ-виклику.',
      details: [
        'Бібліотека готових розборів — без нового ІІ-виклику (Premium)',
        'Пошук на YouTube — потрібен вхід',
        'Посилання на YouTube або свій файл до 100 МБ',
      ],
      badge: 'premium',
    },
    {
      title: 'ІІ розбирає ролик',
      text: 'Gemini виділяє сцени з таймкодами, дійових осіб і масовку, візуальний стиль, темп і формат кадру — і оцінює, кому адресований цей ролик і що він продає.',
      details: ['Нічого вводити не потрібно — ІІ сам покаже розбір по сценах'],
    },
    {
      title: 'Перевірте релевантність',
      text: 'Окрема перевірка порівнює аудиторію ролика з покупцями вашого товару: оцінка, пояснення логіки і конкретні правки — чи варто взагалі клонувати цей референс.',
      details: [
        'Чекбокс «Враховувати під час генерації» — додає пораду в промпт',
        'Кнопка «Перевірити ще раз» — новий аналіз релевантності',
        'Кнопка «Обрати інший референс» — назад до кроку 2',
      ],
      badge: 'standard',
    },
    {
      title: 'Зберіть склад кадру',
      text: 'Зніміть зайвих персонажів, сцени та масовку — клік по будь-якому з них підсвічує потрібні рядки розбору. Персонажа можна замінити своїм фото, описом або персонажем бренду.',
      details: [
        'Клік по персонажу — увімкнути або вимкнути його в ролику',
        'Заміна персонажа: як є, своїм фото (Standard+), текстом або персонажем бренду',
        'Клік по сцені або масовці — увімкнути або вимкнути в кадрі',
        'Голос, субтитри та рух камери — з маніфесту бренду (для товарів з проєктом)',
      ],
      badge: 'standard',
    },
    {
      title: 'Отримайте промпт',
      text: 'GPT-5 збирає text-to-video промпт із розбору, товару, маніфесту бренду, мови озвучки та порад щодо релевантності. Промпт можна поправити руками.',
      details: [
        'Кнопка «Згенерувати промпт» — готовий текст із розбору та товару',
        'Промпт можна поправити вручну перед збереженням',
        'Окреме поле тексту для озвучення — якщо обрано свій голос',
      ],
    },
    {
      title: 'Оберіть формат і референс-зображення',
      text: 'Співвідношення сторін — 16:9 і 9:16 у будь-якому режимі, 3:4, 1:1 або своє починаючи зі Standard — і те, які три зображення модель отримає референсами: персонажі, ваші сцени, сцени бренду, фото товару. Решта йде в промпт текстом.',
      details: [
        'Якість рендеру: «Швидка» або «Кінематографічна» (Standard+)',
        'До трьох референс-зображень для моделі генерації — свої сцени та фото (Standard+)',
        'Співвідношення кадру: 16:9 і 9:16 усім, решта форматів — від Standard',
      ],
      badge: 'standard',
    },
    {
      title: 'Згенеруйте відео',
      text: 'Grok або Google Veo 3.1 рендерить нове рекламне відео — на вибір рушій і якість рендеру, швидше або більш кінематографічно.',
      details: [
        'Фото товару обов’язкове — без нього кнопка генерації не з’явиться',
        'Кнопка «Згенерувати рекламний ролик»',
        'У разі невдачі — «Згенерувати ще раз»',
      ],
    },
    {
      title: 'Перевірте результат',
      text: 'Окрема перевірка на артефакти запропонує виправлений промпт для повторної генерації. Для товару з проєкту — одразу партія на всю лінійку і три A/B-варіанти хука. Готовий ролик — прямим посиланням на файл, а далі кнопка «Відкрити в Постпрод».',
      details: [
        'Перевірка на артефакти та саундчек (Standard+)',
        'Партія для всієї лінійки товарів і 3 варіанти A/B (Premium, лише для товарів із проєктом)',
        'Кнопка «Відкрити в Постпрод» — той самий ролик, серед усіх інших ваших роликів',
      ],
      badge: 'standard',
    },
    {
      title: 'Керуйте в Постпродакшні',
      text: 'Окрема вкладка «Постпрод» — усі ваші готові ролики, а не лише останній. Змініть текст реплік і голос — з явним вибором провайдера синтезу та чесним попереднім прослуховуванням до оплати — без нового рендеру. Експортуйте під кілька площадок і опублікуйте зі сторінкою для шерингу.',
      details: [
        'Переозвучка без нового рендеру — змінюються звук, субтитри і текст реплік (Standard+)',
        'Провайдер синтезу голосу — явно ElevenLabs або Resemble, або «як зараз»',
        'Попередньо прослухати точну комбінацію тексту, голосу і провайдера — до оплати переозвучки',
        'Експорт під кілька площадок одразу — без повторної оплати рендеру (Standard+)',
        'Публікація та сторінка для шерингу (Standard+, потрібен вхід)',
      ],
      badge: 'standard',
    },
  ],
  en: [
    {
      title: 'Add a product',
      text: 'A project and a product: a photo (used to determine category, target audience and comparable prices), a description as text or voice, and a price. The quick path without a project also works — then the product is described right inside the wizard.',
      details: [],
    },
    {
      title: 'Pick a reference',
      text: "Four ways: search YouTube, paste a link, upload your own file up to 100MB, or — on the Premium plan — a ready-made breakdown from the service's library, instant and with no new AI call.",
      details: [
        'A library of ready-made breakdowns — no new AI call (Premium)',
        'YouTube search — sign-in required',
        'A YouTube link or your own file up to 100MB',
      ],
      badge: 'premium',
    },
    {
      title: 'AI breaks down the video',
      text: "Gemini extracts timestamped scenes, cast and extras, visual style, pacing and aspect ratio — and assesses who the video is aimed at and what it's selling.",
      details: [
        'Nothing to enter — the AI shows you the scene-by-scene breakdown on its own',
      ],
    },
    {
      title: 'Check relevance',
      text: "A separate check compares the video's audience with your product's buyers: a score, the reasoning behind it, and concrete edits — whether cloning this reference is even worth it.",
      details: [
        '"Use in generation" checkbox — adds the suggestion to the prompt',
        '"Check again" button — a fresh relevance check',
        '"Pick another reference" button — back to step 2',
      ],
      badge: 'standard',
    },
    {
      title: 'Assemble the shot list',
      text: 'Remove unwanted characters, scenes and extras — clicking any of them highlights the relevant lines of the breakdown. A character can be swapped for your own photo, a description, or a brand character.',
      details: [
        'Click a character — turn it on or off in the video',
        'Replace a character: keep as-is, your own photo (Standard+), a text description, or a brand character',
        'Click a scene or extras group — turn it on or off in frame',
        'Voice, subtitles and camera movement — from the brand manifest (for products with a project)',
      ],
      badge: 'standard',
    },
    {
      title: 'Get the prompt',
      text: 'GPT-5 assembles a text-to-video prompt from the breakdown, the product, the brand manifest, the voice-over language and the relevance suggestions. The prompt can be edited by hand.',
      details: [
        '"Generate prompt" button — a ready text built from the breakdown and the product',
        'The prompt can be edited by hand before saving',
        'A separate voice-over script field — when a custom voice is selected',
      ],
    },
    {
      title: 'Choose the format and reference images',
      text: 'Aspect ratio — 16:9 and 9:16 on any plan, plus 3:4, 1:1 or a custom one from Standard up — and which three images the model will get as references: characters, your scenes, brand scenes, product photo. Everything else goes into the prompt as text.',
      details: [
        'Render quality: "Fast" or "Cinematic" (Standard+)',
        'Up to three reference images for the generation engine — your own scenes and photos (Standard+)',
        'Aspect ratio: 16:9 and 9:16 on any plan, the rest from Standard up',
      ],
      badge: 'standard',
    },
    {
      title: 'Generate the video',
      text: 'Grok or Google Veo 3.1 renders the new ad video — pick the engine and render quality, faster or more cinematic.',
      details: [
        'A product photo is required — the generate button stays hidden without it',
        '"Generate the ad video" button',
        'On failure — "Generate again"',
      ],
    },
    {
      title: 'Review the result',
      text: 'A separate artifact check will propose a fixed prompt for a re-generation. For a product from a project, a batch run for the whole line and three A/B hook variants are right there. The finished video is a direct file link, then an “Open in Postprod” button.',
      details: [
        'Artifact check and sound check (Standard+)',
        'A batch run for a whole product line, and 3 A/B variants (Premium, products with a project only)',
        'An “Open in Postprod” button — the same video, alongside all your other ones',
      ],
      badge: 'standard',
    },
    {
      title: 'Manage it in Postprod',
      text: 'A separate Postprod tab with all your finished videos, not just the latest one. Change the script and the voice — with an explicit synthesis provider and an honest pre-listen before you pay — without a new render. Export to several platforms and publish with a shareable page.',
      details: [
        'Re-voice without a new render — only the audio, subtitles and script change (Standard+)',
        'Voice synthesis provider — ElevenLabs or Resemble explicitly, or “as is”',
        'Pre-listen to the exact text, voice and provider combination — before paying for the re-voice',
        'Export to several platforms at once — no extra render charge (Standard+)',
        'Publication and a shareable page (Standard+, sign-in required)',
      ],
      badge: 'standard',
    },
  ],
  de: [
    {
      title: 'Produkt anlegen',
      text: 'Projekt und Produkt: ein Foto (daraus werden Kategorie, Zielgruppe und Vergleichspreise bestimmt), eine Beschreibung als Text oder Sprache, ein Preis. Der schnelle Weg ohne Projekt funktioniert ebenfalls — dann wird das Produkt direkt im Assistenten beschrieben.',
      details: [],
    },
    {
      title: 'Referenz wählen',
      text: 'Vier Wege: YouTube-Suche, ein Link, eine eigene Datei bis 100 MB und — im Premium-Tarif — eine fertige Analyse aus der Bibliothek des Dienstes, sofort und ohne neuen KI-Aufruf.',
      details: [
        'Bibliothek fertiger Analysen — ohne neuen KI-Aufruf (Premium)',
        'YouTube-Suche — Anmeldung nötig',
        'Ein YouTube-Link oder eine eigene Datei bis 100 MB',
      ],
      badge: 'premium',
    },
    {
      title: 'KI analysiert das Video',
      text: 'Gemini extrahiert Szenen mit Zeitstempeln, Darsteller und Statisten, visuellen Stil, Tempo und Seitenverhältnis — und beurteilt, an wen sich dieses Video richtet und was es bewirbt.',
      details: [
        'Keine Eingabe nötig — die KI zeigt die Szenen-für-Szene-Analyse von selbst',
      ],
    },
    {
      title: 'Relevanz prüfen',
      text: 'Eine separate Prüfung vergleicht die Zielgruppe des Videos mit den Käufern Ihres Produkts: eine Bewertung, die Begründung dazu und konkrete Änderungen — ob es sich überhaupt lohnt, diese Referenz zu klonen.',
      details: [
        'Checkbox „Bei der Generierung berücksichtigen" — nimmt den Hinweis in den Prompt auf',
        'Schaltfläche „Erneut prüfen" — eine neue Relevanzprüfung',
        'Schaltfläche „Andere Referenz wählen" — zurück zu Schritt 2',
      ],
      badge: 'standard',
    },
    {
      title: 'Bildaufbau zusammenstellen',
      text: 'Überflüssige Charaktere, Szenen und Statisten entfernen — ein Klick auf einen davon hebt die passenden Zeilen der Analyse hervor. Ein Charakter lässt sich durch ein eigenes Foto, eine Beschreibung oder einen Marken-Charakter ersetzen.',
      details: [
        'Klick auf einen Charakter — schaltet ihn im Video ein oder aus',
        'Charakter ersetzen: unverändert, eigenes Foto (Standard+), Textbeschreibung oder Marken-Charakter',
        'Klick auf eine Szene oder Statisten — schaltet sie im Bild ein oder aus',
        'Stimme, Untertitel und Kamerabewegung — aus dem Markenmanifest (für Produkte mit Projekt)',
      ],
      badge: 'standard',
    },
    {
      title: 'Prompt erhalten',
      text: 'GPT-5 stellt einen Text-zu-Video-Prompt aus Analyse, Produkt, Markenmanifest, Sprache der Vertonung und Relevanz-Hinweisen zusammen. Der Prompt lässt sich von Hand anpassen.',
      details: [
        'Schaltfläche „Prompt generieren" — fertiger Text aus Analyse und Produkt',
        'Der Prompt lässt sich vor dem Speichern von Hand anpassen',
        'Ein eigenes Textfeld für die Vertonung — wenn eine eigene Stimme gewählt ist',
      ],
    },
    {
      title: 'Format und Referenzbilder wählen',
      text: 'Seitenverhältnis — 16:9 und 9:16 in jedem Tarif, 3:4, 1:1 oder ein eigenes ab Standard — sowie die drei Bilder, die das Modell als Referenz erhält: Charaktere, eigene Szenen, Markenszenen, Produktfoto. Alles Weitere fließt als Text in den Prompt.',
      details: [
        'Render-Qualität: „Schnell" oder „Kinematografisch" (Standard+)',
        'Bis zu drei Referenzbilder für die Generierungs-Engine — eigene Szenen und Fotos (Standard+)',
        'Seitenverhältnis: 16:9 und 9:16 in jedem Tarif, der Rest ab Standard',
      ],
      badge: 'standard',
    },
    {
      title: 'Video generieren',
      text: 'Grok oder Google Veo 3.1 rendert das neue Werbevideo — wahlweise Engine und Render-Qualität, schneller oder kinematografischer.',
      details: [
        'Ein Produktfoto ist Pflicht — ohne es erscheint der Generieren-Button nicht',
        'Schaltfläche „Werbevideo generieren"',
        'Bei Fehlschlag — „Erneut generieren"',
      ],
    },
    {
      title: 'Ergebnis prüfen',
      text: 'Eine separate Artefaktprüfung schlägt einen korrigierten Prompt für eine erneute Generierung vor. Bei einem Produkt aus einem Projekt gibt es gleich einen Batch-Lauf für die ganze Produktlinie und drei A/B-Varianten des Hooks. Das fertige Video steht als direkter Datei-Link zur Verfügung, danach folgt die Schaltfläche „In Postprod öffnen“.',
      details: [
        'Artefaktprüfung und Sound-Check (Standard+)',
        'Ein Batch-Lauf für die ganze Produktlinie und 3 A/B-Varianten (Premium, nur für Produkte mit Projekt)',
        'Schaltfläche „In Postprod öffnen“ — dasselbe Video, zusammen mit all Ihren anderen',
      ],
      badge: 'standard',
    },
    {
      title: 'In Postprod verwalten',
      text: 'Ein eigener Tab „Postprod“ mit all Ihren fertigen Videos, nicht nur dem letzten. Ändern Sie Text und Stimme — mit expliziter Wahl des Synthese-Anbieters und einem ehrlichen Vorab-Anhören vor der Zahlung — ganz ohne neues Rendering. Exportieren Sie für mehrere Plattformen und veröffentlichen Sie mit einer Seite zum Teilen.',
      details: [
        'Neu vertonen ohne neues Rendering — nur Ton, Untertitel und Text ändern sich (Standard+)',
        'Sprachsynthese-Anbieter — explizit ElevenLabs oder Resemble, oder „wie bisher“',
        'Die genaue Kombination aus Text, Stimme und Anbieter vorab anhören — vor der Zahlung für die Neuvertonung',
        'Export für mehrere Plattformen zugleich — ohne erneute Render-Gebühr (Standard+)',
        'Veröffentlichung und Seite zum Teilen (Standard+, Anmeldung nötig)',
      ],
      badge: 'standard',
    },
  ],
  es: [
    {
      title: 'Agrega un producto',
      text: 'Un proyecto y un producto: una foto (a partir de ella se determinan la categoría, la audiencia objetivo y los precios comparables), una descripción en texto o voz, y un precio. El camino rápido sin proyecto también funciona — entonces el producto se describe directamente en el asistente.',
      details: [],
    },
    {
      title: 'Elige una referencia',
      text: 'Cuatro formas: búsqueda en YouTube, un enlace, tu propio archivo de hasta 100 MB y — en el plan Premium — un análisis ya listo de la biblioteca del servicio, al instante y sin una nueva llamada a la IA.',
      details: [
        'Biblioteca de análisis ya listos — sin una nueva llamada a la IA (Premium)',
        'Búsqueda en YouTube — requiere inicio de sesión',
        'Un enlace de YouTube o tu propio archivo de hasta 100 MB',
      ],
      badge: 'premium',
    },
    {
      title: 'La IA analiza el video',
      text: 'Gemini extrae escenas con marcas de tiempo, elenco y extras, estilo visual, ritmo y formato de encuadre — y evalúa a quién está dirigido este video y qué está promocionando.',
      details: [
        'No hay que ingresar nada — la IA muestra el análisis por escenas por sí sola',
      ],
    },
    {
      title: 'Verifica la relevancia',
      text: 'Una verificación aparte compara la audiencia del video con los compradores de tu producto: una puntuación, la explicación del razonamiento y cambios concretos — si realmente vale la pena clonar esa referencia.',
      details: [
        'Casilla «Tener en cuenta en la generación» — añade la sugerencia al prompt',
        'Botón «Verificar de nuevo» — un nuevo análisis de relevancia',
        'Botón «Elegir otra referencia» — volver al paso 2',
      ],
      badge: 'standard',
    },
    {
      title: 'Arma la composición del video',
      text: 'Elimina personajes, escenas y extras innecesarios — al hacer clic en cualquiera de ellos se resaltan las líneas correspondientes del análisis. Un personaje puede reemplazarse por tu propia foto, una descripción o un personaje de marca.',
      details: [
        'Clic en un personaje — lo activa o desactiva en el video',
        'Reemplazar un personaje: tal cual, con tu propia foto (Standard+), con texto o con un personaje de marca',
        'Clic en una escena o extras — la activa o desactiva en el cuadro',
        'Voz, subtítulos y movimiento de cámara — desde el manifiesto de marca (para productos con proyecto)',
      ],
      badge: 'standard',
    },
    {
      title: 'Obtén el prompt',
      text: 'GPT-5 arma un prompt de texto a video a partir del análisis, el producto, el manifiesto de marca, el idioma de la locución y las sugerencias de relevancia. El prompt se puede editar a mano.',
      details: [
        'Botón «Generar prompt» — texto listo a partir del análisis y el producto',
        'El prompt se puede ajustar a mano antes de guardar',
        'Un campo de texto aparte para la locución — si se elige una voz propia',
      ],
    },
    {
      title: 'Elige el formato y las imágenes de referencia',
      text: 'Relación de aspecto — 16:9 y 9:16 en cualquier plan, además de 3:4, 1:1 o una personalizada desde Standard en adelante — y qué tres imágenes recibirá el modelo como referencia: personajes, tus escenas, escenas de marca, foto del producto. Todo lo demás se incluye como texto en el prompt.',
      details: [
        'Calidad de renderizado: «Rápida» o «Cinematográfica» (Standard+)',
        'Hasta tres imágenes de referencia para el motor de generación — tus propias escenas y fotos (Standard+)',
        'Relación de aspecto: 16:9 y 9:16 en cualquier plan, el resto desde Standard',
      ],
      badge: 'standard',
    },
    {
      title: 'Genera el video',
      text: 'Grok o Google Veo 3.1 renderiza el nuevo video publicitario — a elección, motor y calidad de renderizado, más rápido o más cinematográfico.',
      details: [
        'La foto del producto es obligatoria — sin ella el botón de generar no aparece',
        'Botón «Generar video publicitario»',
        'Si falla — «Generar de nuevo»',
      ],
    },
    {
      title: 'Revisa el resultado',
      text: 'Una verificación aparte de artefactos propondrá un prompt corregido para una nueva generación. Para un producto de un proyecto, ahí mismo tienes un lote para toda la línea y tres variantes A/B del gancho. El video terminado se entrega como un enlace directo al archivo, y después el botón «Abrir en Postprod».',
      details: [
        'Verificación de artefactos y de audio (Standard+)',
        'Un lote para toda la línea de productos y 3 variantes A/B (Premium, solo productos con proyecto)',
        'Botón «Abrir en Postprod» — el mismo video, junto con todos tus demás videos',
      ],
      badge: 'standard',
    },
    {
      title: 'Gestiónalo en Postprod',
      text: 'Una pestaña aparte, «Postprod», con todos tus videos terminados, no solo el último. Cambia el texto y la voz — con un proveedor de síntesis explícito y una escucha previa honesta antes de pagar — sin un nuevo renderizado. Exporta a varias plataformas y publica con una página para compartir.',
      details: [
        'Redoblaje sin nuevo renderizado — solo cambian el audio, los subtítulos y el texto (Standard+)',
        'Proveedor de síntesis de voz — ElevenLabs o Resemble de forma explícita, o «como está»',
        'Escucha previa de la combinación exacta de texto, voz y proveedor — antes de pagar el redoblaje',
        'Exportación a varias plataformas a la vez — sin pagar el renderizado otra vez (Standard+)',
        'Publicación y página para compartir (Standard+, requiere inicio de sesión)',
      ],
      badge: 'standard',
    },
  ],
};
