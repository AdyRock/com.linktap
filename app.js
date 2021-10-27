'use strict';

if (process.env.DEBUG === '1')
{
    // eslint-disable-next-line node/no-unsupported-features/node-builtins, global-require
    require('inspector').open(9222, '0.0.0.0', true);
}

const Homey = require('homey');
const https = require('https');
const http = require('http');

const nodemailer = require('nodemailer');

const aedes = require('aedes')();
const net = require('net');

const PORT = 49876;
const mqtt = require('mqtt');

class MyApp extends Homey.App
{

    /**
     * onInit is called when the app is initialized.
     */
    async onInit()
    {
        this.log('MyApp initialising');
        this.diagLog = '';
        this.homeyIP = null;
        this.cloudOnly = true;
        this.enableLocal = this.homey.settings.get('enableLocal'); // Set to true when a local access device is added
        this.fetchingData = false;

        if (this.enableLocal)
        {
            try
            {
                // Setup the local access method if possible
                await this.setupLocalAccess();
            }
            catch (err)
            {
                this.updateLog(`Error setting up local access: ${err.message}`);
            }
        }

        if (process.env.DEBUG === '1')
        {
            // Make extra tabs available in the settings page
            this.homey.settings.set('debugMode', true);
        }
        else
        {
            this.homey.settings.set('debugMode', false);
        }

        const activateInstantMode = this.homey.flow.getActionCard('activate_instant_mode');
        activateInstantMode
            .registerRunListener(async (args, state) =>
            {
                this.log('activate_instant_mode');
                return args.device.activateInstantMode(true, args.water_duration, (args.eco_mode === 'on'), args.on_time, args.off_time, (args.revert === 'on'));
            });

        const turnOffInstantMode = this.homey.flow.getActionCard('turn_off_instant_mode');
        turnOffInstantMode
            .registerRunListener(async (args, state) =>
            {
                this.log('turn_off_instant_mode');
                return args.device.activateInstantMode(false);
            });

        const activateWateringMode = this.homey.flow.getActionCard('activate_watering_mode');
        activateWateringMode
            .registerRunListener(async (args, state) =>
            {
                this.log('activate_watering_mode');
                return args.device.activateWateringMode(true, args.mode);
            });

        const wateringCondition = this.homey.flow.getConditionCard('is_watering');
        wateringCondition.registerRunListener(async (args, state) =>
        {
            return args.device.isWatering; // true or false
        });

        const activateInstantModeLocal = this.homey.flow.getActionCard('activate_instant_mode_local');
        activateInstantModeLocal
            .registerRunListener(async (args, state) =>
            {
                this.log('activate_instant_mode');
                return args.device.onCapabilityOnOff(true, { duration: args.water_duration });
            });

        const turnOffInstantModeLocal = this.homey.flow.getActionCard('turn_off_instant_mode_local');
        turnOffInstantModeLocal
            .registerRunListener(async (args, state) =>
            {
                this.log('turn_off_instant_mode');
                return args.device.onCapabilityOnOff(false);
            });

        const activateWateringModeLocal = this.homey.flow.getActionCard('activate_watering_mode_local');
        activateWateringModeLocal
            .registerRunListener(async (args, state) =>
            {
                this.log('activate_watering_mode');
                return args.device.onCapabilityWateringMode(args.mode);
            });

        this.homey.settings.on('set', async key =>
        {
            if (key === 'APIToken')
            {
                this.apiKey = this.homey.settings.get('APIToken');
                this.setupWebhook().catch(this.error);
            }
            else if (key === 'UserName')
            {
                this.username = this.homey.settings.get('UserName');
                this.setupWebhook().catch(this.error);
            }
            else if (key === 'autoConfig')
            {
                this.autoConfigGateway = this.homey.settings.get('autoConfig');
                if (this.autoConfigGateway)
                {
                    // Automatically configure the gateways for local MQTT access
                    this.checkGatewaysConfiguration().catch(this.error);
                }
            }
        });

        this.apiKey = this.homey.settings.get('APIToken');
        this.username = this.homey.settings.get('UserName');
        this.lastDetectionTime = this.homey.settings.get('lastDetectionTime');
        this.detectedDevices = this.homey.settings.get('detectedDevices');
        this.cacheClean = false; // We have no idea what might have changed while the app wasn't running

        // Setup the webhook call back to receive push notifications
        this.setupWebhook().catch(this.error);

        this.homey.on('unload', async () =>
        {
            await this.unregisterWebhook();
        });

        this.log('MyApp has been initialized');
    }

