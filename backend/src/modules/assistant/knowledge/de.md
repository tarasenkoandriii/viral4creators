# Wissensdatenbank des viral4creators-KI-Beraters

_Собрано автоматически 2026-09-23 из lending/frontend/backend; коммит — local._

## Bereiche der Mini-App

- **Projekte** — Produkt oder Produktlinie, für die Werbung generiert wird
- **Marke** — Ein einheitlicher Stil und Charaktere für alle Projekte einer Marke
- **Produktion** — der Generierungsassistent — von der Referenzauswahl bis zum fertigen Video (siehe die Anleitungsschritte unten)
- **Postprod** — Alle Ihre fertigen Videos: Neuvertonung, Export, Veröffentlichung und Teilen.

## Anleitungsschritte

### 1. Produkt anlegen
Projekt und Produkt: ein Foto (daraus werden Kategorie, Zielgruppe und Vergleichspreise bestimmt), eine Beschreibung als Text oder Sprache, ein Preis. Der schnelle Weg ohne Projekt funktioniert ebenfalls — dann wird das Produkt direkt im Assistenten beschrieben.

### 2. Referenz wählen
Vier Wege: YouTube-Suche, ein Link, eine eigene Datei bis 100 MB und — im Premium-Tarif — eine fertige Analyse aus der Bibliothek des Dienstes, sofort und ohne neuen KI-Aufruf.
(verfügbar ab Tarif: Premium)
- Bibliothek fertiger Analysen — ohne neuen KI-Aufruf (Premium)
- YouTube-Suche — Anmeldung nötig
- Ein YouTube-Link oder eine eigene Datei bis 100 MB

### 3. KI analysiert das Video
Gemini extrahiert Szenen mit Zeitstempeln, Darsteller und Statisten, visuellen Stil, Tempo und Seitenverhältnis — und beurteilt, an wen sich dieses Video richtet und was es bewirbt.
- Keine Eingabe nötig — die KI zeigt die Szenen-für-Szene-Analyse von selbst

### 4. Relevanz prüfen
Eine separate Prüfung vergleicht die Zielgruppe des Videos mit den Käufern Ihres Produkts: eine Bewertung, die Begründung dazu und konkrete Änderungen — ob es sich überhaupt lohnt, diese Referenz zu klonen.
(verfügbar ab Tarif: Standard+)
- Checkbox „Bei der Generierung berücksichtigen" — nimmt den Hinweis in den Prompt auf
- Schaltfläche „Erneut prüfen" — eine neue Relevanzprüfung
- Schaltfläche „Andere Referenz wählen" — zurück zu Schritt 2

### 5. Bildaufbau zusammenstellen
Überflüssige Charaktere, Szenen und Statisten entfernen — ein Klick auf einen davon hebt die passenden Zeilen der Analyse hervor. Ein Charakter lässt sich durch ein eigenes Foto, eine Beschreibung oder einen Marken-Charakter ersetzen.
(verfügbar ab Tarif: Standard+)
- Klick auf einen Charakter — schaltet ihn im Video ein oder aus
- Charakter ersetzen: unverändert, eigenes Foto (Standard+), Textbeschreibung oder Marken-Charakter
- Klick auf eine Szene oder Statisten — schaltet sie im Bild ein oder aus
- Stimme, Untertitel und Kamerabewegung — aus dem Markenmanifest (für Produkte mit Projekt)

### 6. Prompt erhalten
GPT-5 stellt einen Text-zu-Video-Prompt aus Analyse, Produkt, Markenmanifest, Sprache der Vertonung und Relevanz-Hinweisen zusammen. Der Prompt lässt sich von Hand anpassen.
- Schaltfläche „Prompt generieren" — fertiger Text aus Analyse und Produkt
- Der Prompt lässt sich vor dem Speichern von Hand anpassen
- Ein eigenes Textfeld für die Vertonung — wenn eine eigene Stimme gewählt ist

