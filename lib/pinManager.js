'use strict';

/**
 * PIN management for Tedee locks via the local Bridge API (>= 1.19).
 *
 * Reads all PINs of a lock and mirrors them as states (one channel per PIN plus a JSON list),
 * and creates / updates / deletes PINs on request (sendTo commands, delete button).
 *
 * The PIN code itself is never written to a state or to the log. It only leaves this module as
 * answer of an explicit `getPin` request with `includeCode: true`.
 */

const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** accepted weekday names (en + de), index = bit position (0 = Monday) */
const WEEKDAY_ALIASES = [
  ['mon', 'monday', 'mo', 'montag'],
  ['tue', 'tuesday', 'di', 'dienstag'],
  ['wed', 'wednesday', 'mi', 'mittwoch'],
  ['thu', 'thursday', 'do', 'donnerstag'],
  ['fri', 'friday', 'fr', 'freitag'],
  ['sat', 'saturday', 'sa', 'samstag'],
  ['sun', 'sunday', 'so', 'sonntag'],
];
const PIN_REGEX = /^[0-9]{5,8}$/;
const ALIAS_MAX_BYTES = 32;
/** interval for checking the PIN list for changes made in the Tedee app */
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * @typedef {object} PinInfo PIN record without the code
 * @property {number} id PIN id assigned by the lock
 * @property {string} alias name of the PIN
 * @property {number | null} startDate validity start, unix seconds (null = unbounded)
 * @property {number | null} endDate validity end, unix seconds (null = unbounded)
 * @property {number | null} dayStartTime daily window start, seconds from midnight (null = unbounded)
 * @property {number | null} dayEndTime daily window end, seconds from midnight (null = unbounded)
 * @property {number | null} weekdays bitmask, bit 0 = Monday ... bit 6 = Sunday (null = every day)
 */

/**
 * @typedef {object} PinInput fields accepted by createPin / updatePin
 * @property {string | number} [pin] PIN code, 5-8 digits
 * @property {string} [alias] name, max. 32 bytes
 * @property {string | number | null} [startDate] date string, unix seconds or ms; null/0 = unbounded
 * @property {string | number | null} [endDate] date string, unix seconds or ms; null/0 = unbounded
 * @property {string | number | null} [dayStartTime] "HH:MM" or seconds from midnight; null = unbounded
 * @property {string | number | null} [dayEndTime] "HH:MM" or seconds from midnight; null = unbounded
 * @property {number | Array<string | number> | null} [weekdays] bitmask or list of days (["Mon", "Sat"] / ["Mo", "Sa"]); null = every day
 */

/**
 * @typedef {object} PinListEntry entry of pins.list
 * @property {number} id PIN id
 * @property {string} alias name
 * @property {boolean} active valid right now
 * @property {number | null} validFrom ms timestamp, null = unbounded
 * @property {number | null} validTo ms timestamp, null = unbounded
 * @property {string} dayStart "HH:MM" or empty
 * @property {string} dayEnd "HH:MM" or empty
 * @property {number} weekdays bitmask
 * @property {string} weekdaysText e.g. "Mon,Sat" or "every day"
 */

/**
 * @typedef {object} PinCommand message of a sendTo command
 * @property {string | number} [lockId] lock id, optional if only one lock exists
 * @property {string | number} [pinId] PIN id (getPin, updatePin, deletePin)
 * @property {boolean} [includeCode] getPin: also return the PIN code
 */

/**
 * @typedef {object} BridgePin PIN record as returned by the bridge
 * @property {number} [id] PIN id
 * @property {string} [alias] name
 * @property {string} [pin] PIN code (only in GET /lock/{id}/pin/{pinId})
 * @property {number | null} [startDate] unix seconds
 * @property {number | null} [endDate] unix seconds
 * @property {number | null} [dayStartTime] seconds from midnight
 * @property {number | null} [dayEndTime] seconds from midnight
 * @property {number | null} [weekdays] bitmask
 */

/**
 * @typedef {object} BridgeError axios error of a bridge request
 * @property {{status?: number, data?: Record<string, unknown>}} [response] HTTP response
 * @property {string} [code] network error code
 * @property {string} [message] message
 */

