'use strict';

const { EcovacsAPI } = require('ecovacs-deebot');

const CLIENT_DEVICE_ID_PATTERN = /^[a-zA-Z0-9.\-_:]+$/;

/**
 * Reads and validates the connection settings from the environment.
 * @returns {{accountId: string, password: string, countryCode: string, deviceNumber: number, clientDeviceId: string, authDomain: string}}
 */
function readSettings() {
    const settings = {
        accountId: process.env.ECOVACS_ACCOUNT_ID,
        password: process.env.ECOVACS_PASSWORD,
        countryCode: process.env.ECOVACS_COUNTRY_CODE || 'DE',
        deviceNumber: Number(process.env.ECOVACS_DEVICE_NUMBER || 0),
        clientDeviceId: (process.env.ECOVACS_CLIENT_DEVICE_ID || '').trim(),
        authDomain: process.env.ECOVACS_AUTH_DOMAIN || ''
    };
    if (!settings.accountId || !settings.password) {
        throw new Error('ECOVACS_ACCOUNT_ID and ECOVACS_PASSWORD must be set.');
    }
    // A fixed client device id keeps Ecovacs from asking for verification on every container start.
    if (!CLIENT_DEVICE_ID_PATTERN.test(settings.clientDeviceId)) {
        throw new Error('ECOVACS_CLIENT_DEVICE_ID must be set and may only contain letters, digits, dots, hyphens, colons and underscores.');
    }
    return settings;
}

/**
 * Creates the API client for the configured account region and client device id.
 * @param {ReturnType<typeof readSettings>} settings
 * @returns {EcovacsAPI}
 */
function createApi(settings) {
    const deviceId = EcovacsAPI.getDeviceId(settings.clientDeviceId, settings.deviceNumber);
    return new EcovacsAPI(deviceId, settings.countryCode, '', settings.authDomain);
}

/**
 * Logs in (running device verification if Ecovacs requires it) and returns the robot.
 * @param {EcovacsAPI} api - from createApi(); also used to resend verification codes
 * @param {ReturnType<typeof readSettings>} settings
 * @param {function(boolean): Promise<string>} promptForCode - asks for the e-mailed code;
 *   receives true when the previous code was invalid
 * @returns {Promise<Object>} the robot (EcovacsDevice), not yet connected
 */
async function connectRobot(api, settings, promptForCode) {
    await loginWithVerification(api, settings, promptForCode);

    const devices = await api.devices();
    const device = devices[settings.deviceNumber];
    if (!device) {
        throw new Error(`No robot at index ${settings.deviceNumber} in this account.`);
    }
    return api.getDeviceObj(device);
}

/**
 * Logs in; on response code 1013 requests an e-mailed code and confirms it,
 * asking again while the code is invalid.
 * @param {EcovacsAPI} api
 * @param {ReturnType<typeof readSettings>} settings
 * @param {function(boolean): Promise<string>} promptForCode
 */
async function loginWithVerification(api, settings, promptForCode) {
    try {
        await api.connect(settings.accountId, EcovacsAPI.md5(settings.password));
        return;
    } catch (error) {
        if (!(error instanceof EcovacsAPI.DeviceVerificationRequired)) {
            throw error;
        }
    }
    await api.requestDeviceVerificationCode();
    for (let previousCodeInvalid = false; ; previousCodeInvalid = true) {
        try {
            await api.verifyDevice(await promptForCode(previousCodeInvalid));
            return;
        } catch (error) {
            if (!(error instanceof EcovacsAPI.InvalidVerificationCode)) {
                throw error;
            }
        }
    }
}

module.exports = { readSettings, createApi, connectRobot };
