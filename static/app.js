'use strict';

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';

// Map sizes in device units (millimetres).
const MAP_PADDING = 500;
const ROBOT_RADIUS = 170;
const CHARGER_RADIUS = 110;
const TARGET_RADIUS = 120;
// Screen distance (px) a press must move to count as drawing rather than a click.
const DRAG_THRESHOLD = 6;
const NOTICE_DURATION_MS = 8000;

const BOUNDARY_TYPE_NAMES = { vw: 'boundary', mw: 'no-mop zone' };

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
    BridgeError: showError,
    Notice: showNotice,
    MapBackups: showBackups
};

const state = {
    ready: false,
    selectedRooms: new Set(),
    // Current map: rooms by id ({name, subtype, points}), boundaries ({id, type, points}) and all room points.
    rooms: new Map(),
    boundaries: [],
    mapPoints: [],
    mapLoaded: false,
    backups: [],
    // Edit mode: picked room ids, picked boundary, the shape being drawn and the pointer press.
    edit: { rooms: [], boundary: null, draft: null, press: null },
    noticeTimer: null
};

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
    initMapEditor();
    initBackups();

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
        radio.addEventListener('change', () => {
            map.dataset.mode = radio.value;
            $('room-actions').hidden = radio.value === 'edit';
            $('edit-tools').hidden = radio.value !== 'edit';
            $('edit-actions').hidden = radio.value !== 'edit';
            resetEdit();
        });
    });
    map.addEventListener('click', (event) => {
        if (map.dataset.mode === 'edit') {
            return; // handled by the pointer events in initMapEditor
        }
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
 * Wires up the edit tools: drawing on the map, picking rooms and boundaries, and the actions.
 */
function initMapEditor() {
    const map = $('map');
    $('edit-tools').dataset.tool = 'boundary';
    map.dataset.tool = 'boundary';
    document.querySelectorAll('input[name="edit-tool"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            $('edit-tools').dataset.tool = radio.value;
            map.dataset.tool = radio.value;
            resetEdit();
        });
    });
    $('boundary-shape').addEventListener('change', resetEdit);
    $('boundary-type').addEventListener('change', updateEditor);

    map.addEventListener('pointerdown', (event) => {
        if (map.dataset.mode !== 'edit' || !state.ready) {
            return;
        }
        state.edit.press = { x: event.clientX, y: event.clientY, start: toMapPoint(event), target: event.target };
        map.setPointerCapture(event.pointerId);
    });
    map.addEventListener('pointermove', (event) => {
        const press = state.edit.press;
        if (!press || !['boundary', 'divide'].includes(editTool())) {
            return;
        }
        if (!press.dragging && Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_THRESHOLD) {
            return;
        }
        press.dragging = true;
        state.edit.boundary = null;
        state.edit.draft = { from: press.start, to: toMapPoint(event) };
        updateEditor();
    });
    map.addEventListener('pointerup', () => {
        const press = state.edit.press;
        state.edit.press = null;
        if (press && !press.dragging) {
            pickEditTarget(press.target);
        }
    });
    map.addEventListener('pointercancel', () => { state.edit.press = null; });

    $('edit-apply').addEventListener('click', applyEdit);
    $('edit-cancel').addEventListener('click', resetEdit);
    $('delete-map').addEventListener('click', () => {
        if (confirm('Delete the map from the robot? It will have to explore and map the home again.')) {
            sendCommand('DeleteMap', []);
        }
    });
}

/**
 * Returns the selected edit tool: "boundary", "merge", "divide" or "label".
 * @returns {string}
 */
function editTool() {
    return $('edit-tools').dataset.tool;
}

/**
 * Picks the clicked room or boundary for the current edit tool.
 * @param {Element} target - the element under the pointer
 */
function pickEditTarget(target) {
    const { roomId, boundaryId, boundaryType } = target.dataset;
    const tool = editTool();
    if (tool === 'boundary') {
        const picked = state.edit.boundary?.id === boundaryId;
        state.edit.boundary = boundaryId === undefined || picked ? null : { id: boundaryId, type: boundaryType };
        state.edit.draft = null;
    } else if (roomId !== undefined && tool === 'merge') {
        const rooms = state.edit.rooms;
        state.edit.rooms = rooms.includes(roomId) ? rooms.filter((id) => id !== roomId) : [...rooms, roomId];
    } else if (roomId !== undefined) {
        state.edit.rooms = [roomId];
        if (tool === 'label') {
            const room = state.rooms.get(roomId);
            $('room-type').value = room.subtype;
            $('room-name').value = room.subtype === '0' || roomTypeName(room.subtype) === room.name ? '' : room.name;
        }
    }
    updateEditor();
}

/**
 * Sends the pending edit to the robot.
 */