/**
 * @typedef {ioBroker.Adapter & {
 *   requestClient: import('axios').AxiosInstance,
 *   apiVersion: string,
 *   hashedAPIKey: () => string,
 *   pinCache: Record<string, object>,
 * }} TedeeAdapter
 */

/**
 * Error with a message that can be returned to the caller of a sendTo command.
 */
class PinError extends Error {
  /**
   * @param {string} message message for the caller
   */
  constructor(message) {
    super(message);
    this.name = 'PinError';
  }
}

/**
 * Reads and changes the PINs of the registered locks.
 */
class PinManager {
  /**
   * @param {TedeeAdapter} adapter the Tedee adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
    /** @type {Record<string, {listVersion: number, pins: Map<number, PinInfo>, supported: boolean}>} */
    this.locks = {};
    /**
     * all bridge requests of this module run one after another
     *
     * @type {Promise<unknown>}
     */
    this.queue = Promise.resolve();
    /** @type {ioBroker.Interval | undefined} */
    this.checkInterval = null;
  }

  /**
   * Registers a lock for PIN management.
   *
   * @param {string} lockId device id of the lock
   */
  addLock(lockId) {
    if (!this.locks[lockId]) {
      this.locks[lockId] = { listVersion: 0, pins: new Map(), supported: true };
    }
  }

  /**
   * Loads the PINs of all registered locks and starts the periodic change check.
   *
   * @returns {Promise<void>}
   */
  async start() {
    for (const lockId of Object.keys(this.locks)) {
      await this.load(lockId, true).catch((e) => this.adapter.log.warn(`PIN management ${lockId}: ${e.message}`));
    }
    this.checkInterval = this.adapter.setInterval(() => {
      for (const lockId of Object.keys(this.locks)) {
        this.load(lockId, false).catch((e) => this.adapter.log.debug(`PIN check ${lockId}: ${e.message}`));
      }
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Runs a function after all previously queued bridge requests of this module.
   *
   * @template T
   * @param {() => Promise<T>} fn function to run
   * @returns {Promise<T>} result of fn
   */
  enqueue(fn) {
    // @KI_HINWEIS: the bridge handles one local API request at a time and reads PINs via BLE,
    // parallel PIN requests would only produce 409 / ECONNRESET
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Sends a request to the bridge.
   *
   * @param {string} method HTTP method
   * @param {string} path path below /v1.0
   * @param {{data?: object, params?: object, retry?: boolean}} [options] body, query, allow automatic retries (GET only)
   * @returns {Promise<import('axios').AxiosResponse>} response
   */
  request(method, path, options = {}) {
    const a = this.adapter;
    /** @type {Record<string, string>} */
    const headers = { accept: '*/*', api_token: a.hashedAPIKey() };
    if (options.data) {
      headers['Content-Type'] = 'application/json';
    }
    return a.requestClient({
      method,
      url: `http://${a.config.bridgeip}/${a.apiVersion}${path}`,
      headers,
      data: options.data,
      params: options.params,
      // the bridge streams long PIN lists, ~20 s per 100 PINs
      timeout: 2 * 60 * 1000,
      validateStatus: (/** @type {number} */ status) => (status >= 200 && status < 300) || status === 304,
      // writes are never repeated automatically, a timeout does not prove that nothing changed
      'axios-retry': options.retry ? undefined : { retries: 0 },
    });
  }

  /**
   * Converts a bridge error into a readable message, never includes the request body.
   *
   * @param {BridgeError} error axios error
   * @returns {string} message
   */
  describeError(error) {
    const status = error && error.response && error.response.status;
    const description = error && error.response && error.response.data && error.response.data['error-description'];
    switch (status) {
      case 400:
        return `invalid request${description ? `: ${description}` : ''}`;
      case 404:
        return 'lock or PIN not found';
      case 405:
        return 'lock is disconnected';
      case 406:
        return `lock reported an error${description ? `: ${description}` : ''}`;
      case 409:
        return 'another PIN operation is in progress (e.g. Tedee app), please try again later';
      default:
        return (error && (error.code || error.message)) || 'unknown error';
    }
  }

  /**
   * Loads the PIN list (and the details of every PIN) of a lock and updates the states.
   *
   * @param {string} lockId device id of the lock
   * @param {boolean} force reload even if listVersion is unchanged
   * @returns {Promise<void>}
   */
  load(lockId, force) {
    return this.enqueue(async () => {
      this.addLock(lockId);
      const lock = this.locks[lockId];
      if (!lock.supported) {
        return;
      }
      let res;
      try {
        res = await this.request('get', `/lock/${lockId}/pin`, {
          params: !force && lock.listVersion ? { listVersion: lock.listVersion } : undefined,
          retry: true,
        });
      } catch (error) {
        const status = error && error.response && error.response.status;
        if (status === 400 || status === 404) {
          lock.supported = false;
          this.adapter.log.warn(`Lock ${lockId}: bridge does not support the PIN API (Bridge API >= 1.19 required)`);
          return;
        }
        throw new PinError(this.describeError(error));
      }
      if (res.status === 304) {
        await this.updateActive(lockId);
        return;
      }
      const list = res.data && Array.isArray(res.data.pins) ? res.data.pins : [];
      /** @type {Map<number, PinInfo>} */
      const pins = new Map();
      for (const entry of list) {
        if (!entry || entry.id == null) {
          continue;
        }
        try {
          const detail = await this.request('get', `/lock/${lockId}/pin/${entry.id}`, { retry: true });
          pins.set(Number(entry.id), this.toPinInfo(detail.data, entry));
        } catch (error) {
          // keep the PIN with the data of the list, details can be loaded with the next check
          this.adapter.log.debug(`PIN ${entry.id} of lock ${lockId}: ${this.describeError(error)}`);
          pins.set(Number(entry.id), this.toPinInfo({}, entry));
        }
      }
      lock.pins = pins;
      lock.listVersion = Number(res.data && res.data.listVersion) || 0;
      this.updateAliasCache(lockId);
      await this.writeStates(lockId);
      this.adapter.log.info(`Loaded ${pins.size} PINs for lock ${lockId}`);
    });
  }

  /**
   * Builds a PinInfo from a bridge response, the PIN code is dropped.
   *
   * @param {BridgePin} detail response of GET /lock/{id}/pin/{pinId}
   * @param {BridgePin} entry entry of the PIN list
   * @returns {PinInfo} PIN without code
   */
  toPinInfo(detail, entry) {
    /**
     * @param {number | null | undefined} value raw value
     * @returns {number | null} number, null for unbounded (null or 0)
     */
    const bound = (value) => (value == null || Number(value) === 0 ? null : Number(value));
    return {
      id: Number(entry.id),
      alias: (detail && detail.alias) || entry.alias || '',
      startDate: bound(detail.startDate),
      endDate: bound(detail.endDate),
      dayStartTime: detail.dayStartTime == null ? null : Number(detail.dayStartTime),
      dayEndTime: detail.dayEndTime == null || Number(detail.dayEndTime) === 0 ? null : Number(detail.dayEndTime),
      weekdays: detail.weekdays == null ? null : Number(detail.weekdays),
    };
  }

  /**
   * Shares the aliases with lastAction.pinAlias, so no second PIN list request is needed.
   *
   * @param {string} lockId device id of the lock
   */
  updateAliasCache(lockId) {
    const a = this.adapter;
    const lock = this.locks[lockId];
    /** @type {Record<number, string>} */
    const aliases = {};
    for (const pin of lock.pins.values()) {
      aliases[pin.id] = pin.alias;
    }
    a.pinCache[lockId] = { listVersion: lock.listVersion, aliases, supported: true, loading: null };
  }

  /**
   * Checks whether a PIN is valid right now (date range, weekday, daily window).
   * Uses the time zone of the ioBroker host, which should match the lock.
   *
   * @param {PinInfo} pin PIN
   * @param {Date} [now] point in time
   * @returns {boolean} true if the PIN can be used now
   */
  isActive(pin, now = new Date()) {
    const ts = now.getTime() / 1000;
    if (pin.startDate && ts < pin.startDate) {
      return false;
    }
    if (pin.endDate && ts > pin.endDate) {
      return false;
    }
    const weekday = (now.getDay() + 6) % 7;
    if (pin.weekdays != null && !(pin.weekdays & (1 << weekday))) {
      return false;
    }
    if (pin.dayStartTime || pin.dayEndTime) {
      const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
      const start = pin.dayStartTime || 0;
      const end = pin.dayEndTime || 86399;
      if (seconds < start || seconds > end) {
        return false;
      }
    }
    return true;
  }

  /**
   * Formats seconds from midnight as HH:MM.
   *
   * @param {number | null} seconds seconds from midnight
   * @returns {string} "HH:MM" or empty string
   */
  formatTime(seconds) {
    if (seconds == null) {
      return '';
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /**
   * Formats a weekday bitmask.
   *
   * @param {number | null} weekdays bitmask
   * @returns {string} e.g. "Mon,Tue" or "every day"
   */
  formatWeekdays(weekdays) {
    if (weekdays == null || weekdays === 127) {
      return 'every day';
    }
    return WEEKDAY_NAMES.filter((_, i) => weekdays & (1 << i)).join(',');
  }

  /**
   * Builds the entry of a PIN for pins.list.
   *
   * @param {PinInfo} pin PIN
   * @returns {PinListEntry} JSON entry
   */
  toListEntry(pin) {
    return {
      id: pin.id,
      alias: pin.alias,
      active: this.isActive(pin),
      validFrom: pin.startDate ? pin.startDate * 1000 : null,
      validTo: pin.endDate ? pin.endDate * 1000 : null,
      dayStart: this.formatTime(pin.dayStartTime),
      dayEnd: this.formatTime(pin.dayEndTime),
      weekdays: pin.weekdays == null ? 127 : pin.weekdays,
      weekdaysText: this.formatWeekdays(pin.weekdays),
    };
  }

  /**
   * Creates / updates all PIN states of a lock and removes channels of deleted PINs.
   *
   * @param {string} lockId device id of the lock
   * @returns {Promise<void>}
   */
  async writeStates(lockId) {
    const a = this.adapter;
    const lock = this.locks[lockId];
    const base = `${lockId}.pins`;
    await a.extendObjectAsync(base, { type: 'channel', common: { name: 'PINs (keypad)' }, native: {} });
    await this.ensureState(`${base}.count`, 'Number of PINs', 'number', 'value', false);
    await this.ensureState(`${base}.listVersion`, 'Version of the PIN list on the lock', 'number', 'value', false);
    await this.ensureState(`${base}.list`, 'All PINs as JSON (without codes)', 'string', 'json', false);
    await this.ensureState(`${base}.refresh`, 'Reload PINs from the lock', 'boolean', 'button', true);

    for (const pin of lock.pins.values()) {
      const p = `${base}.${pin.id}`;
      const entry = this.toListEntry(pin);
      await a.extendObjectAsync(p, { type: 'channel', common: { name: pin.alias || `PIN ${pin.id}` }, native: {} });
      await this.ensureState(`${p}.alias`, 'Name', 'string', 'text', false);
      await this.ensureState(`${p}.active`, 'Valid right now', 'boolean', 'indicator', false);
      await this.ensureState(`${p}.validFrom`, 'Valid from (null = unbounded)', 'number', 'date.start', false);
      await this.ensureState(`${p}.validTo`, 'Valid to (null = unbounded)', 'number', 'date.end', false);
      await this.ensureState(`${p}.dayStart`, 'Daily window start (HH:MM)', 'string', 'text', false);
      await this.ensureState(`${p}.dayEnd`, 'Daily window end (HH:MM)', 'string', 'text', false);
      await this.ensureState(`${p}.weekdays`, 'Weekdays bitmask (1 = Mon ... 64 = Sun)', 'number', 'value', false);
      await this.ensureState(`${p}.weekdaysText`, 'Weekdays', 'string', 'text', false);
      await this.ensureState(`${p}.delete`, 'Delete this PIN from the lock', 'boolean', 'button', true);
      await a.setStateAsync(`${p}.alias`, pin.alias, true);
      await a.setStateAsync(`${p}.active`, entry.active, true);
      await a.setStateAsync(`${p}.validFrom`, entry.validFrom, true);
      await a.setStateAsync(`${p}.validTo`, entry.validTo, true);
      await a.setStateAsync(`${p}.dayStart`, entry.dayStart, true);
      await a.setStateAsync(`${p}.dayEnd`, entry.dayEnd, true);
      await a.setStateAsync(`${p}.weekdays`, entry.weekdays, true);
      await a.setStateAsync(`${p}.weekdaysText`, entry.weekdaysText, true);
    }

    // remove channels of PINs that no longer exist on the lock
    const prefix = `${a.namespace}.${base}.`;
    const channels = await a.getObjectViewAsync('system', 'channel', { startkey: prefix, endkey: `${prefix}香` });
    for (const row of channels.rows || []) {
      const pinId = Number(row.id.substring(prefix.length));
      if (!row.id.substring(prefix.length).includes('.') && !lock.pins.has(pinId)) {
        await a.delObjectAsync(row.id, { recursive: true });
      }
    }

    await a.setStateAsync(`${base}.count`, lock.pins.size, true);
    await a.setStateAsync(`${base}.listVersion`, lock.listVersion, true);
    await a.setStateAsync(`${base}.list`, JSON.stringify(this.getList(lockId)), true);
  }

  /**
   * Creates a state object if needed.
   *
   * @param {string} id state id
   * @param {string} name name
   * @param {ioBroker.CommonType} type type
   * @param {string} role role
   * @param {boolean} write writable
   * @returns {Promise<void>}
   */
  async ensureState(id, name, type, role, write) {
    await this.adapter.extendObjectAsync(id, {
      type: 'state',
      common: {
        name,
        type,
        role,
        read: !write || role !== 'button',
        write,
        def: role === 'button' ? false : undefined,
      },
      native: {},
    });
  }

  /**
   * Recalculates the "active" states, called with every poll of the lock status.
   *
   * @param {string} [lockId] only this lock, default all
   * @returns {Promise<void>}
   */
  async updateActive(lockId) {
    const ids = lockId ? [lockId] : Object.keys(this.locks);
    for (const id of ids) {
      const lock = this.locks[id];
      if (!lock || !lock.supported || lock.pins.size === 0) {
        continue;
      }
      for (const pin of lock.pins.values()) {
        await this.adapter.setStateChangedAsync(`${id}.pins.${pin.id}.active`, this.isActive(pin), true);
      }
      await this.adapter.setStateChangedAsync(`${id}.pins.list`, JSON.stringify(this.getList(id)), true);
    }
  }

  /**
   * Returns the PIN list of a lock (without codes).
   *
   * @param {string} lockId device id of the lock
   * @returns {PinListEntry[]} entries as in pins.list
   */
  getList(lockId) {
    const lock = this.locks[lockId];
    return lock ? [...lock.pins.values()].map((pin) => this.toListEntry(pin)) : [];
  }

  /**
   * Determines the lock for a command. Without lockId the only lock is used.
   *
   * @param {string | number | undefined} lockId lock id from the message
   * @returns {string} lock id
   */
  resolveLock(lockId) {
    const ids = Object.keys(this.locks);
    if (lockId == null || lockId === '') {
      if (ids.length === 1) {
        return ids[0];
      }
      throw new PinError(`lockId is required (available: ${ids.join(', ')})`);
    }
    const id = String(lockId);
    if (!this.locks[id]) {
      throw new PinError(`unknown lockId ${id} (available: ${ids.join(', ')})`);
    }
    if (!this.locks[id].supported) {
      throw new PinError(`lock ${id} does not support the PIN API`);
    }
    return id;
  }

  /**
   * Parses the PIN id from a message.
   *
   * @param {string | number | undefined} pinId PIN id
   * @returns {number} PIN id
   */
  parsePinId(pinId) {
    const id = Number(pinId);
    if (!Number.isInteger(id) || id < 0) {
      throw new PinError('pinId must be a number');
    }
    return id;
  }

  /**
   * Converts a date input to unix seconds, 0 = unbounded.
   *
   * @param {string | number | Array<string | number> | null | undefined} value date string, unix seconds, ms or null.
   *   A plain date ("2026-11-30") is local time, start of the day (startDate) or end of the day (endDate).
   * @param {string} field field name for the error message
   * @returns {number} unix seconds
   */
  parseDate(value, field) {
    if (value == null || value === '' || value === 0) {
      return 0;
    }
    if (Array.isArray(value)) {
      throw new PinError(`${field}: invalid date`);
    }
    if (typeof value === 'number') {
      // values above 1e11 are milliseconds
      return Math.floor(value > 1e11 ? value / 1000 : value);
    }
    let text = String(value).trim();
    // a plain date means local time: start of the day for startDate, end of the day for endDate
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
      text += field === 'endDate' ? 'T23:59:59' : 'T00:00:00';
    }
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) {
      throw new PinError(`${field}: invalid date "${value}"`);
    }
    return Math.floor(ms / 1000);
  }

  /**
   * Converts a time input to seconds from midnight.
   *
   * @param {string | number | Array<string | number> | null | undefined} value "HH:MM", "HH:MM:SS" or seconds
   * @param {string} field field name for the error message
   * @returns {number} seconds from midnight, 0 = unbounded
   */
  parseTime(value, field) {
    if (value == null || value === '') {
      return 0;
    }
    let seconds = NaN;
    if (Array.isArray(value)) {
      throw new PinError(`${field}: invalid time`);
    }
    if (typeof value === 'number') {
      seconds = value;
    } else {
      const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(value).trim());
      if (match) {
        seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
      }
    }
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 86399) {
      throw new PinError(`${field}: invalid time "${value}", use "HH:MM"`);
    }
    return seconds;
  }

  /**
   * Converts a weekday input to the bitmask.
   *
   * @param {number | string | Array<string | number> | null | undefined} value bitmask or list of weekday names / numbers (1 = Monday ... 7 = Sunday)
   * @returns {number} bitmask
   */
  parseWeekdays(value) {
    if (value == null || value === '') {
      return 127;
    }
    if (typeof value === 'number') {
      if (!Number.isInteger(value) || value < 1 || value > 127) {
        throw new PinError('weekdays: bitmask must be 1 ... 127');
      }
      return value;
    }
    const list = Array.isArray(value) ? value : String(value).split(',');
    let mask = 0;
    for (const item of list) {
      let index = -1;
      if (typeof item === 'number') {
        index = item - 1;
      } else {
        const name = String(item).trim().toLowerCase();
        index = WEEKDAY_ALIASES.findIndex((aliases) => aliases.includes(name));
      }
      if (index < 0 || index > 6) {
        throw new PinError(`weekdays: unknown day "${item}"`);
      }
      mask |= 1 << index;
    }
    if (mask === 0) {
      throw new PinError('weekdays: at least one day is required');
    }
    return mask;
  }

  /**
   * Builds and validates the request body for create / update.
   *
   * @param {PinInput} input fields from the message
   * @param {BridgePin} [current] current PIN record (update), contains the code
   * @returns {object} request body
   */
  buildBody(input, current) {
    const has = (/** @type {string} */ key) => Object.prototype.hasOwnProperty.call(input, key);
    const pin = has('pin') ? String(input.pin) : current && current.pin;
    if (!pin || !PIN_REGEX.test(pin)) {
      throw new PinError('pin must be a string of 5 to 8 digits');
    }
    const alias = has('alias') ? String(input.alias || '') : (current && current.alias) || '';
    if (Buffer.byteLength(alias, 'utf8') > ALIAS_MAX_BYTES) {
      throw new PinError(`alias is too long (max. ${ALIAS_MAX_BYTES} bytes)`);
    }
    /**
     * @param {'startDate' | 'endDate' | 'dayStartTime' | 'dayEndTime' | 'weekdays'} key field
     * @param {(value: string | number | Array<string | number> | null | undefined) => number} parse parser for new values
     * @param {number} fallback value if neither given nor present
     * @returns {number} value
     */
    const value = (key, parse, fallback) => {
      if (has(key)) {
        return parse(input[key]);
      }
      const old = current && current[key];
      return old == null ? fallback : Number(old);
    };
    const body = {
      pin,
      alias,
      startDate: value('startDate', (v) => this.parseDate(v, 'startDate'), 0),
      endDate: value('endDate', (v) => this.parseDate(v, 'endDate'), 0),
      dayStartTime: value('dayStartTime', (v) => this.parseTime(v, 'dayStartTime'), 0),
      dayEndTime: value('dayEndTime', (v) => this.parseTime(v, 'dayEndTime'), 0),
      weekdays: value('weekdays', (v) => this.parseWeekdays(v), 127),
    };
    if (body.startDate && body.endDate && body.endDate <= body.startDate) {
      throw new PinError('endDate must be after startDate');
    }
    if (body.dayStartTime && body.dayEndTime && body.dayEndTime < body.dayStartTime) {
      throw new PinError('dayEndTime must not be before dayStartTime');
    }
    return body;
  }

  /**
   * Handles a sendTo command.
   *
   * @param {string} command getPins | getPin | createPin | updatePin | deletePin | refreshPins
   * @param {PinCommand & PinInput} message message object
   * @returns {Promise<object>} answer for the caller
   */
  async handleCommand(command, message) {
    const msg = message && typeof message === 'object' ? message : {};
    const lockId = this.resolveLock(msg.lockId);
    switch (command) {
      case 'getPins':
        return { lockId, pins: this.getList(lockId) };

      case 'getPin': {
        const pinId = this.parsePinId(msg.pinId);
        const res = await this.enqueue(() =>
          this.request('get', `/lock/${lockId}/pin/${pinId}`, { retry: true }),
        ).catch((error) => {
          throw new PinError(this.describeError(error));
        });
        /** @type {PinListEntry & {pin?: string}} */
        const result = this.toListEntry(this.toPinInfo(res.data, { id: pinId, alias: '' }));
        if (msg.includeCode === true) {
          result.pin = res.data.pin;
        }
        return { lockId, pin: result };
      }

      case 'createPin': {
        const body = this.buildBody(msg);
        const res = await this.enqueue(() => this.request('post', `/lock/${lockId}/pin`, { data: body })).catch(
          (error) => {
            throw new PinError(this.describeError(error));
          },
        );
        const pinId = res.data && res.data.id;
        this.adapter.log.info(`Lock ${lockId}: PIN "${body.alias}" created (id ${pinId})`);
        await this.load(lockId, true);
        return { lockId, pinId };
      }

      case 'updatePin': {
        const pinId = this.parsePinId(msg.pinId);
        await this.enqueue(async () => {
          const current = await this.request('get', `/lock/${lockId}/pin/${pinId}`, { retry: true });
          const body = this.buildBody(msg, current.data);
          await this.request('put', `/lock/${lockId}/pin/${pinId}`, { data: body });
        }).catch((error) => {
          throw error instanceof PinError ? error : new PinError(this.describeError(error));
        });
        this.adapter.log.info(`Lock ${lockId}: PIN ${pinId} updated`);
        await this.load(lockId, true);
        return { lockId, pinId };
      }

      case 'deletePin': {
        const pinId = this.parsePinId(msg.pinId);
        await this.deletePin(lockId, pinId);
        return { lockId, pinId };
      }

      case 'refreshPins':
        await this.load(lockId, true);
        return { lockId, pins: this.getList(lockId) };

      default:
        throw new PinError(`unknown command ${command}`);
    }
  }

  /**
   * Deletes a PIN from the lock and reloads the list.
   *
   * @param {string} lockId device id of the lock
   * @param {number} pinId PIN id
   * @returns {Promise<void>}
   */
  async deletePin(lockId, pinId) {
    await this.enqueue(() => this.request('delete', `/lock/${lockId}/pin/${pinId}`)).catch((error) => {
      throw new PinError(this.describeError(error));
    });
    this.adapter.log.info(`Lock ${lockId}: PIN ${pinId} deleted`);
    await this.load(lockId, true);
  }

  /**
   * Handles writes to pins.refresh and pins.<id>.delete.
   *
   * @param {string} lockId device id of the lock
   * @param {string[]} rest id parts after "<lockId>.pins"
   * @returns {Promise<void>}
   */
  async handleStateChange(lockId, rest) {
    try {
      if (rest.length === 1 && rest[0] === 'refresh') {
        await this.load(this.resolveLock(lockId), true);
      } else if (rest.length === 2 && rest[1] === 'delete') {
        await this.deletePin(this.resolveLock(lockId), this.parsePinId(rest[0]));
      }
    } catch (error) {
      this.adapter.log.warn(`PIN management: ${error.message}`);
    }
  }
}

module.exports = { PinManager, PinError };
