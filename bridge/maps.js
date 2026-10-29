'use strict';

// Map editing and map backups.
//
// The ecovacs-deebot library has no commands for merging, dividing or labelling rooms, so all
// edits are sent as raw commands with the payloads the Ecovacs app uses on T8/T9 series
// robots (as captured by https://github.com/m8schmit/ecovacs-stack).
//
// A backup is a JSON file in DATA_DIR/map-backups with the rooms, labels and virtual
// boundaries of the current map, plus the id of the robot's own backup of that map.

const fs = require('node:fs/promises');
const path = require('node:path');
const { VacBotCommand } = require('ecovacs-deebot/library/commands/base');

const BACKUP_DIR = path.join(process.env.DATA_DIR || 'data', 'map-backups');
const BACKUP_ID_PATTERN = /^[\w-]+$/;
const SUBSET_ID_PATTERN = /^\d+$/;
const BOUNDARY_TYPES = new Set(['vw', 'mw']);
const MAX_ROOM_SUBTYPE = 14;
const MAX_ROOM_NAME_LENGTH = 32;

// Time for the robot to apply an edit before the map is fetched again.
const MAP_REFRESH_DELAY_MS = 2000;
// Pause between the commands of a layout restore so the robot handles them one at a time.
const RESTORE_COMMAND_DELAY_MS = 500;
// Grid spacing (mm) for estimating how much of a room lies inside a saved room.
const OVERLAP_SAMPLE_STEP = 100;
// Share of a room that must lie inside a saved room for it to take that room's label.
const MIN_LABEL_OVERLAP = 0.5;
// Share of the current map that must lie inside the saved rooms before anything is re-applied;
// below this the robot has likely mapped in a different position or orientation.
const MIN_MAP_OVERLAP = 0.6;

/**
 * Adds a virtual wall (2 points) or zone (4 points) to the current map.
 * @param {Object} vacbot - the connected EcovacsDevice
 * @param {string} type - "vw" (keep out) or "mw" (no mopping)
 * @param {Array<number>} coordinates - x1,y1,x2,y2[,x3,y3,x4,y4] in device units
 */
async function addBoundary(vacbot, type, coordinates) {
    checkBoundaryType(type);
    if (!Array.isArray(coordinates) || ![4, 8].includes(coordinates.length) || !coordinates.every(Number.isFinite)) {
        throw new Error('A boundary needs 2 points (wall) or 4 points (zone)');
    }
    await setMapSubSet(vacbot, { act: 'add', type, value: `[${coordinates.map(Math.round).join(',')}]` });
}

/**
 * Removes a virtual wall or zone from the current map.
 * @param {Object} vacbot
 * @param {string} type - "vw" or "mw"
 * @param {string} id - the boundary's mapVirtualBoundaryID
 */
async function deleteBoundary(vacbot, type, id) {
    checkBoundaryType(type);
    checkSubsetID(id);
    await setMapSubSet(vacbot, { act: 'del', type, mssid: id });
}

/**
 * Merges adjacent rooms into one.
 * @param {Object} vacbot
 * @param {Array<string>} ids - at least two room ids
 */
async function mergeRooms(vacbot, ids) {
    if (!Array.isArray(ids) || ids.length < 2) {
        throw new Error('Select at least two rooms to merge');
    }
    ids.forEach(checkSubsetID);
    await sendRaw(vacbot, 'setMapSet', {
        act: 'merge',
        mid: currentMapID(vacbot),
        type: 'ar',
        subsets: ids.map((mssid) => ({ mssid }))
    });
}

/**
 * Divides a room in two along a line.
 * @param {Object} vacbot
 * @param {string} id - the room id
 * @param {Array<number>} line - x1,y1,x2,y2 in device units
 */
async function divideRoom(vacbot, id, line) {
    checkSubsetID(id);
    if (!Array.isArray(line) || line.length !== 4 || !line.every(Number.isFinite)) {
        throw new Error('Invalid dividing line');
    }
    const [x1, y1, x2, y2] = line.map(Math.round);
    await setMapSubSet(vacbot, { act: 'divide', type: 'ar', mssid: id, value: `${x1},${y1};${x2},${y2}` });
}

