# Base de conocimiento del consultor de IA de viral4creators

_Собрано автоматически 2026-09-17 из lending/frontend/backend; коммит — local._

## Secciones de la mini-app

- **Proyectos** — Producto o línea para la que se genera publicidad
- **Marca** — Un estilo y unos personajes unificados para todos los proyectos de la marca
- **Producción** — el asistente de generación — desde elegir la referencia hasta el video terminado (ver los pasos del tutorial más abajo)
- **Postprod** — Todos tus vídeos terminados: redoblaje, exportación, publicación y compartir.

## Pasos del tutorial

### 1. Agrega un producto
Un proyecto y un producto: una foto (a partir de ella se determinan la categoría, la audiencia objetivo y los precios comparables), una descripción en texto o voz, y un precio. El camino rápido sin proyecto también funciona — entonces el producto se describe directamente en el asistente.

### 2. Elige una referencia
Cuatro formas: búsqueda en YouTube, un enlace, tu propio archivo de hasta 100 MB y — en el plan Premium — un análisis ya listo de la biblioteca del servicio, al instante y sin una nueva llamada a la IA.
(disponible desde el plan: Premium)
- Biblioteca de análisis ya listos — sin una nueva llamada a la IA (Premium)
- Búsqueda en YouTube — requiere inicio de sesión
- Un enlace de YouTube o tu propio archivo de hasta 100 MB

### 3. La IA analiza el video
Gemini extrae escenas con marcas de tiempo, elenco y extras, estilo visual, ritmo y formato de encuadre — y evalúa a quién está dirigido este video y qué está promocionando.
- No hay que ingresar nada — la IA muestra el análisis por escenas por sí sola

### 4. Verifica la relevancia
Una verificación aparte compara la audiencia del video con los compradores de tu producto: una puntuación, la explicación del razonamiento y cambios concretos — si realmente vale la pena clonar esa referencia.
(disponible desde el plan: Standard+)
- Casilla «Tener en cuenta en la generación» — añade la sugerencia al prompt
- Botón «Verificar de nuevo» — un nuevo análisis de relevancia
- Botón «Elegir otra referencia» — volver al paso 2

### 5. Arma la composición del video
Elimina personajes, escenas y extras innecesarios — al hacer clic en cualquiera de ellos se resaltan las líneas correspondientes del análisis. Un personaje puede reemplazarse por tu propia foto, una descripción o un personaje de marca.
(disponible desde el plan: Standard+)
- Clic en un personaje — lo activa o desactiva en el video
- Reemplazar un personaje: tal cual, con tu propia foto (Standard+), con texto o con un personaje de marca
- Clic en una escena o extras — la activa o desactiva en el cuadro
- Voz, subtítulos y movimiento de cámara — desde el manifiesto de marca (para productos con proyecto)

### 6. Obtén el prompt
GPT-5 arma un prompt de texto a video a partir del análisis, el producto, el manifiesto de marca, el idioma de la locución y las sugerencias de relevancia. El prompt se puede editar a mano.
- Botón «Generar prompt» — texto listo a partir del análisis y el producto
- El prompt se puede ajustar a mano antes de guardar
- Un campo de texto aparte para la locución — si se elige una voz propia

### 7. Elige el formato y las imágenes de referencia
Relación de aspecto — 16:9 y 9:16 en cualquier plan, además de 3:4, 1:1 o una personalizada desde Standard en adelante — y qué tres imágenes recibirá el modelo como referencia: personajes, tus escenas, escenas de marca, foto del producto. Todo lo demás se incluye como texto en el prompt.
(disponible desde el plan: Standard+)
- Calidad de renderizado: «Rápida» o «Cinematográfica» (Standard+)
- Hasta tres imágenes de referencia para el motor de generación — tus propias escenas y fotos (Standard+)
- Relación de aspecto: 16:9 y 9:16 en cualquier plan, el resto desde Standard

### 8. Genera el video
Grok o Google Veo 3.1 renderiza el nuevo video publicitario — a elección, motor y calidad de renderizado, más rápido o más cinematográfico.
- La foto del producto es obligatoria — sin ella el botón de generar no aparece
- Botón «Generar video publicitario»
- Si falla — «Generar de nuevo»

### 9. Revisa el resultado
Una verificación aparte de artefactos propondrá un prompt corregido para una nueva generación. Para un producto de un proyecto, ahí mismo tienes un lote para toda la línea y tres variantes A/B del gancho. El video terminado se entrega como un enlace directo al archivo, y después el botón «Abrir en Postprod».
(disponible desde el plan: Standard+)
- Verificación de artefactos y de audio (Standard+)
- Un lote para toda la línea de productos y 3 variantes A/B (Premium, solo productos con proyecto)
- Botón «Abrir en Postprod» — el mismo video, junto con todos tus demás videos