    // Try to setup local access
    async setupLocalAccess()
    {
        let homeyLocalURL = null;
        try
        {
            homeyLocalURL = await this.homey.cloud.getLocalAddress();
            this.cloudOnly = false;
        }
        catch (err)
        {
            // getLocalAddress will fail on Homey cloud installations so only use cloud to cloud method
            this.cloudOnly = true;
            return false;
        }

        const _this = this;

        // Setup the local MQTT server
        const server = net.createServer(aedes.handle);
        server.listen(PORT, () => {
            _this.homey.app.updateLog(`server started and listening on port ${PORT}`);
        });

        aedes.authenticate = function aedesAuthenticate(client, username, password, callback)
        {
            callback(null, (username === 'homeyApp') && (password.toString() === 'fred69'));
        };

        this.homeyIP = homeyLocalURL.split(':')[0];

        this.mDNSGateways = this.homey.settings.get('gateways');
        this.mDNSGateways = [];

        this.autoConfigGateway = this.homey.settings.get('autoConfig');

        // setup the mDNS discovery for local gateways
        this.discoveryStrategy = this.homey.discovery.getStrategy('link_tap');

        const discoveryResult = this.discoveryStrategy.getDiscoveryResults();
        this.updateLog(`Got initial mDNS result:${this.varToString(discoveryResult)}`);
        if (discoveryResult && discoveryResult.address)
        {
            this.mDNSGatewaysUpdate(discoveryResult);
        }

        this.discoveryStrategy.on('result', discoveryResult =>
        {
            this.updateLog(`Got mDNS result:${this.varToString(discoveryResult)}`);
            this.mDNSGatewaysUpdate(discoveryResult);
        });

        // Connect to the MQTT server and subscribe to the required topics
        this.MQTTclient = mqtt.connect('mqtt://localhost:49876', { clientId: 'homeyLinkTapApp', username: 'homeyApp', password: 'fred69' });
        this.MQTTclient.on('connect', () =>
        {
            _this.MQTTclient.subscribe('linktap/up_cmd', err => {
                if (err)
                {
                    _this.updateLog("setupLocalAccess.onConnect 'linktap/up_cmd' error: " * _this.varToString(err), 0);
                }
            });
            _this.MQTTclient.subscribe('linktap/down_cmd_ack', err => {
                if (err)
                {
                    _this.updateLog("setupLocalAccess.onConnect 'linktap/down_cmd_ack' error: " * _this.varToString(err), 0);
                }
            });
        });

        this.MQTTclient.on('message', (topic, message) =>
        {
            // message is in Buffer
            try
            {
                const tapLinkData = JSON.parse(message.toString());
                _this.homey.app.updateLog(`MQTTDeviceValues: ${_this.homey.app.varToString(tapLinkData)}`);

                if ((tapLinkData.cmd === 0) || (tapLinkData.cmd === 13))
                {
                    // A gateway is connecting or refreshing so return the current date and time
                    const t = new Date();
                    const date = (`0${t.getDate()}`).slice(-2);
                    const month = (`0${t.getMonth() + 1}`).slice(-2);
                    const year = t.getFullYear();
                    const hours = (`0${t.getHours()}`).slice(-2);
                    const minutes = (`0${t.getMinutes()}`).slice(-2);
                    const seconds = (`0${t.getSeconds()}`).slice(-2);
                    const dateTxt = `${year}${month}${date}`;
                    const timeTxt = `${hours}${minutes}${seconds}`;
                    const reply = {
                        cmd: 0,
                        gwID: tapLinkData.gwID,
                        date: dateTxt,
                        time: timeTxt,
                        wday: t.getDay(),
                    };

                    const data = JSON.stringify(reply);

                    _this.MQTTclient.publish('linktap/up_cmd_ack', data);
                }
                else if ((tapLinkData.cmd === 3) || (tapLinkData.cmd === 9))
                {
                    // New data has been received so update the device cache used when adding devices
                    _this.updateDetectedMQTTDevices(tapLinkData);

                    // Update the device capabilities
                    _this.updateDevicesMQTT(tapLinkData);
                }
            }
            catch (err)
            {
                _this.homey.app.updateLog(`MQTT Client error: ${topic}: ${err.message}`);
            }
        });

        return true;
    }