/**
 * Sets the room type (0 = default letter, 1 = living room, ...) and an optional custom name.
 * @param {Object} vacbot
 * @param {string} id - the room id
 * @param {number} subtype - 0 to 14
 * @param {string} name - custom name, or "" to use the type's name
 */
async function labelRoom(vacbot, id, subtype, name) {
    checkSubsetID(id);
    if (!Number.isInteger(subtype) || subtype < 0 || subtype > MAX_ROOM_SUBTYPE) {
        throw new Error(`Invalid room type: ${subtype}`);
    }
    if (typeof name !== 'string' || name.length > MAX_ROOM_NAME_LENGTH) {
        throw new Error(`Room names can have at most ${MAX_ROOM_NAME_LENGTH} characters`);
    }
    await setMapSubSet(vacbot, { act: 'mod', type: 'ar', mssid: id, subtype: String(subtype), name: name.trim() });
}

/**
 * Deletes the current map from the robot.
 * @param {Object} vacbot
 */
async function deleteMap(vacbot) {
    await sendRaw(vacbot, 'setCachedMapInfo', { itemType: 0, act: 'del', mid: currentMapID(vacbot) });
}

/**
 * Fetches the map again so the page shows the result of an edit.
 * @param {Object} vacbot
 */
function refreshMap(vacbot) {
    setTimeout(() => {
        vacbot.mapDataObject = null;
        vacbot.run('GetMaps', true, false);
    }, MAP_REFRESH_DELAY_MS);
}

/**
 * Saves the current map's rooms and boundaries, and the id of the robot's own backup of it.
 * @param {Object} vacbot
 * @param {?{x: number, y: number}} chargingPosition - last known dock position
 * @returns {Promise<Object>} the saved backup
 */
async function saveBackup(vacbot, chargingPosition) {
    const map = currentMap(vacbot);
    const cachedMaps = await sendRaw(vacbot, 'getCachedMapInfo', {});
    const robotMap = cachedMaps?.info?.find((candidate) => candidate.mid === map.mapID);
    const savedAt = new Date().toISOString();
    const backup = {
        id: savedAt.replace(/[:.]/g, '-'),
        savedAt,
        robot: vacbot.getName(),
        mapID: map.mapID,
        robotBackupID: robotMap?.backupId || '',
        chargingPosition,
        rooms: (map.mapSpotAreas || []).map((room) => ({
            id: room.mapSpotAreaID,
            name: room.mapSpotAreaName,
            subtype: room.mapSpotAreaSubType,
            boundaries: room.mapSpotAreaBoundaries
        })),
        boundaries: currentBoundaries(map)
    };
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.writeFile(backupPath(backup.id), JSON.stringify(backup, null, 2) + '\n');
    return backup;
}

/**
 * Returns all saved backups, newest first. Unreadable files are skipped.
 * @returns {Promise<Array<Object>>}
 */
