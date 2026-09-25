# Crimson Tide Tracker

Zyklus-Tracker als installierbare Web-App. Alle Daten bleiben im `localStorage`
des Geräts — kein Konto, kein Server, keine Netzwerkaufrufe.

Die Oberfläche folgt standardmäßig dem Farbschema des Geräts; im Tab
„Optionen“ lässt sich stattdessen fest Hell oder Dunkel wählen.

Die App besteht ausschließlich aus statischen Dateien und läuft vollständig auf
GitHub Pages. Es gibt keinen Backend-Teil, und es soll auch keinen geben: was
einen dauerhaft laufenden Dienst bräuchte, gehört nicht in dieses Projekt.

Live: <https://crimson-tide-tracker.leiding.net>

## Aufbau

Die App wird statisch ausgeliefert (GitHub Pages), es gibt keinen Build-Schritt.

| Datei | Zweck |
| --- | --- |
| `index.html` | UI, Rendering, Canvas-Diagramme, Zustandsverwaltung |
| `cycle-core.js` | Reine Logik: Datumsrechnung, Mittelwerte, Phasenprojektion, Tagesklassifikation. Ohne DOM, ohne Storage — deshalb im Browser **und** in Node ladbar |
| `sw.js` | Service Worker: Offline-Cache und Update-Erkennung |
| `manifest.webmanifest` | PWA-Manifest |
| `tests/` | Unit- und Browsertests |

`cycle-core.js` muss **vor** dem Inline-Skript geladen werden; es veröffentlicht
seine Funktionen als Globals (so wie sie vorher inline definiert waren) und
zusätzlich unter `CycleCore`.

### Was im `localStorage` liegt

| Schlüssel | Inhalt |
| --- | --- |
| `crimson-tide-tracker` | `state`: Zyklen und Einstellungen. Das — und nur das — enthält der Export |
| `crimson-tide-tracker-theme` | `system`, `light` oder `dark`. Geräteeinstellung, bewusst außerhalb von `state` |
| `crimson-tide-tracker-hormones` | `open` oder `closed`: ob der (schematische) Hormonverlauf auf der Übersicht aufgeklappt ist. Geräteeinstellung wie das Theme |
| `crimson-tide-tracker-backup` | Kopie eines unlesbaren Payloads, angelegt von `load()`, wenn beschädigte Daten gefunden wurden |

## Version und Cache

`<meta name="app-version">` in `index.html` ist der einzige Ort, an dem die
Version steht. Sie wandert als `?v=` an die Service-Worker-URL und bildet den
Cache-Namen. **Bei jeder Änderung an ausgelieferten Dateien hochzählen** —
sonst bekommen bestehende Installationen das Update nicht.

Neue Dateien, die die Seite lädt, gehören in `PRECACHE` in `sw.js`. Ein Test
prüft das.

Angeboten wird das Update von `#update-banner` — einem eigenen Knopf, **nicht**
vom Toast. Der Toast ist eine flüchtige Live-Region mit `pointer-events:none`;
solange das Angebot in ihm steckte, ließ es sich nicht antippen. Entscheidend
ist dabei: ein wartender Worker übernimmt erst, wenn **jedes** Fenster der App
geschlossen ist oder er `SKIP_WAITING` bekommt. Neu laden oder die App in den
Vordergrund holen reicht nicht — auf einem Handy, das die PWA im Hintergrund
hält, ist der Knopf der einzige Weg zum Update. Deshalb bleibt das Angebot
stehen, bis es angenommen wird, und verschwindet von selbst, sobald nichts mehr
anzuwenden ist (`sync()` nach jedem Update-Check). K1c in `tests/e2e/critical.js`
fährt den ganzen Weg einmal durch: eigener Server, echter Versionssprung,
echter Klick.

## Tests

```sh
tests/run.sh          # alles
tests/run.sh unit     # nur Unit-Tests, braucht keinen Browser
tests/run.sh e2e      # nur Browsertests
```

