# Push-Relay

Optionaler Zusatzdienst. **Ohne ihn funktioniert die App vollständig** — die
Warnung erscheint dann, sobald du die App am oder nach dem Warntag öffnest.
Dieser Dienst ist nur nötig, wenn die Warnung dich auch bei *geschlossener* App
erreichen soll.

Warum überhaupt ein Server: Die App liegt auf GitHub Pages, und ein statischer
Host kann kein Gerät aufwecken. Das kann nur ein Push-Dienst des Browser-
Herstellers, und der nimmt Nachrichten nur von einem authentifizierten Absender
entgegen. Timer im Service Worker sind kein Ersatz — er wird nach Sekunden
Leerlauf beendet.

## Was dieser Server erfährt

Bewusst nur zwei Dinge:

| gespeichert | nicht gespeichert |
| --- | --- |
| Push-Endpunkt (welcher Push-Dienst, welches anonyme Gerät) | Zyklusdaten |
| **ein Zeitstempel** — wann er anstupsen soll | das Datum der Periode |
| | der Text der Nachricht |

Der Push selbst wird **ohne Inhalt** verschickt. Die Formulierung liegt im
Cache des Browsers und wird erst dort zusammengesetzt, wenn der leere Push
ankommt. Aus den gespeicherten Daten lässt sich ablesen, dass *irgendeine*
Erinnerung zum Zeitpunkt T ansteht — nicht, worum es geht.

Ein Test hält das fest: `test.js` prüft, dass ein Client, der zusätzliche
Felder mitschickt, sie nicht gespeichert bekommt, und dass der Push keinen
Payload trägt.

## Einrichten

```sh
npm install
npm run keys        # gibt ein VAPID-Schlüsselpaar aus
```

Die Ausgabe als Umgebungsvariablen setzen und starten:

```sh
VAPID_PUBLIC=B… \
VAPID_PRIVATE=… \
VAPID_SUBJECT=mailto:du@example.com \
ALLOWED_ORIGIN=https://crimson-tide-tracker.leiding.net \
npm start
```

Der Dienst braucht **HTTPS**, sonst verweigert der Browser die Verbindung von
der App aus. In der Praxis heißt das: hinter einen Reverse Proxy mit Zertifikat
(Caddy, nginx, Traefik) oder auf eine Plattform, die das mitbringt.

Anschließend in der App unter **Daten → Push bei geschlossener App** die
Adresse eintragen und aktivieren.

Der private Schlüssel bleibt auf dem Server. Geht er verloren, müssen sich alle
Geräte neu anmelden.

## Umgebungsvariablen

| Variable | Vorgabe | Bedeutung |
| --- | --- | --- |
| `VAPID_PUBLIC` | — | erforderlich, wird an Browser ausgeliefert |
| `VAPID_PRIVATE` | — | erforderlich, verlässt den Server nie |
| `VAPID_SUBJECT` | — | erforderlich, `mailto:` oder `https:` als Kontakt |
| `PORT` | `8080` | |
| `DATA_FILE` | `./subscriptions.json` | |
| `ALLOWED_ORIGIN` | `*` | in Produktion auf die Adresse der App setzen |
| `TICK_SECONDS` | `30` | wie oft auf fällige Erinnerungen geprüft wird |

## Endpunkte

| Route | Zweck |
| --- | --- |
| `GET /vapid` | öffentlicher Schlüssel, damit die App nichts fest verdrahten muss |
| `GET /health` | Statusprüfung, nennt die Zahl offener Erinnerungen |
| `POST /subscribe` | `{ subscription, fireAt }` — ersetzt eine bestehende Erinnerung desselben Geräts |
| `POST /unsubscribe` | `{ endpoint }` |

## Betrieb

Eine gefeuerte Erinnerung wird gelöscht; die App meldet die nächste an, sobald
sie wieder geöffnet wird. Antwortet der Push-Dienst mit 404 oder 410, ist das
Abonnement endgültig weg und wird entfernt; alle anderen Fehler werden beim
nächsten Durchlauf erneut versucht.

Speicherung ist eine JSON-Datei, geschrieben über eine temporäre Datei und
umbenannt — ein Absturz mitten im Schreiben kann sie nicht abschneiden.

## Tests

```sh
npm test
```

20 Tests gegen die Endpunkte, die Validierung, den Scheduler und die
Persistenz. Ein echter Push-Dienst wird nicht kontaktiert: `sendNotification`
ist gestubbt, damit der Scheduler deterministisch durchgespielt werden kann.