### 10. Gestiónalo en Postprod
Una pestaña aparte, «Postprod», con todos tus videos terminados, no solo el último. Cambia el texto y la voz — con un proveedor de síntesis explícito y una escucha previa honesta antes de pagar — sin un nuevo renderizado. Exporta a varias plataformas y publica con una página para compartir.
(disponible desde el plan: Standard+)
- Redoblaje sin nuevo renderizado — solo cambian el audio, los subtítulos y el texto (Standard+)
- Proveedor de síntesis de voz — ElevenLabs o Resemble de forma explícita, o «como está»
- Escucha previa de la combinación exacta de texto, voz y proveedor — antes de pagar el redoblaje
- Exportación a varias plataformas a la vez — sin pagar el renderizado otra vez (Standard+)
- Publicación y página para compartir (Standard+, requiere inicio de sesión)

## Preguntas frecuentes

**¿Hace falta registrarse?**
No. La sesión es anónima y se crea automáticamente en la primera visita — solo hay que aceptar una vez la oferta pública y los términos de uso antes del primer análisis. Iniciar sesión con Telegram está disponible pero es opcional: se necesita para proyectos, el catálogo de productos, el manifiesto de marca y para volver más tarde a tus sesiones.

**¿Qué formatos de video se admiten?**
MP4, MOV y AVI de hasta 100 MB, o simplemente un enlace a un video público de YouTube — en ese caso no hace falta descargar ni subir ningún archivo.

**¿Cuánto tarda la generación del video?**
Una vez aprobado el prompt, el video suele estar listo en 3 a 5 minutos — el tiempo exacto depende del motor de generación elegido (Grok por defecto; también está disponible Google Veo 3.1 con los modos Fast/Standard) y de la carga actual.

**¿Cuánto cuesta?**
Por ahora, nada: los tres planes — Lite, Standard y Premium — son gratuitos y se cambian directamente desde la aplicación. Es un período de prueba; cuando se introduzcan los pagos, lo que ya hayas hecho seguirá siendo tuyo. Más adelante, Lite pasará a ser condicionalmente gratuito — a cambio de dar «me gusta» al canal de YouTube del proyecto y enviar algunos enlaces al servicio.

**¿En qué se diferencian los planes entre sí?**
Lite es el camino mínimo: análisis de la referencia y generación del video en 16:9 o 9:16. Standard añade verificación de relevancia, auditoría del video, manifiesto de marca, escenas propias, reemplazo de personajes por foto, cualquier formato de encuadre y publicación. Premium es Standard más la biblioteca de análisis ya listos. El plan se puede cambiar en cualquier momento sin afectar los proyectos, videos o análisis ya creados.

**¿Dónde se guardan mis archivos y cuándo se eliminan?**
En Vercel Blob — la referencia, la foto del producto y el video terminado se guardan en el mismo almacenamiento. Cada archivo tiene un propietario en la base de datos: una sesión vencida se lleva sus archivos, un producto eliminado se lleva su foto, un manifiesto eliminado se lleva las fotos de personajes y escenas. La limpieza se ejecuta a diario, y un proceso aparte recoge los archivos huérfanos.

**¿A quién pertenecen los análisis y los videos terminados?**
El análisis de la referencia lo crea el servicio, y según los términos de uso los análisis le pertenecen — precisamente por eso la biblioteca puede ofrecerlos a otros usuarios. Tu producto, tus materiales subidos y el video generado siguen siendo tuyos. Los análisis de videos subidos como archivo son privados: solo los ve el autor.

**¿Se puede usar desde Telegram?**
Sí — el mismo producto funciona tanto como un sitio web normal en el navegador como una Telegram Mini App dentro de Telegram, con el mismo conjunto de funciones.

**¿Se puede editar manualmente el análisis del video o el prompt?**
Sí, en ambos pasos: después del análisis automático de la referencia y después de la generación automática del prompt, ambos resultados se pueden ajustar antes de continuar.

**¿Es un proyecto de código abierto?**
Sí — el código fuente está disponible en GitHub, y el desarrollo siguió la metodología GitHub Spec Kit.

## Planes y funciones

Todos los planes son gratuitos por ahora y el propio usuario los cambia en la mini-app (es un período de prueba temporal, la facturación aún no está activada).

### Lite
Разбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.
Boceto IA en lugar de la imagen
16:9/9:16 only