    // Build up a cache of the tapLinkers (valves) for the get devices part of the add device
    updateDetectedMQTTDevices(tapLinkData)
    {
        if (tapLinkData.dev_stat && this.mDNSGateways)
        {
            try
            {
                // find the gateway in the list of mDNS detected gateways
                const index = this.mDNSGateways.findIndex(gateway =>
                {
                    return gateway.gatewayId === tapLinkData.gw_id;
                });

                if (index >= 0)
                {
                    // Found the gateway so look for the taplinkers to see if already cached
                    const gatewayTapLinkers = this.mDNSGateways[index].taplinker;
                    tapLinkData.dev_stat.forEach(tapLinker1 =>
                    {
                        const index2 = gatewayTapLinkers.findIndex(tapLinker2 =>
                        {
                            return tapLinker2.taplinkerId === tapLinker1.dev_id;
                        });

                        if (index2 < 0)
                        {
                            // No match found so add this tapLinker
                            const newTapLinker = {
                                location: '',
                                taplinkerName: tapLinker1.dev_id,
                                taplinkerId: tapLinker1.dev_id,
                            };
                            gatewayTapLinkers.push(newTapLinker);
                            this.homey.settings.set('gateways', this.mDNSGateways);
                            this.homey.app.updateLog(`MQTTDevice: ${this.homey.app.varToString(this.mDNSGateways)}`);
                        }
                    });
                }
            }
            catch (err)
            {
                this.homey.app.updateLog(`updateDetectedMQTTDevices error: ${err.message}`);
            }
        }
    }

    // Build a list of gateways detected by mDNS
    mDNSGatewaysUpdate(discoveryResult)
    {
        try
        {
            let index = this.mDNSGateways.findIndex(gateway =>
            {
                return gateway.gatewayId === discoveryResult.id;
            });

            if (index >= 0)
            {
                // Already cached so just make sure the address is up to date
                this.mDNSGateways[index].address = discoveryResult.address;
            }
            else
            {
                // Add a new entry to the cache
                const gateway = {
                    gatewayId: discoveryResult.id,
                    address: discoveryResult.address,
                    model: discoveryResult.txt.model,
                    taplinker: [],
                };

                this.mDNSGateways.push(gateway);
                index = this.mDNSGateways.length - 1;
            }

            this.homey.settings.set('gateways', this.mDNSGateways);

            if (this.autoConfigGateway)
            {
                // Make sure the gateway is configure for local access
                this.checkGatewayConfiguration(this.mDNSGateways[index]);
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`mDNSGatewaysUpdate error: ${err.message}`);
        }
    }

    async checkGatewayConfiguration(gateway)
    {
        // Check if gateway already configured
        const res = await this.GetURL(`http://${gateway.address}`, {});
        const hostPos = res.search('#HOST');
        if (hostPos > 0)
        {
            const hostValuePos = res.indexOf('value=', hostPos);
            let hostValue = res.substr(hostValuePos + 6, 17);
            hostValue = hostValue.split('"');
            hostValue = hostValue[1];

            if (hostValue !== this.homeyIP)
            {
                // the gateway needs to be configured for local access
                this.updateGatewayConfiguration(gateway, this.homeyIP);
            }
        }
    }

    // The gateways are setup via a html forms so plug in the values by posting the forma data
    async updateGatewayConfiguration(gateway, homeyIP)
    {
        // Post form 2 data to configure the MQTT client settings
        let urlOptions = '?';
        urlOptions += 'flag=2';
        urlOptions += '&func=2';
        urlOptions += '&hosttype=0';
        urlOptions += '&prefix=linktap';
        urlOptions += `&host=${encodeURIComponent(homeyIP)}`;
        urlOptions += '&port=49876';
        urlOptions += `&cltid=${gateway.gatewayId}`;
        urlOptions += '&user=homeyApp';
        urlOptions += '&pwd=fred69';
        urlOptions += '&alive=120';
        try
        {
            await this.GetURL(`http://${gateway.address}/index.shtml${urlOptions}`, {});
        }
        catch (err)
        {
            this.homey.app.updateLog(`Publish Form 1 error:${err.message}`, 0);
        }

        // Post form 3 data to configure the MQTT topics settings
        urlOptions = '?';
        urlOptions += 'flag=3';
        urlOptions += '&uptopic=linktap/up_cmd';
        urlOptions += '&uptpcrx=linktap/up_cmd_ack';
        urlOptions += '&dwntpc=linktap/down_cmd';
        urlOptions += '&dwntpcrx=linktap/down_cmd_ack';
        try
        {
            await this.GetURL(`http://${gateway.address}/index.shtml${urlOptions}`, {});
        }
        catch (err)
        {
            this.homey.app.updateLog(`Publish Form 2 error:${err.message}`);
        }

        // Post form 0 to reboot the gateway
        urlOptions = '?';
        urlOptions += 'flag=0';
        try
        {
            await this.GetURL(`http://${gateway.address}/index.shtml${urlOptions}`, {});
        }
        catch (err)
        {
            this.homey.app.updateLog(`Publish Form 3 error:${err.message}`, 0);
        }
    }