**Unit** (`tests/core.test.js`, `node --test`) prüft `cycle-core.js` und läuft
**einmal pro Zeitzone**. Das ist keine Formalie: der Fehler, der jede Prognose
um einen Tag verschob, war in UTC unsichtbar und trat nur östlich davon auf —
eine CI mit Standardeinstellung hätte ihn durchgelassen.

**Browser** (`tests/e2e/*.js`, Playwright) deckt ab, was ein Unit-Test nicht
erreicht: Service-Worker-Registrierung, Offline-Betrieb, PWA-Manifest,
Benachrichtigungen, Wiederherstellung nach beschädigtem `localStorage`,
Tastaturbedienung, Theme-Auswahl, Farbkontrast und das gerenderte DOM.
`critical`, `medium` und `small` entsprechen den Schweregraden eines
Code-Reviews, `icons` prüft die Icons — beim maskierbaren pixelweise, dass
außerhalb der mittleren 80 % nur Hintergrund liegt.

Zwei Prüfungen darin arbeiten flächendeckend statt an Einzelfällen, weil die
Fehler, die sie fangen, auch flächendeckend auftraten: eine misst den Kontrast
**jedes** sichtbaren Textknotens in allen Tabs gegen seinen tatsächlichen
Hintergrund, die andere prüft, in welcher Parsephase das `data-theme`-Attribut
erscheint — vor dem `<body>` oder danach.

Voraussetzung für die Browsertests:

```sh
npm i -D playwright
```

Sie brauchen den **vollen** Chromium-Build, nicht die Headless-Shell — diese
unterstützt keine Benachrichtigungen, und mehrere Prüfungen hängen daran. Der
Code startet Chromium deshalb mit `channel: 'chromium'`. Ohne installiertes
Playwright überspringt der Runner diesen Teil mit Hinweis statt zu scheitern.

## Was beim Ändern leicht schiefgeht

- **Datumsrechnung**: Alles hier sind Kalendertage, keine Zeitpunkte. Niemals
  `toISOString()` auf ein aus lokalen Teilen gebautes Datum anwenden — das
  konvertiert nach UTC und verschiebt östlich von UTC den Kalendertag.
  `dateStr()` und `addDays()` in `cycle-core.js` sind die einzigen richtigen
  Wege.
- **Tagesklassifikation**: `classifyDay()` bzw. `makeDayClassifier()` sind die
  einzige Quelle dafür, welche Phase ein Tag hat. Kalender, Zeitstrahl und das
  Status-Badge greifen alle darauf zu. Keine zweite Implementierung danebenbauen.
- **Zykluslängen**: `cycleGaps()` ist die einzige Stelle, die entscheidet, was
  als plausible Zykluslänge zählt. Mittelwert, Schwankung, Prognose und
  Statistiktab bauen alle darauf auf. Verworfen werden Abstände außerhalb
  15–60 Tagen und — ab drei Abständen — solche, die etwa ein Vielfaches (≥ 2)
  des Medians sind: das ist fast immer eine nicht eingetragene Periode.
- **Prognose**: siehe unten. Kurz: nie ein exaktes Datum, immer eine
  80-%-Spanne; nie „14 Tage vor der Periode" als Eisprung-Tatsache; nie eine
  überfällige Periode stillschweigend durch die nächste ersetzen.