### 7. Format und Referenzbilder wählen
Seitenverhältnis — 16:9 und 9:16 in jedem Tarif, 3:4, 1:1 oder ein eigenes ab Standard — sowie die drei Bilder, die das Modell als Referenz erhält: Charaktere, eigene Szenen, Markenszenen, Produktfoto. Alles Weitere fließt als Text in den Prompt.
(verfügbar ab Tarif: Standard+)
- Render-Qualität: „Schnell" oder „Kinematografisch" (Standard+)
- Bis zu drei Referenzbilder für die Generierungs-Engine — eigene Szenen und Fotos (Standard+)
- Seitenverhältnis: 16:9 und 9:16 in jedem Tarif, der Rest ab Standard

### 8. Video generieren
Grok oder Google Veo 3.1 rendert das neue Werbevideo — wahlweise Engine und Render-Qualität, schneller oder kinematografischer.
- Ein Produktfoto ist Pflicht — ohne es erscheint der Generieren-Button nicht
- Schaltfläche „Werbevideo generieren"
- Bei Fehlschlag — „Erneut generieren"

### 9. Ergebnis prüfen
Eine separate Artefaktprüfung schlägt einen korrigierten Prompt für eine erneute Generierung vor. Bei einem Produkt aus einem Projekt gibt es gleich einen Batch-Lauf für die ganze Produktlinie und drei A/B-Varianten des Hooks. Das fertige Video steht als direkter Datei-Link zur Verfügung, danach folgt die Schaltfläche „In Postprod öffnen“.
(verfügbar ab Tarif: Standard+)
- Artefaktprüfung und Sound-Check (Standard+)
- Ein Batch-Lauf für die ganze Produktlinie und 3 A/B-Varianten (Premium, nur für Produkte mit Projekt)
- Schaltfläche „In Postprod öffnen“ — dasselbe Video, zusammen mit all Ihren anderen

### 10. In Postprod verwalten
Ein eigener Tab „Postprod“ mit all Ihren fertigen Videos, nicht nur dem letzten. Ändern Sie Text und Stimme — mit expliziter Wahl des Synthese-Anbieters und einem ehrlichen Vorab-Anhören vor der Zahlung — ganz ohne neues Rendering. Exportieren Sie für mehrere Plattformen und veröffentlichen Sie mit einer Seite zum Teilen.
(verfügbar ab Tarif: Standard+)
- Neu vertonen ohne neues Rendering — nur Ton, Untertitel und Text ändern sich (Standard+)
- Sprachsynthese-Anbieter — explizit ElevenLabs oder Resemble, oder „wie bisher“
- Die genaue Kombination aus Text, Stimme und Anbieter vorab anhören — vor der Zahlung für die Neuvertonung
- Export für mehrere Plattformen zugleich — ohne erneute Render-Gebühr (Standard+)
- Veröffentlichung und Seite zum Teilen (Standard+, Anmeldung nötig)

## Häufige Fragen

**Ist eine Registrierung erforderlich?**
Nein. Die Sitzung ist anonym und wird beim ersten Besuch automatisch erstellt — man muss nur einmal, vor der ersten Analyse, dem öffentlichen Angebot und den Nutzungsbedingungen zustimmen. Die Anmeldung über Telegram ist verfügbar, aber optional: Sie wird für Projekte, den Produktkatalog, das Markenmanifest und um später zu eigenen Sitzungen zurückzukehren benötigt.

**Welche Videoformate werden unterstützt?**
MP4, MOV und AVI bis 100 MB, oder einfach ein Link zu einem öffentlichen YouTube-Video — dann muss überhaupt keine Datei heruntergeladen oder hochgeladen werden.

**Wie lange dauert die Videogenerierung?**
Sobald der Prompt bestätigt ist, ist das Video meist innerhalb von 3–5 Minuten fertig — die genaue Dauer hängt von der gewählten Generierungs-Engine ab (standardmäßig Grok, alternativ Google Veo 3.1 mit den Modi Fast/Standard) sowie der aktuellen Auslastung.

