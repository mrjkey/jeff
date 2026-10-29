'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Map sizes in device units (millimetres).
const MAP_PADDING = 500;
const ROBOT_RADIUS = 170;
const CHARGER_RADIUS = 110;
const TARGET_RADIUS = 120;

const VERIFICATION_MESSAGES = {
    'code-sent': 'Ecovacs requires this device to be verified. A code was sent to your account e-mail address.',
    'invalid-code': 'That code was invalid or has expired. Try again or request a new code.'
};

const EVENT_HANDLERS = {
    Status: showStatus,
    Device: showDevice,
    Verification: showVerification,
    BatteryInfo: (level) => { $('battery').textContent = `${Math.round(level)} %`; },
    CleanReport: (state) => { $('clean').textContent = state; },
    ChargeState: (state) => { $('charge').textContent = state; },
    CleanSpeed: (speed) => { $('suction').value = String(speed); },
    WaterLevel: (level) => { $('water').value = String(level); },
    LifeSpan: showLifeSpan,
    NetworkInfo: ({ ip, mac, wifiSSID, wifiSignal }) => {
        $('network').textContent = `${ip} · ${mac} · ${wifiSSID} · signal ${wifiSignal}`;
    },
    MapDataObject: showMap,
    Position: showRobotPosition,
    ChargingPosition: ({ x, y }) => placeCircle($('map-charger'), x, y, CHARGER_RADIUS),
    Availability: ({ available }) => showStatus(available ? 'ready' : 'robot offline'),
    Error: (message) => showError(message.startsWith('NoError') ? null : message),
    BridgeError: showError
};

const state = { ready: false, selectedRooms: new Set() };

/**
 * Wires up the controls and subscribes to the server's event stream.
 */
function init() {
    showStatus('connecting');
    document.querySelectorAll('button[data-command]').forEach((button) => {
        button.addEventListener('click', () => sendCommand(button.dataset.command, JSON.parse(button.dataset.args || '[]')));
    });
    document.querySelectorAll('select[data-command]').forEach((select) => {
        select.addEventListener('change', () => sendCommand(select.dataset.command, [Number(select.value)]));
    });
    initVerification();
    initMap();

    const events = new EventSource('api/events');
    events.onmessage = (message) => {
        const { event, data } = JSON.parse(message.data);
        EVENT_HANDLERS[event]?.(data);
    };
    events.onerror = () => showStatus('offline');
}

/**
 * Submits the verification code and requests new codes.
 */
function initVerification() {
    $('verification').addEventListener('submit', (event) => {
        event.preventDefault();
        sendCommand('VerifyCode', [$('verification-code').value.trim()]);
        $('verification-code').value = '';
    });
    $('verification-resend').addEventListener('click', () => sendCommand('RequestVerificationCode', []));
}

/**
 * Wires up map clicks (select rooms or go to a point) and the room buttons.
 */
function initMap() {
    const map = $('map');
    map.dataset.mode = 'rooms';
    document.querySelectorAll('input[name="map-mode"]').forEach((radio) => {
        radio.addEventListener('change', () => { map.dataset.mode = radio.value; });
    });
    map.addEventListener('click', (event) => {
        if (map.dataset.mode === 'goto') {
            goToMapPoint(event);
            return;
        }
        const roomID = event.target.dataset.roomId;
        if (roomID !== undefined) {
            toggleRoom(roomID);
        }
    });
    $('clean-rooms').addEventListener('click', () => sendCommand('CleanRooms', [[...state.selectedRooms].join(',')]));
    $('clear-rooms').addEventListener('click', () => {
        state.selectedRooms.clear();
        updateRoomSelection();
    });
}

/**
 * Posts a command to the server and shows any failure.
 * @param {string} command - command name
 * @param {Array} args - command arguments
 */
async function sendCommand(command, args) {
    try {
        const response = await fetch('api/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command, args })
        });
        if (!response.ok) {
            showError(await response.text());
        }
    } catch (error) {
        showError(error.message);
    }
}

