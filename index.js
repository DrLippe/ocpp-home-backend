// Standalone OCPP 2.0.1 backend for Elli Charger 2 Connect (CommonJS, Node >= 20)
const WebSocket = require('ws');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 8887);
const ALLOWED_RFID = new Set((process.env.ALLOWED_RFID || '').split(',').map(s => s.trim()).filter(Boolean));
const WALLBOX_ID = process.env.WALLBOX_ID || '';
if (!WALLBOX_ID) {
    console.error('WALLBOX_ID fehlt. Bitte die Ladepunkt-ID als Umgebungsvariable setzen.');
    process.exit(1);
}
const ENABLE_LOCAL_LIST = process.env.ENABLE_LOCAL_LIST === 'true';
const ENABLE_DIAGNOSTICS = process.env.ENABLE_DIAGNOSTICS === 'true';
const ENABLE_TEST_START = process.env.ENABLE_TEST_START === 'true';
const ENABLE_CHARGING_CONTROL = process.env.ENABLE_CHARGING_CONTROL === 'true';
const TEST_TOKEN = 'local-ocpp-test';
const PAUSE_PROFILE_ID = 900001;
const CERT_PEM_FILE = process.env.CERT_PEM_FILE || '';
const CERT_TYPE = process.env.CERT_TYPE || 'V2GRootCertificate';
const WS_PASSWORD = process.env.WS_PASSWORD || '';
const LOG_DIR = process.env.OCPP_LOG_DIR || path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const runId = require('node:crypto').randomBytes(3).toString('hex');
const logfile = path.join(LOG_DIR, `ocpp-${runStamp}-${runId}.jsonl`);
// Exclusive create: never append to or overwrite a log from another run.
const logstream = fs.createWriteStream(logfile, { flags: 'wx', mode: 0o600 });
logstream.on('error', err => console.error('❌ Logdatei nicht beschreibbar:', err.message));
function logFrame(direction, frame, extra = {}) {
    // Logs the complete original wire content, including unknown/unparseable frames.
    const record = { timestamp: new Date().toISOString(), direction, ...extra, raw: frame };
    logstream.write(JSON.stringify(record) + '\n');
    console.log(`[${record.timestamp}] ${direction}: ${frame}`);
}
const wss = new WebSocket.Server({ port: PORT, maxPayload: 1024 * 1024 });
let connectedDiagnostics = null;
let connectedTestStart = null;
let connectedCertificateCheck = null;
let connectedCertificateInstall = null;
let connectedControls = null;
let connectedVehicleProbe = null;

console.log(`🚀 Lokaler OCPP-Server läuft auf ws://localhost:${PORT}`);
console.log(`📝 Vollständiges OCPP-Protokoll: ${logfile}`);
console.warn('⚠️ Rohprotokolle können RFID-Kennungen, Zertifikate und andere sensible Daten enthalten.');
if (!ALLOWED_RFID.size) console.warn('🔒 Keine RFID-Tokens hinterlegt: Alle Authorize-Anfragen werden abgelehnt.');
console.log('🔎 Diagnose jederzeit starten: diag eingeben und Enter drücken.');
console.log(`⚡ Manueller Teststart: ${ENABLE_TEST_START ? 'start eingeben und Enter drücken' : 'deaktiviert (ENABLE_TEST_START=true)'}`);
console.log('🔏 Zertifikatsübersicht: certs; optionale Installation: installcert (nur mit CERT_PEM_FILE).');
console.log(`⏯️ Laden: ${ENABLE_CHARGING_CONTROL ? 'pause / resume / stop verfügbar' : 'deaktiviert (ENABLE_CHARGING_CONTROL=true)'}`);
console.log('🚗 Experimentelle Elli-Fahrzeugabfrage: vehicle');
process.stdin.setEncoding('utf8');
process.stdin.on('data', input => {
    for (const command of input.split(/\r?\n/).map(x => x.trim().toLowerCase())) {
        if (command === 'diag') {
            if (!connectedDiagnostics) console.warn('⚠️ Keine Wallbox verbunden; Diagnose nicht möglich.');
            else void connectedDiagnostics();
        }
        if (command === 'start') {
            if (!ENABLE_TEST_START) console.warn('🔒 Teststart ist deaktiviert.');
            else if (!connectedTestStart) console.warn('⚠️ Keine Wallbox verbunden.');
            else void connectedTestStart();
        }
        if (command === 'certs') {
            if (!connectedCertificateCheck) console.warn('⚠️ Keine Wallbox verbunden.');
            else void connectedCertificateCheck();
        }
        if (command === 'installcert') {
            if (!connectedCertificateInstall) console.warn('⚠️ Keine Wallbox verbunden.');
            else void connectedCertificateInstall();
        }
        if (['pause', 'resume', 'stop'].includes(command)) {
            if (!ENABLE_CHARGING_CONTROL) console.warn('🔒 Ladesteuerung deaktiviert.');
            else if (!connectedControls) console.warn('⚠️ Keine Wallbox verbunden.');
            else void connectedControls(command);
        }
        if (command === 'vehicle') {
            if (!connectedVehicleProbe) console.warn('⚠️ Keine Wallbox verbunden.');
            else void connectedVehicleProbe();
        }
    }
});