**Was kostet das?**
Derzeit nichts: Alle drei Tarife — Lite, Standard und Premium — sind kostenlos und lassen sich direkt in der App umschalten. Das ist eine Testphase; wenn eine Bezahlung eingeführt wird, bleibt bereits Erstelltes erhalten. Später soll Lite bedingt kostenlos werden — gegen ein Like des Projekt-YouTube-Kanals und einige an den Dienst gesendete Links.

**Worin unterscheiden sich die Tarife?**
Lite ist der minimale Weg: Referenzanalyse und ein Video in 16:9 oder 9:16; Grußvideo und KI-Produktskizze sind in jedem Tarif verfügbar. Standard ergänzt Relevanzprüfung, Video-Audit, Markenmanifest, eigene Szenen, Charakteraustausch per Foto, beliebige Seitenverhältnisse, Stimmklon, das Tutorial über die Website des Kunden, Veröffentlichung und Feed. Premium ist Standard plus Bibliothek fertiger Analysen und Dub: Der Veo-Ton wird vollständig durch Ihre Stimme ersetzt. Der Tarif lässt sich jederzeit wechseln und berührt bereits erstellte Projekte, Videos und Analysen nicht.

**Wo werden meine Dateien gespeichert und wann werden sie gelöscht?**
In Vercel Blob — Referenz, Produktfoto und fertiges Video liegen im selben Speicher. Jede Datei hat einen Besitzer in der Datenbank: Eine abgelaufene Sitzung nimmt ihre Dateien mit, ein gelöschtes Produkt sein Foto, ein gelöschtes Manifest die Fotos von Charakteren und Szenen. Die Bereinigung läuft täglich, verwaiste Dateien erfasst ein separater Durchlauf.

**Wem gehören die Analysen und die fertigen Videos?**
Die Analyse der Referenz erstellt der Dienst, und laut Nutzungsbedingungen gehören die Analysen ihm — genau deshalb kann die Bibliothek sie anderen anbieten. Ihr Produkt, Ihre hochgeladenen Materialien und das generierte Video bleiben Ihnen. Analysen von als Datei hochgeladenen Videos sind privat: Nur der Autor sieht sie.

**Kann man es über Telegram nutzen?**
Ja — dasselbe Produkt funktioniert sowohl als gewöhnliche Website im Browser als auch als Telegram Mini App innerhalb von Telegram, mit demselben Funktionsumfang.

**Kann man die Videoanalyse oder den Prompt manuell bearbeiten?**
Ja, an beiden Stellen: nach der automatischen Analyse der Referenz und nach der automatischen Generierung des Prompts lassen sich beide Ergebnisse anpassen, bevor es weitergeht.

**Ist das ein Open-Source-Projekt?**
Ja — der Quellcode ist auf GitHub verfügbar, die Entwicklung folgte der GitHub-Spec-Kit-Methodik.

**Was ist der Marktplatz und worin unterscheidet er sich vom Generator?**
Es ist eine zweite Plattform neben dem Generator, unter eigener Adresse und mit demselben Telegram-Login. Im Generator erstellt die KI das Video aus Ihrer Referenz; auf dem Marktplatz erstellt es ein echter Creator — Sie finden ihn im Katalog nach Portfolio und Nische oder veröffentlichen ein Briefing, und die Plattform schlägt passende vor. Kontakt und Abrechnung laufen direkt: Ausschreibung und Vorauszahlung über die Plattform gibt es derzeit nicht.

**Wie funktioniert die Video-Auktion?**
Ein Creator stellt ein bereits fertiges Video als Los ein: Startpreis, offene Gebote und, wenn er das so wollte, eine Schaltfläche „Sofort kaufen“. Es gibt exklusive Lose und Blitzpreise. Ein Gebot in der letzten Sekunde kann ein Los nicht abfangen — die Zeit verlängert sich automatisch. Einige Blitz-Lose haben eine Live-Übertragung mit KI-Moderatorin, und nur mit ausdrücklicher Zustimmung des Verkäufers.