function applyEdit() {
    const { rooms, boundary } = state.edit;
    const tool = editTool();
    if (tool === 'boundary' && boundary) {
        sendCommand('DeleteBoundary', [boundary.type, boundary.id]);
    } else if (tool === 'boundary') {
        sendCommand('AddBoundary', [$('boundary-type').value, draftCoordinates()]);
    } else if (tool === 'merge') {
        sendCommand('MergeRooms', [rooms]);
    } else if (tool === 'divide') {
        sendCommand('DivideRoom', [rooms[0], draftCoordinates()]);
    } else if (tool === 'label') {
        sendCommand('LabelRoom', [rooms[0], Number($('room-type').value), $('room-name').value]);
    }
    resetEdit();
}

/**
 * Returns the drawn shape in device coordinates: a box's 4 corners, or a line's 2 ends.
 * @returns {Array<number>}
 */
function draftCoordinates() {
    return draftPoints().flatMap(([x, y]) => [Math.round(x), Math.round(-y)]);
}

/**
 * Returns the drawn shape's corners in SVG coordinates.
 * @returns {Array<[number, number]>}
 */
function draftPoints() {
    const { draft } = state.edit;
    if (!draft) {
        return [];
    }
    const [[x1, y1], [x2, y2]] = [draft.from, draft.to];
    if (editTool() === 'boundary' && $('boundary-shape').value === 'zone') {
        return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
    }
    return [[x1, y1], [x2, y2]];
}

/**
 * Clears the picked rooms, boundary and drawn shape.
 */
function resetEdit() {
    state.edit = { rooms: [], boundary: null, draft: null, press: null };
    updateEditor();
}

/**
 * Shows the edit state on the map and sets the hint and the apply button for the current tool.
 */
function updateEditor() {
    const { rooms, boundary, draft } = state.edit;
    const editing = $('map').dataset.mode === 'edit';
    document.querySelectorAll('.room').forEach((room) => {
        room.classList.toggle('picked', editing && rooms.includes(room.dataset.roomId));
    });
    document.querySelectorAll('.boundary').forEach((element) => {
        element.classList.toggle('picked', editing && element.dataset.boundaryId === boundary?.id);
    });
    const points = draftPoints();
    const shape = svgElement(points.length > 2 ? 'polygon' : 'polyline', { class: 'draft', points: points.join(' ') });
    $('map-draft').replaceChildren(...(draft && editing ? [shape] : []));

    const roomName = (id) => state.rooms.get(id)?.name ?? id;
    const tool = editTool();
    let hint = '';
    let action = 'Apply';
    let ready = false;
    if (tool === 'boundary' && boundary) {
        [hint, action, ready] = ['Delete this boundary, or click elsewhere to keep it.', `Delete ${BOUNDARY_TYPE_NAMES[boundary.type]}`, true];
    } else if (tool === 'boundary') {
        hint = 'Drag on the map to draw a boundary, or click an existing one to delete it.';
        [action, ready] = [`Add ${BOUNDARY_TYPE_NAMES[$('boundary-type').value]}`, Boolean(draft)];
    } else if (tool === 'merge') {
        hint = 'Click the adjacent rooms to merge.';
        [action, ready] = [rooms.length > 1 ? `Merge ${rooms.map(roomName).join(' + ')}` : 'Merge rooms', rooms.length > 1];
    } else if (tool === 'divide') {
        hint = rooms.length ? 'Drag a line across the room where it should be divided.' : 'Click the room to divide.';
        [action, ready] = [rooms.length ? `Divide ${roomName(rooms[0])}` : 'Divide room', rooms.length === 1 && Boolean(draft)];
    } else if (tool === 'label') {
        hint = 'Click a room, then pick its type or give it a name.';
        [action, ready] = [rooms.length ? `Save label for ${roomName(rooms[0])}` : 'Save label', rooms.length === 1];
    }
    if (!state.mapLoaded) {
        hint = 'Loading map…';
    } else if (state.rooms.size === 0) {
        hint = 'No rooms found on the robot\'s map.';
    } else if (!editing) {
        hint = 'Click rooms to select them, or switch to "Go to point".';
    }
    $('map-hint').textContent = hint;
    $('edit-apply').textContent = action;
    $('edit-apply').disabled = !state.ready || !ready;
    $('edit-cancel').disabled = !rooms.length && !boundary && !draft;
    $('delete-map').disabled = !state.ready;
}

/**
 * Returns the name the robot gives a room type, e.g. "Kitchen".
 * @param {string} subtype - room type number
 * @returns {string}
 */
function roomTypeName(subtype) {
    return $('room-type').querySelector(`option[value="${subtype}"]`)?.textContent ?? '';
}

/**
 * Wires up saving, showing, re-applying and deleting map backups.
 */
