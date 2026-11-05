# Elli OCPP 2.0.1 – Erweiterung des vorhandenen Servers

Die bisherige `index.js` wurde beibehalten (CommonJS, Port **8887**, URL-Pfad `/<Ladepunkt-ID>`). Sie beantwortet jetzt auch Heartbeat, StatusNotification, NotifyEvent, SecurityEventNotification und TransactionEvent; `Authorize` prüft eine konfigurierbare RFID-Liste.

## Vollständiges OCPP-Logging

**Jede eingehende WebSocket-Nachricht wird vor dem Parsen/Verarbeiten gespeichert**, auch unbekannte OCPP-Aktionen, Antworten des Ladepunkts und ungültiges JSON. Ausgehende OCPP-Nachrichten werden ebenfalls gespeichert. **Bei jedem Serverstart entsteht eine neue Datei**, beispielsweise `logs/ocpp-2026-11-05T08-30-00-000Z-a1b2c3.jsonl`. Der eindeutige Dateiname verhindert, dass bestehende Logdateien überschrieben werden. Über `OCPP_LOG_DIR` kann ein anderer Ordner gewählt werden. Logs enthalten unter Umständen RFID-IDs, eMAIDs, ISO-15118-Zertifikatsinformationen oder personenbezogene Daten: privat aufbewahren und nur gezielt weitergeben. Die Dateien werden in dieser Testversion nicht automatisch rotiert oder gelöscht.

## ISO 15118-2 / PLC

Die Elli unterstützt laut Hersteller ISO 15118-2 über PLC. Das kann bei aktivem Plug & Charge zu einer `Authorize`-Nachricht mit eMAID und ggf. Zertifikatsinformationen führen. Die Wallbox muss diese Informationen aber tatsächlich über OCPP liefern; ein bloßer `Occupied`-Status enthält sie nicht. **Die bisherige Token-Allowlist ist kein Plug-&-Charge-Zertifikatsprüfer** und lehnt solche Tokens standardmäßig ab. Bitte zuerst einen Test mit aktiviertem PLC und vollständigem Log machen; Zertifikatsprüfung erst nach Sichtung implementieren.

## Start unter Windows (PowerShell)

```powershell
npm install
$env:ALLOWED_RFID="DEINE_RFID_UID"
$env:WALLBOX_ID="DEINE_OCPP_LADEPUNKT_ID"
node index.js
```

## Schreibgeschützte OCPP-Diagnose

Für den Diagnosetest den Server in PowerShell so starten:

```powershell
$env:ENABLE_DIAGNOSTICS="true"
node index.js
```

**Wichtig:** Die Wallbox muss danach neu mit dem Server verbinden und eine `BootNotification` senden. Nur dann startet die Diagnose automatisch. Der Server sendet `GetVariables` (Autorisierungseinstellungen) und `GetBaseReport` (`ConfigurationInventory`). Die Antworten und alle nachfolgenden `NotifyReport`-Nachrichten landen im vollständigen JSONL-Protokoll. `UnknownComponent`, `UnknownVariable`, `Rejected` oder `NotSupported` sind valide Diagnoseergebnisse. Es wird **kein** `RequestStartTransaction`, `SetVariables` oder Ladevorgang ausgelöst.

**Einfacher und unabhängig von `BootNotification`:** Sobald die Elli verbunden ist, `diag` im laufenden Node.js-Terminal eingeben und **Enter** drücken. Das funktioniert auch ohne `ENABLE_DIAGNOSTICS=true` und startet die beiden read-only-Anfragen unmittelbar. Das Terminal sollte `Starte OCPP-Diagnose` und `outbound`-Zeilen mit `GetVariables` und `GetBaseReport` anzeigen. Beim Verbindungsabbruch wird der Befehl abgewiesen.

Wenn die Elli bereits verbunden ist und keine neue BootNotification sendet, den Ladepunkt kontrolliert neu verbinden. Das Gerät muss nicht zwangsläufig neu gestartet werden.

## Einmaliger manueller Ladefreigabetest

**Nur im kontrollierten Test und bei eigener Wallbox verwenden.** In PowerShell:

```powershell
$env:ENABLE_TEST_START="true"
node index.js
```

