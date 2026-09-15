<!-- Manual knowledge layer (spec §5.2, item 6) — English translation. -->

## Choosing a good reference

Any ad or review video works, as long as it shows pacing, editing and
delivery — it does not need to feature the same kind of product. The
analysis extracts structure (scenes, cast, style, aspect ratio), it does
not transplant someone else's product onto the screen: you add your own
product and photo at step 5, even if the reference was about sneakers
and your product is cosmetics. A poor reference is one with almost no
action (a static talking head for ten minutes) or one where the analysis
clearly can't find what is being sold (no product in frame at all).

## If a render fails

The video is automatically marked as failed, the reason is shown in the
interface, and a "Retry" button is usually available — a new attempt
with the same settings. If a video keeps failing for the same reason,
the issue is likely the reference itself or the frame composition (too
long a scene chain, an unusual aspect ratio), not a transient error —
simplifying the frame composition at step 5 and re-running the analysis
is worth trying first.

## Veo vs. Grok in practice

Veo is the primary engine, up to 56 seconds total (8 seconds per call,
up to seven calls), consistently higher quality, generation usually
takes a few minutes. Grok is the alternative engine, up to 25 seconds
(a 15-second base clip plus one extension of up to 10 seconds),
resolution up to 1080p (capped at 720p when reference images or an
extension are used) — usually a bit cheaper with a different visual
character. Which engine is used for a given session is decided by the
wizard and the brand settings — the consultant does not switch engines
itself.

## Positioning

The service is a tool for people who already have (or found) an example
video and want something similar for their own product, without a film
crew or editing from scratch: analyze the reference, then generate a new
video based on the structure of that analysis. It is not a from-scratch
ad builder or a library of ready-made templates — a reference is always
required (found on YouTube, by link, your own file, or — on Premium — an
already-analyzed entry from the library).

## Support and documents

There is no separate support channel besides the service's own Telegram
bot yet (open question for the product owner, spec §12.3) — for
anything the consultant can't answer about the product itself, suggest
opening the mini-app. The terms of use and the offer are at
`/legal/offer` and `/legal/terms-of-use`; the consultant does not quote
them verbatim or give legal guarantees, it points to the document.