    // Send the data to each device so it can filter and update as required
    async updateDevicesMQTT(tapLinkData)
    {
        const promises = [];
        const drivers = this.homey.drivers.getDrivers();
        // eslint-disable-next-line no-restricted-syntax
        for (const driver in drivers)
        {
            if (Object.prototype.hasOwnProperty.call(drivers, driver))
            {
                const devices = this.homey.drivers.getDriver(driver).getDevices(false);
                const numDevices = devices.length;
                for (let i = 0; i < numDevices; i++)
                {
                    const device = devices[i];
                    if (device.updateDeviceMQTT)
                    {
                        promises.push(device.updateDeviceMQTT(tapLinkData));
                    }
                }
            }
        }

        await Promise.all(promises);
    }

    async publishMQTTMessage(message)
    {
        const data = JSON.stringify(message);
        this.homey.app.updateLog(`publishMQTTMessage: ${data}`);
        this.MQTTclient.publish('linktap/down_cmd', data);
    }

    // The getAllDevices API can only be called once every 5 minutes so get the data from the cache if it was called less than 5 minutes ago
    // Set UseDirtyCache to true if just need a list of devices and the values are not important
    async getDeviceData(UseDirtyCache, body)
    {
        let searchData = null;

        // If debug mode then check if the simulator has data to use
        if (this.homey.settings.get('debugMode'))
        {
            const simData = this.homey.settings.get('simData');
            if (simData)
            {
                return JSON.parse(simData);
            }
        }

        let maxWait = 30;
        while (this.fetchingData && (maxWait-- > 0))
        {
            // Already fetching new data so wait for that to complete as we don't want to call the API too many times
            await new Promise(resolve => this.homey.setTimeout(resolve, 1000));
        }

        if (!this.fetchingData && (!this.lastDetectionTime || (Date.now() - this.lastDetectionTime > (1000 * 60 * 5))))
        {
            this.fetchingData = true;
            try
            {
                // More than 5 minutes since last request
                // https://www.link-tap.com/api/getAllDevices
                const url = 'getAllDevices';
                const response = await this.PostURL(url, body);
                searchData = response.devices;
                this.detectedDevices = this.varToString(searchData);
                this.cacheClean = true;
                this.lastDetectionTime = Date.now();
                this.homey.settings.set('detectedDevices', this.detectedDevices);
                this.homey.settings.set('lastDetectionTime', this.lastDetectionTime);
                if (!this.cloudOnly)
                {
                    this.homey.api.realtime('com.linktap.detectedDevicesUpdated', { devices: this.detectedDevices });
                }
            }
            catch (err)
            {
                this.updateLog(`Get Device Data error: ${err.message}`, 0);
                return null;
            }
            finally
            {
                this.fetchingData = false;
            }
        }
        else if (UseDirtyCache || this.cacheClean)
        {
            searchData = JSON.parse(this.detectedDevices);
        }
        return searchData;
    }