/**
 * Shows the connection state and enables the controls only when the robot is ready.
 * @param {string} status - e.g. "connecting", "ready", "offline"
 */
function showStatus(status) {
    state.ready = status === 'ready';
    $('status').textContent = status;
    $('status').dataset.state = status;
    document.querySelectorAll('[data-command]').forEach((control) => { control.disabled = !state.ready; });
    updateRoomSelection();
}

/**
 * Shows the robot's name and model and the settings it supports.
 * @param {{name: string, model: string, hasMoppingSystem: boolean, hasMap: boolean}} device
 */
function showDevice({ name, model, hasMoppingSystem, hasMap }) {
    $('name').textContent = name;
    $('model').textContent = model;
    $('water-setting').hidden = !hasMoppingSystem;
    $('map-section').hidden = !hasMap;
}

/**
 * Shows or hides the verification form.
 * @param {?string} verification - "code-sent", "invalid-code" or null when not needed
 */
function showVerification(verification) {
    $('verification').hidden = !verification;
    $('verification-message').textContent = VERIFICATION_MESSAGES[verification] || '';
    if (verification) {
        $('verification-code').focus();
    }
}

/**
 * Draws the current map's rooms and virtual boundaries.
 * @param {Array<Object>} maps - the library's MapDataObject
 */
function showMap(maps) {
    const map = maps.find((candidate) => candidate.mapIsCurrentMap) || maps[0];
    const rooms = (map?.mapSpotAreas || []).filter((room) => room.mapSpotAreaBoundaries);
    if (rooms.length === 0) {
        $('map-hint').textContent = 'No rooms found on the robot\'s map.';
        return;
    }

    const roomShapes = rooms.map((room) => ({
        id: String(room.mapSpotAreaID),
        name: room.mapSpotAreaName,
        points: parsePoints(room.mapSpotAreaBoundaries.split(';').join(','))
    }));
    const boundaries = (map.mapVirtualBoundaries || [])
        .filter((boundary) => boundary.mapVirtualBoundaryCoordinates)
        .map((boundary) => ({
            type: boundary.mapVirtualBoundaryType,
            points: parsePoints(boundary.mapVirtualBoundaryCoordinates.replace(/[[\]]/g, ''))
        }));

    fitMapToPoints(roomShapes.flatMap((room) => room.points));
    $('map-rooms').replaceChildren(...roomShapes.map((room) => svgElement('polygon', {
        class: 'room',
        points: room.points.join(' '),
        'data-room-id': room.id
    })));
    $('map-labels').replaceChildren(...roomShapes.map((room) => {
        const [x, y] = centerOf(room.points);
        const label = svgElement('text', { x, y });
        label.textContent = room.name;
        return label;
    }));
    $('map-boundaries').replaceChildren(...boundaries.map((boundary) => svgElement('polygon', {
        class: `boundary ${boundary.type}`,
        points: boundary.points.join(' ')
    })));
    $('map-hint').textContent = 'Click rooms to select them, or switch to "Go to point".';
    updateRoomSelection();
}

/**
 * Parses "x1,y1,x2,y2,..." device coordinates into SVG points (y axis flipped).
 * @param {string} coordinates
 * @returns {Array<[number, number]>}
 */
function parsePoints(coordinates) {
    const values = coordinates.split(',').filter(Boolean).map(Number);
    return values.flatMap((value, index) => (index % 2 === 0 ? [[value, -values[index + 1]]] : []));
}

/**
 * Returns the center of the bounding box of the points.
 * @param {Array<[number, number]>} points
 * @returns {[number, number]}
 */
function centerOf(points) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

/**
 * Sets the SVG viewBox and label size to enclose the points.
 * @param {Array<[number, number]>} points
 */
