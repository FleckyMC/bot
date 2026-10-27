# Mining Bots – Dashboard

Bot-Netzwerk für Minecraft **1.21.11** (Mineflayer) mit Web-Dashboard.
Die Bots bauen einen Bereich zwischen zwei Eckpunkten ab, reparieren ihre Spitzhacke mit XP-Flaschen und
können vom Dashboard aus gestartet, gestoppt und per Chat/Befehl gesteuert werden.

## Was die Bots machen

- **Bereich abbauen:** Du gibst Pos 1 und Pos 2 an. Der Bereich wird in gleich breite Streifen geteilt, jeder Bot bekommt einen
  Streifen und baut von oben nach unten Schicht für Schicht ab. Außerhalb des Bereichs wird **nichts** abgebaut
  (außer du aktivierst „Tunnel graben“).
- **Reparatur:** Fällt die Haltbarkeit der Spitzhacke **unter 300** (einstellbar), holt der Bot XP-Flaschen
  (`experience_bottle`) aus dem Inventar, legt sie in die **Nebenhand** (egal ob sie in der Hotbar oder tief im Inventar liegen),
  schaut nach unten und wirft sie, bis die Spitzhacke wieder voll ist. Danach baut er weiter ab.
  **Die Spitzhacke braucht Mending**, sonst repariert die XP nichts (der Bot bricht dann nach 8 Würfen mit einer Meldung ab).
- **Start / Stop:** Stop lässt alle Bots sofort aufhören und stehen. Start beginnt wieder (bereits abgebaute Blöcke werden übersprungen).
- **Verbinden:** Server-IP eingeben (optional `:Port`), Namen eintragen, „Verbinden“. Danach kannst du im Dashboard
  Chat-Nachrichten und `/Befehle` an alle oder einen einzelnen Bot schicken.
- **Kiste (optional):** Ist das Inventar fast voll, bringen die Bots ihre Beute zu einer Kiste. Fehlen XP-Flaschen, holen sie neue aus derselben Kiste.
- **Weiteres:** Automatisches Wiederverbinden, Blöcke neben Wasser/Lava werden ausgelassen (abschaltbar), Drops werden eingesammelt.

## Installation auf dem VPS (Ubuntu/Debian)

```bash
# 1. Node.js 20 oder neuer
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs unzip

# 2. Projekt entpacken und Pakete installieren
unzip mining-bots.zip -d mining-bots && cd mining-bots
npm install

# 3. Starten
npm start
```

Beim ersten Start wird ein **Passwort erzeugt** und in der Konsole angezeigt (gespeichert in `.env`, dort änderbar).
Danach ist das Dashboard unter `http://<VPS-IP>:3000` erreichbar. Dort mit dem Benutzer `admin` und dem Passwort anmelden.

### Dauerbetrieb mit pm2

```bash
sudo npm install -g pm2
pm2 start src/index.js --name mining-bots
pm2 save && pm2 startup     # startet nach einem Neustart automatisch
pm2 logs mining-bots        # Log ansehen
```

### Sicherheit (wichtig)

Das Dashboard steuert Accounts, die sich auf einem Server einloggen. Es ist durch Login geschützt, aber über
`http://` wird das Passwort **unverschlüsselt** übertragen. Empfohlen:

- **HTTPS mit Domain (Caddy):** In der `Caddyfile`: `deine-domain.de { reverse_proxy 127.0.0.1:3000 }`,
  in `.env` `HOST=127.0.0.1` und `COOKIE_SECURE=true` setzen. Port 3000 in der Firewall nicht öffnen, nur 80 und 443.
- **Oder ohne Domain:** `HOST=127.0.0.1` setzen und per SSH-Tunnel zugreifen:
  `ssh -L 3000:127.0.0.1:3000 user@vps-ip`, dann `http://localhost:3000` im Browser öffnen.
- Mindestens ein **langes Passwort** in `.env` (`DASHBOARD_PASSWORD`).

## Bedienung

1. **Server & Bots:** IP eintragen, Anmeldung wählen, Namen eintragen (eine pro Zeile, oder „Füllen“ drücken), **Verbinden**.
   - *Offline-Modus:* nur auf Servern mit `online-mode=false`, beliebige Namen.
   - *Microsoft:* eine E-Mail pro Zeile, pro Account erscheint ein **Code** im Dashboard. Seite öffnen, Code eingeben,
     mit dem passenden Microsoft-Konto anmelden. Das wird gespeichert (Ordner `data/profiles`), nächstes Mal ist das nicht mehr nötig.
     **Passwörter gibst du nirgends ein.**
2. **Abbau-Bereich:** zwei Ecken eintragen, **Bereich speichern**.
3. **Ausrüstung:** Jeder Bot braucht eine **Spitzhacke mit Mending** und **XP-Flaschen** im Inventar. Das legst du den Bots ins Inventar
   (z. B. per Kiste, `/give` oder fallen lassen). Alternativ Kiste in den Einstellungen setzen, dann holen sie sich Flaschen von dort.
4. **Start**. Zum Anhalten **Stop**.

## Einstellungen

| Einstellung | Bedeutung |
|---|---|
| Reparieren unter | Haltbarkeit, ab der repariert wird (Standard 300). Bei kleinen Spitzhacken (Holz, Gold) maximal die Hälfte ihrer Haltbarkeit. |
| Pause pro Flasche | Wartezeit zwischen zwei Würfen in ms (Standard 600). |
| Freie Slots mind. | Darunter gehen die Bots zur Kiste (Standard 2). Ohne Kiste halten sie dann an. |
| Kiste | Koordinaten einer Kiste/Tonne für Beute und XP-Flaschen. Leer lassen = keine Kiste. |
| Wasser/Lava auslassen | Überspringt Blöcke neben Flüssigkeiten, damit nichts überflutet. |
| Tunnel graben | Erlaubt Abbau außerhalb des Bereichs, falls er unter einer Schicht liegt und sonst nicht erreichbar ist. |

## Wichtige Hinweise

- **Nur mit Erlaubnis des Server-Betreibers** verwenden. Viele Server verbieten Bots und Automation.
- Die Bots laufen als reine Programme ohne Minecraft-Fenster. Pro Bot rechne mit etwa 50–100 MB RAM.
- Neue Serverversionen: Setze `MC_VERSION` in `.env`, wenn der Server eine andere Version hat. Mineflayer unterstützt 1.21.11.
- Viele Server begrenzen schnelle Logins; die Bots verbinden sich deshalb gestaffelt (5 s Abstand im Offline-Modus).
- Die Bots essen nicht. Bei langen Läufen am besten Essen bereitstellen oder den Server auf Peaceful/ohne Hunger halten.
- Wegfindung kann an komplizierten Stellen hängen bleiben; dann überspringt der Bot den Block nach zwei Versuchen.
- Erreicht ein Bot einen Block nicht (z. B. Bereich unter einer Erdschicht), meldet er das statt still zu stehen.

## Dateien

```
src/index.js        Webserver, Login, Socket
src/botManager.js   Verwaltung aller Bots, Start/Stop, Einstellungen
src/botWorker.js    Ein Bot: Abbau, Reparatur, Kiste, Wiederverbinden
src/planner.js      Bereich prüfen und auf Bots verteilen
src/auth.js         Sessions und Login-Schutz
public/             Dashboard (HTML, CSS, JS)
data/config.json    gespeicherte Einstellungen (wird automatisch angelegt)
.env                Passwort, Port, Version
```

## Test

`npm test` prüft die Bereichsaufteilung.
