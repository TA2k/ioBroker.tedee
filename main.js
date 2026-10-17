'use strict';

/*
 * Created with @iobroker/create-adapter v2.5.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require('@iobroker/adapter-core');
const axios = require('axios').default;
const Json2iob = require('json2iob');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const bodyParser = require('body-parser');
const axiosRetry = require('axios-retry').default;

class Tedee extends utils.Adapter {
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  constructor(options) {
    super({
      ...options,
      name: 'tedee',
    });

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('unload', this.onUnload.bind(this));
    this.deviceArray = [];
    this.userAgent = 'ioBroker v' + this.version;
    this.apiVersion = 'v1.0';
    this.json2iob = new Json2iob(this);

    this.requestClient = axios.create({
      withCredentials: true,
      headers: { 'user-agent': this.userAgent },
      timeout: 3 * 60 * 1000, //3min client timeout
    });
    //retry on 405-599 and timeout
    //calculate a new header for each retry
    // @KI_HINWEIS: Lock commands (lock/unlock/pull) disable retries per request via
    // the 'axios-retry' request option. A 405/406 or a socket reset after a command
    // does not prove the motor did not move, so repeating it could unlock a door twice.

    axiosRetry(this.requestClient, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      onRetry: (retryCount, err, cfg) => {
        if (err.response) {
          this.log.warn(`Retrying request to ${cfg.url} after ${err.response.status} ${err.response.statusText}`);
        } else {
          this.log.warn(`Retrying request to ${cfg.url} after ${err.code}`);
        }
        cfg.headers.api_token = this.hashedAPIKey();
      },
      retryCondition: (error) => {
        return (
          error.code !== 'ECONNABORTED' &&
          (!error.response || (error.response.status >= 405 && error.response.status <= 599))
        );
      },
    });
    this.updateTimeout = null;
    this.isUnloading = false;
    this.session = {};
    /**
     * Webhook "source" values of lock-status-changed events.
     * @KI_HINWEIS: not documented in the Bridge API. Values determined with a Lock PRO,
     * Keypad PRO and Bridge FW 2.2.48155. Unknown values are kept as raw number.
     * @type {Record<number, string>}
     */
    this.actionSources = {
      1: 'Button / manual',
      2: 'App / API',
      7: 'Auto pull spring',
      10: 'Keypad',
      22: 'Keypad (pull spring)',
      23: 'Fingerprint',
      24: 'Fingerprint (pull spring)',
    };
    /** sources whose user_id is the PIN id on the lock */
    this.pinSources = [10, 22];
    /**
     * PIN alias cache per lock.
     * @type {Record<string, {listVersion: number, aliases: Record<number, string>, supported: boolean, loading: Promise<void> | null}>}
     */
    this.pinCache = {};
    /** @type {Record<string, number>} time of the last lastAction update per lock */
    this.lastActionTime = {};
    this.states = {
      state: {
        0: 'Uncalibrated',
        1: 'Calibrating',
        2: 'Unlocked',
        3: 'SemiLocked',
        4: 'Unlocking',
        5: 'Locking',
        6: 'Locked',
        7: 'Pulled',
        8: 'Pulling',
        9: 'Unknown',
        18: 'Updating',
        255: 'Unpulling',
      },
      type: {
        1: 'Bridge',
        2: 'Lock PRO',
        3: 'Keypad',
        4: 'Lock GO',
        5: 'Gate',
      },
    };
  }

  /**
   * Is called when databases are connected and adapter received configuration.
   */
  async onReady() {
    // Reset the connection indicator during startup
    this.setState('info.connection', false, true);
    if (this.config.interval < 1) {
      this.log.info('Set interval to minimum 1');
      this.config.interval = 1;
    }
    if (this.config.interval > 2147483647) {
      this.log.info('Set interval to maximum 2147483647');
      this.config.interval = 2147483647;
    }
    if (!this.config.bridgeip || !this.config.token) {
      this.log.error('Please set Ip and bridge token in the instance settings');
      return;
    }

    this.subscribeStates('*');
    await this.getDeviceList();
    await this.sleep(1500);
    await this.startWebhooks();
    this.scheduleUpdate();
  }

  /**
   * Schedules the next backup poll of all locks.
   * @KI_HINWEIS: setTimeout chain instead of setInterval. The bridge handles only one
   * local API request at a time, so a new poll must not start before the previous
   * one (incl. retries, up to 3 min timeout) has finished.
   * @returns {void}
   */
  scheduleUpdate() {
    if (this.isUnloading) {
      return;
    }
    this.updateTimeout && clearTimeout(this.updateTimeout);
    this.updateTimeout = setTimeout(async () => {
      this.updateTimeout = null;
      await this.updateDevices();
      this.scheduleUpdate();
    }, this.config.interval * 1000);
  }

  /**
   * Determines the address the bridge uses to reach the webhook server.
   * Order: instance setting "callbackHost" -> first non-internal IPv4 of this system.
   * IPv6 addresses are wrapped in brackets so they can be used inside a URL.
   * @KI_HINWEIS: this.host is the ioBroker host *name* (e.g. "iobroker"), which the
   * bridge usually cannot resolve. Webhooks were registered but never delivered.
   * @returns {string | null} host part for the callback URL or null if none was found
   */
  getCallbackHost() {
    const configured = (this.config.callbackHost || '').toString().trim();
    if (configured) {
      if (configured.includes(':') && !configured.startsWith('[')) {
        return `[${configured}]`;
      }
      return configured;
    }
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const addr of interfaces[name] || []) {
        // Node 18.0-18.3 reports family as number 4, later versions as 'IPv4'
        const family = String(addr.family);
        const isV4 = family === 'IPv4' || family === '4';
        if (isV4 && !addr.internal) {
          return addr.address;
        }
      }
    }
    return null;
  }
  async getDeviceList() {
    this.log.info(`Getting devices from bridge ${this.config.bridgeip}`);
    await this.requestClient({
      method: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/bridge',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
      },
    })
      .then(async (res) => {
        this.setState('info.connection', true, true);
        this.log.debug(JSON.stringify(res.data));
        await this.extendObjectAsync('bridge', {
          type: 'device',
          common: {
            name: res.data.name,
          },
          native: {},
        });
        this.json2iob.parse('bridge', res.data, { forceIndex: true });
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
    await this.requestClient({
      method: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/lock',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info(`Found ${res.data.length} devices`);

        for (const device of res.data) {
          const id = device.id.toString().replace(this.FORBIDDEN_CHARS, '_');

          const name = device.name;
          this.deviceArray.push(device);

          await this.extendObjectAsync(id, {
            type: 'device',
            common: {
              name: name,
            },
            native: { type: device.type },
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });
          let remoteArray = [];
          if (device.type === 2 || device.type === 4) {
            remoteArray = [
              { command: 'refresh', name: 'True = Refresh' },
              { command: 'lock', name: 'True = Lock, False = Unlock' },
              {
                command: 'unlock',
                name: 'Unlock',
                type: 'number',
                role: 'level',
                def: 0,
                states: { 0: 'Unlock', 2: 'Force Unlock', 3: 'Without auto pull spring', 4: 'Unlock or pull spring' },
              },
              { command: 'pull', name: 'True = Pull' },
            ];
          }
          if (device.type === 2 || device.type === 4) {
            await this.createLastActionObjects(id);
            this.loadPinAliases(id).catch((e) => this.log.debug('PIN list: ' + e));
          }
          for (const remote of remoteArray) {
            this.extendObject(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'switch',
                def: remote.def == null ? false : remote.def,
                states: remote.states,
                write: true,
                read: true,
              },
              native: {},
            });
          }
          this.json2iob.parse(id, device, { forceIndex: true, states: this.states });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  /**
   * Starts the local webhook server and registers it at the bridge.
   * @returns {Promise<void>}
   */
  async startWebhooks() {
    const app = express();
    const port = await this.getPortAsync(29170);
    const host = this.getCallbackHost();
    if (!host) {
      this.log.error(
        'No callback address found, cannot start webhooks. Please set "Callback host" in the instance settings',
      );
      return;
    }
    this.callbackHost = host;
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    // @KI_HINWEIS: no listen host -> Node binds to "::" (dual stack), so IPv4 and IPv6 callbacks both arrive.
    this.webhookServer = app.listen(port, () => {
      this.log.info(`Webhooks listening on port ${port} (IPv4 + IPv6)`);
    });
    app.post('/webhook', async (req, res) => {
      this.log.debug(JSON.stringify(req.body));
      if (this.firstWebhook == null) {
        this.firstWebhook = Date.now();
        this.log.info('Webhook connected successfully');
      }
      // @KI_HINWEIS: answer first. The bridge handles one request at a time and waits for
      // this response, so a PIN list request inside the handler would block both sides.
      res.send('OK');
      if (req.body.data) {
        let deviceId = req.body.data.deviceId;
        if (deviceId) {
          deviceId = deviceId.toString().replace(this.FORBIDDEN_CHARS, '_');
          this.json2iob.parse(deviceId, req.body.data, { forceIndex: true, states: this.states });
          if (req.body.event === 'lock-status-changed') {
            this.handleLastAction(deviceId, req.body.data).catch((e) => this.log.warn('lastAction: ' + e));
          }
        } else {
          this.json2iob.parse('bridge', req.body.data, { forceIndex: true });
        }
      }
    });
    //receive list of webhooks
    await this.cleanWebhooks();
    await this.sleep(1500);
    //register webhook
    this.log.info('Registering webhook ' + 'http://' + host + ':' + port + '/webhook');
    await this.requestClient({
      method: 'post',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/callback',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
        'Content-Type': 'application/json',
      },
      data: {
        url: 'http://' + host + ':' + port + '/webhook',
        headers: [],
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        this.log.info('Webhook registered');
      })
      .catch((error) => {
        this.log.error("Couldn't register webhook. Please try to restart the adapter.");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  /**
   * Checks whether a registered bridge callback belongs to this adapter.
   * Matches callbacks pointing to "/webhook" on our callback host (any port, so
   * stale registrations from a previous port are removed as well).
   * @param {string} url callback URL as returned by GET /callback
   * @returns {boolean}
   */
  isOwnWebhook(url) {
    if (!url || !this.callbackHost) {
      return false;
    }
    try {
      const parsed = new URL(url);
      return parsed.hostname === this.callbackHost && parsed.pathname === '/webhook';
    } catch (e) {
      return false;
    }
  }

  /**
   * Removes webhooks registered by this adapter from the bridge.
   * @KI_HINWEIS: previously every callback on the bridge was deleted, which also
   * removed webhooks of other integrations (e.g. Home Assistant) on each adapter start/stop.
   * @returns {Promise<void>}
   */
  async cleanWebhooks() {
    if (!this.config.bridgeip || !this.config.token) {
      return;
    }

    await this.requestClient({
      method: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/callback',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        const webhooks = Array.isArray(res.data) ? res.data : [];
        for (const webhook of webhooks) {
          if (!this.isOwnWebhook(webhook.url)) {
            this.log.debug('Keeping foreign webhook ' + webhook.id + ' ' + webhook.url);
            continue;
          }
          this.log.info('Deleting webhook ' + webhook.id + ' ' + webhook.url);
          await this.sleep(500);
          await this.requestClient({
            method: 'delete',
            url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/callback/' + webhook.id,
            headers: {
              accept: '*/*',
              api_token: this.hashedAPIKey(),
            },
          })
            .then((res) => {
              this.log.debug(JSON.stringify(res.data));
              this.log.info('Webhook deleted');
            })
            .catch((error) => {
              this.log.error(error);
              error.response && this.log.error(JSON.stringify(error.response.data));
            });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  /**
   * Creates the lastAction channel of a lock.
   * @param {string} id device id
   * @returns {Promise<void>}
   */
  async createLastActionObjects(id) {
    await this.extendObjectAsync(id + '.lastAction', {
      type: 'channel',
      common: { name: 'Last action (who / how the lock was operated)' },
      native: {},
    });
    /** @type {Array<{id: string, name: string, type: ioBroker.CommonType, role: string, states?: Record<number, string>}>} */
    const lastActionStates = [
      { id: 'action', name: 'Action', type: 'string', role: 'text' },
      { id: 'source', name: 'Source (how)', type: 'number', role: 'value', states: this.actionSources },
      { id: 'sourceName', name: 'Source name', type: 'string', role: 'text' },
      { id: 'userId', name: 'User / PIN / fingerprint id', type: 'number', role: 'value' },
      { id: 'pinAlias', name: 'PIN alias (keypad only)', type: 'string', role: 'text' },
    ];
    for (const state of lastActionStates) {
      await this.extendObjectAsync(id + '.lastAction.' + state.id, {
        type: 'state',
        common: {
          name: state.name,
          type: state.type,
          role: state.role,
          read: true,
          write: false,
          states: state.states,
        },
        native: {},
      });
    }
  }

  /**
   * Updates lastAction.* from a lock-status-changed webhook.
   * Only the first event of an operation is used (4 = opening, 5 = closing, 8 = pulling
   * without a preceding unlock), so the following pull events do not overwrite the source.
   * @param {string} id device id
   * @param {{state?: number, source?: number, user_id?: number}} data webhook data
   * @returns {Promise<void>}
   */
  async handleLastAction(id, data) {
    if (!data || data.state == null || data.source == null) {
      return;
    }
    const now = Date.now();
    const recent = now - (this.lastActionTime[id] || 0) < 15 * 1000;
    let action = null;
    if (data.state === 4) {
      action = 'unlock';
    } else if (data.state === 5) {
      action = 'lock';
    } else if (data.state === 8 && !recent) {
      action = 'pull';
    }
    if (!action) {
      return;
    }
    this.lastActionTime[id] = now;
    const source = Number(data.source);
    // user_id -1: keypad lock button without PIN, 0: operated at the lock itself
    const userId = data.user_id == null || Number(data.user_id) < 0 ? null : Number(data.user_id);
    let pinAlias = '';
    if (userId != null && this.pinSources.includes(source)) {
      pinAlias = await this.getPinAlias(id, userId);
    }
    await this.setStateAsync(id + '.lastAction.source', source, true);
    await this.setStateAsync(
      id + '.lastAction.sourceName',
      this.actionSources[source] || 'Unknown (' + source + ')',
      true,
    );
    await this.setStateAsync(id + '.lastAction.userId', userId, true);
    await this.setStateAsync(id + '.lastAction.pinAlias', pinAlias, true);
    // written last, so scripts can trigger on lastAction.action and read the other states
    await this.setStateAsync(id + '.lastAction.action', action, true);
  }

  /**
   * Returns the alias of a PIN, reloads the PIN list once if the id is unknown.
   * @param {string} id device id
   * @param {number} pinId PIN id (user_id of the webhook)
   * @returns {Promise<string>}
   */
  async getPinAlias(id, pinId) {
    let cache = this.pinCache[id];
    if (!cache || cache.aliases[pinId] == null) {
      await this.loadPinAliases(id).catch((e) => this.log.debug('PIN list: ' + e));
      cache = this.pinCache[id];
    }
    return (cache && cache.aliases[pinId]) || '';
  }

  /**
   * Loads id/alias of all PINs of a lock (GET /lock/{id}/pin, Bridge API >= 1.19).
   * Uses listVersion, so an unchanged list is answered with 304 without body.
   * @KI_HINWEIS: the bridge reads the list via BLE (~5 PINs per second) and is blocked
   * meanwhile. Therefore only loaded on start and when an unknown PIN id shows up.
   * @param {string} id device id
   * @returns {Promise<void>}
   */
  async loadPinAliases(id) {
    if (!this.pinCache[id]) {
      this.pinCache[id] = { listVersion: 0, aliases: {}, supported: true, loading: null };
    }
    const cache = this.pinCache[id];
    if (!cache.supported) {
      return;
    }
    if (cache.loading) {
      await cache.loading;
      return;
    }
    cache.loading = this.requestClient({
      method: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/lock/' + id + '/pin',
      params: cache.listVersion ? { listVersion: cache.listVersion } : undefined,
      headers: { accept: '*/*', api_token: this.hashedAPIKey() },
      timeout: 2 * 60 * 1000,
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304,
    })
      .then((res) => {
        if (res.status === 304) {
          return;
        }
        const pins = res.data && Array.isArray(res.data.pins) ? res.data.pins : [];
        /** @type {Record<number, string>} */
        const aliases = {};
        for (const pin of pins) {
          if (pin && pin.id != null) {
            aliases[pin.id] = pin.alias || '';
          }
        }
        cache.aliases = aliases;
        cache.listVersion = Number(res.data.listVersion) || 0;
        this.log.info(`Loaded ${pins.length} PIN aliases for lock ${id}`);
      })
      .catch((error) => {
        const status = error.response && error.response.status;
        if (status === 400 || status === 404) {
          // bridge firmware without PIN API (< v1.19)
          cache.supported = false;
          this.log.info('Bridge does not support the PIN API, lastAction.pinAlias stays empty');
          return;
        }
        this.log.debug('Could not load PIN list: ' + error);
      })
      .finally(() => {
        cache.loading = null;
      });
    await cache.loading;
  }

  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  hashedAPIKey() {
    //api_key = SHA256(token + timestamp) + timestamp
    const timestamp = Date.now();
    const hash = crypto
      .createHash('sha256')
      .update(this.config.token + timestamp)
      .digest('hex');
    return hash + timestamp;
  }

  async updateDevices() {
    await this.requestClient({
      method: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/lock',
      headers: {
        'Content-Type': 'application/json',
        api_token: this.hashedAPIKey(),
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        for (const device of res.data) {
          const id = device.id.toString().replace(this.FORBIDDEN_CHARS, '_');
          this.json2iob.parse(id, device, { forceIndex: true, states: this.states });
        }
      })
      .catch((error) => {
        //check for socket hangup
        if (error.code === 'ECONNRESET') {
          this.log.info('Bridge is busy. Cannot handle more requests');
          return;
        }
        this.log.warn(error);
        error.response && this.log.warn(JSON.stringify(error.response.data));
      });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      this.isUnloading = true;
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.updateTimeout && clearTimeout(this.updateTimeout);
      //wait to prevent busy bridge
      await this.sleep(500);
      await this.cleanWebhooks();
      this.webhookServer && this.webhookServer.close();
      this.setState('info.connection', false, true);
      callback();
    } catch (e) {
      callback();
    }
  }

  /**
   * Is called if a subscribed state changes
   * @param {string} id
   * @param {ioBroker.State | null | undefined} state
   */
  async onStateChange(id, state) {
    if (state) {
      if (!state.ack) {
        const deviceId = id.split('.')[2];
        let command = id.split('.')[4];
        if (id.split('.')[3] !== 'remote') {
          return;
        }

        if (command === 'refresh') {
          this.updateDevices();
          return;
        }
        if (!['lock', 'unlock', 'pull'].includes(command)) {
          return;
        }
        if (state.val === false && command === 'lock') {
          command = 'unlock';
        }
        /** @type {Record<string, string>} */
        const headers = {
          accept: '*/*',
          api_token: this.hashedAPIKey(),
        };
        // The "mode" header is only defined for /unlock (0, 2, 3, 4). Other values are rejected with 403.
        if (command === 'unlock') {
          const mode = typeof state.val === 'number' ? state.val : 0;
          if (![0, 2, 3, 4].includes(mode)) {
            this.log.warn(`Invalid unlock mode ${mode}. Allowed: 0, 2, 3, 4`);
            return;
          }
          if (mode !== 0) {
            headers.mode = mode.toString();
          }
        }
        const url = 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/lock/' + deviceId + '/' + command;
        this.log.debug('Sending url: ' + url);
        await this.requestClient({
          method: 'POST',
          url: url,
          headers: headers,
          // never repeat a lock command automatically, see constructor
          'axios-retry': { retries: 0 },
        })
          .then(async (res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch((error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
        this.refreshTimeout && clearTimeout(this.refreshTimeout);
        this.refreshTimeout = setTimeout(() => {
          this.updateDevices();
        }, 10 * 1000);
      } else {
        if (id.split('.')[3] === 'state') {
          const deviceId = id.split('.')[2];
          if (state.val === 2 || state.val === 3 || state.val === 7 || state.val === 18) {
            this.setState(deviceId + '.remote.lock', false, true);
          }
          if (state.val === 7) {
            this.setState(deviceId + '.remote.pull', true, true);
          }
          if (state.val === 6) {
            this.setState(deviceId + '.remote.lock', true, true);
            this.setState(deviceId + '.remote.pull', false, true);
          }
        }
      }
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  /**
   * @param {Partial<utils.AdapterOptions>} [options={}]
   */
  module.exports = (options) => new Tedee(options);
} else {
  // otherwise start the instance directly
  new Tedee();
}