function fitMapToPoints(points) {
    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    const minX = Math.min(...xs) - MAP_PADDING;
    const minY = Math.min(...ys) - MAP_PADDING;
    const width = Math.max(...xs) - minX + MAP_PADDING;
    const height = Math.max(...ys) - minY + MAP_PADDING;
    $('map').setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
    $('map-labels').setAttribute('font-size', Math.max(width, height) / 30);
}

/**
 * Moves the robot marker and highlights the room it is in.
 * @param {{x: number, y: number, a: number, invalid: boolean, spotAreaID: (string|number)}} position
 */
function showRobotPosition({ x, y, a, invalid, spotAreaID }) {
    const robot = $('map-robot');
    robot.toggleAttribute('hidden', Boolean(invalid));
    robot.setAttribute('transform', `translate(${x} ${-y}) rotate(${-(a || 0)})`);
    robot.querySelector('circle').setAttribute('r', ROBOT_RADIUS);
    robot.querySelector('line').setAttribute('x2', ROBOT_RADIUS);
    document.querySelectorAll('.room').forEach((room) => {
        room.classList.toggle('current', room.dataset.roomId === String(spotAreaID));
    });
}

/**
 * Sends the robot to the clicked map point and marks the target.
 * @param {MouseEvent} event
 */
function goToMapPoint(event) {
    if (!state.ready) {
        return;
    }
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform($('map').getScreenCTM().inverse());
    placeCircle($('map-target'), point.x, -point.y, TARGET_RADIUS);
    sendCommand('GoTo', [point.x, -point.y]);
}

/**
 * Selects or deselects a room for cleaning.
 * @param {string} roomID
 */
function toggleRoom(roomID) {
    if (!state.selectedRooms.delete(roomID)) {
        state.selectedRooms.add(roomID);
    }
    updateRoomSelection();
}

/**
 * Reflects the room selection on the map and in the room buttons.
 */
function updateRoomSelection() {
    document.querySelectorAll('.room').forEach((room) => {
        room.classList.toggle('selected', state.selectedRooms.has(room.dataset.roomId));
    });
    const count = state.selectedRooms.size;
    $('clean-rooms').textContent = count ? `Clean ${count} selected room${count > 1 ? 's' : ''}` : 'Clean selected rooms';
    $('clean-rooms').disabled = !state.ready || count === 0;
    $('clear-rooms').disabled = count === 0;
}

/**
 * Shows a circle marker at device coordinates.
 * @param {SVGCircleElement} circle
 * @param {number} x
 * @param {number} y
 * @param {number} radius
 */
function placeCircle(circle, x, y, radius) {
    Object.entries({ cx: x, cy: -y, r: radius }).forEach(([name, value]) => circle.setAttribute(name, value));
    circle.removeAttribute('hidden');
}

/**
 * Creates an SVG element with attributes.
 * @param {string} name - tag name
 * @param {Object<string, (string|number)>} attributes
 * @returns {SVGElement}
 */
function svgElement(name, attributes) {
    const element = document.createElementNS(SVG_NS, name);
    Object.entries(attributes).forEach(([attribute, value]) => element.setAttribute(attribute, value));
    return element;
}

/**
 * Renders one meter per consumable.
 * @param {Object<string, number>} lifeSpan - remaining life in percent by component
 */
function showLifeSpan(lifeSpan) {
    const rows = Object.entries(lifeSpan).map(([component, percent]) => {
        const row = document.createElement('li');
        const label = document.createElement('span');
        const meter = document.createElement('meter');
        const value = document.createElement('span');
        label.textContent = component.replaceAll('_', ' ');
        Object.assign(meter, { min: 0, max: 100, low: 20, optimum: 100, value: percent });
        value.textContent = `${Math.round(percent)} %`;
        row.append(label, meter, value);
        return row;
    });
    $('lifespan').replaceChildren(...rows);
}

/**
 * Shows an error message, or hides the banner when message is empty.
 * @param {?string} message
 */
function showError(message) {
    $('error').textContent = message || '';
    $('error').hidden = !message;
}

init();
