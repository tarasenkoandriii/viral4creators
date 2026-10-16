import { BRAND, type StoriesCopy } from './types';

/**
 * Edición en español — el mismo sentido que el original ruso, sin
 * promesas nuevas (decisión del 16.10: cinco idiomas con la misma
 * completitud). Los comentarios siguen en ruso, como en todo el proyecto.
 */
export const es: StoriesCopy = {
  meta: {
    title: `${BRAND} — un cuento con un mensaje de alguien cercano`,
    description:
      'Muy pronto: un mensaje personal de alguien cercano y un cuento ilustrado con el narrador que elijas. Lo prepara un adulto, lo recibe la familia.',
  },
  tagline: 'Lo mejor para los niños',
  skipLink: 'Ir al contenido',
  header: {
    navAriaLabel: 'Secciones de la página',
    brandHome: `${BRAND} — volver al inicio`,
    how: 'Cómo funciona',
    example: 'Ejemplo',
    faq: 'Preguntas',
    languageLabel: 'Idioma',
  },
  cta: {
    how: 'Cómo funciona',
    example: 'Ver un ejemplo',
    lead: 'Avisarme del lanzamiento',
    telegram: 'Abrir en Telegram',
    app: 'Abrir la aplicación',
    create: 'Crear un cuento',
  },
  hero: {
    badge: 'Muy pronto',
    title: 'Regala un cuento con un mensaje de alguien cercano',
    subtitle:
      'Graba unas palabras cálidas. Después llega un cuento ilustrado con el narrador que elijas: un pequeño regalo que se puede volver a poner.',
    micro: 'Lo prepara un adulto · Lo recibe la familia · Sin chat para niños',
    appNote:
      'En la aplicación ya puedes configurar un perfil de narrador: la apariencia (foto o boceto) y la voz. La creación de cuentos llegará más adelante.',
    illustrationCaption: 'Ilustración del formato',
    illustrationAlt:
      'Dibujo: a la izquierda, una tarjeta aparte con un narrador adulto; a la derecha, una escena de cuento con una casita, árboles y la luna, unidas por una línea de puntos.',
    narratorCardLabel: 'Mensaje',
    taleCardLabel: 'Cuento',
  },
  example: {
    title: 'Cómo es el regalo',
    lead: 'El regalo son tres partes de un mismo ejemplo coherente.',
    schemeLabel: 'Esquema del regalo en tres partes',
    parts: [
      {
        title: 'Mensaje personal',
        text: 'Una grabación breve de un adulto: unas palabras cálidas con su propia voz.',
      },
      {
        title: 'Cuento',
        text: 'Una historia ilustrada que lee el narrador elegido.',
      },
      {
        title: 'Cierre',
        text: 'Un final breve, tras el cual el regalo se puede volver a poner.',
      },
    ],
    caption:
      'El ejemplo aparecerá cuando se apruebe una grabación. Junto a él indicaremos quién habla, si es una grabación real, qué voz lee el cuento y si es la historia completa o un fragmento, con su duración.',
  },
  audience: {
    title: 'Para quién es',
    resultLabel: 'Qué se obtiene',
    items: [
      {
        title: 'Un padre o una madre lejos de casa',
        situation:
          'Mamá o papá está de viaje o de servicio y quiere dejar un mensaje conocido y una historia para la noche.',
        result: 'Una grabación suya y un cuento que la familia pone cuando le viene bien.',
      },
      {
        title: 'Abuelos que viven lejos',
        situation:
          'Los seres queridos viven en otra ciudad u otro país y quieren regalar su saludo o su lectura.',
        result: 'Un saludo con una voz conocida y una historia ilustrada de su parte.',
      },
      {
        title: 'Un pequeño regalo personal',
        situation: 'Un adulto prepara un regalo de cumpleaños o simplemente sin motivo.',
        result: 'Un cuento con un mensaje personal que se puede volver a poner.',
      },
    ],
  },
  how: {
    title: 'Cómo funciona',
    plannedBadge: 'Recorrido previsto',
    lead: 'Así funcionará el asistente de cuentos. Todavía está en preparación: abajo se describen los pasos, no es un formulario en funcionamiento.',
    steps: [
      'Un adulto elige una historia y un idioma del catálogo disponible.',
      'Graba un mensaje o elige un perfil de narrador permitido.',
      'Comprueba la imagen, la locución y una vista previa del resultado.',
      'Recibe el regalo terminado y decide aparte si lo publica mediante un enlace.',
    ],
    appLead: `La aplicación ya tiene una sección ${BRAND}: la descripción del formato y los ajustes del narrador. El asistente de cuentos todavía no está allí.`,
    appLink: 'Ver la sección en la aplicación',
    telegramLink: 'Abrir en Telegram',
  },
  narrator: {
    title: 'Quién lee el cuento',
    lead: 'Son tres cosas distintas y no las mezclamos.',
    items: [
      {
        title: 'Una grabación real de la introducción',
        text: 'Conserva la voz y la imagen de la persona tal como se grabaron. Elegir una voz para el cuento no la vuelve a doblar.',
      },
      {
        title: 'Un narrador estándar',
        text: 'Lee el texto del cuento con una voz disponible que elijas. No es la voz de tu ser querido.',
      },
      {
        title: 'Una voz familiar sintética',
        text: 'Solo aparecerá cuando la función esté lista por separado y con el consentimiento del dueño de la voz. Ahora no existe.',
      },
    ],
    sketch: {
      title: 'Foto o boceto',
      text: 'Una foto o un boceto es solo la apariencia del narrador. Un boceto no significa clonar la voz ni promete una animación natural. En el asistente, el original y la variante aplicada se verán por separado.',
    },
  },
  catalog: {
    title: 'Historias e idiomas',
    status: 'Catálogo en preparación',
    text: 'En la página solo figurarán las ediciones, los idiomas y las duraciones que estén disponibles de verdad. Todavía no hay ninguna: el catálogo se está preparando.',
    points: [
      'Cada historia indicará su edición concreta y su fuente.',
      'En cada tarjeta: idioma, recomendación de edad de la edición, duración y disponibilidad.',
      'Un argumento clásico no da derechos libres sobre cualquier traducción, ilustración o grabación; por eso el catálogo se arma por derechos, no por títulos.',
    ],
  },
  privacy: {
    title: 'Control del adulto y privacidad',
    items: [
      'El adulto verá el resultado antes de publicarlo y decidirá si lo comparte.',
      'La grabación y la voz personal no pasarán a formar parte de un catálogo común.',
      'Cualquiera que reciba un enlace familiar puede reenviarlo: no es un acceso cerrado.',
      'El acceso mediante enlace se podrá retirar en la medida que prevea el producto. Un archivo ya descargado no se puede borrar del dispositivo de quien lo recibió.',
      'La página está cerrada a la indexación de los buscadores. Esto reduce la visibilidad en las búsquedas, pero no sustituye la protección del acceso.',
    ],
  },
  launch: {
    title: 'Lanzamiento',
    statusLabel: 'Estado',
    status: 'Muy pronto',
    availableTitle: 'Ya disponible',
    available: [
      'La sección Story‑Tales en la aplicación, con la descripción del formato.',
      'Un perfil de narrador: apariencia (foto o boceto) y voz.',
    ],
    availableNeutral: [
      'La descripción del formato y del recorrido previsto, en esta página.',
    ],
    comingTitle: 'Llegará con el lanzamiento',
    coming: [
      'El asistente de cuentos: elegir la historia, grabar el mensaje y comprobar el resultado.',
      'Un catálogo de historias con sus ediciones e idiomas indicados.',
      'Un ejemplo aprobado del regalo en esta página.',
      'Precio y plazos, completos, antes de empezar.',
    ],
    note: 'Ahora mismo en esta página no se vende nada ni se cobra nada.',
  },
  faq: {
    title: 'Preguntas',
    items: [
      {
        question: '¿Puedo usar una grabación real sin clonar la voz?',
        answer:
          'Sí: el primer formato empezará con una grabación real de la introducción, seguida de un cuento ilustrado con el narrador que elijas. Para ello no hará falta clonar la voz.',
      },
      {
        question: '¿Con qué voz se lee el cuento entero y con cuál la introducción?',
        answer:
          'La introducción sonará tal como la grabó tu ser querido. El cuento lo leerá el narrador estándar que elijas. La lectura del cuento entero con una voz familiar solo aparecerá cuando la función esté lista por separado y con el consentimiento del dueño de la voz.',
      },
      {
        question: '¿Puedo elegir una foto o un boceto?',
        answer:
          'Sí, en el asistente se podrá elegir una foto o un boceto para la apariencia del narrador. Es solo el aspecto: no clona la voz ni promete una animación natural.',
      },
      {
        question: '¿Qué hace falta si el narrador es otro adulto?',
        answer:
          'Su propio consentimiento para la grabación y para el uso de su voz y su imagen. Las normas de consentimiento del narrador se publicarán antes del lanzamiento; sin consentimiento no se puede usar la grabación de otra persona.',
      },
      {
        question: '¿El niño necesita una cuenta?',
        answer:
          'No. El regalo lo preparará un adulto y la familia recibirá el resultado terminado. El niño no necesitará ni cuenta ni chat con IA.',
      },
      {
        question: '¿Quién podrá abrir el enlace y se puede retirar?',
        answer:
          'Lo abrirá cualquiera que lo tenga, también alguien a quien se lo hayan reenviado. El acceso mediante enlace se podrá retirar en la medida que prevea el producto; los archivos ya descargados se quedan con quien los recibió.',
      },
      {
        question: '¿Qué idiomas e historias hay ahora?',
        answer:
          'Todavía ninguno: el catálogo se está preparando. Esta página está en ruso, ucraniano, inglés, alemán y español; los idiomas de las propias historias aparecerán en el catálogo junto con las ediciones.',
      },
      {
        question: '¿Puedo ver el resultado antes de publicarlo?',
        answer:
          'Sí. El adulto comprobará la imagen, la locución y una vista previa del resultado y decidirá aparte si publica el regalo mediante un enlace.',
      },
      {
        question: '¿Cuánto cuesta y cuánto tarda la preparación?',
        answer:
          'El precio llegará con el lanzamiento; ahora no se vende ni se cobra nada. El plazo de preparación se indicará junto con el precio, antes de empezar.',
      },
      {
        question: '¿Qué pasa con la grabación original y cómo pido que se borre?',
        answer:
          'La grabación no entrará en un catálogo común ni se convertirá en material de esta página. El almacenamiento y el borrado para Story‑Tales se describirán antes del lanzamiento; por ahora rigen los Términos de uso generales de la plataforma, enlazados en el pie de página.',
      },
    ],
  },
  final: {
    title: 'Un regalo que se puede volver a poner',
    text: 'Mientras preparamos el lanzamiento, ya puedes preparar un perfil de narrador en la aplicación.',
    textNeutral: 'Mientras preparamos el lanzamiento, esta página explica cómo se construirá el regalo.',
  },
  footer: {
    navAriaLabel: 'Documentos',
    platform: 'La plataforma viral4creators',
    operatorLabel: 'Operador del servicio',
    operator: 'FOP Tarasenko Andrii Yevheniiovych (ФОП Тарасенко Андрій Євгенійович), Kyiv.',
    contactLabel: 'Contacto',
    contactBot: 'el bot de Telegram de la plataforma',
    offer: 'Oferta pública',
    terms: 'Términos de uso',
    privacy: 'Datos y privacidad',
    termsAndPrivacy: 'Términos de uso, datos y privacidad',
    narratorConsent: 'Normas de consentimiento del narrador',
    consentNote:
      'Las normas propias de Story‑Tales para narradores y materiales familiares se publicarán antes del lanzamiento. Por ahora rigen los documentos generales de la plataforma.',
    legalNoticeOtherLocale: 'Por ahora, los documentos solo están disponibles en ruso.',
  },
};