- **Benachrichtigungen** erscheinen, wenn die App geöffnet oder in den
  Vordergrund geholt wird — nicht während sie geschlossen ist. Das ist eine
  Grenze von reinem Static-Hosting, kein Fehler: ein geschlossenes Gerät kann
  nur ein Push-Dienst aufwecken, und der verlangt einen dauerhaft laufenden
  Server samt Domain. Das widerspricht dem Kern dieser App, also gibt es das
  bewusst nicht. Timer im Service Worker sind übrigens auch kein Ersatz — er
  wird nach Sekunden Leerlauf beendet, und `TimestampTrigger` ist über den
  Chrome-Origin-Trial nie hinausgekommen.

  Der Aus-Schalter hängt deshalb an `settings.notifyEnabled` und nicht an der
  Browser-Berechtigung: die lässt sich aus dem Skript nur erteilen, nie
  zurücknehmen, und ohne eigenes Flag gäbe es aus der App keinen Weg zurück.
  `checkDueNotification()` prüft es als Erstes und löscht dabei auch das Badge.
  Zwei getrennte Knöpfe und zwei getrennte Funktionen: in
  `requestNotificationPermission()` muss `Notification.requestPermission()` die
  erste Anweisung nach dem Klick bleiben, sonst verwirft iOS Safari die
  Nutzergeste — eine Verzweigung davor ist genau der Fehler, der später
  hineingebaut würde.
- **Theme**: Drei Einstellungen — Systemstandard, Hell, Dunkel. `system` ist
  kein drittes Farbschema, sondern das Fehlen einer Wahl: es löst gegen
  `prefers-color-scheme` auf und folgt einem Systemwechsel weiter zur Laufzeit,
  eine ausdrückliche Wahl nicht mehr. Alles Weitere hängt am Attribut
  `data-theme="light|dark"` auf `<html>`, nicht an einer Media Query — eine
  Media Query lässt sich aus der UI nicht überstimmen. Drei Dinge, die dabei
  leicht kaputtgehen:
  - Gesetzt wird das Attribut zuerst vom Bootstrap-Skript im `<head>`, und das
    muss **vor** dem `<body>` passieren: sonst erscheint die Seite hell und
    springt einen Frame später um. Deshalb steht es dort inline und nicht im
    Hauptskript am Seitenende.
  - Dieses Skript wiederholt notgedrungen, was `readThemePref()` und
    `applyTheme()` tun — oben im `<head>` existiert vom Hauptskript noch
    nichts. Schlüssel, erlaubte Werte und Auflösungsregel müssen an beiden
    Stellen gleich bleiben; ein Test speichert eine Auswahl, lädt neu und
    prüft, dass das `<head>`-Skript sie übernimmt.
  - Die Canvas-Diagramme backen ihre Farben beim Zeichnen ein. Nach einem
    Themewechsel müssen sie neu gezeichnet werden (`repaintForTheme()`), sonst
    bleibt das halbe Übersichts-Tab im alten Farbschema stehen.
- **Farben**: Jede Farbe steht als CSS-Variable in `:root` und wird im
  `:root[data-theme="dark"]`-Block überschrieben. Zwei Fallen: Eine
  eingefärbte Fläche muss **immer auch ihre Schriftfarbe setzen** — erbt sie
  `--text`, steht im Dark Mode Weiß auf Pastell. Und Inline-Styles (auch die
  aus dem JS erzeugten Badges und Pills) lassen sich von keiner Media Query
  überschreiben, also gehört dort `var(--…)` hinein statt eines Hex-Werts.
  Deshalb gibt es die Paare `--day-*-bg`/`--day-*-ink` (Kalenderzellen) und
  `--pill-*-bg`/`--pill-*-ink` (Pills und Badge). Die Chart-Palette `--ph-*`
  ist davon getrennt: sie landet per `getComputedStyle` auf dem Canvas, der
  kein `var()` auflösen kann. Ein Test fährt über jeden sichtbaren Textknoten
  und besteht auf 4.5:1 im Dark Mode.
- **Icons**: `icon-*.jpg` sind die normalen (`purpose: "any"`), die
  `icon-maskable-*.png` haben einen Sicherheitsrand und dürfen von Android
  beschnitten werden. Ein Icon darf nie beides gleichzeitig sein — wird ein
  randloses Motiv als `maskable` deklariert, schneidet der Launcher hinein.
  Ein Test prüft, dass außerhalb der mittleren 80 % nur Hintergrund liegt.
