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
    this.reLoginTimeout = null;
    this.refreshTokenTimeout = null;
    this.session = {};
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

    this.subscribeStates('*.remote.*');
    await this.getDeviceList();
    await this.startWebhooks();
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
          const id = device.id.toString();
          const name = device.name;
          this.deviceArray.push(device);

          await this.setObjectNotExistsAsync(id, {
            type: 'device',
            common: {
              name: name,
            },
            native: {},
          });
          await this.setObjectNotExistsAsync(id + '.remote', {
            type: 'channel',
            common: {
              name: 'Remote Controls',
            },
            native: {},
          });

          const remoteArray = [
            { command: 'refresh', name: 'True = Refresh' },
            { command: 'lock', name: 'True = Lock' },
            { command: 'unlock', name: 'True = Unlock' },
            { command: 'pull', name: 'True = Pull' },
          ];
          for (const remote of remoteArray) {
            this.extendObject(id + '.remote.' + remote.command, {
              type: 'state',
              common: {
                name: remote.name || '',
                type: remote.type || 'boolean',
                role: remote.role || 'boolean',
                def: remote.def == null ? false : remote.def,
                write: true,
                read: true,
              },
              native: {},
            });
          }
          this.json2iob.parse(id, device, { forceIndex: true });
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
          this.json2iob.parse(deviceId, req.body.data, { forceIndex: true });
        } else {
          this.json2iob.parse('bridge', req.body.data, { forceIndex: true });
        }
      }
      res.send('OK');
    });
    //receive list of webhooks
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
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
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
          this.json2iob.parse(device.id, device, { forceIndex: true });
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }
  /*
  async refreshToken() {}
  async loginViaApi() {
    await this.requestClient({
      method: 'post',
      url: 'https://tedee.b2clogin.com/tedee.onmicrosoft.com/oauth2/v2.0/token?p=B2C_1_SignIn_Ropc',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      data: {
        username: this.config.username,
        grant_type: 'password',
        password: this.config.password,
        scope: 'openid 02106b82-0524-4fd3-ac57-af774f340979',
        client_id: '02106b82-0524-4fd3-ac57-af774f340979',
        response_type: 'token id_token',
      },
    })
      .then((res) => {
        this.log.debug(JSON.stringify(res.data));
        this.session = res.data;
        this.log.info('Login successful');
        this.setState('info.connection', true, true);
      })
      .catch((error) => {
        this.log.error(error);
        this.log.error('Login failed');
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }

  async getDeviceListViaApi() {
    await this.requestClient({
      method: 'get',
      url: 'https://api.tedee.com/api/' + this.apiVersion + '/my/Device/details?includeUserSettings=true',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: 'Bearer ' + this.session.access_token,
      },
    })
      .then(async (res) => {
        this.log.debug(JSON.stringify(res.data));
        const result = res.data.result;
        if (result) {
          for (const type of result) {
            this.log.info('Found ' + result[type].length + ' ' + type);

            for (const device of result[type]) {
              const id = device.id;
              const name = device.name;

              device.deviceType = type;
              this.deviceArray.push(device);

              await this.setObjectNotExistsAsync(id, {
                type: 'device',
                common: {
                  name: name,
                },
                native: {},
              });
              await this.setObjectNotExistsAsync(id + '.remote', {
                type: 'channel',
                common: {
                  name: 'Remote Controls',
                },
                native: {},
              });

              const remoteArray = [
                { command: 'refresh', name: 'True = Refresh' },
                { command: 'lock', name: 'True = Lock' },
                { command: 'unlock', name: 'True = Unlock' },
                { command: 'pull', name: 'True = Pull' },
              ];
              for (const remote of remoteArray) {
                this.extendObject(id + '.remote.' + remote.command, {
                  type: 'state',
                  common: {
                    name: remote.name || '',
                    type: remote.type || 'boolean',
                    role: remote.role || 'boolean',
                    def: remote.def == null ? false : remote.def,
                    write: true,
                    read: true,
                  },
                  native: {},
                });
              }
              this.json2iob.parse(id, device, { forceIndex: true });
            }
          }
        }
      })
      .catch((error) => {
        this.log.error(error);
        error.response && this.log.error(JSON.stringify(error.response.data));
      });
  }*/
  /**
   * Is called when adapter shuts down - callback has to be called under any circumstances!
   * @param {() => void} callback
   */
  onUnload(callback) {
    try {
      this.setState('info.connection', false, true);
      this.refreshTimeout && clearTimeout(this.refreshTimeout);
      this.reLoginTimeout && clearTimeout(this.reLoginTimeout);
      this.refreshTokenTimeout && clearTimeout(this.refreshTokenTimeout);
      this.updateInterval && clearInterval(this.updateInterval);
      // this.refreshTokenInterval && clearInterval(this.refreshTokenInterval);
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
        const command = id.split('.')[4];
        if (id.split('.')[3] !== 'remote') {
          return;
        }

        if (command === 'Refresh') {
          this.updateDevices();
          return;
        }

        await this.requestClient({
          method: 'POST',
          url: 'https://' + this.config.bridgeip + '/' + this.apiVersion + '/' + deviceId + '/' + command,
          headers: {
            acceot: '*/*',
            api_token: this.hashedAPIKey(),
          },
        })
          .then(async (res) => {
            this.log.info(JSON.stringify(res.data));
          })
          .catch((error) => {
            this.log.error(error);
            error.response && this.log.error(JSON.stringify(error.response.data));
          });
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