    // useInternet is true for cloud devices and false for local devices
    // body can be use to pass in the APIKey and user name. If it is empty then the global app settings will be used
    async getLinkTapDevices(useInternet, body)
    {
        const devices = [];
        let searchData = null;

        if (useInternet)
        {
            // For cloud to cloud connections use the API
            searchData = await this.getDeviceData(true, body);
        }
        else
        {
            // For local access use the MQTT cache
            searchData = this.mDNSGateways;
        }

        if (searchData)
        {
            // Create an array of devices
            for (const gateway of searchData)
            {
                for (const tapLinker of gateway.taplinker)
                {
                    this.updateLog('Found LinkTap: ');
                    this.updateLog(tapLinker);

                    const data = {
                        id: tapLinker.taplinkerId,
                        gatewayId: gateway.gatewayId,
                    };
                    const store = {
                        apiKey: body.apiKey ? body.apiKey : this.apiKey,
                        username: body.username ? body.username : this.username,
                    };

                    // Add this device to the table
                    devices.push(
                        {
                            name: `${tapLinker.location} - ${tapLinker.taplinkerName}`,
                            data,
                            store: useInternet ? store : {},
                        },
                    );
                }
            }
            return devices;
        }

        this.updateLog('Get Devices Error: Nothing returned', 0);
        throw (new Error('HTTPS Error: Nothing returned'));
    }

    // Send the webhook message to all the devices so they can update their capabilities if applicable
    async processWebhookMessage(message)
    {
        // Receiving a webhook message means the cache data is no longer up to date so we don't want to use that for setting capabilities incase it retards the values
        this.cacheClean = false;
        const drivers = this.homey.drivers.getDrivers();
        // eslint-disable-next-line no-restricted-syntax
        for (const driver in drivers)
        {
            if (Object.prototype.hasOwnProperty.call(drivers, driver))
            {
                const devices = this.homey.drivers.getDriver(driver).getDevices(true);
                const numDevices = devices.length;
                for (let i = 0; i < numDevices; i++)
                {
                    const device = devices[i];
                    if (device.processWebhookMessage)
                    {
                        device.processWebhookMessage(message).catch(this.error);
                    }
                }
            }
        }
    }

    // Create the Homey webhook and send the URL to the LinkTap account
    async setupWebhook()
    {
        try
        {
            const id = Homey.env.WEBHOOK_ID;
            const secret = Homey.env.WEBHOOK_SECRET;
            const myWebhook = await this.homey.cloud.createWebhook(id, secret, {});

            myWebhook.on('message', args =>
            {
                this.updateLog(`Got a webhook message!${this.varToString(args.body)}`, 0);
                this.processWebhookMessage(args.body).catch(this.error);
            });
        }
        catch (err)
        {
            this.updateLog(`setWebHookURL error: ${err.message}`, 0);
            return false;
        }

        this.updateLog('Webhook registered');
        return true;
    }

    async registerWebhookURL(apiKey, username)
    {
        if (apiKey && username)
        {
            try
            {
                // https://www.link-tap.com/api/setWebHookUrl
                const homeyId = await this.homey.cloud.getHomeyId();
                const id = Homey.env.WEBHOOK_ID;
                const webHookUrl = `https://webhooks.athom.com/webhook/${id}?homey=${homeyId}`;
                const url = 'setWebHookUrl';
                const body = {
                    webHookUrl,
                    apiKey,
                    username,
                };
                const response = await this.PostURL(url, body, false);
                if (response.result !== 'error')
                {
                    return true;
                }
                this.updateLog(`setWebHookURL error: ${this.varToString(response.message)}`, 0);
            }
            catch (err)
            {
                this.updateLog(`setWebHookURL error: ${err.message}`, 0);
            }
        }

        return false;
    }

    // Clear the webhook URL from the LinkTap account
    async unregisterWebhook()
    {
        // https://www.link-tap.com/api/deleteWebHookUrl
        const url = 'deleteWebHookUrl';
        const response = await this.PostURL(url, { username: this.username, apiKey: this.apiKey });
        this.updateLog(this.varToString(response.message));
    }