- **Navigation und Icons**: Es gibt genau **eine** Tab-Leiste (`.tabs`, fünf
  `.tab`). Am Handy (< 768 px) rückt sie per CSS als feste Leiste nach unten,
  darüber liegt nichts Zweites — Tastatur, ARIA und Tests hängen an diesem
  einen Element. Icons kommen aus dem SVG-Sprite am Anfang von `<body>`
  (`ico('name')` im Skript), nicht aus Emoji.
- **Übersicht**: Der Hauptknopf der Hero-Karte wechselt seine `data-action`
  zwischen `quick-start` und `quick-end`, je nachdem, ob gerade eine Periode
  läuft. Schnelleinträge, Bearbeiten und Löschen bieten danach „Rückgängig“ an
  (`offerUndo`) — deshalb fragt Löschen nicht mehr extra nach.
- **Berechtigungsdialoge** brauchen eine echte Nutzergeste, sonst lehnt iOS
  Safari sie ab.

## Prognosemodell

Alles in `cycle-core.js`; jede Zahl steht dort mit Quelle in einem Block
`REFERENCE VALUES`.

**Zykluslänge.** Normalmodell mit konjugiertem Prior (Normal /
skaliert-invers-χ²) über die letzten 12 Abstände (`cycleModel`). Der
Bevölkerungsmittelwert zählt wie ein eigener Zyklus, die Streuung startet bei
3 Tagen mit dem Gewicht von zwei Freiheitsgraden. Mit wenigen Daten ist die
Prognose deshalb vorsichtig, mit einem Dutzend Zyklen praktisch die eigene
Stichprobe. Die nächste Zykluslänge folgt dann einer Student-t-Verteilung; die
angezeigte Spanne ist deren 80-%-Prognoseintervall, inklusive der Unsicherheit
über den Mittelwert selbst (`√(1 + 1/κ)`). Für den k-ten Zyklus voraus wächst
die Varianz mit `k + k²/κ` — im Kalender werden solche Tage gestrichelt, sobald
die Spanne länger ist als die Periode.

**Überfällig.** Eine Periode, deren erwarteter Start vorbei ist, bleibt die
nächste Periode — die App zeigt „überfällig seit n Tagen" und ob das noch in
der Spanne liegt. Vorher sprang sie still einen Monat weiter. Der untere Rand
der Spanne liegt nie vor heute: hätte die Periode begonnen, wäre sie
eingetragen.

**Eisprung und fruchtbares Fenster.** Rückwärts von der nächsten Periode um
die Lutealphase gerechnet, 12,4 ± 2,5 Tage (Bull et al. 2019,
*npj Digital Medicine* 2:83, 612 613 Zyklen) — die Lutealphase ist der stabile
Teil des Zyklus. Das fruchtbare Fenster sind die sechs Tage bis einschließlich
Eisprung (Wilcox et al. 1995, *NEJM* 333:1517), verbreitert um die
Unsicherheit des Eisprungtags. Für eingetragene Zyklen ergibt das rund 12 Tage,
in der Größenordnung der Standard-Days-Methode (Tag 8–19). Mehr als einen
Zyklus voraus wird kein Fenster mehr eingezeichnet. **Das ist eine
Kalenderschätzung, keine Verhütungsmethode**, und die App sagt das auch.

**PMS / Hell Day.** PMS = fünf Tage vor der Periode (ACOG-Definition). Der
„Hell Day" eine Woche vorher ist eine Faustregel der App, keine klinische
Größe.

**Grenzen / Ausblick.** Aus reinen Kalenderdaten ist der Eisprung prinzipiell
nur auf einige Tage genau bestimmbar (Wilcox et al. 2000, *BMJ* 321:1259).
Deutlich besser würde es nur mit Messwerten: positive LH-Tests oder
Basaltemperatur würden die eigene Lutealphase messbar machen und das Fenster
stark verengen. Hormonelle Verhütung, Stillzeit oder Perimenopause machen die
Prognose bedeutungslos; das erkennt die App nicht.