wss.on('connection', (ws, req) => {
    logFrame('connection', JSON.stringify({ url: req.url, remoteAddress: req.socket.remoteAddress }));
    const id = decodeURIComponent((req.url || '').split('?')[0].replace(/^\//, ''));
    if (id !== WALLBOX_ID) {
        console.warn('Unbekannte Ladepunkt-ID, Verbindung abgewiesen');
        ws.close(1008, 'Unknown charger ID');
        return;
    }
    if (WS_PASSWORD) {
        const auth = req.headers.authorization || '';
        const expected = 'Basic ' + Buffer.from(`${WALLBOX_ID}:${WS_PASSWORD}`).toString('base64');
        if (auth !== expected) { ws.close(1008, 'Authentication required'); return; }
    }

    console.log(`🔌 Neue Verbindung von IP: ${req.socket.remoteAddress}`);
    console.log(`🔗 Aufgerufene URL: ${req.url}`);
    const pending = new Map();
    let listAttempted = false;
    let listVersion = 0;
    let transactionActive = false;
    let activeTransactionId = null;
    let connectorStatus = null;
    let controlBusy = false;
    let pausedByServer = false;
    let vehicleProbeRunning = false;
    let vehicleDetails = null;
    let chargingNeeds = null;
    let testTokenValidUntil = 0;
    let testStartRunning = false;
    let diagnosticsRunning = false;

    function sendFrame(frame) { const raw = JSON.stringify(frame); logFrame('outbound', raw); ws.send(raw); }
    function reply(messageId, result = {}) { sendFrame([3, messageId, result]); }
    function error(messageId, code, description) { sendFrame([4, messageId, code, description, {}]); }
    function call(action, body) {
        if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Disconnected'));
        const uuid = require('node:crypto').randomUUID();
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => { pending.delete(uuid); reject(new Error(`${action} timeout`)); }, 12000);
            pending.set(uuid, { resolve, reject, timeout });
            sendFrame([2, uuid, action, body]);
        });
    }
    async function installLocalList() {
        if (!ENABLE_LOCAL_LIST || listAttempted || !ALLOWED_RFID.size) return;
        listAttempted = true;
        try {
            const version = await call('GetLocalListVersion', {});
            if (!Number.isInteger(version.versionNumber) || version.versionNumber < 0) throw new Error('Local list unsupported');
            listVersion = version.versionNumber + 1;
            const result = await call('SendLocalList', {
                versionNumber: listVersion, updateType: 'Full',
                localAuthorizationList: [...ALLOWED_RFID].map(idToken => ({
                    idToken: { idToken, type: 'ISO14443' },
                    idTokenInfo: { status: 'Accepted' }
                }))
            });
            console.log('📋 SendLocalList:', result.status);
        } catch (e) { console.warn('⚠️ Offline-RFID-Liste konnte nicht übertragen werden:', e.message); }
    }
    async function runDiagnostics() {
        if (ws.readyState !== WebSocket.OPEN) { console.warn('⚠️ Keine aktive OCPP-Verbindung.'); return; }
        if (diagnosticsRunning) { console.warn('⚠️ Diagnose läuft bereits.'); return; }
        diagnosticsRunning = true;
        console.log('🔎 Starte OCPP-Diagnose: GetVariables und GetBaseReport');
        // Read-only OCPP 2.0.1 diagnostics. No remote start or configuration changes.
        const variables = [
            ['AuthCtrlr', 'AuthEnabled'],
            ['AuthCtrlr', 'LocalPreAuthorize'],
            ['AuthCtrlr', 'LocalAuthorizeOffline'],
            ['AuthCtrlr', 'AuthorizeRemoteStart'],
            ['AuthCtrlr', 'AuthorizationCacheEnabled'],
            ['AuthCtrlr', 'OfflineTxForUnknownIdEnabled'],
            ['AuthCtrlr', 'EVConnectionTimeOut'],
            ['ISO15118Ctrlr', 'Enabled']
        ];
        try {
            const result = await call('GetVariables', {
                getVariableData: variables.map(([component, variable]) => ({
                    component: { name: component }, variable: { name: variable }, attributeType: 'Actual'
                }))
            });
            console.log('🔍 GetVariables:', JSON.stringify(result, null, 2));
        } catch (e) { console.warn('⚠️ GetVariables fehlgeschlagen:', e.message); }

        try {
            const result = await call('GetBaseReport', {
                requestId: Math.floor(Math.random() * 2147483646) + 1,
                reportBase: 'ConfigurationInventory'
            });
            console.log('📋 GetBaseReport:', JSON.stringify(result, null, 2));
            if (result.status === 'Accepted') console.log('📋 Weitere Inventardaten folgen asynchron per NotifyReport.');
        } catch (e) { console.warn('⚠️ GetBaseReport fehlgeschlagen:', e.message); }
        await inspectInstalledCertificates();
        diagnosticsRunning = false;
    }
    async function inspectInstalledCertificates() {
        try {
            const result = await call('GetInstalledCertificateIds', {});
            console.log('🔏 GetInstalledCertificateIds:', JSON.stringify(result, null, 2));
        } catch (e) { console.warn('⚠️ Zertifikatsübersicht fehlgeschlagen:', e.message); }
    }
    async function installCertificate() {
        if (!CERT_PEM_FILE) return console.warn('🔒 CERT_PEM_FILE nicht gesetzt; keine Installation.');
        const allowedTypes = ['V2GRootCertificate', 'MORootCertificate', 'CSMSRootCertificate', 'ManufacturerRootCertificate'];
        if (!allowedTypes.includes(CERT_TYPE)) return console.warn('⚠️ Unzulässiger CERT_TYPE');
        let certificate;
        try {
            certificate = fs.readFileSync(CERT_PEM_FILE, 'utf8');
            if (!/-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----/.test(certificate))
                throw new Error('Datei enthält kein PEM-Zertifikat');
        } catch (e) { return console.warn('⚠️ Zertifikat kann nicht gelesen werden:', e.message); }
        console.warn(`⚠️ Sende InstallCertificate (${CERT_TYPE}) an Elli. Dies verändert den Zertifikatsspeicher!`);
        try { console.log('🔏 InstallCertificate:', JSON.stringify(await call('InstallCertificate', { certificateType: CERT_TYPE, certificate }))); }
        catch (e) { console.warn('⚠️ InstallCertificate fehlgeschlagen:', e.message); }
    }
    async function controlCharging(action) {
        if (!ENABLE_CHARGING_CONTROL || ws.readyState !== WebSocket.OPEN) return;
        if (controlBusy) return console.warn('⚠️ Ein Steuerbefehl läuft bereits.');
        // Resume may clear a previously installed profile even after server restart.
        if (action !== 'resume' && (!transactionActive || !activeTransactionId))
            return console.warn('⚠️ Keine aktive OCPP-Transaktion bekannt.');
        controlBusy = true;
        try {
            let result;
            if (action === 'stop') {
                result = await call('RequestStopTransaction', { transactionId: activeTransactionId });
                console.log('⏹️ RequestStopTransaction:', JSON.stringify(result));
                if (result?.status === 'Accepted') console.log('ℹ️ Auf TransactionEvent Ended warten.');
            } else if (action === 'pause') {
                if (pausedByServer) return console.log('⏸️ Lokales Pause-Profil wurde bereits angefordert.');
                const now = new Date().toISOString();
                result = await call('SetChargingProfile', {
                    evseId: 1,
                    chargingProfile: {
                        id: PAUSE_PROFILE_ID,
                        stackLevel: 10,
                        chargingProfilePurpose: 'TxProfile',
                        chargingProfileKind: 'Absolute',
                        transactionId: activeTransactionId,
                        chargingSchedule: [{
                            id: PAUSE_PROFILE_ID,
                            startSchedule: now,
                            chargingRateUnit: 'A',
                            chargingSchedulePeriod: [{ startPeriod: 0, limit: 0 }]
                        }]
                    }
                });
                pausedByServer = result?.status === 'Accepted';
                console.log('⏸️ SetChargingProfile (0 A):', JSON.stringify(result));
            } else if (action === 'resume') {
                result = await call('ClearChargingProfile', { chargingProfileId: PAUSE_PROFILE_ID });
                if (result?.status === 'Accepted') pausedByServer = false;
                console.log('▶️ ClearChargingProfile:', JSON.stringify(result));
                console.log('ℹ️ Entfernt nur unser Pause-Profil; Fahrzeug/Stromanbieter entscheiden weiterhin über den tatsächlichen Ladestart.');
            }
        } catch (e) { console.warn(`⚠️ ${action} fehlgeschlagen:`, e.message); }
        finally { controlBusy = false; }
    }
    async function probeVehicleDetails() {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (vehicleProbeRunning) return console.warn('⚠️ Fahrzeugabfrage läuft bereits.');
        vehicleProbeRunning = true;
        console.log('🚗 Experimentelle Fahrzeugabfrage: keine OCPP-standardisierte FIN-Abfrage verfügbar.');
        // These are read-intent guesses for undocumented Elli vendor extensions;
        // no automatic start or configuration changes are issued.
        for (const messageId of ['EVDetailsRequest', 'GetEVDetails']) {
            try {
                const result = await call('DataTransfer', {
                    vendorId: 'de.elli', messageId, data: '{}'
                });
                console.log(`🚗 DataTransfer ${messageId}:`, JSON.stringify(result));
            } catch (e) { console.warn(`⚠️ DataTransfer ${messageId}:`, e.message); }
        }
        vehicleProbeRunning = false;
    }
    async function testStart() {
        if (!ENABLE_TEST_START || ws.readyState !== WebSocket.OPEN) return;
        if (testStartRunning) return console.warn('⚠️ Teststart läuft bereits.');
        if (connectorStatus !== 'Occupied') return console.warn('⚠️ Anschluss ist nicht bestätigt Occupied; erst Fahrzeug anschließen und StatusNotification abwarten.');
        if (transactionActive) return console.warn('⚠️ Bereits eine Transaktion aktiv.');
        testStartRunning = true;
        testTokenValidUntil = Date.now() + 5 * 60 * 1000;
        console.warn('⚠️ TESTMODUS: Ein beliebiges angeschlossenes Fahrzeug kann nun geladen werden.');
        try {
            const result = await call('RequestStartTransaction', {
                remoteStartId: Math.floor(Math.random() * 2147483646) + 1,
                idToken: { idToken: TEST_TOKEN, type: 'Central' },
                evseId: 1
            });
            console.log('⚡ RequestStartTransaction:', JSON.stringify(result));
            if (result?.status !== 'Accepted') testTokenValidUntil = 0;
            else console.log('ℹ️ Accepted bedeutet nur: Auftrag angenommen. Auf TransactionEvent Started warten.');
        } catch (e) {
            testTokenValidUntil = 0;
            console.warn('⚠️ Remote-Start fehlgeschlagen:', e.message);
        } finally { testStartRunning = false; }
    }
    connectedDiagnostics = runDiagnostics;
    connectedTestStart = testStart;
    connectedCertificateCheck = inspectInstalledCertificates;
    connectedCertificateInstall = installCertificate;
    connectedControls = controlCharging;
    connectedVehicleProbe = probeVehicleDetails;
    function tokenAllowed(token) {
        return typeof token === 'string' &&
            (ALLOWED_RFID.has(token) || (ENABLE_TEST_START && token === TEST_TOKEN && Date.now() < testTokenValidUntil));
    }

    ws.on('message', raw => {
        // Capture every inbound WebSocket message BEFORE JSON parsing, filtering,
        // or checking whether the OCPP action is implemented.
        const rawText = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
        logFrame('inbound', rawText);
        let data;
        try { data = JSON.parse(rawText); }
        catch { console.warn('Ungültiges JSON empfangen'); return; }
        if (!Array.isArray(data) || typeof data[1] !== 'string') return;
        const [type, messageId, action, body] = data;
        if (type === 3 || type === 4) {
            const request = pending.get(messageId);
            if (request) {
                pending.delete(messageId); clearTimeout(request.timeout);
                if (type === 3) request.resolve(action);
                else request.reject(new Error(`${action}: ${body}`));
            }
            return;
        }
        if (type !== 2 || typeof action !== 'string' || !body || typeof body !== 'object') return;
        console.log(`⬅️ ${action}`, JSON.stringify(body));
        switch (action) {
            case 'BootNotification':
                reply(messageId, { status: 'Accepted', currentTime: new Date().toISOString(), interval: 60 });
                console.log('➡️ BootNotification akzeptiert');
                setTimeout(installLocalList, 1000);
                if (ENABLE_DIAGNOSTICS) setTimeout(runDiagnostics, 2000);
                break;
            case 'Heartbeat':
                reply(messageId, { currentTime: new Date().toISOString() });
                break;
            case 'StatusNotification':
                reply(messageId);
                if (body.evseId === 1 && body.connectorId === 1) connectorStatus = body.connectorStatus;
                console.log('🔌 Anschluss:', body.connectorStatus);
                break;
            case 'Authorize': {
                const token = body.idToken?.idToken;
                const accepted = tokenAllowed(token);
                reply(messageId, { idTokenInfo: { status: accepted ? 'Accepted' : 'Invalid' } });
                console.log(`🔐 Autorisierung: ${accepted ? 'Accepted' : 'Invalid'}`);
                break;
            }
            case 'TransactionEvent': {
                if (body.eventType === 'Started') transactionActive = true;
                if (typeof body.transactionInfo?.transactionId === 'string') activeTransactionId = body.transactionInfo.transactionId;
                if (body.eventType === 'Ended') {
                    transactionActive = false;
                    activeTransactionId = null;
                    pausedByServer = false;
                    vehicleDetails = null;
                    chargingNeeds = null;
                }
                const token = body.idToken?.idToken;
                reply(messageId, token ? { idTokenInfo: { status: tokenAllowed(token) ? 'Accepted' : 'Invalid' } } : {});
                console.log(`⚡ TransactionEvent: ${body.eventType}, aktiv: ${transactionActive}`);
                break;
            }
            case 'DataTransfer': {
                // Proprietary Elli telemetry. Acknowledge known messages without
                // altering the car-managed charging schedule.
                const supported = body.vendorId === 'de.elli' &&
                    ['EVDetailsUpdate', 'ChargeParameterUpdate', 'PowerStatusUpdate'].includes(body.messageId);
                if (supported && body.messageId === 'EVDetailsUpdate') {
                    vehicleDetails = {
                        brand: body.data?.EVBrand ?? null,
                        model: body.data?.EVModel ?? null,
                        pcid: body.data?.PCID ?? null
                    };
                    const maskedId = typeof vehicleDetails.pcid === 'string'
                        ? `***${vehicleDetails.pcid.slice(-4)}` : 'unavailable';
                    console.log(`🚗 Fahrzeugdaten: ${vehicleDetails.brand} ${vehicleDetails.model}, PCID ${maskedId}`);
                }
                if (supported && body.messageId === 'ChargeParameterUpdate')
                    console.log('🔌 Elli ChargeParameterUpdate empfangen (Rohwerte bleiben im JSONL-Log)');
                if (supported && body.messageId === 'PowerStatusUpdate')
                    console.log('⚡ Elli PowerStatusUpdate empfangen (keine Änderung des Ladeplans)');
                reply(messageId, { status: supported ? 'Accepted' :
                    body.vendorId === 'de.elli' ? 'UnknownMessageId' : 'UnknownVendorId' });
                break;
            }
            case 'NotifyEVChargingNeeds': {
                chargingNeeds = body.chargingNeeds || null;
                console.log('🔋 EVChargingNeeds:', JSON.stringify({
                    evseId: body.evseId,
                    requestedEnergyTransfer: chargingNeeds?.requestedEnergyTransfer,
                    departureTime: chargingNeeds?.departureTime,
                    acChargingParameters: chargingNeeds?.acChargingParameters,
                    dcChargingParameters: chargingNeeds?.dcChargingParameters,
                    maxScheduleTuples: body.maxScheduleTuples
                }, null, 2));
                // OCPP 2.0.1 requires a status in NotifyEVChargingNeedsResponse.
                reply(messageId, { status: 'Accepted' });
                break;
            }
            case 'NotifyEVChargingSchedule':
                // Charging schedule is reported by the EV, not created here.
                reply(messageId, { status: 'Accepted' });
                break;
            case 'Get15118EVCertificate':
                // No contract certificate provisioning service/EXI signer configured.
                // Never pretend a contract certificate was issued.
                console.warn('🔏 Plug & Charge requested contract certificate provisioning; unavailable.');
                reply(messageId, { status: 'Failed', statusInfo: { reasonCode: 'NoProvisioningService' } });
                break;
            case 'GetCertificateStatus':
                // No trusted OCSP responder is configured. Fail closed.
                console.warn('🔏 Certificate status requested; no OCSP validation service configured.');
                reply(messageId, { status: 'Failed', statusInfo: { reasonCode: 'NoOCSPService' } });
                break;
            case 'SecurityEventNotification':
            case 'NotifyEvent':
            case 'MeterValues':
            case 'NotifyChargingLimit':
            case 'NotifyReport':
            case 'FirmwareStatusNotification':
            case 'LogStatusNotification':
                reply(messageId);
                break;
            default:
                error(messageId, 'NotImplemented', `Unsupported action ${action}`);
                console.warn(`⚠️ Nicht implementiert: ${action}`);
        }
    });
    ws.on('close', () => {
        if (connectedDiagnostics === runDiagnostics) connectedDiagnostics = null;
        if (connectedTestStart === testStart) connectedTestStart = null;
        if (connectedCertificateCheck === inspectInstalledCertificates) connectedCertificateCheck = null;
        if (connectedCertificateInstall === installCertificate) connectedCertificateInstall = null;
        if (connectedControls === controlCharging) connectedControls = null;
        if (connectedVehicleProbe === probeVehicleDetails) connectedVehicleProbe = null;
        logFrame('disconnect', JSON.stringify({chargerId: id}));
        for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Disconnected')); }
        pending.clear(); console.log('❌ Verbindung zur Wallbox getrennt.');
    });
    ws.on('error', err => console.warn('WebSocket:', err.message));
});