**Kann man auch etwas anderes als Werbung machen?**
Ja, es gibt zwei weitere Projekttypen. Ein Grußvideo: Anlass, Name des Empfängers, Name des Absenders und Tonfall — heraus kommt ein persönliches Video, in jedem Tarif verfügbar. Ein Tutorial über die Website des Kunden: Der Assistent führt einen Browser durch die Website und baut aus dem, was auf dem Bildschirm passiert ist, ein Lernvideo — bis hin zur Live-Anmeldung im Kundenkonto — ab Standard.

## Tarife und Funktionen

Alle Tarife sind derzeit kostenlos und werden vom Nutzer selbst in der Mini-App umgeschaltet (dies ist eine vorübergehende Testphase, die Abrechnung ist noch nicht aktiviert).

### Lite
Разбор референса и генерация ролика в 16:9 или 9:16 — самый короткий путь от примера к результату.
KI-Skizze statt des Bildes, Grußvideo
16:9/9:16 only

### Standard
Весь функционал сервиса, кроме библиотеки готовых разборов и дубляжа: бренд, персонажи, сцены, релевантность, аудит, публикация, любые форматы кадра, озвучка своим голосом поверх звука Veo.
Bewertung der Referenzrelevanz, Audit eines fertigen Videos, Veröffentlichung über den Dienst, Marken-Manifest, Eigene Szenen und Referenz-Slots, Austausch von Personen im Foto, Beliebiges Seitenverhältnis, Vollständiges Veo-Modell, Eigene Stimme klonen, Tutorial-Video für die Website des Kunden, KI-Skizze statt des Bildes, Grußvideo
any aspect ratio

### Premium
Всё вместе с библиотекой разборов, дубляжом (полная замена звука Veo своим голосом) и говорящим аватаром для поздравлений: готовые сценарии под аудиторию вашего товара и мгновенный разбор уже виденных роликов.
Bibliothek fertiger Analysen, Bewertung der Referenzrelevanz, Audit eines fertigen Videos, Veröffentlichung über den Dienst, Marken-Manifest, Eigene Szenen und Referenz-Slots, Austausch von Personen im Foto, Beliebiges Seitenverhältnis, Vollständiges Veo-Modell, Eigene Stimme klonen, Synchronisation (modelleigene Stimme vollständig ersetzt), Tutorial-Video für die Website des Kunden, KI-Skizze statt des Bildes, Grußvideo
any aspect ratio

## Pipeline-Regeln

Veo: до 8 секунд за вызов, до 7 вызовов, максимум 56 секунд суммарно.
Grok: базовый ролик до 15 секунд плюс одно расширение до 10 секунд, максимум 25 секунд. Разрешение до 1080p, при референс-изображениях или расширении — до 720p.
Референс — поиск по YouTube, ссылка или свой файл (лимит — см. интерфейс загрузки, ориентир 100 МБ); на Premium — библиотека готовых разборов без нового вызова ИИ.
Озвучка — три режима: Голос Veo, Свой голос поверх, Свой голос вместо; по умолчанию — «Свой голос поверх».
Форматы кадра: 16:9 и 9:16 доступны на всех тарифах; остальные — от Standard.
Фото товара — до 10 МБ.

## Hinweise zu Assistentenfeldern

**Загрузка референса**: Eine erfolgreiche UGC-Werbung, die wir für Ihr Produkt klonen – nehmen Sie eine fertige Analyse aus der Bibliothek, suchen Sie ein Video auf YouTube, fügen Sie einen Link ein oder laden Sie eine Datei hoch.

**Файл референса**: MP4, MOV, AVI · bis zu 100 MB

**Референс — файл слишком большой**: Das Video ist größer als 100 MB.

**Манифест бренда — голос**: Stimmcharakter, Tempo, Art — fließt in den Prompt ein; die Sprache der Repliken wird im Schritt „Produkt“ festgelegt.

