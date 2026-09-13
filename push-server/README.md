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

## Betreiben

Der Dienst braucht **HTTPS** — der Browser verweigert die Verbindung zu einem
Relay ohne Zertifikat. Deshalb bringt der empfohlene Weg gleich einen Proxy mit,
der sich selbst um das Zertifikat kümmert.

### Docker Compose (empfohlen)

Voraussetzung: eine Domain, deren A-/AAAA-Eintrag auf den Host zeigt, und
offene Ports 80 und 443.

```sh
cp .env.example .env
npm install && npm run keys      # Ausgabe in .env eintragen
echo 'PUSH_DOMAIN=push.example.net' >> .env
docker compose up -d
```

Caddy holt und erneuert das Zertifikat selbstständig. Prüfen:

```sh
curl https://push.example.net/health     # {"ok":true,"scheduled":0}
```

Die Abos liegen im Volume `relay-data` und überleben ein
`docker compose down`. Die Zertifikate liegen in `caddy-data` — dieses Volume
nicht löschen, sonst werden bei jedem Start neue angefordert (es gibt
Ratenlimits).

### Ohne Docker, mit systemd

`crimson-tide-push.service` liegt bei; die Einrichtungsschritte stehen als
Kommentar darin. Ein Reverse Proxy mit TLS wird weiterhin gebraucht.

### Auf einer PaaS

Der Dienst ist ein gewöhnlicher Node-Prozess, der auf `$PORT` hört, und bringt
ein Dockerfile mit — Fly.io, Render, Railway und ähnliche nehmen ihn ohne
Änderung. Zwei Dinge dabei beachten:

- **Persistentes Volume auf `/data`.** Ohne das gehen bei jedem Deploy alle
  geplanten Erinnerungen verloren. Die App meldet sie beim nächsten Öffnen
  zwar neu an — bis dahin fällt die Warnung aber aus.
- **Kein Scale-to-Zero.** Ein schlafender Dienst tickt nicht und verschickt
  folglich nichts.

### Danach

In der App unter **Daten → Push bei geschlossener App** die Adresse eintragen
und aktivieren.

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
| `ALLOWED_ORIGIN` | `*` | in Produktion auf die Adresse der App setzen; beim Start wird gewarnt, solange `*` steht |
| `TICK_SECONDS` | `30` | wie oft auf fällige Erinnerungen geprüft wird |
| `MAX_ENTRIES` | `10000` | Obergrenze für gespeicherte Erinnerungen. Ist sie erreicht, werden neue Geräte mit 507 abgewiesen — bereits bekannte können weiterhin umplanen |
| `RATE_PER_MIN` | `20` | POST-Anfragen pro Minute und Client. Darüber 429 mit `Retry-After` |
| `TRUST_PROXY` | aus | `1` setzen, wenn ein Reverse Proxy davorsteht. Sonst ist `X-Forwarded-For` nur ein frei wählbarer Text und das Rate-Limit wirkungslos |

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

Protokolliert werden Methode, Pfad, Status und Dauer — **bewusst ohne IP und
ohne Push-Endpunkt**. Beides zu loggen würde genau die Daten wieder einsammeln,
die dieser Dienst nicht speichert.

## Tests

```sh
npm test                 # beides
npm run test:unit        # schnell, ohne Kindprozesse
npm run test:integration # startet den echten Server
```

**24 Unit-Tests** gegen Endpunkte, Validierung, Scheduler, Missbrauchsschutz
und Persistenz. `sendNotification` ist gestubbt, damit der Scheduler
deterministisch durchgespielt werden kann.

**12 Integrationstests** starten `server.js` als echten Kindprozess mit echten
VAPID-Schlüsseln und echter Datei — inklusive Neustart mitten im Ablauf. Der
Push geht an einen HTTPS-Ersatzdienst statt an FCM, das Relay baut die Anfrage
aber vollständig selbst: geprüft wird, dass sie VAPID-signiert ist, den
korrekten TTL trägt und **einen leeren Body** hat.

Nicht abgedeckt bleibt der Push-Dienst selbst — dafür bräuchte es das offene
Internet.