function initBackups() {
    const selectedBackup = () => state.backups.find((backup) => backup.id === $('backup-list').value);
    $('backup-save').addEventListener('click', () => sendCommand('SaveMapBackup', []));
    $('backup-list').addEventListener('change', () => {
        drawBackup();
        updateBackups();
    });
    $('backup-show').addEventListener('change', drawBackup);
    $('backup-layout').addEventListener('click', () => {
        if (confirm('Copy the room labels and boundaries of this backup onto the current map?')) {
            sendCommand('RestoreMapLayout', [selectedBackup().id]);
        }
    });
    $('backup-robot').addEventListener('click', () => {
        if (confirm('Ask the robot to replace its current map with the backup it made of this map? '
            + 'This only works while the robot still has that backup.')) {
            sendCommand('RestoreRobotBackup', [selectedBackup().id]);
        }
    });
    $('backup-delete').addEventListener('click', () => {
        if (confirm('Delete this saved backup?')) {
            sendCommand('DeleteMapBackup', [selectedBackup().id]);
        }
    });
}

/**
 * Lists the saved backups, keeping the current choice when it still exists.
 * @param {Array<Object>} backups - newest first
 */
function showBackups(backups) {
    const selected = $('backup-list').value;
    state.backups = backups;
    $('backup-list').replaceChildren(...backups.map((backup) => {
        const option = document.createElement('option');
        option.value = backup.id;
        option.textContent = `${new Date(backup.savedAt).toLocaleString()} · ${backup.rooms.length} rooms`;
        return option;
    }));
    if (backups.some((backup) => backup.id === selected)) {
        $('backup-list').value = selected;
    }
    drawBackup();
    updateBackups();
}

/**
 * Enables the backup controls that apply to the selected backup.
 */
function updateBackups() {
    const backup = state.backups.find((candidate) => candidate.id === $('backup-list').value);
    $('backup-controls').hidden = !backup;
    $('backup-actions').hidden = !backup;
    $('backup-save').disabled = !state.ready;
    $('backup-layout').disabled = !state.ready || !backup;
    $('backup-robot').disabled = !state.ready || !backup?.robotBackupID;
    $('backup-delete').disabled = !state.ready || !backup;
}

/**
 * Outlines the selected backup's rooms, boundaries and dock over the map when "Show on map" is on.
 */
function drawBackup() {
    const backup = $('backup-show').checked && state.backups.find((candidate) => candidate.id === $('backup-list').value);
    if (!backup) {
        $('map-ghost').replaceChildren();
        fitMapToPoints(state.mapPoints);
        return;
    }
    const rooms = backup.rooms.map((room) => parsePoints(room.boundaries.split(';').join(',')));
    const boundaries = backup.boundaries.map((boundary) => parsePoints(boundary.coordinates.replace(/[[\]]/g, '')));
    const shapes = [...rooms, ...boundaries].map((points) => svgElement('polygon', { class: 'ghost', points: points.join(' ') }));
    if (backup.chargingPosition) {
        const { x, y } = backup.chargingPosition;
        shapes.push(svgElement('circle', { class: 'ghost', cx: x, cy: -y, r: CHARGER_RADIUS }));
    }
    $('map-ghost').replaceChildren(...shapes);
    fitMapToPoints([...state.mapPoints, ...rooms.flat()]);
}

/**
 * Shows a short-lived confirmation message below the map.
 * @param {?string} message
 */
function showNotice(message) {
    clearTimeout(state.noticeTimer);
    $('notice').textContent = message || '';
    $('notice').hidden = !message;
    state.noticeTimer = setTimeout(() => { $('notice').hidden = true; }, NOTICE_DURATION_MS);
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
    updateEditor();
    updateBackups();
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
    $('backup-section').hidden = !hasMap;
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
    const roomShapes = rooms.map((room) => ({
        id: String(room.mapSpotAreaID),
        name: room.mapSpotAreaName,
        subtype: String(room.mapSpotAreaSubType ?? '0'),
        points: parsePoints(room.mapSpotAreaBoundaries.split(';').join(','))
    }));
    const boundaries = (map?.mapVirtualBoundaries || [])
        .filter((boundary) => boundary.mapVirtualBoundaryCoordinates)
        .map((boundary) => ({
            id: String(boundary.mapVirtualBoundaryID),
            type: boundary.mapVirtualBoundaryType,
            points: parsePoints(boundary.mapVirtualBoundaryCoordinates.replace(/[[\]]/g, ''))
        }));
    state.rooms = new Map(roomShapes.map((room) => [room.id, room]));
    state.boundaries = boundaries;
    state.mapPoints = roomShapes.flatMap((room) => room.points);
    state.selectedRooms = new Set([...state.selectedRooms].filter((id) => state.rooms.has(id)));

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
        points: boundary.points.join(' '),
        'data-boundary-id': boundary.id,
        'data-boundary-type': boundary.type
    })));
    state.mapLoaded = true;
    drawBackup();
    updateRoomSelection();
    resetEdit();
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
    if (points.length === 0) {
        return;
    }
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
    const [x, y] = toMapPoint(event);
    placeCircle($('map-target'), x, -y, TARGET_RADIUS);
    sendCommand('GoTo', [x, -y]);
}

/**
 * Converts the pointer position to SVG coordinates (device coordinates with y flipped).
 * @param {MouseEvent} event
 * @returns {[number, number]}
 */
function toMapPoint(event) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform($('map').getScreenCTM().inverse());
    return [point.x, point.y];
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
