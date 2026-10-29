'use strict';

// Bridge between the Go web server (main.go) and the ecovacs-deebot library.
// Reads one JSON command per line on stdin ({"command": "...", "args": [...]})
// and writes one JSON event per line on stdout ({"event": "...", "data": ...}).

const readline = require('node:readline');
const { readSettings, createApi, connectRobot } = require('./ecovacs');

// stdout is reserved for the JSON protocol, so route all console logging to stderr.
console.log = console.error;
console.info = console.error;

const FORWARDED_EVENTS = [
    'BatteryInfo', 'ChargeState', 'CleanReport', 'CleanSpeed', 'WaterLevel',
    'LifeSpan', 'NetworkInfo', 'Availability', 'Error',
    'MapDataObject', 'Position', 'ChargingPosition'
];

const STATUS_REQUESTS = ['GetChargeState', 'GetBatteryState', 'GetCleanState', 'GetCleanSpeed', 'GetLifeSpan', 'GetNetInfo'];

// Commands passed through to vacbot.run() unchanged.
const ALLOWED_COMMANDS = new Set([
    'Clean', 'Pause', 'Resume', 'Stop', 'Charge', 'PlaySound', 'SetCleanSpeed', 'SetWaterLevel'
]);

const ROOM_IDS_PATTERN = /^\d+(,\d+)*$/;

// Commands that need translation before reaching the robot.
const ROBOT_COMMANDS = {
    Refresh: (vacbot) => requestStatus(vacbot),
    CleanRooms: (vacbot, [roomIDs]) => {
        if (!ROOM_IDS_PATTERN.test(roomIDs)) {
            throw new Error(`Invalid room list: ${roomIDs}`);
        }
        // run('SpotArea', 'start', ids) is upgraded to SpotArea_V2 on V2 models, which then
        // reads 'start' as the area list (library bug), so V2 models need SpotArea_V2 directly.
        if (vacbot.is950type_V2()) {
            vacbot.run('SpotArea_V2', roomIDs);
            return;
        }
        vacbot.run('SpotArea', 'start', roomIDs);
    },
    GoTo: (vacbot, [x, y]) => {
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
            throw new Error('Invalid target position');
        }
        vacbot.run('GoToPosition', `${Math.round(x)},${Math.round(y)}`);
    }
};

// The API session, the connected robot, and the resolver of a pending verification code.
const session = { api: null, vacbot: null, submitCode: null };

/**
 * Connects to the robot (asking the page for a verification code if needed),
 * forwards its events to stdout and executes commands from stdin.
 */
async function main() {
    send('Status', 'connecting');
    send('Verification', null);
    readline.createInterface({ input: process.stdin }).on('line', handleLine);
    process.stdin.on('end', async () => {
        await session.vacbot?.disconnect();
        process.exit(0);
    });

    const settings = readSettings();
    session.api = createApi(settings);
    const vacbot = await connectRobot(session.api, settings, promptPageForCode);
    send('Verification', null);
    session.vacbot = vacbot;

    FORWARDED_EVENTS.forEach((event) => vacbot.on(event, (data) => send(event, data)));
    vacbot.on('ready', () => {
        send('Device', {
            name: vacbot.getName(),
            model: vacbot.getModelName(),
            hasMoppingSystem: vacbot.hasMoppingSystem(),
            hasMap: vacbot.hasMappingCapabilities()
        });
        send('BridgeError', null);
        send('Status', 'ready');
        requestStatus(vacbot);
        if (vacbot.hasMappingCapabilities()) {
            vacbot.run('GetMaps', true, false);
        }
    });

    vacbot.connect();
}

/**
 * Asks the page for the e-mailed verification code; resolves when a "VerifyCode" command arrives.
 * @param {boolean} previousCodeInvalid - whether the last entered code was rejected
 * @returns {Promise<string>}
 */
function promptPageForCode(previousCodeInvalid) {
    send('Status', 'verification required');
    send('Verification', previousCodeInvalid ? 'invalid-code' : 'code-sent');
    return new Promise((resolve) => {
        session.submitCode = resolve;
    });
}

/**
 * Parses and executes one command line, reporting failures to the page.
 * @param {string} line - JSON-encoded {command, args}
 */
function handleLine(line) {
    try {
        const { command, args = [] } = JSON.parse(line);
        runCommand(command, args);
    } catch (error) {
        send('BridgeError', `Command failed: ${error.message}`);
    }
}

/**
 * Executes a verification command, or a robot command once the robot is connected.
 * @param {string} command - command name
 * @param {Array} args - command arguments
 */
function runCommand(command, args) {
    if (command === 'VerifyCode') {
        submitVerificationCode(String(args[0] ?? ''));
        return;
    }
    if (command === 'RequestVerificationCode') {
        requestVerificationCode();
        return;
    }
    if (!session.vacbot) {
        throw new Error('the robot is not connected yet');
    }
    if (ROBOT_COMMANDS[command]) {
        ROBOT_COMMANDS[command](session.vacbot, args);
        return;
    }
    if (!ALLOWED_COMMANDS.has(command)) {
        throw new Error(`command not allowed: ${command}`);
    }
    session.vacbot.run(command, ...args);
}

/**
 * Hands the entered code to the waiting login.
 * @param {string} code - the code from the verification e-mail
 */
function submitVerificationCode(code) {
    if (!session.submitCode) {
        throw new Error('no verification is pending');
    }
    session.submitCode(code);
    session.submitCode = null;
}

/**
 * Asks Ecovacs to e-mail a new verification code while a verification is pending.
 */
function requestVerificationCode() {
    if (!session.submitCode) {
        throw new Error('no verification is pending');
    }
    session.api.requestDeviceVerificationCode()
        .then(() => send('Verification', 'code-sent'))
        .catch((error) => send('BridgeError', `Could not send a new code: ${error.message}`));
}

/**
 * Requests the basic status values; the answers arrive as forwarded events.
 * @param {Object} vacbot - the connected EcovacsDevice
 */
function requestStatus(vacbot) {
    const waterRequest = vacbot.hasMoppingSystem() ? ['GetWaterInfo'] : [];
    const positionRequest = vacbot.hasMappingCapabilities() ? ['GetPosition'] : [];
    [...STATUS_REQUESTS, ...waterRequest, ...positionRequest].forEach((command) => vacbot.run(command));
}

/**
 * Writes one event line to stdout.
 * @param {string} event - event name
 * @param {*} data - JSON-serializable payload
 */
function send(event, data) {
    process.stdout.write(JSON.stringify({ event, data }) + '\n');
}

main().catch((error) => {
    send('BridgeError', error.message);
    process.exit(1);
});
