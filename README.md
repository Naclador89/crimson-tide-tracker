# Crimson Tide Tracker

Zyklus-Tracker als installierbare Web-App. Alle Daten bleiben im `localStorage`
des Geräts — kein Konto, kein Server, keine Netzwerkaufrufe.

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

## Version und Cache

`<meta name="app-version">` in `index.html` ist der einzige Ort, an dem die
Version steht. Sie wandert als `?v=` an die Service-Worker-URL und bildet den
Cache-Namen. **Bei jeder Änderung an ausgelieferten Dateien hochzählen** —
sonst bekommen bestehende Installationen das Update nicht.

Neue Dateien, die die Seite lädt, gehören in `PRECACHE` in `sw.js`. Ein Test
prüft das.

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
Tastaturbedienung und das gerenderte DOM. `critical`, `medium` und `small`
entsprechen den Schweregraden eines Code-Reviews, `icons` prüft die Icons —
beim maskierbaren pixelweise, dass außerhalb der mittleren 80 % nur
Hintergrund liegt.

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
  als plausible Zykluslänge zählt. Mittelwert, Schwankung und Statistiktab
  bauen alle darauf auf.
- **Prognose**: Ab drei Abständen wird die Vorhersage als Spanne gezeigt
  (`calcCycleSpread`, Stichproben-Standardabweichung). Darunter bleibt es bei
  einem Tag — zwei Messwerte sagen über Schwankung nichts aus. Eine Spanne von
  ±7 Tagen sieht unbrauchbar aus, ist aber ehrlicher als ein exaktes Datum, das
  die Daten nicht hergeben.
- **Benachrichtigungen** erscheinen, wenn die App geöffnet oder in den
  Vordergrund geholt wird — nicht während sie geschlossen ist. Das ist eine
  Grenze von reinem Static-Hosting, kein Fehler: ein geschlossenes Gerät kann
  nur ein Push-Dienst aufwecken, und der verlangt einen dauerhaft laufenden
  Server samt Domain. Das widerspricht dem Kern dieser App, also gibt es das
  bewusst nicht. Timer im Service Worker sind übrigens auch kein Ersatz — er
  wird nach Sekunden Leerlauf beendet.
- **Theme**: Es gibt drei Einstellungen — Systemstandard, Hell, Dunkel. Sie
  steht unter dem eigenen `localStorage`-Schlüssel
  `crimson-tide-tracker-theme`, **nicht** in `state.settings`: sie beschreibt
  das Gerät, nicht die Zyklusdaten, und gehört deshalb nicht in den Export.
  Aufgelöst wird sie vom Bootstrap-Skript im `<head>` (`system` gegen
  `prefers-color-scheme`), das `data-theme="light|dark"` auf `<html>` setzt —
  das muss **vor** dem `<body>` passieren, sonst erscheint die Seite hell und
  springt einen Frame später um. Danach setzt nur noch `applyTheme()` dieses
  Attribut — Schlüssel, erlaubte Werte und Auflösungsregel stehen damit an
  zwei Stellen und müssen gleich bleiben; ein Test speichert eine Auswahl,
  lädt neu und prüft, dass das `<head>`-Skript sie übernimmt. Das CSS hängt am Attribut statt an der Media Query,
  denn eine Media Query lässt sich aus der UI nicht überstimmen. Und die
  Canvas-Diagramme backen ihre Farben beim Zeichnen ein — nach einem
  Themewechsel müssen sie neu gezeichnet werden (`repaintForTheme()`).
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
- **Berechtigungsdialoge** brauchen eine echte Nutzergeste, sonst lehnt iOS
  Safari sie ab.
