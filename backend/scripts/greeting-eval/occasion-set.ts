/**
 * Набор замеров классификатора регистра «Особого повода» — приёмка §8.1
 * ТЗ docs-tz/TZ-Greeting-2.0-Adaptive-Persona-Landing.md: «размеченный
 * набор из 50 описаний «Особого повода» на пяти языках — ни одного
 * траурного, определённого как праздничный».
 *
 * 50 сюжетов × 5 языков (ru, uk, en, de, es) = 250 описаний. Перевод — один
 * и тот же сюжет, поэтому метка одна на все языки: так видно, на каком
 * языке классификатор ошибается, а не «где сюжет другой».
 *
 * Метка `register` — закрытый список `GREETING_REGISTERS` (ответ
 * `GreetingRegisterClassifier`, §3.4 п.3). Спорный сюжет размечен более
 * серьёзным регистром — тем же правилом, что в запросе классификатора
 * («Если сомневаешься между двумя — выбери более серьёзный»).
 * `occasion` — ближайший повод каталога (`GREETING_OCCASIONS`), `OTHER` —
 * если в каталоге такого нет; нужен для разбора ошибок, в метрике не
 * участвует.
 *
 * Ловушки (`trap`) — описания, где слова и смысл расходятся: «до смерти
 * рада», вечеринка зомби, «похоронили старый склад» (ключевые слова там
 * ошибаются нарочно — набор меряет и их), и наоборот — траур без единого
 * ключевого слова («прощание с дедушкой»).
 *
 * Имена — распространённые, без фамилий; сюжеты выдуманы, реальных
 * персональных данных нет.
 */
import type {
  GreetingOccasion,
  GreetingRegister,
} from '../../src/common/types/greeting.types';

export const EVAL_LANGUAGES = ['ru', 'uk', 'en', 'de', 'es'] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

export interface OccasionScenario {
  id: string;
  register: GreetingRegister;
  occasion: GreetingOccasion;
  /** Почему сюжет каверзный — для разбора ошибок. */
  trap?: string;
  text: Record<EvalLanguage, string>;
}