1. Fahrzeug anschließen; `StatusNotification` mit `Occupied` abwarten.
2. Im laufenden Terminal `start` eingeben und Enter drücken.
3. Der Server sendet `RequestStartTransaction` für EVSE 1 mit einem zeitlich begrenzten Test-Token (`Central`). Er beantwortet dazugehörige `Authorize`-Anfragen und akzeptiert den Token in `TransactionEvent` für maximal fünf Minuten.
4. `RequestStartTransaction: Accepted` allein ist noch kein Ladebeginn: `TransactionEvent: Started` und den tatsächlichen Energiefluss prüfen.
5. Danach den Server beenden und `ENABLE_TEST_START` wieder deaktivieren (`Remove-Item Env:ENABLE_TEST_START`).

**WARNUNG:** Das Verfahren identifiziert den Cupra Born **nicht**. Es würde jedes an EVSE 1 angeschlossene Fahrzeug freigeben. Es kann trotz `Occupied` scheitern, wenn die Elli den Remote-Start nicht unterstützt oder weitere Autorisierungsbedingungen gelten. Die Offline-RFID-Freigabeliste bleibt unabhängig davon.

## Elli-Fahrzeugdaten und Ladebedürfnisse

Die beobachteten proprietären Elli-`DataTransfer`-Nachrichten `EVDetailsUpdate`, `ChargeParameterUpdate` und `PowerStatusUpdate` werden jetzt mit `status: Accepted` bestätigt. Unbekannte Nachrichten erhalten `UnknownMessageId` bzw. `UnknownVendorId`. `EVDetailsUpdate` enthält Marke, Modell und PCID (in der Konsole gekürzt, vollständig im lokalen Rohprotokoll). Die PCID wurde **erst nach einem Remote-Start** beobachtet und gilt ohne zusätzliche Prüfung nicht als fälschungssicherer Beweis der Fahrzeugidentität. Daraus erfolgt ausdrücklich **noch keine automatische Autorisierung**.

### Experimenteller Fahrzeugabfrage-Test

Wenn die Wallbox verbunden ist, kann im Terminal `vehicle` eingegeben werden. Der Server sendet dann nacheinander zwei **nicht dokumentierte, rein experimentelle** Elli-`DataTransfer`-Anfragen (`EVDetailsRequest` und `GetEVDetails`, jeweils `vendorId: de.elli`) und zeichnet sämtliche Antworten auf. **Es ist nicht bekannt, ob diese Nachrichtennamen von der Elli unterstützt werden.** `UnknownMessageId`, `Rejected` oder Time-outs sind mögliche und aussagekräftige Ergebnisse. Dieser Befehl startet keinen Ladevorgang und fragt **nicht** über einen offiziellen OCPP-Standardmechanismus eine FIN ab. Vor produktivem Einsatz ist zu prüfen, ob irgendeine erfolgreiche Antwort tatsächlich vor Autorisierung verfügbar ist.

`NotifyEVChargingNeeds` wird mit dem nach OCPP 2.0.1 erforderlichen `status: Accepted` bestätigt und die Ladeanforderung wird lesbar protokolliert. Die gemeldeten Werte für Energiebedarf, Strom, Spannung und Abfahrtszeit werden **nicht** als verbindlicher Ladeplan interpretiert. Insbesondere erzeugt der Server keine `SetChargingProfile`-Nachrichten und verändert keine Fahrzeug- oder Stromanbieter-Ladeplanung. Der Stromanbieter kann weiterhin die zeitliche Ladesteuerung im Auto übernehmen, soweit dessen Dienst durch den Backendwechsel nicht beeinträchtigt wird.

## ISO 15118 und Zertifikatsdiagnose

- `Get15118EVCertificate`: protokolliert die vollständige Anfrage; antwortet mit `Failed` und `NoProvisioningService`, weil noch kein Zertifikatsbereitstellungsdienst/EXI-Signer existiert.
- `GetCertificateStatus`: protokolliert die vollständige OCSP-Anfrage; antwortet mit `Failed` und `NoOCSPService`, weil keine geprüfte OCSP-Infrastruktur konfiguriert ist.
- `NotifyEVChargingSchedule`: nimmt fahrzeugseitige Ladepläne zur Beobachtung an (`status: Accepted`), ohne etwas zu ändern.
- `GetInstalledCertificateIds`: mit dem manuellen Terminalbefehl `certs` oder automatisch im Diagnosemodus (`diag`) abrufbar. Die Antwort wird vollständig protokolliert.
- `InstallCertificate`: **nur manuell** per Terminalbefehl `installcert`, wenn `CERT_PEM_FILE` auf eine gültige PEM-Datei zeigt. Optional `CERT_TYPE` (`V2GRootCertificate` voreingestellt). Dies ändert den Zertifikatsspeicher der Wallbox; nur mit einem tatsächlich vertrauenswürdigen, für diesen Zweck bestimmten Zertifikat ausführen. Ohne `CERT_PEM_FILE` findet kein Installationsversuch statt.

