'use strict';

/**
 * Object definitions for the data of the Tedee Bridge API (v1.0, bridge firmware 2.2).
 *
 * Roles follow https://github.com/ioBroker/ioBroker.docs/blob/master/docs/en/dev/stateroles.md
 * and the "lock" template of the ioBroker type-detector.
 *
 * @typedef {object} FieldDef
 * @property {string} name object name
 * @property {ioBroker.CommonType} type common.type
 * @property {string} role common.role
 * @property {string} [unit] common.unit
 * @property {Record<number, string>} [states] value -> text
 * @property {(value: unknown) => ioBroker.StateValue} [convert] converts the API value
 */

/**
 * The bridge sends booleans as 0/1.
 *
 * @param {unknown} value API value
 * @returns {boolean} converted value
 */
const toBool = (value) => value === true || value === 1 || value === '1';

/** Lock states of GET /lock and the lock-status-changed webhook */
const LOCK_STATES = {
  0: 'Uncalibrated',
  1: 'Calibrating',
  2: 'Unlocked',
  3: 'Semi locked',
  4: 'Unlocking',
  5: 'Locking',
  6: 'Locked',
  7: 'Pulled',
  8: 'Pulling',
  9: 'Unknown',
  18: 'Updating',
  255: 'Unpulling',
};

/** Device types (10 = Keypad PRO determined with a Keypad PRO, not documented) */
const DEVICE_TYPES = {
  1: 'Bridge',
  2: 'Lock PRO',
  3: 'Keypad',
  4: 'Lock GO',
  5: 'Gate',
  10: 'Keypad PRO',
};

/** Door sensor state */
const DOOR_STATES = {
  0: 'Not paired',
  1: 'Disconnected',
  2: 'Opened',
  3: 'Closed',
  4: 'Uncalibrated',
};

/** @type {Record<string, FieldDef>} fields of a lock (GET /lock and webhooks) */
const DEVICE_FIELDS = {
  name: { name: 'Name', type: 'string', role: 'info.name' },
  type: { name: 'Device type', type: 'number', role: 'value', states: DEVICE_TYPES },
  id: { name: 'Device id', type: 'number', role: 'value' },
  serialNumber: { name: 'Serial number', type: 'string', role: 'info.serial' },
  isConnected: { name: 'Connected to the bridge', type: 'boolean', role: 'indicator.reachable', convert: toBool },
  rssi: { name: 'Signal strength', type: 'number', role: 'value.rssi', unit: 'dBm' },
  deviceRevision: { name: 'Hardware revision', type: 'number', role: 'value' },
  version: { name: 'Firmware version', type: 'string', role: 'info.firmware' },
  state: { name: 'Lock state', type: 'number', role: 'value.lock', states: LOCK_STATES },
  jammed: { name: 'Jammed', type: 'boolean', role: 'indicator.error', convert: toBool },
  doorState: { name: 'Door sensor', type: 'number', role: 'value', states: DOOR_STATES },
  batteryLevel: { name: 'Battery level', type: 'number', role: 'value.battery', unit: '%' },
  isCharging: { name: 'Charging', type: 'boolean', role: 'indicator', convert: toBool },
};

/** @type {Record<string, FieldDef>} channel deviceSettings of a lock */
const SETTINGS_FIELDS = {
  autoLockEnabled: { name: 'Auto lock', type: 'boolean', role: 'indicator', convert: toBool },
  autoLockDelay: { name: 'Auto lock delay', type: 'number', role: 'value', unit: 's' },
  autoLockImplicitEnabled: {
    name: 'Auto lock after closing the door',
    type: 'boolean',
    role: 'indicator',
    convert: toBool,
  },
  autoLockImplicitDelay: { name: 'Auto lock delay after closing the door', type: 'number', role: 'value', unit: 's' },
  pullSpringEnabled: { name: 'Pull spring', type: 'boolean', role: 'indicator', convert: toBool },
  pullSpringDuration: { name: 'Pull spring duration', type: 'number', role: 'value', unit: 's' },
  autoPullSpringEnabled: { name: 'Auto pull spring after unlock', type: 'boolean', role: 'indicator', convert: toBool },
  postponedLockEnabled: { name: 'Postponed lock', type: 'boolean', role: 'indicator', convert: toBool },
  postponedLockDelay: { name: 'Postponed lock delay', type: 'number', role: 'value', unit: 's' },
  buttonLockEnabled: { name: 'Lock with the button', type: 'boolean', role: 'indicator', convert: toBool },
  buttonUnlockEnabled: { name: 'Unlock with the button', type: 'boolean', role: 'indicator', convert: toBool },
};

/** @type {Record<string, FieldDef>} fields of GET /bridge and the backend-connection-changed webhook */
const BRIDGE_FIELDS = {
  name: { name: 'Name', type: 'string', role: 'info.name' },
  serialNumber: { name: 'Serial number', type: 'string', role: 'info.serial' },
  ssid: { name: 'WiFi network', type: 'string', role: 'text' },
  isConnected: { name: 'Connected to the Tedee cloud', type: 'boolean', role: 'indicator', convert: toBool },
  version: { name: 'Firmware version', type: 'string', role: 'info.firmware' },
  wifiVersion: { name: 'WiFi firmware version', type: 'string', role: 'text' },
  currentTime: { name: 'Bridge time', type: 'string', role: 'date' },
};

/**
 * Webhook keys that only address the device or belong to lastAction.
 * `source` and `user_id` are evaluated in the channel lastAction.
 */
const IGNORED_KEYS = new Set(['deviceId', 'deviceType', 'source', 'user_id']);

/**
 * Objects of older versions that are replaced by this definition (removed on start).
 * `remote.lock` had the inverse meaning of the ioBroker role `switch.lock`, see `remote.open`.
 */
const OBSOLETE_STATES = ['remote.lock', 'source', 'user_id', 'deviceId', 'deviceType'];

/**
 * Generic definition for fields the adapter does not know yet (newer bridge firmware).
 *
 * @param {string} key API key
 * @param {unknown} value API value
 * @returns {FieldDef | null} definition or null for objects/arrays
 */
function genericField(key, value) {
  if (typeof value === 'number') {
    return { name: key, type: 'number', role: 'value' };
  }
  if (typeof value === 'boolean') {
    return { name: key, type: 'boolean', role: 'indicator' };
  }
  if (typeof value === 'string') {
    return { name: key, type: 'string', role: 'text' };
  }
  return null;
}

module.exports = {
  toBool,
  LOCK_STATES,
  DEVICE_TYPES,
  DEVICE_FIELDS,
  SETTINGS_FIELDS,
  BRIDGE_FIELDS,
  IGNORED_KEYS,
  OBSOLETE_STATES,
  genericField,
};