export const OCCASION_SET: readonly OccasionScenario[] = [
  // ── Траурный (12) ────────────────────────────────────────────────────
  {
    id: 'm01',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Похороны бабушки Нины в пятницу, хочу поддержать маму',
      uk: "Похорон бабусі Ніни в п'ятницю, хочу підтримати маму",
      en: "Grandma Nina's funeral is on Friday, I want to support my mom",
      de: 'Die Beerdigung von Oma Nina ist am Freitag, ich möchte meine Mutter unterstützen',
      es: 'El funeral de la abuela Nina es el viernes, quiero apoyar a mi madre',
    },
  },
  {
    id: 'm02',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    trap: 'траур без ключевых слов',
    text: {
      ru: 'Прощание с дедушкой в субботу, он ушёл тихо во сне',
      uk: 'Прощання з дідусем у суботу, він пішов тихо уві сні',
      en: 'Saying goodbye to grandpa on Saturday, he slipped away quietly in his sleep',
      de: 'Abschied von Opa am Samstag, er ist friedlich im Schlaf gegangen',
      es: 'Despedida del abuelo el sábado, se fue tranquilo mientras dormía',
    },
  },
  {
    id: 'm03',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Сорок дней со дня смерти папы, соберёмся семьёй',
      uk: 'Сорок днів від дня смерті тата, зберемося родиною',
      en: 'Forty days since dad died, the family will gather',
      de: 'Vierzig Tage nach Papas Tod, die Familie kommt zusammen',
      es: 'Cuarenta días desde la muerte de papá, nos reuniremos en familia',
    },
  },
  {
    id: 'm04',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Коллега Ирина потеряла маму, хочу выразить соболезнования от отдела',
      uk: 'Колега Ірина втратила маму, хочу висловити співчуття від відділу',
      en: 'My colleague Irina lost her mother, I want to send condolences from our team',
      de: 'Meine Kollegin Irina hat ihre Mutter verloren, ich möchte im Namen des Teams mein Beileid aussprechen',
      es: 'Mi compañera Irina perdió a su madre, quiero darle el pésame de parte del equipo',
    },
  },
  {
    id: 'm05',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    trap: 'утрата без слова «смерть»',
    text: {
      ru: 'Год, как не стало мамы, хочу сказать брату тёплые слова',
      uk: 'Рік, як не стало мами, хочу сказати братові теплі слова',
      en: "It's been a year since mom has been gone, I want to say kind words to my brother",
      de: 'Ein Jahr ist es her, dass Mama nicht mehr da ist, ich möchte meinem Bruder etwas Liebes sagen',
      es: 'Hace un año que mamá ya no está, quiero decirle unas palabras cariñosas a mi hermano',
    },
  },
  {
    id: 'm06',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'У подруги умер муж, хочу поддержать её',
      uk: 'У подруги помер чоловік, хочу її підтримати',
      en: "My friend's husband died, I want to support her",
      de: 'Der Mann meiner Freundin ist gestorben, ich möchte ihr beistehen',
      es: 'Murió el marido de mi amiga, quiero apoyarla',
    },
  },
  {
    id: 'm07',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    trap: 'утрата питомца',
    text: {
      ru: 'Умер наш пёс Барон, прожил с нами четырнадцать лет, хочу поддержать детей',
      uk: 'Помер наш пес Барон, прожив з нами чотирнадцять років, хочу підтримати дітей',
      en: 'Our dog Baron died after fourteen years with us, I want to comfort the kids',
      de: 'Unser Hund Baron ist nach vierzehn Jahren bei uns gestorben, ich möchte die Kinder trösten',
      es: 'Murió nuestro perro Barón después de catorce años con nosotros, quiero consolar a los niños',
    },
  },
  {
    id: 'm08',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Вечер памяти одноклассника Андрея, которого не стало весной',
      uk: "Вечір пам'яті однокласника Андрія, якого не стало навесні",
      en: 'An evening in memory of our classmate Andrii, who died this spring',
      de: 'Gedenkabend für unseren Mitschüler Andrij, der im Frühling gestorben ist',
      es: 'Velada en memoria de nuestro compañero de clase Andrés, que falleció en primavera',
    },
  },
  {
    id: 'm09',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Девять дней по бабушке, поминальный обед у тёти',
      uk: "Дев'ять днів по бабусі, поминальний обід у тітки",
      en: "Nine days after grandma's death, a remembrance lunch at my aunt's",
      de: 'Neun Tage nach Omas Tod, ein Gedenkessen bei meiner Tante',
      es: 'Nueve días tras la muerte de la abuela, una comida en su memoria en casa de mi tía',
    },
  },
  {
    id: 'm10',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Дядя погиб на фронте, прощание в родном селе',
      uk: 'Дядько загинув на фронті, прощання в рідному селі',
      en: 'My uncle was killed at the front, the farewell is in his home village',
      de: 'Mein Onkel ist an der Front gefallen, die Trauerfeier ist in seinem Heimatdorf',
      es: 'Mi tío murió en el frente, la despedida es en su pueblo natal',
    },
  },
  {
    id: 'm11',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Соседка тётя Валя похоронила сына, хочу записать ей слова поддержки',
      uk: 'Сусідка тітка Валя поховала сина, хочу записати їй слова підтримки',
      en: 'Our neighbour Valya buried her son, I want to record words of support for her',
      de: 'Unsere Nachbarin Walja hat ihren Sohn begraben, ich möchte ihr tröstende Worte aufnehmen',
      es: 'Nuestra vecina Valia enterró a su hijo, quiero grabarle unas palabras de apoyo',
    },
  },
  {
    id: 'm12',
    register: 'MOURNING',
    occasion: 'CONDOLENCE',
    text: {
      ru: 'Провожаем в последний путь нашего первого тренера',
      uk: 'Проводжаємо в останню путь нашого першого тренера',
      en: 'We are seeing our first coach off on his final journey',
      de: 'Wir begleiten unseren ersten Trainer auf seinem letzten Weg',
      es: 'Despedimos a nuestro primer entrenador en su último viaje',
    },
  },

  // ── Деликатный (10) ──────────────────────────────────────────────────
  {
    id: 's01',
    register: 'SENSITIVE',
    occasion: 'GET_WELL',
    text: {
      ru: 'Папа после операции на сердце в больнице, хочу его подбодрить',
      uk: 'Тато після операції на серці в лікарні, хочу його підбадьорити',
      en: 'Dad is in hospital after heart surgery, I want to cheer him up',
      de: 'Papa liegt nach einer Herzoperation im Krankenhaus, ich möchte ihn aufmuntern',
      es: 'Papá está en el hospital tras una operación de corazón, quiero animarlo',
    },
  },
  {
    id: 's02',
    register: 'SENSITIVE',
    occasion: 'APOLOGY',
    trap: 'годовщина свадьбы, но это извинение',
    text: {
      ru: 'Забыл о годовщине нашей свадьбы, хочу извиниться перед женой',
      uk: 'Забув про річницю нашого весілля, хочу вибачитися перед дружиною',
      en: 'I forgot our wedding anniversary and want to apologise to my wife',
      de: 'Ich habe unseren Hochzeitstag vergessen und möchte mich bei meiner Frau entschuldigen',
      es: 'Olvidé nuestro aniversario de boda y quiero pedirle perdón a mi esposa',
    },
  },
  {
    id: 's03',
    register: 'SENSITIVE',
    occasion: 'OTHER',
    text: {
      ru: 'Подруга тяжело переживает развод, хочу сказать, что я рядом',
      uk: 'Подруга важко переживає розлучення, хочу сказати, що я поруч',
      en: "My friend is going through a hard divorce, I want to say I'm here for her",
      de: 'Meine Freundin leidet sehr unter der Scheidung, ich möchte ihr sagen, dass ich für sie da bin',
      es: 'Mi amiga está pasando por un divorcio difícil, quiero decirle que estoy a su lado',
    },
  },
  {
    id: 's04',
    register: 'SENSITIVE',
    occasion: 'OTHER',
    text: {
      ru: 'Брата сократили с работы, хочу поддержать и не давить',
      uk: 'Брата скоротили з роботи, хочу підтримати й не тиснути',
      en: 'My brother was laid off, I want to support him without pressure',
      de: 'Mein Bruder wurde entlassen, ich möchte ihn unterstützen, ohne Druck zu machen',
      es: 'A mi hermano lo despidieron, quiero apoyarlo sin presionarlo',
    },
  },
  {
    id: 's05',
    register: 'SENSITIVE',
    occasion: 'GET_WELL',
    text: {
      ru: 'Тётя проходит химиотерапию, хочу пожелать ей сил',
      uk: 'Тітка проходить хіміотерапію, хочу побажати їй сил',
      en: 'My aunt is going through chemotherapy, I want to wish her strength',
      de: 'Meine Tante macht eine Chemotherapie, ich möchte ihr Kraft wünschen',
      es: 'Mi tía está en quimioterapia, quiero desearle fuerza',
    },
  },
  {
    id: 's06',
    register: 'SENSITIVE',
    occasion: 'APOLOGY',
    text: {
      ru: 'Сорвался на коллегу на совещании, хочу попросить прощения',
      uk: 'Зірвався на колегу на нараді, хочу попросити пробачення',
      en: 'I snapped at a colleague in a meeting and want to ask for forgiveness',
      de: 'Ich habe in der Besprechung einen Kollegen angefahren und möchte um Verzeihung bitten',
      es: 'Le grité a un compañero en una reunión y quiero pedirle perdón',
    },
  },
  {
    id: 's07',
    register: 'SENSITIVE',
    occasion: 'GET_WELL',
    text: {
      ru: 'Сын друзей долго лечится в больнице, хочу поддержать родителей',
      uk: 'Син друзів довго лікується в лікарні, хочу підтримати батьків',
      en: "Our friends' son has been in hospital for a long time, I want to support his parents",
      de: 'Der Sohn unserer Freunde ist seit Langem im Krankenhaus, ich möchte die Eltern unterstützen',
      es: 'El hijo de unos amigos lleva mucho tiempo en el hospital, quiero apoyar a sus padres',
    },
  },
  {
    id: 's08',
    register: 'SENSITIVE',
    occasion: 'OTHER',
    text: {
      ru: 'У друга сгорел дом, все живы, но ему очень тяжело',
      uk: 'У друга згорів будинок, усі живі, але йому дуже важко',
      en: "My friend's house burned down, everyone is alive but he's having a very hard time",
      de: 'Das Haus meines Freundes ist abgebrannt, alle leben, aber es geht ihm sehr schlecht',
      es: 'Se quemó la casa de mi amigo, todos están vivos, pero lo está pasando muy mal',
    },
  },
  {
    id: 's09',
    register: 'SENSITIVE',
    occasion: 'GET_WELL',
    text: {
      ru: 'Маме завтра на операцию, хочу её успокоить',
      uk: 'Мамі завтра на операцію, хочу її заспокоїти',
      en: 'Mom has surgery tomorrow, I want to reassure her',
      de: 'Mama wird morgen operiert, ich möchte sie beruhigen',
      es: 'Mamá se opera mañana, quiero tranquilizarla',
    },
  },
  {
    id: 's10',
    register: 'SENSITIVE',
    occasion: 'APOLOGY',
    text: {
      ru: 'Мы с сестрой поссорились и не говорим месяц, хочу помириться',
      uk: 'Ми з сестрою посварилися й не говоримо місяць, хочу помиритися',
      en: "My sister and I fell out and haven't spoken for a month, I want to make peace",
      de: 'Meine Schwester und ich haben uns gestritten und reden seit einem Monat nicht, ich möchte mich versöhnen',
      es: 'Mi hermana y yo nos peleamos y no hablamos desde hace un mes, quiero reconciliarme',
    },
  },

  // ── Торжественный (8) ────────────────────────────────────────────────
  {
    id: 'o01',
    register: 'SOLEMN',
    occasion: 'DEFENDERS_DAY',
    text: {
      ru: 'Сын принимает военную присягу, хочу сказать ему напутствие',
      uk: 'Син складає військову присягу, хочу сказати йому напутнє слово',
      en: 'My son is taking the military oath, I want to give him a few words for the road',
      de: 'Mein Sohn legt den Fahneneid ab, ich möchte ihm ein paar Worte mit auf den Weg geben',
      es: 'Mi hijo hace el juramento militar, quiero darle unas palabras para el camino',
    },
  },
  {
    id: 'o02',
    register: 'SOLEMN',
    occasion: 'DEFENDERS_DAY',
    text: {
      ru: 'Деду-ветерану вручают орден, торжественное собрание в мэрии',
      uk: 'Дідові-ветерану вручають орден, урочисті збори в мерії',
      en: 'My veteran grandfather is receiving an order of merit at a ceremony in the city hall',
      de: 'Mein Großvater, ein Veteran, erhält im Rathaus feierlich einen Orden',
      es: 'A mi abuelo veterano le entregan una condecoración en un acto solemne en el ayuntamiento',
    },
  },
  {
    id: 'o03',
    register: 'SOLEMN',
    occasion: 'OTHER',
    text: {
      ru: 'Памятная дата освобождения нашего города, обращение к землякам',
      uk: "Пам'ятна дата звільнення нашого міста, звернення до земляків",
      en: "A memorial date, the anniversary of our city's liberation, a message to fellow townspeople",
      de: 'Gedenktag der Befreiung unserer Stadt, eine Ansprache an die Mitbürger',
      es: 'Fecha conmemorativa de la liberación de nuestra ciudad, un mensaje a los vecinos',
    },
  },
  {
    id: 'o04',
    register: 'SOLEMN',
    occasion: 'BAPTISM',
    text: {
      ru: 'Первое причастие крестницы в воскресенье',
      uk: 'Перше причастя хрещениці в неділю',
      en: "My goddaughter's first communion on Sunday",
      de: 'Die Erstkommunion meines Patenkindes am Sonntag',
      es: 'La primera comunión de mi ahijada el domingo',
    },
  },
  {
    id: 'o05',
    register: 'SOLEMN',
    occasion: 'DEFENDERS_DAY',
    trap: 'повышение, но это церемония',
    text: {
      ru: 'Мужу присвоили офицерское звание, построение на плацу',
      uk: 'Чоловікові присвоїли офіцерське звання, шикування на плацу',
      en: 'My husband was commissioned as an officer, there is a formation on the parade ground',
      de: 'Mein Mann wurde zum Offizier ernannt, es gibt einen Appell auf dem Exerzierplatz',
      es: 'A mi marido le concedieron el grado de oficial, hay formación en la plaza de armas',
    },
  },
  {
    id: 'o06',
    register: 'SOLEMN',
    occasion: 'OTHER',
    text: {
      ru: 'Открытие мемориальной доски нашему земляку-учёному',
      uk: 'Відкриття меморіальної дошки нашому землякові-науковцю',
      en: 'Unveiling of a memorial plaque to a scientist from our town',
      de: 'Enthüllung einer Gedenktafel für einen Wissenschaftler aus unserer Stadt',
      es: 'Inauguración de una placa conmemorativa a un científico de nuestro pueblo',
    },
  },
  {
    id: 'o07',
    register: 'SOLEMN',
    occasion: 'OTHER',
    text: {
      ru: 'Освящение нового храма в нашем селе',
      uk: 'Освячення нового храму в нашому селі',
      en: 'Consecration of the new church in our village',
      de: 'Weihe der neuen Kirche in unserem Dorf',
      es: 'Consagración de la nueva iglesia de nuestro pueblo',
    },
  },
  {
    id: 'o08',
    register: 'SOLEMN',
    occasion: 'GRADUATION',
    trap: 'выпуск, но военный и торжественный',
    text: {
      ru: 'Выпуск курсантов военной академии, торжественное построение',
      uk: 'Випуск курсантів військової академії, урочисте шикування',
      en: 'Graduation of cadets from the military academy, a formal parade',
      de: 'Abschlussfeier der Kadetten der Militärakademie, ein feierlicher Appell',
      es: 'Graduación de los cadetes de la academia militar, un desfile solemne',
    },
  },

  // ── Тёплый нейтральный (10) ──────────────────────────────────────────
  {
    id: 'w01',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Хочу поблагодарить медсестру Олю, которая выхаживала папу',
      uk: 'Хочу подякувати медсестрі Олі, яка доглядала тата',
      en: 'I want to thank nurse Olya who looked after my dad',
      de: 'Ich möchte mich bei Krankenschwester Olja bedanken, die meinen Vater gepflegt hat',
      es: 'Quiero darle las gracias a la enfermera Olia, que cuidó de mi padre',
    },
  },
  {
    id: 'w02',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Подруга переехала в другую страну, хочу сказать, что скучаю',
      uk: 'Подруга переїхала в іншу країну, хочу сказати, що сумую',
      en: 'My friend moved to another country, I want to say I miss her',
      de: 'Meine Freundin ist in ein anderes Land gezogen, ich möchte ihr sagen, dass ich sie vermisse',
      es: 'Mi amiga se mudó a otro país, quiero decirle que la echo de menos',
    },
  },
  {
    id: 'w03',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Соседи переезжают, хотим сказать спасибо за десять лет рядом',
      uk: 'Сусіди переїжджають, хочемо сказати дякую за десять років поруч',
      en: 'Our neighbours are moving away, we want to thank them for ten years next door',
      de: 'Unsere Nachbarn ziehen weg, wir möchten uns für zehn Jahre Nachbarschaft bedanken',
      es: 'Nuestros vecinos se mudan, queremos darles las gracias por diez años juntos',
    },
  },
  {
    id: 'w04',
    register: 'WARM_NEUTRAL',
    occasion: 'TEACHERS_DAY',
    text: {
      ru: 'Спасибо классной руководительнице за помощь сыну с математикой',
      uk: 'Дякую класній керівничці за допомогу синові з математикою',
      en: "Thanks to my son's form teacher for helping him with maths",
      de: 'Danke an die Klassenlehrerin meines Sohnes für ihre Hilfe in Mathe',
      es: 'Gracias a la tutora de mi hijo por ayudarle con las matemáticas',
    },
  },
  {
    id: 'w05',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Просто сказать маме, что люблю её, без повода',
      uk: 'Просто сказати мамі, що люблю її, без приводу',
      en: 'Just to tell my mom I love her, for no particular reason',
      de: 'Einfach Mama sagen, dass ich sie liebe, ohne besonderen Anlass',
      es: 'Solo decirle a mi madre que la quiero, sin motivo especial',
    },
  },
  {
    id: 'w06',
    register: 'WARM_NEUTRAL',
    occasion: 'CORPORATE',
    text: {
      ru: 'Приветствие новому сотруднику Максиму в первый рабочий день',
      uk: 'Вітальне слово новому співробітнику Максиму в перший робочий день',
      en: 'A welcome message for our new colleague Maksym on his first day',
      de: 'Ein Willkommensgruß für unseren neuen Kollegen Maksym an seinem ersten Arbeitstag',
      es: 'Un mensaje de bienvenida para nuestro nuevo compañero Maksym en su primer día',
    },
  },
  {
    id: 'w07',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Дочка завтра сдаёт экзамен, хочу её подбодрить',
      uk: 'Донька завтра складає іспит, хочу її підбадьорити',
      en: 'My daughter has an exam tomorrow, I want to encourage her',
      de: 'Meine Tochter hat morgen eine Prüfung, ich möchte ihr Mut machen',
      es: 'Mi hija tiene un examen mañana, quiero darle ánimos',
    },
  },
  {
    id: 'w08',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Благодарность волонтёрам, которые помогли с ремонтом школы',
      uk: 'Подяка волонтерам, які допомогли з ремонтом школи',
      en: 'A thank-you to the volunteers who helped repair the school',
      de: 'Ein Dankeschön an die Freiwilligen, die bei der Renovierung der Schule geholfen haben',
      es: 'Un agradecimiento a los voluntarios que ayudaron a reparar la escuela',
    },
  },
  {
    id: 'w09',
    register: 'WARM_NEUTRAL',
    occasion: 'OTHER',
    text: {
      ru: 'Папа на вахте третий месяц, хочу передать привет от всей семьи',
      uk: 'Тато на вахті третій місяць, хочу передати привіт від усієї родини',
      en: 'Dad has been away on a rotation job for three months, I want to say hi from the whole family',
      de: 'Papa ist seit drei Monaten auf Montage, ich möchte ihm Grüße von der ganzen Familie schicken',
      es: 'Papá lleva tres meses trabajando fuera, quiero mandarle saludos de toda la familia',
    },
  },
  {
    id: 'w10',
    register: 'WARM_NEUTRAL',
    occasion: 'FAREWELL_COLLEAGUE',
    trap: 'прощание, но не утрата',
    text: {
      ru: 'Коллега Света уходит на другую работу, хотим сказать спасибо',
      uk: 'Колега Світлана йде на іншу роботу, хочемо сказати дякую',
      en: 'Our colleague Sveta is leaving for another job, we want to say thank you',
      de: 'Unsere Kollegin Sweta wechselt den Job, wir möchten Danke sagen',
      es: 'Nuestra compañera Sveta se va a otro trabajo, queremos darle las gracias',
    },
  },

  // ── Праздничный (10) ─────────────────────────────────────────────────
  {
    id: 'c01',
    register: 'CELEBRATORY',
    occasion: 'GRADUATION',
    trap: 'слова смерти в праздничной идиоме',
    text: {
      ru: 'Сестра поступила в медуниверситет, я до смерти рада за неё!',
      uk: 'Сестра вступила до медуніверситету, я до нестями рада за неї!',
      en: "My sister got into medical school, I'm thrilled to death for her!",
      de: 'Meine Schwester hat einen Medizinstudienplatz, ich könnte vor Freude sterben!',
      es: '¡Mi hermana entró en Medicina, me muero de alegría por ella!',
    },
  },
  {
    id: 'c02',
    register: 'CELEBRATORY',
    occasion: 'OTHER',
    trap: 'образы смерти на вечеринке',
    text: {
      ru: 'Хеллоуин-вечеринка в костюмах зомби у Димы',
      uk: 'Гелловін-вечірка в костюмах зомбі в Дмитра',
      en: "Dima's Halloween party with zombie costumes",
      de: 'Dimas Halloween-Party mit Zombie-Kostümen',
      es: 'La fiesta de Halloween de Dima con disfraces de zombis',
    },
  },
  {
    id: 'c03',
    register: 'CELEBRATORY',
    occasion: 'WEDDING',
    text: {
      ru: 'Помолвка лучшего друга, он наконец сделал предложение',
      uk: 'Заручини найкращого друга, він нарешті освідчився',
      en: "My best friend's engagement, he finally proposed",
      de: 'Die Verlobung meines besten Freundes, er hat endlich einen Antrag gemacht',
      es: 'El compromiso de mi mejor amigo, por fin le pidió matrimonio',
    },
  },
  {
    id: 'c04',
    register: 'CELEBRATORY',
    occasion: 'BIRTHDAY',
    text: {
      ru: 'Бабушке исполняется восемьдесят, вся семья собирается на даче',
      uk: 'Бабусі виповнюється вісімдесят, уся родина збирається на дачі',
      en: 'Grandma is turning eighty, the whole family is gathering at the country house',
      de: 'Oma wird achtzig, die ganze Familie trifft sich im Ferienhaus',
      es: 'La abuela cumple ochenta años, toda la familia se reúne en la casa de campo',
    },
  },
  {
    id: 'c05',
    register: 'CELEBRATORY',
    occasion: 'OTHER',
    text: {
      ru: 'Сын с командой выиграл турнир по футболу',
      uk: 'Син із командою виграв турнір з футболу',
      en: "My son's team won the football tournament",
      de: 'Die Mannschaft meines Sohnes hat das Fußballturnier gewonnen',
      es: 'El equipo de mi hijo ganó el torneo de fútbol',
    },
  },
  {
    id: 'c06',
    register: 'CELEBRATORY',
    occasion: 'OTHER',
    text: {
      ru: 'Друг купил первую машину, обмываем колёса',
      uk: 'Друг купив першу машину, обмиваємо колеса',
      en: "My friend bought his first car, we're celebrating",
      de: 'Mein Freund hat sein erstes Auto gekauft, das wird gefeiert',
      es: 'Mi amigo se compró su primer coche, lo celebramos',
    },
  },
  {
    id: 'c07',
    register: 'CELEBRATORY',
    occasion: 'BIRTHDAY',
    text: {
      ru: 'День рождения нашего кота Мурчика, ему пять лет',
      uk: 'День народження нашого кота Мурчика, йому п’ять років',
      en: "Our cat Murchyk's birthday, he's turning five",
      de: 'Geburtstag unseres Katers Murtschik, er wird fünf',
      es: 'El cumpleaños de nuestro gato Murchik, cumple cinco años',
    },
  },
  {
    id: 'c08',
    register: 'CELEBRATORY',
    occasion: 'GRADUATION',
    text: {
      ru: 'Выпускной в детском саду у дочки',
      uk: 'Випускний у дитячому садку в доньки',
      en: "My daughter's kindergarten graduation",
      de: 'Die Kindergarten-Abschlussfeier meiner Tochter',
      es: 'La graduación del jardín de infancia de mi hija',
    },
  },
  {
    id: 'c09',
    register: 'CELEBRATORY',
    occasion: 'WEDDING',
    trap: '«проводы» и «прощание» — но мальчишник',
    text: {
      ru: 'Проводы холостяцкой жизни Вовы, мальчишник в субботу',
      uk: 'Проводи холостяцького життя Вови, парубочий вечір у суботу',
      en: "Seeing off Vova's bachelor life, the stag party is on Saturday",
      de: 'Abschied von Wowas Junggesellenleben, der Junggesellenabschied ist am Samstag',
      es: 'Despedida de soltero de Vova, la fiesta es el sábado',
    },
  },
  {
    id: 'c10',
    register: 'CELEBRATORY',
    occasion: 'CORPORATE',
    trap: '«похоронили» в переносном смысле: ключевые слова здесь ошибаются',
    text: {
      ru: 'Переезд в новый офис: похоронили старый склад, празднуем всей командой',
      uk: 'Переїзд у новий офіс: поховали старий склад, святкуємо всією командою',
      en: 'Moving to the new office, we buried the old warehouse and are celebrating as a team',
      de: 'Umzug ins neue Büro, das alte Lager ist beerdigt, wir feiern mit dem ganzen Team',
      es: 'Mudanza a la oficina nueva, enterramos el viejo almacén y lo celebramos con todo el equipo',
    },
  },
];