Diese Diagnosen enthalten unter Umständen Zertifikate, Hashes, eMAIDs oder sonstige sensible Identifikatoren. JSONL-Logs vertraulich behandeln. Die beiden Zertifikatsprüfungs-Antworten sind absichtlich **nicht** `Accepted`; ein späterer produktiver Plug-&-Charge-Betrieb erfordert eine echte Zertifikats- und Vertrauenskette.

## Manuelles Stoppen, Pausieren und Fortsetzen

Die Befehle sind standardmäßig **deaktiviert**. Vor einem kontrollierten Test in PowerShell setzen:

```powershell
$env:ENABLE_CHARGING_CONTROL="true"
node index.js
```

Nach einem `TransactionEvent` mit bekannter `transactionId` sind im laufenden Terminal drei Befehle möglich:

- `stop`: `RequestStopTransaction` mit der aktiven Transaktions-ID. Beendet den Ladevorgang; Wiederaufnahme erfordert eine neue Autorisierung/Transaktion.
- `pause`: `SetChargingProfile` mit einem eigenen `TxProfile` (Profil-ID `900001`) für die **aktuelle** Transaktion und einem Grenzwert von **0 A**. Der Ladevorgang soll dadurch unterbrochen werden, ohne die Transaktion zu beenden. **Herstellerunterstützung und tatsächliche Wirkung müssen getestet werden.**
- `resume`: `ClearChargingProfile` nur für unsere Profil-ID `900001`. Entfernt ausschließlich die von uns angeforderte 0-A-Begrenzung; der Zeitpunkt tatsächlicher Energieaufnahme bleibt vom Fahrzeug und dessen Stromanbietersteuerung abhängig.

Der Server setzt **keine** allgemeinen Ladepläne und verändert nicht die Fahrzeugplanung. Nach `stop` wird ein `TransactionEvent: Ended` erwartet. Bei `pause` ist `Accepted` allein noch kein Beweis für unterbrochenen Energiefluss; Messwerte und `chargingState` prüfen. Falls die Elli ein 0-A-Profil ablehnt, wird kein alternatives Verfahren wie `ChangeAvailability` automatisch versucht. **Nach einem Programmabbruch kann ein Pause-Profil noch auf der Wallbox aktiv sein**: bei Bedarf den Server wieder starten und `resume` eingeben, um genau die Profil-ID zu entfernen.

Ohne `ALLOWED_RFID` wird **jede** Autorisierung abgelehnt. Mehrere UIDs mit Kommas trennen. `WALLBOX_ID` ist zwingend zu setzen und muss exakt der Ladepunkt-ID im URL-Pfad entsprechen. Die private gerätespezifische ID ist absichtlich nicht im öffentlichen Repository gespeichert.

Optional **nach Tests**: `$env:ENABLE_LOCAL_LIST="true"` synchronisiert die komplette Liste per OCPP `SendLocalList` mit der Wallbox. Bestehende Einträge können überschrieben werden. Die Offline-Nutzung erfordert passende Firmware-/Autorisierungseinstellungen und einen RFID-Leser; sie ist noch nicht bestätigt.

## Hinweise

- Dies ist ein lokaler Testserver mit **unverschlüsseltem WS**. Nur im vertrauenswürdigen, abgeschotteten Netz verwenden; für andere Netze TLS/WSS über einen vertrauenswürdigen Reverse-Proxy bereitstellen.
- Der optionale WS_PASSWORD prüft ein Basic-Auth-Header mit Benutzername gleich Ladepunkt-ID; die Elli-Unterstützung dafür ist ungeprüft.
- `Occupied` bedeutet nur Ladeanschluss belegt, keine verlässliche Fahrzeugidentität. Der Server startet bewusst nicht automatisch irgendein Fahrzeug.
- Nach Umstellung des OCPP-Backends können Elli- und Octopus-Energy-Smart-Charging-Funktionen entfallen.
- Die Fehlercodes `0X40100e`/`0X402005` sind nicht allein anhand der Logs eindeutig zuzuordnen. Der zusätzliche OCPP-Antwortumfang kann Protokoll-Time-outs vermeiden, beweist aber noch keine Fehlerbehebung.
