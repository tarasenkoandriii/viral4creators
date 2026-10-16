import { BRAND, type StoriesCopy } from './types';

/**
 * Deutsche Fassung — derselbe Sinn wie die russische Vorlage, ohne neue
 * Versprechen (Entscheidung vom 16.10: fünf Sprachen, gleich vollständig).
 * Kommentare bleiben russisch, wie im ganzen Projekt.
 */
export const de: StoriesCopy = {
  meta: {
    title: `${BRAND} — ein Märchen mit einer Botschaft von einem nahestehenden Menschen`,
    description:
      'Bald verfügbar: eine persönliche Botschaft eines nahestehenden Menschen und ein illustriertes Märchen mit dem gewählten Erzähler. Ein Erwachsener gestaltet, die Familie erhält das Geschenk.',
  },
  tagline: 'Das Beste für die Kinder',
  skipLink: 'Zum Inhalt springen',
  header: {
    navAriaLabel: 'Abschnitte der Seite',
    brandHome: `${BRAND} — zum Seitenanfang`,
    how: 'So funktioniert es',
    example: 'Beispiel',
    faq: 'Fragen',
    languageLabel: 'Sprache',
  },
  cta: {
    how: 'So funktioniert es',
    example: 'Beispiel ansehen',
    lead: 'Mehr zum Start',
    telegram: 'In Telegram öffnen',
    app: 'App öffnen',
    create: 'Märchen erstellen',
  },
  hero: {
    badge: 'Start in Kürze',
    title: 'Schenken Sie ein Märchen mit einer Botschaft von einem nahestehenden Menschen',
    subtitle:
      'Nehmen Sie ein paar herzliche Worte auf. Daran schließt ein illustriertes Märchen mit dem gewählten Erzähler an — ein kleines Geschenk, das man immer wieder abspielen kann.',
    micro: 'Ein Erwachsener gestaltet · Die Familie erhält das Geschenk · Kein Kinderchat',
    appNote:
      'In der App lässt sich schon jetzt ein Erzählerprofil einrichten — Aussehen (Foto oder Skizze) und Stimme. Das Erstellen eines Märchens folgt später.',
    illustrationCaption: 'Illustration des Formats',
    illustrationAlt:
      'Zeichnung: links eine eigene Karte mit einem erwachsenen Erzähler, rechts eine Märchenszene mit Häuschen, Bäumen und Mond, dazwischen eine gepunktete Linie.',
    narratorCardLabel: 'Botschaft',
    taleCardLabel: 'Märchen',
  },
  example: {
    title: 'So sieht das Geschenk aus',
    lead: 'Das Geschenk besteht aus drei Teilen eines stimmigen Beispiels.',
    schemeLabel: 'Aufbau des Geschenks in drei Teilen',
    parts: [
      {
        title: 'Persönliche Botschaft',
        text: 'Eine kurze Aufnahme eines Erwachsenen: ein paar herzliche Worte mit der eigenen Stimme.',
      },
      {
        title: 'Märchen',
        text: 'Eine illustrierte Geschichte, die der gewählte Erzähler vorliest.',
      },
      {
        title: 'Abschluss',
        text: 'Ein kurzes Ende, nach dem sich das Geschenk erneut abspielen lässt.',
      },
    ],
    caption:
      'Ein Beispiel erscheint, sobald eine Aufnahme freigegeben ist. Daneben steht dann, wer spricht, ob es eine echte Aufnahme ist, mit welcher Stimme das Märchen gelesen wird und ob es die ganze Geschichte oder ein Ausschnitt ist — mit Dauer.',
  },
  audience: {
    title: 'Für wen es passt',
    resultLabel: 'Was entsteht',
    items: [
      {
        title: 'Ein Elternteil unterwegs',
        situation:
          'Mama oder Papa ist auf Reisen oder im Dienst und möchte eine vertraute Botschaft und eine Geschichte für den Abend hinterlassen.',
        result: 'Eine Aufnahme des Elternteils und ein Märchen, das die Familie abspielt, wann es ihr passt.',
      },
      {
        title: 'Großeltern in der Ferne',
        situation:
          'Die Liebsten wohnen in einer anderen Stadt oder einem anderen Land und möchten ihren Gruß oder ihr Vorlesen schenken.',
        result: 'Ein Gruß mit vertrauter Stimme und eine illustrierte Geschichte von ihnen.',
      },
      {
        title: 'Ein kleines persönliches Geschenk',
        situation: 'Ein Erwachsener bereitet ein Geschenk zum Geburtstag vor — oder einfach ohne Anlass.',
        result: 'Ein Märchen mit persönlicher Botschaft, das man erneut abspielen kann.',
      },
    ],
  },
  how: {
    title: 'So funktioniert es',
    plannedBadge: 'Geplanter Ablauf',
    lead: 'So wird der Märchen-Assistent aufgebaut sein. Er ist noch in Vorbereitung: Unten stehen die Schritte als Beschreibung, nicht als funktionierendes Formular.',
    steps: [
      'Ein Erwachsener wählt eine Geschichte und eine Sprache aus dem verfügbaren Katalog.',
      'Er nimmt eine Botschaft auf oder wählt ein zulässiges Erzählerprofil.',
      'Er prüft Aussehen, Vertonung und eine Vorschau des Ergebnisses.',
      'Er erhält das fertige Geschenk und entscheidet gesondert, ob es per Link veröffentlicht wird.',
    ],
    appLead: `In der App gibt es bereits einen Bereich ${BRAND}: eine Beschreibung des Formats und die Erzähler-Einstellungen. Den Märchen-Assistenten gibt es dort noch nicht.`,
    appLink: 'Bereich in der App ansehen',
    telegramLink: 'In Telegram öffnen',
  },
  narrator: {
    title: 'Wer das Märchen liest',
    lead: 'Das sind drei verschiedene Dinge, und wir vermischen sie nicht.',
    items: [
      {
        title: 'Echte Aufnahme der Einleitung',
        text: 'Bewahrt Stimme und Bild des Menschen so, wie sie aufgenommen wurden. Die Stimmwahl für das Märchen vertont sie nicht neu.',
      },
      {
        title: 'Standard-Erzähler',
        text: 'Liest den Text des Märchens mit einer gewählten verfügbaren Stimme. Das ist nicht die Stimme Ihres Angehörigen.',
      },
      {
        title: 'Synthetische Familienstimme',
        text: 'Kommt nur, wenn die Funktion gesondert bereit ist und der Inhaber der Stimme zugestimmt hat. Derzeit gibt es sie nicht.',
      },
    ],
    sketch: {
      title: 'Foto oder Skizze',
      text: 'Foto oder Skizze bestimmen nur das Aussehen des Erzählers. Eine Skizze bedeutet kein Klonen der Stimme und verspricht keine natürlich wirkende Animation. Im Assistenten werden Original und angewendete Variante getrennt zu sehen sein.',
    },
  },
  catalog: {
    title: 'Geschichten und Sprachen',
    status: 'Katalog in Vorbereitung',
    text: 'Auf der Seite stehen nur Ausgaben, Sprachen und Längen, die tatsächlich verfügbar sind. Noch gibt es keine — der Katalog wird vorbereitet.',
    points: [
      'Zu jeder Geschichte wird die konkrete Ausgabe und ihre Quelle angegeben.',
      'Auf jeder Karte: Sprache, Altersempfehlung der Ausgabe, Länge und Verfügbarkeit.',
      'Ein klassischer Stoff bedeutet keine freien Rechte an jeder Übersetzung, Illustration oder Aufnahme — deshalb entsteht der Katalog nach Rechten, nicht nach Titeln.',
    ],
  },
  privacy: {
    title: 'Kontrolle durch Erwachsene und Privatsphäre',
    items: [
      'Ein Erwachsener wird das Ergebnis vor der Veröffentlichung sehen und selbst entscheiden, ob er es teilt.',
      'Die Aufnahme und die persönliche Stimme werden nicht Teil eines gemeinsamen Katalogs werden.',
      'Wer einen Familienlink erhält, kann ihn weiterleiten: Das ist kein geschlossener Zugang.',
      'Der Zugang per Link wird sich in dem Umfang widerrufen lassen, den das Produkt vorsieht. Eine bereits heruntergeladene Datei lässt sich vom Gerät des Empfängers nicht entfernen.',
      'Die Seite ist für Suchmaschinen gesperrt. Das verringert die Sichtbarkeit in der Suche, ersetzt aber keinen Zugriffsschutz.',
    ],
  },
  launch: {
    title: 'Start',
    statusLabel: 'Status',
    status: 'In Kürze',
    availableTitle: 'Schon jetzt',
    available: [
      'Der Bereich Story‑Tales in der App mit einer Beschreibung des Formats.',
      'Ein Erzählerprofil: Aussehen (Foto oder Skizze) und Stimme.',
    ],
    availableNeutral: [
      'Eine Beschreibung des Formats und des geplanten Ablaufs — auf dieser Seite.',
    ],
    comingTitle: 'Kommt zum Start',
    coming: [
      'Der Märchen-Assistent: Geschichte wählen, Botschaft aufnehmen, Ergebnis prüfen.',
      'Ein Katalog von Geschichten mit angegebenen Ausgaben und Sprachen.',
      'Ein freigegebenes Beispiel des Geschenks auf dieser Seite.',
      'Preis und Fristen — vollständig, vor Arbeitsbeginn.',
    ],
    note: 'Auf dieser Seite wird derzeit nichts verkauft und nichts abgebucht.',
  },
  faq: {
    title: 'Fragen',
    items: [
      {
        question: 'Kann ich eine echte Aufnahme ohne Klonen verwenden?',
        answer:
          'Ja: Das erste Format wird mit einer echten Aufnahme der Einleitung beginnen, danach folgt ein illustriertes Märchen mit dem gewählten Erzähler. Ein Klonen der Stimme wird dafür nicht nötig sein.',
      },
      {
        question: 'Mit welcher Stimme wird das ganze Märchen gelesen und mit welcher die Einleitung?',
        answer:
          'Die Einleitung wird so klingen, wie der nahestehende Mensch sie aufgenommen hat. Das Märchen wird der gewählte Standard-Erzähler lesen. Das Vorlesen des ganzen Märchens mit einer Familienstimme kommt nur, wenn die Funktion gesondert bereit ist und der Inhaber der Stimme zugestimmt hat.',
      },
      {
        question: 'Kann ich ein Foto oder eine Skizze wählen?',
        answer:
          'Ja, im Assistenten wird man ein Foto oder eine Skizze für das Aussehen des Erzählers wählen können. Das ist reine Gestaltung: Damit wird keine Stimme geklont, und eine natürlich wirkende Animation ist nicht versprochen.',
      },
      {
        question: 'Was ist nötig, wenn ein anderer Erwachsener erzählt?',
        answer:
          'Seine eigene Zustimmung zur Aufnahme und zur Nutzung von Stimme und Bild. Die Regeln zur Zustimmung des Erzählers werden vor dem Start veröffentlicht; ohne Zustimmung darf eine fremde Aufnahme nicht verwendet werden.',
      },
      {
        question: 'Braucht das Kind ein Konto?',
        answer:
          'Nein. Ein Erwachsener wird das Geschenk vorbereiten, und die Familie wird das fertige Ergebnis erhalten. Das Kind wird weder ein Konto noch einen Chat mit KI brauchen.',
      },
      {
        question: 'Wer kann den Link öffnen, und lässt er sich widerrufen?',
        answer:
          'Jeder, der den Link hat, kann ihn öffnen — auch jemand, an den er weitergeleitet wurde. Der Zugang per Link wird sich in dem Umfang widerrufen lassen, den das Produkt vorsieht; bereits heruntergeladene Dateien bleiben beim Empfänger.',
      },
      {
        question: 'Welche Sprachen und Geschichten gibt es jetzt?',
        answer:
          'Noch keine: Der Katalog wird vorbereitet. Diese Seite gibt es auf Russisch, Ukrainisch, Englisch, Deutsch und Spanisch; die Sprachen der Geschichten selbst erscheinen im Katalog zusammen mit den Ausgaben.',
      },
      {
        question: 'Kann ich das Ergebnis vor der Veröffentlichung sehen?',
        answer:
          'Ja. Der Erwachsene prüft Aussehen, Vertonung und eine Vorschau des Ergebnisses und entscheidet gesondert, ob das Geschenk per Link veröffentlicht wird.',
      },
      {
        question: 'Was kostet es und wie lange dauert die Vorbereitung?',
        answer:
          'Der Preis kommt zum Start; derzeit wird nichts verkauft und nichts abgebucht. Die Vorbereitungszeit wird zusammen mit dem Preis angegeben, vor Arbeitsbeginn.',
      },
      {
        question: 'Was passiert mit der Originalaufnahme, und wie beantrage ich die Löschung?',
        answer:
          'Die Aufnahme wird in keinen gemeinsamen Katalog kommen und kein Material dieser Seite werden. Speicherung und Löschung für Story‑Tales werden vor dem Start beschrieben; derzeit gelten die allgemeinen Nutzungsbedingungen der Plattform — Link in der Fußzeile.',
      },
    ],
  },
  final: {
    title: 'Ein Geschenk, das man immer wieder abspielen kann',
    text: 'Während wir den Start vorbereiten, lässt sich in der App schon ein Erzählerprofil anlegen.',
    textNeutral: 'Während wir den Start vorbereiten, zeigt diese Seite, wie das Geschenk entstehen wird.',
  },
  footer: {
    navAriaLabel: 'Dokumente',
    platform: 'Die Plattform viral4creators',
    operatorLabel: 'Betreiber des Dienstes',
    operator: 'FOP Tarasenko Andrii Yevheniiovych (ФОП Тарасенко Андрій Євгенійович), Kyjiw.',
    contactLabel: 'Kontakt',
    contactBot: 'Telegram-Bot der Plattform',
    offer: 'Vertragsangebot',
    terms: 'Nutzungsbedingungen',
    privacy: 'Daten und Privatsphäre',
    termsAndPrivacy: 'Nutzungsbedingungen, Daten und Privatsphäre',
    narratorConsent: 'Regeln zur Zustimmung des Erzählers',
    consentNote:
      'Eigene Story‑Tales-Regeln für Erzähler und Familienmaterial werden vor dem Start veröffentlicht. Bis dahin gelten die allgemeinen Dokumente der Plattform.',
    legalNoticeOtherLocale: 'Die Dokumente sind derzeit nur auf Russisch verfügbar.',
  },
};