    async PostURL(url, body, logBody = true)
    {
        if (!body.username)
        {
            throw (new Error('HTTPS: No user name specified'));
        }

        if (!body.apiKey)
        {
            throw (new Error('HTTPS: No API Key specified'));
        }

        this.updateLog(`Post to: ${url}`);
        if (logBody)
        {
            let logText = this.varToString(body);
            logText = logText.replace(body.apiKey, 'hidden');
            this.updateLog(logText);
        }

        const bodyText = JSON.stringify(body);

        return new Promise((resolve, reject) =>
        {
            try
            {
                const safeUrl = encodeURI(url);

                const httpsOptions = {
                    host: 'www.link-tap.com',
                    path: `/api/${safeUrl}`,
                    method: 'POST',
                    headers:
                    {
                        'Content-type': 'application/json',
                        'Content-Length': bodyText.length,
                    },
                };

                const req = https.request(httpsOptions, res =>
                {
                    const body = [];
                    res.on('data', chunk =>
                    {
                        body.push(chunk);
                    });

                    res.on('end', () =>
                    {
                        if (res.statusCode === 200)
                        {
                            let returnData = Buffer.concat(body);
                            if (returnData.length > 2)
                            {
                                returnData = JSON.parse(returnData);
                            }
                            resolve(returnData);
                        }
                        else
                        {
                            reject(new Error(`HTTPS Error - ${res.statusCode}`));
                        }
                    });
                });

                req.on('error', err =>
                {
                    reject(new Error(`HTTPS Catch: ${err}`), 0);
                });

                req.setTimeout(5000, () => {
                    req.destroy();
                    reject(new Error('HTTP Catch: Timeout'));
                });

                req.write(bodyText);
                req.end();
            }
            catch (err)
            {
                reject(new Error(`HTTPS Catch: ${err.message}`));
            }
        });
    }

    async PostFormData(url, headers, body)
    {
        const bodyText = JSON.stringify(body);

        return new Promise((resolve, reject) =>
        {
            try
            {
                const httpOptions = {
                    host: url,
                    path: '',
                    method: 'POST',
                    headers,
                };

                const req = http.request(httpOptions, res =>
                {
                    const body = [];
                    res.on('data', chunk =>
                    {
                        body.push(chunk);
                    });

                    res.on('end', () =>
                    {
                        if (res.statusCode === 200)
                        {
                            let returnData = Buffer.concat(body);
                            if (returnData.length > 2)
                            {
                                returnData = JSON.parse(returnData);
                            }
                            resolve(returnData);
                        }
                        else
                        {
                            this.updateLog(`Post Form Data HTTPS Error: ${res.statusCode}`, 0);
                            reject(new Error(`HTTPS Error - ${res.statusCode}`));
                        }
                    });
                });

                req.on('error', err =>
                {
                    this.updateLog(err);
                    reject(new Error(`HTTPS Catch: ${err}`), 0);
                });

                req.setTimeout(5000, () => {
                    req.destroy();
                    reject(new Error('HTTP Catch: Timeout'));
                });

                req.write(bodyText);
                req.end();
            }
            catch (err)
            {
                this.updateLog(err.message, 0);
                reject(new Error(`HTTPS Catch: ${err.message}`));
            }
        });
    }

    async GetURL(url, Options)
    {
        return new Promise((resolve, reject) =>
        {
            try
            {
                this.updateLog(`Checking: ${url}`);
                http.get(url, Options, res =>
                {
                    if (res.statusCode === 200)
                    {
                        const body = [];
                        res.on('data', chunk =>
                        {
                            body.push(chunk);
                        });
                        res.on('end', () =>
                        {
                            resolve(
                                Buffer.concat(body).toString(),
                            );
                        });
                    }
                    else
                    {
                        let message = '';
                        if (res.statusCode === 204)
                        {
                            message = 'No Data Found';
                        }
                        else if (res.statusCode === 302)
                        {
                            message = res.headers.location;
                        }
                        else if (res.statusCode === 400)
                        {
                            message = 'Bad request';
                        }
                        else if (res.statusCode === 401)
                        {
                            message = 'Unauthorized';
                        }
                        else if (res.statusCode === 403)
                        {
                            message = 'Forbidden';
                        }
                        else if (res.statusCode === 404)
                        {
                            message = 'Not Found';
                        }
                        reject(new Error({ source: 'HTTPS Error', code: res.statusCode, message }));
                    }
                }).on('error', err =>
                {
                    reject(new Error({ source: 'HTTPS Catch', err }));
                });
            }
            catch (e)
            {
                reject(new Error({ source: 'HTTPS Try Catch', err: e }));
            }
        });
    }

