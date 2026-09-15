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