async function listBackups() {
    let files;
    try {
        files = await fs.readdir(BACKUP_DIR);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const backups = await Promise.all(files
        .filter((file) => file.endsWith('.json'))
        .map((file) => fs.readFile(path.join(BACKUP_DIR, file), 'utf8').then(JSON.parse).catch(() => null)));
    return backups.filter(Boolean).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/**
 * Deletes a saved backup.
 * @param {string} id
 */
async function deleteBackup(id) {
    await fs.unlink(backupPath(id));
}

/**
 * Asks the robot to restore its own backup recorded in a saved backup. This brings back the
 * whole map (walls and floor plan included), as long as the robot still has that backup.
 * @param {Object} vacbot
 * @param {string} id - the saved backup's id
 */
async function restoreRobotBackup(vacbot, id) {
    const backup = await readBackup(id);
    if (!backup.robotBackupID) {
        throw new Error('This backup has no robot backup id');
    }
    await sendRaw(vacbot, 'setCachedMapInfo', {
        itemType: 0,
        act: 'restore',
        built: 1,
        mid: currentMapID(vacbot),
        reMid: backup.robotBackupID,
        isFake: false
    });
}

/**
 * Copies the room labels and virtual boundaries of a saved backup onto the current map.
 * Each current room takes the label of the saved room it mostly lies in; boundaries that
 * are not on the map yet are added at their saved coordinates.
 * @param {Object} vacbot
 * @param {string} id - the saved backup's id
 * @returns {Promise<{labels: number, boundaries: number}>} how many were changed
 */
async function restoreLayout(vacbot, id) {
    const backup = await readBackup(id);
    const map = currentMap(vacbot);
    const overlap = mapOverlap(map.mapSpotAreas || [], backup.rooms);
    if (overlap < MIN_MAP_OVERLAP) {
        throw new Error(`Only ${Math.round(overlap * 100)} % of the current map lies inside the saved rooms, `
            + 'so the robot has probably mapped from a different position. Nothing was changed.');
    }
    const labels = matchRoomLabels(map.mapSpotAreas || [], backup.rooms)
        .filter(({ room, saved }) => room.mapSpotAreaSubType !== saved.subtype || room.mapSpotAreaName !== saved.name);
    const existing = new Set(currentBoundaries(map).map(boundaryKey));
    const boundaries = backup.boundaries.filter((boundary) => !existing.has(boundaryKey(boundary)));

    for (const { room, saved } of labels) {
        await labelRoom(vacbot, room.mapSpotAreaID, Number(saved.subtype), saved.name);
        await sleep(RESTORE_COMMAND_DELAY_MS);
    }
    for (const boundary of boundaries) {
        await addBoundary(vacbot, boundary.type, parseNumbers(boundary.coordinates));
        await sleep(RESTORE_COMMAND_DELAY_MS);
    }
    return { labels: labels.length, boundaries: boundaries.length };
}

/**
 * Returns the share of the current rooms' area that lies inside any saved room.
 * @param {Array<Object>} rooms - the current map's mapSpotAreas
 * @param {Array<Object>} savedRooms - a backup's rooms
 * @returns {number} 0 to 1
 */
function mapOverlap(rooms, savedRooms) {
    const polygons = savedRooms.map((saved) => parsePolygon(saved.boundaries));
    const points = rooms
        .filter((room) => room.mapSpotAreaBoundaries)
        .flatMap((room) => samplePoints(parsePolygon(room.mapSpotAreaBoundaries)));
    const inside = points.filter(([x, y]) => polygons.some((polygon) => containsPoint(polygon, x, y)));
    return inside.length / Math.max(points.length, 1);
}

/**
 * Pairs current rooms with labelled saved rooms by overlap; each saved room labels at most one room.
 * @param {Array<Object>} rooms - the current map's mapSpotAreas
 * @param {Array<Object>} savedRooms - a backup's rooms
 * @returns {Array<{room: Object, saved: Object}>}
 */
function matchRoomLabels(rooms, savedRooms) {
    const labelled = savedRooms
        .filter((saved) => saved.subtype !== '0' || saved.name !== defaultRoomName(saved.id))
        .map((saved) => ({ saved, polygon: parsePolygon(saved.boundaries) }));
    const candidates = rooms
        .filter((room) => room.mapSpotAreaBoundaries)
        .flatMap((room) => {
            const points = samplePoints(parsePolygon(room.mapSpotAreaBoundaries));
            return labelled.map(({ saved, polygon }) => ({
                room,
                saved,
                overlap: points.filter(([x, y]) => containsPoint(polygon, x, y)).length / Math.max(points.length, 1)
            }));
        })
        .filter(({ overlap }) => overlap >= MIN_LABEL_OVERLAP)
        .sort((a, b) => b.overlap - a.overlap);

    const usedRooms = new Set();
    const usedSaved = new Set();
    return candidates.filter(({ room, saved }) => {
        if (usedRooms.has(room) || usedSaved.has(saved)) {
            return false;
        }
        usedRooms.add(room);
        usedSaved.add(saved);
        return true;
    });
}

/**
 * Returns the library's name for a room without a label (0 = A, 1 = B, ...).
 * @param {string} id - room id
 * @returns {string}
 */
function defaultRoomName(id) {
    return String.fromCharCode(65 + Number(id));
}

/**
 * Returns the grid points inside a polygon.
 * @param {Array<[number, number]>} polygon
 * @returns {Array<[number, number]>}
 */
function samplePoints(polygon) {
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const points = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += OVERLAP_SAMPLE_STEP) {
        for (let y = Math.min(...ys); y <= Math.max(...ys); y += OVERLAP_SAMPLE_STEP) {
            if (containsPoint(polygon, x, y)) {
                points.push([x, y]);
            }
        }
    }
    return points;
}

/**
 * Ray-casting point-in-polygon test.
 * @param {Array<[number, number]>} polygon
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function containsPoint(polygon, x, y) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const [xi, yi] = polygon[i];
        const [xj, yj] = polygon[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Parses "x1,y1;x2,y2;..." into points.
 * @param {string} text
 * @returns {Array<[number, number]>}
 */
function parsePolygon(text) {
    const values = parseNumbers(text);
    return values.flatMap((value, index) => (index % 2 === 0 ? [[value, values[index + 1]]] : []));
}

/**
 * Parses the numbers of "[x1,y1,x2,y2]" or "x1,y1;x2,y2".
 * @param {string} text
 * @returns {Array<number>}
 */
function parseNumbers(text) {
    return text.replace(/[[\]]/g, '').split(/[,;]/).filter(Boolean).map(Number);
}

/**
 * Returns the virtual boundaries of a map in backup form.
 * @param {Object} map - an entry of the MapDataObject
 * @returns {Array<{id: string, type: string, coordinates: string}>}
 */
function currentBoundaries(map) {
    return (map.mapVirtualBoundaries || [])
        .filter((boundary) => boundary.mapVirtualBoundaryCoordinates)
        .map((boundary) => ({
            id: boundary.mapVirtualBoundaryID,
            type: boundary.mapVirtualBoundaryType,
            coordinates: boundary.mapVirtualBoundaryCoordinates
        }));
}

/**
 * Identifies a boundary by type and coordinates, so equal boundaries compare equal.
 * @param {{type: string, coordinates: string}} boundary
 * @returns {string}
 */
function boundaryKey({ type, coordinates }) {
    return `${type}:${parseNumbers(coordinates).join(',')}`;
}

/**
 * Returns the map the robot is using.
 * @param {Object} vacbot
 * @returns {Object} an entry of the MapDataObject
 */
function currentMap(vacbot) {
    const map = (vacbot.mapDataObject || []).find((candidate) => candidate.mapIsCurrentMap);
    if (!map) {
        throw new Error('The map has not loaded yet');
    }
    return map;
}

/**
 * Returns the id of the map the robot is using.
 * @param {Object} vacbot
 * @returns {string}
 */
function currentMapID(vacbot) {
    if (!vacbot.currentMapMID) {
        throw new Error('The map has not loaded yet');
    }
    return vacbot.currentMapMID;
}

/**
 * Sends a setMapSubSet command for the current map.
 * @param {Object} vacbot
 * @param {Object} fields - act, type and the act's fields
 */
function setMapSubSet(vacbot, fields) {
    return sendRaw(vacbot, 'setMapSubSet', { mid: currentMapID(vacbot), ...fields });
}

/**
 * Sends a command the library has no wrapper for and resolves with the robot's answer.
 * @param {Object} vacbot
 * @param {string} name - Ecovacs command name
 * @param {Object} payload
 * @returns {Promise<*>}
 */
function sendRaw(vacbot, name, payload) {
    return vacbot.sendCommand(new VacBotCommand(name, payload), { returnPromise: true });
}

/**
 * Loads a saved backup.
 * @param {string} id
 * @returns {Promise<Object>}
 */
async function readBackup(id) {
    return JSON.parse(await fs.readFile(backupPath(id), 'utf8'));
}

/**
 * Returns the file path of a backup, rejecting ids that could leave the backup directory.
 * @param {string} id
 * @returns {string}
 */
function backupPath(id) {
    if (typeof id !== 'string' || !BACKUP_ID_PATTERN.test(id)) {
        throw new Error(`Invalid backup id: ${id}`);
    }
    return path.join(BACKUP_DIR, `${id}.json`);
}

/**
 * @param {string} type
 */
function checkBoundaryType(type) {
    if (!BOUNDARY_TYPES.has(type)) {
        throw new Error(`Invalid boundary type: ${type}`);
    }
}

/**
 * @param {string} id
 */
function checkSubsetID(id) {
    if (typeof id !== 'string' || !SUBSET_ID_PATTERN.test(id)) {
        throw new Error(`Invalid id: ${id}`);
    }
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
    addBoundary,
    deleteBoundary,
    mergeRooms,
    divideRoom,
    labelRoom,
    deleteMap,
    refreshMap,
    saveBackup,
    listBackups,
    deleteBackup,
    restoreRobotBackup,
    restoreLayout
};
