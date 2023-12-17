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
const express = require('express');
const bodyParser = require('body-parser');

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
    this.updateInterval = null;
    this.session = {};
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
    this.updateInterval = setInterval(() => {
      this.updateDevices();
    }, this.config.interval * 1000);
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
  async startWebhooks() {
    const app = express();
    const port = await this.getPortAsync(29170);
    const host = await this.host;
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: true }));
    app.listen(port, () => {
      this.log.info(`Webhooks listening at http://${host}:${port}`);
    });
    app.post('/webhook', async (req, res) => {
      this.log.debug(JSON.stringify(req.body));
      if (this.firstWebhook == null) {
        this.firstWebhook = Date.now();
        this.log.info('Webhook message received');
      }
      if (req.body.data) {
        const deviceId = req.body.data.deviceId;
        if (deviceId) {
          this.json2iob.parse(deviceId, req.body.data, { forceIndex: true, states: this.states });
        } else {
          this.json2iob.parse('bridge', req.body.data, { forceIndex: true });
        }
      }
      res.send('OK');
    });
    //receive list of webhooks
    await this.cleanWebhooks();
    await this.sleep(1500);
    //register webhook
    this.log.debug('Registering webhook');
    await this.requestClient({
      method: 'post',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/callback',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
        content_type: 'application/json',
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
        this.log.error("Couldn't register webhook");
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async cleanWebhooks() {
    if (!this.config.bridgeip || !this.config.token) {
      return;
    }

    await this.requestClient({
      methode: 'get',
      url: 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/callback',
      headers: {
        accept: '*/*',
        api_token: this.hashedAPIKey(),
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        for (const webhook of res.data) {
          this.log.info('Deleting webhook ' + webhook.id + ' ' + webhook.url);

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
          await this.sleep(1500);
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
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
          this.json2iob.parse(device.id, device, { forceIndex: true, states: this.states });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  async onUnload(callback) {
    try {
      await this.cleanWebhooks();
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
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
        if (state.val === false && command === 'lock') {
          command = 'unlock';
        }
        let mode;
        if (command === 'unlock') {
          mode = state.val || 0;
        }
        const url = 'http://' + this.config.bridgeip + '/' + this.apiVersion + '/lock/' + deviceId + '/' + command;
        this.log.debug('Sending url: ' + url);
        await this.requestClient({
          method: 'POST',
          url: url,
          headers: {
            acceot: '*/*',
            api_token: this.hashedAPIKey(),
            mode: mode || '',
          },
        })
          .then(async (res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch((error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
      } else {
        if (id.split('.')[3] === 'state') {
          const deviceId = id.split('.')[2];
          if (state.val === 2 || state.val === 7 || state.val === 18) {
            this.setState(deviceId + '.remote.lock', false, true);
            this.setState(deviceId + '.remote.unlock', 0, true);
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
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.refreshTimeout = setTimeout(() => {
        this.updateDevices();
      }, 10 * 1000);
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