**Манифест бренда — по умолчанию**: Kopie für dieses Video: Passen Sie den Stil für diese Generierung an — das Manifest selbst bleibt unverändert.

**Клонирование голоса — лимит**: Limit von {{max}} Stimmen erreicht — löschen Sie eine, um eine neue zu klonen.

## Zusätzliches

<!-- Manuelle Wissensebene (Spezifikation §5.2, Punkt 6) — deutsche Übersetzung. -->

## Eine gute Referenz auswählen

Jedes Werbe- oder Rezensionsvideo eignet sich, solange Tempo, Schnitt und
Vortragsweise erkennbar sind — es muss nicht dieselbe Produktart zeigen.
Die Analyse extrahiert die Struktur (Szenen, Besetzung, Stil,
Seitenverhältnis), sie überträgt nicht das fremde Produkt auf den
Bildschirm: Ihr eigenes Produkt und Foto fügen Sie in Schritt 5 hinzu,
auch wenn die Referenz Sneaker zeigte und Ihr Produkt Kosmetik ist. Eine
schlechte Referenz hat kaum Handlung (ein zehnminütiger statischer
Sprecher) oder die Analyse findet gar kein verkauftes Produkt im Bild.

## Wenn ein Rendering fehlschlägt

Das Video wird automatisch als fehlgeschlagen markiert, der Grund wird
in der Oberfläche angezeigt, und meist ist eine „Wiederholen“-Schaltfläche
verfügbar — ein neuer Versuch mit denselben Einstellungen. Schlägt ein
Video wiederholt aus demselben Grund fehl, liegt es wahrscheinlich an der
Referenz selbst oder an der Bildkomposition (zu lange Szenenkette,
ungewöhnliches Format), nicht an einer vorübergehenden Störung — zuerst
die Bildkomposition in Schritt 5 vereinfachen und die Analyse wiederholen.

## Veo und Grok in der Praxis

Veo ist die Haupt-Engine, bis zu 56 Sekunden insgesamt (8 Sekunden pro
Aufruf, bis zu sieben Aufrufe), durchgehend höhere Qualität, die
Generierung dauert meist einige Minuten. Grok ist die alternative
Engine, bis zu 25 Sekunden (15 Sekunden Basisclip plus eine Erweiterung
von bis zu 10 Sekunden), Auflösung bis 1080p (auf 720p begrenzt bei
Referenzbildern oder Erweiterung) — meist etwas günstiger und mit
anderem visuellem Charakter. Welche Engine für eine bestimmte Sitzung
verwendet wird, entscheiden der Assistent und die Markeneinstellungen —
der Berater wechselt die Engine nicht selbst.

## Positionierung

Der Dienst ist ein Werkzeug für alle, die bereits ein Beispielvideo haben
(oder gefunden haben) und etwas Ähnliches für ihr eigenes Produkt wollen,
ohne Filmteam oder Schnitt von Grund auf: Referenz analysieren, dann ein
neues Video basierend auf der Struktur dieser Analyse generieren. Es ist
kein Werbebaukasten von Grund auf und keine Bibliothek fertiger
Vorlagen — eine Referenz ist immer erforderlich (gefunden auf YouTube,
per Link, eigene Datei oder — bei Premium — ein bereits analysierter
Eintrag aus der Bibliothek).

## Support und Dokumente

Es gibt derzeit noch keinen separaten Support-Kanal außer dem eigenen
Telegram-Bot des Dienstes (offene Frage an den Produktverantwortlichen,
Spezifikation §12.3) — bei allem, was der Berater zum Produkt nicht
beantworten kann, wird vorgeschlagen, die Mini-App zu öffnen. Nutzungs-
bedingungen und Angebot stehen unter `/legal/offer` und
`/legal/terms-of-use`; der Berater zitiert sie nicht wörtlich und gibt
keine rechtlichen Garantien, sondern verweist auf das Dokument.