### Standard
Весь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.
Evaluación de relevancia de la referencia, Auditoría de un vídeo terminado, Publicación a través del servicio, Manifiesto de marca, Escenas propias y espacios de referencia, Sustitución de personajes en la foto, Cualquier formato de imagen, Modelo Veo completo, Clonar tu propia voz, Vídeo tutorial del sitio del cliente, Boceto IA en lugar de la imagen
any aspect ratio

### Premium
Всё вместе с библиотекой разборов и дубляжом (полная замена звука Veo своим голосом): готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.
Biblioteca de análisis listos, Evaluación de relevancia de la referencia, Auditoría de un vídeo terminado, Publicación a través del servicio, Manifiesto de marca, Escenas propias y espacios de referencia, Sustitución de personajes en la foto, Cualquier formato de imagen, Modelo Veo completo, Clonar tu propia voz, Doblaje (reemplazo completo de la voz del modelo), Vídeo tutorial del sitio del cliente, Boceto IA en lugar de la imagen
any aspect ratio

## Reglas del pipeline

Veo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.
Grok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.
Референс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.
Озвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».
Форматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.
Фото товара — до 10 МБ.

## Sugerencias de los campos del asistente

**Загрузка референса**: Un anuncio UGC exitoso que clonaremos para tu producto: toma un desglose ya listo de la biblioteca, busca un vídeo en YouTube, pega un enlace o sube un archivo.

**Файл референса**: MP4, MOV, AVI · hasta 100 MB

**Референс — файл слишком большой**: El vídeo supera los 100 MB.

**Манифест бренда — голос**: Carácter de la voz, ritmo, estilo — se incluirá en el prompt; el idioma de las réplicas se define en el paso «Producto».

**Манифест бренда — по умолчанию**: Copia para este video: ajusta el estilo para esta generación concreta — el manifiesto en sí no se modifica.

**Клонирование голоса — лимит**: Se alcanzó el límite de {{max}} voces — elimina una para clonar otra.

## Notas adicionales

<!-- Capa manual de la base de conocimiento (spec §5.2, punto 6) — traducción. -->

## Cómo elegir una buena referencia

Sirve cualquier video publicitario o de reseña, siempre que muestre
ritmo, montaje y estilo de presentación — no hace falta que sea el mismo
tipo de producto. El análisis extrae la estructura (escenas, elenco,
estilo, relación de aspecto), no traslada el producto ajeno a la
pantalla: tu propio producto y foto se agregan en el paso 5, aunque la
referencia fuera de zapatillas y tu producto sea cosmética. Una mala
referencia es la que casi no tiene acción (una persona hablando
estáticamente diez minutos) o donde el análisis claramente no encuentra
qué se está vendiendo (ningún producto en cuadro).

## Si el renderizado falla

El video se marca automáticamente como fallido, el motivo se muestra en
la interfaz y normalmente hay un botón "Reintentar" — un nuevo intento
con la misma configuración. Si un video falla varias veces seguidas por
el mismo motivo, probablemente el problema esté en la referencia misma o
en la composición del cuadro (cadena de escenas demasiado larga, formato
inusual), no en un fallo pasajero — conviene simplificar la composición
del cuadro en el paso 5 y repetir el análisis.

## Veo y Grok en la práctica

Veo es el motor principal, hasta 56 segundos en total (8 segundos por
llamada, hasta siete llamadas), calidad consistentemente más alta, la
generación suele tardar unos minutos. Grok es el motor alternativo,
hasta 25 segundos (un clip base de 15 segundos más una extensión de
hasta 10 segundos), resolución hasta 1080p (limitada a 720p si se usan
imágenes de referencia o extensión) — suele ser algo más económico y con
un carácter visual distinto. Qué motor se usa para una sesión concreta
lo deciden el asistente y la configuración de marca — el consultor no
cambia el motor por sí mismo.

## Posicionamiento

El servicio es una herramienta para quienes ya tienen (o encontraron) un
video de ejemplo y quieren algo similar para su propio producto, sin
equipo de filmación ni montaje desde cero: analizar la referencia y
luego generar un nuevo video basado en la estructura de ese análisis. No
es un generador de anuncios desde cero ni una biblioteca de plantillas
listas — siempre se necesita una referencia (encontrada en YouTube, por
enlace, archivo propio o — en Premium — una entrada ya analizada de la
biblioteca).

## Soporte y documentos

Por ahora no hay un canal de soporte separado además del propio bot de
Telegram del servicio (pregunta abierta para el dueño del producto, spec
§12.3) — para todo lo que el consultor no pueda responder sobre el
producto, se sugiere abrir la mini-app. Los términos de uso y la oferta
están en `/legal/offer` y `/legal/terms-of-use`; el consultor no los cita
textualmente ni da garantías legales, remite al documento.