    // Convert a variable of any type (almost) to a string
    varToString(source)
    {
        try
        {
            if (source === null)
            {
                return 'null';
            }
            if (source === undefined)
            {
                return 'undefined';
            }
            if (source instanceof Error)
            {
                const stack = source.stack.replace('/\\n/g', '\n');
                return `${source.message}\n${stack}`;
            }
            if (typeof (source) === 'object')
            {
                const getCircularReplacer = () =>
                {
                    const seen = new WeakSet();
                    return (key, value) =>
                    {
                        if (typeof value === 'object' && value !== null)
                        {
                            if (seen.has(value))
                            {
                                return '';
                            }
                            seen.add(value);
                        }
                        return value;
                    };
                };

                return JSON.stringify(source, getCircularReplacer(), 2);
            }
            if (typeof (source) === 'string')
            {
                return source;
            }
        }
        catch (err)
        {
            this.updateLog(`VarToString Error: ${err.message}`);
        }

        return source.toString();
    }

    // Add a message to the debug log if not running in the cloud
    updateLog(newMessage, errorLevel = 1)
    {
        if (!this.cloudOnly && ((errorLevel === 0) || this.homey.settings.get('logEnabled')))
        {
            this.log(newMessage);

            try
            {
                const nowTime = new Date(Date.now());

                this.diagLog += '\r\n* ';
                this.diagLog += (nowTime.getHours());
                this.diagLog += ':';
                this.diagLog += nowTime.getMinutes();
                this.diagLog += ':';
                this.diagLog += nowTime.getSeconds();
                this.diagLog += '.';
                const milliSeconds = nowTime.getMilliseconds().toString();
                if (milliSeconds.length === 2)
                {
                    this.diagLog += '0';
                }
                else if (milliSeconds.length === 1)
                {
                    this.diagLog += '00';
                }
                this.diagLog += milliSeconds;
                this.diagLog += ': ';
                this.diagLog += '\r\n';

                this.diagLog += newMessage;
                this.diagLog += '\r\n';
                if (this.diagLog.length > 60000)
                {
                    this.diagLog = this.diagLog.substr(this.diagLog.length - 60000);
                }

                this.homey.api.realtime('com.linktap.logupdated', { log: this.diagLog });
            }
            catch (err)
            {
                this.log(err);
            }
        }
    }

    // Send the log to the developer (not applicable to Homey cloud)
    async sendLog(body)
    {
        let tries = 5;

        let logData;
        if (body.logType === 'diag')
        {
            logData = this.diagLog;
        }
        else
        {
            logData = JSON.parse(this.detectedDevices);
            if (logData)
            {
                let gNum = 1;
                for (const gateway of logData)
                {
                    // rename the gateway ID
                    gateway.gatewayId = `GateWay ${gNum}`;
                    gNum++;

                    let vNum = 1;
                    for (const tapLinker of gateway.taplinker)
                    {
                        tapLinker.taplinkerId = `tapLinker ${vNum}`;
                        vNum++;
                    }
                }
            }
            else
            {
                throw (new Error('No data to send'));
            }

            logData = this.varToString(logData);
        }

        while (tries-- > 0)
        {
            try
            {
                // create reusable transporter object using the default SMTP transport
                const transporter = nodemailer.createTransport(
                {
                    host: Homey.env.MAIL_HOST, // Homey.env.MAIL_HOST,
                    port: 465,
                    ignoreTLS: false,
                    secure: true, // true for 465, false for other ports
                    auth:
                    {
                        user: Homey.env.MAIL_USER, // generated ethereal user
                        pass: Homey.env.MAIL_SECRET, // generated ethereal password
                    },
                    tls:
                    {
                        // do not fail on invalid certs
                        rejectUnauthorized: false,
                    },
                },
);

                // send mail with defined transport object
                const info = await transporter.sendMail(
                {
                    from: `"Homey User" <${Homey.env.MAIL_USER}>`, // sender address
                    to: Homey.env.MAIL_RECIPIENT, // list of receivers
                    subject: `LinkTap ${body.logType} log`, // Subject line
                    text: logData, // plain text body
                },
);

                this.updateLog(`Message sent: ${info.messageId}`);
                // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

                // Preview only available when sending through an Ethereal account
                this.log('Preview URL: ', nodemailer.getTestMessageUrl(info));
                return this.homey.__('settings.logSent');
            }
            catch (err)
            {
                this.updateLog(`Send log error: ${err.message}`, 0);
            }
        }

        return (this.homey.__('settings.logSendFailed'));
    }

    // Retrive the API key for the specified account
    async getAPIKey(body)
    {
        return this.PostURL('getApiKey', body);
    }

}

module.exports = MyApp;
