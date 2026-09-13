# Crimson Tide Tracker

Zyklus-Tracker als installierbare Web-App. Alle Daten bleiben im `localStorage`
des Geräts — kein Konto, kein Server, keine Netzwerkaufrufe.

Live: <https://crimson-tide-tracker.leiding.net>

## Aufbau

Die App wird statisch ausgeliefert (GitHub Pages), es gibt keinen Build-Schritt.

| Datei | Zweck |
| --- | --- |
| `index.html` | UI, Rendering, Canvas-Diagramme, Zustandsverwaltung |
| `cycle-core.js` | Reine Logik: Datumsrechnung, Mittelwerte, Phasenprojektion, Tagesklassifikation. Ohne DOM, ohne Storage — deshalb im Browser **und** in Node ladbar |
| `sw.js` | Service Worker: Offline-Cache und Update-Erkennung |
| `manifest.webmanifest` | PWA-Manifest |
| `push-server/` | Optionaler Dienst für Benachrichtigungen bei geschlossener App, samt Dockerfile, Compose-Stack und systemd-Unit. Die App funktioniert ohne ihn |
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
cd push-server && npm test    # der optionale Dienst (Unit + Integration)
```

**Unit** (`tests/core.test.js`, `node --test`) prüft `cycle-core.js` und läuft
**einmal pro Zeitzone**. Das ist keine Formalie: der Fehler, der jede Prognose
um einen Tag verschob, war in UTC unsichtbar und trat nur östlich davon auf —
eine CI mit Standardeinstellung hätte ihn durchgelassen.

**Browser** (`tests/e2e/*.js`, Playwright) deckt ab, was ein Unit-Test nicht
erreicht: Service-Worker-Registrierung, Offline-Betrieb, PWA-Manifest,
Benachrichtigungen, Wiederherstellung nach beschädigtem `localStorage`,
Tastaturbedienung und das gerenderte DOM. `critical`, `medium` und `small`
entsprechen den Schweregraden eines Code-Reviews, `push` deckt das maskierbare
Icon und den Push-Weg ab — inklusive einer echten Push-Zustellung über das
Chrome DevTools Protocol. Nur der Handshake mit dem Push-Dienst selbst ist
gestubbt: der braucht einen erreichbaren Dienst, und Chrome schaltet die Push
API in Inkognito-Kontexten ohnehin ab.

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
- **Benachrichtigungen** kommen standardmäßig nur an, während die App offen ist
  oder geöffnet wird. Timer im Service Worker sind kein Ersatz — er wird nach
  Sekunden Leerlauf beendet. Für Zustellung bei geschlossener App gibt es
  `push-server/`; das ist opt-in und schickt nur einen Zeitstempel dorthin,
  nie Zyklusdaten.
- **Icons**: `icon-*.jpg` sind die normalen (`purpose: "any"`), die
  `icon-maskable-*.png` haben einen Sicherheitsrand und dürfen von Android
  beschnitten werden. Ein Icon darf nie beides gleichzeitig sein — wird ein
  randloses Motiv als `maskable` deklariert, schneidet der Launcher hinein.
  Ein Test prüft, dass außerhalb der mittleren 80 % nur Hintergrund liegt.
- **Berechtigungsdialoge** brauchen eine echte Nutzergeste, sonst lehnt iOS
  Safari sie ab.
