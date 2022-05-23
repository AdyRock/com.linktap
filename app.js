'use strict';

if (process.env.DEBUG === '1')
{
    // eslint-disable-next-line node/no-unsupported-features/node-builtins, global-require
    require('inspector').open(9222, '0.0.0.0', true);
}

const Homey = require('homey');
const https = require('https');

const nodemailer = require('nodemailer');

class MyApp extends Homey.App
{

    /**
     * onInit is called when the app is initialized.
     */
    async onInit()
    {
        this.log('MyApp initialising');
        this.diagLog = '';
        this.fetchingData = false;
        this.cloudOnly = true;
        this.linkTaps = [];
        this.homeyWebhook = null;

        if (process.env.DEBUG === '1')
        {
            // Make extra tabs available in the settings page
            this.homey.settings.set('debugMode', true);
        }
        else
        {
            this.homey.settings.set('debugMode', false);
        }

        try
        {
            // Try to get the local IP address to see if the app is running in Homey cloud so we don't update the logs
            await this.homey.cloud.getLocalAddress();
            this.cloudOnly = false;
        }
        catch (err)
        {
            // getLocalAddress will fail on Homey cloud installations so disable the loging options
            this.cloudOnly = true;
            this.homey.settings.set('logEnabled', false);
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
                return args.device.activateWateringMode(args.mode);
            });

        const wateringCondition = this.homey.flow.getConditionCard('is_watering');
        wateringCondition.registerRunListener(async (args, state) =>
        {
            return args.device.isWatering; // true or false
        });

        this.homey.settings.on('set', async key =>
        {
            if (key === 'APIToken')
            {
                this.apiKey = this.homey.settings.get('APIToken');
                this.registerWebhookURL(this.apiKey, this.username).catch(this.error);
            }
            else if (key === 'UserName')
            {
                this.username = this.homey.settings.get('UserName');
                this.registerWebhookURL(this.apiKey, this.username).catch(this.error);
            }
        });

        this.apiKey = this.homey.settings.get('APIToken');
        this.username = this.homey.settings.get('UserName');
        this.lastDetectionTime = this.homey.settings.get('lastDetectionTime');
        this.detectedDevices = this.homey.settings.get('detectedDevices');
        this.cacheClean = false; // We have no idea what might have changed while the app wasn't running

        this.log('MyApp has been initialized');
    }

    async registerHomeyWebhook(LinkTapID)
    {
        // See if the LinkTap is already registered
        if (this.linkTaps.findIndex(linktap => linktap === LinkTapID) >= 0)
        {
            // Already registered
            return;
        }

        this.linkTaps.push(LinkTapID);

        const data = {
            $keys: this.linkTaps,
        };

        // Setup the webhook call back to receive push notifications
        const id = Homey.env.WEBHOOK_ID;
        const secret = Homey.env.WEBHOOK_SECRET;

        if (this.homeyWebhook)
        {
            // Unregister the existing webhook
            await this.homeyWebhook.unregister();
            this.homeyWebhook = null;
        }

        try
        {
            this.homeyWebhook = await this.homey.cloud.createWebhook(id, secret, data);

            this.homeyWebhook.on('message', async args =>
            {
                this.updateLog(`Got a webhook message! ${this.varToString(args.body)}`, 0);
                try
                {
                    await this.processWebhookMessage(args.body);
                }
                catch(err)
                {
                    this.updateLog(`Homey Webhook message error: ${err.message}`);
                }
            });

            this.updateLog('Homey Webhook registered');
        }
        catch (err)
        {
            this.updateLog(`Homey Webhook failed to register: $(err.message)`);

            // Try again after 1 minute as it could be failing with the cached data
            this.homey.setTimeout(() =>
            {
                this.registerHomeyWebhook(LinkTapID);
            }, 1000 * 60);
        }
    }

    async onUninit()
    {
        this.deleteLinkTapWebhook();
    }

    // The getAllDevices API can only be called once every 5 minutes so get the data from the cache if it was called less than 5 minutes ago
    // Set UseDirtyCache to true if just need a list of devices and the values are not important
    // Returns null if no new data or an error
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
                this.homey.app.updateLog('App getDeviceData fetching data');

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

    // body can be use to pass in the APIKey and user name. If it is empty then the global app settings will be used
    async getLinkTapDevices(body)
    {
        const devices = [];
        let searchData = null;

        // For cloud to cloud connections use the API
        searchData = await this.getDeviceData(true, body);

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
                        type: tapLinker.dType,
                    };

                    // Add this device to the table
                    devices.push(
                    {
                        name: `${tapLinker.location} - ${tapLinker.taplinkerName}`,
                        data,
                        store,
                    }, );
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
        for (const driver of Object.values(drivers))
        {
            const devices = driver.getDevices();
            for (const device of Object.values(devices))
            {
                // const device = devices[i];
                if (device.processWebhookMessage)
                {
                    await device.processWebhookMessage(message);
                }
            }
        }
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
                //const webHookUrl = `https://webhooks.athom.com/webhook/${id}?homey=${homeyId}`;
                const webHookUrl = `https://webhooks.athom.com/webhook/${id}`;
              
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
    async deleteLinkTapWebhook()
    {
        try
        {
            // https://www.link-tap.com/api/deleteWebHookUrl
            const url = 'deleteWebHookUrl';
            await this.PostURL(url, { username: this.username, apiKey: this.apiKey });
        }
        catch (err)
        {
            this.log(err.message);
        }
    }

    async PostURL(url, body, logBody = true)
    {
        if (!body.username)
        {
            throw (new Error('HTTPS: No user name specified'));
        }

        if (!body.apiKey && !body.password)
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
                            returnData = JSON.parse(returnData);
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

                req.setTimeout(5000, () =>
                {
                    req.destroy();
                    reject(new Error('HTTP Catch: Timeout'));
                });

                req.write(bodyText);
                req.end();
            }
            catch (err)
            {
                this.log('HTTPS Catch: ', err);
                const stack = this.varToString(err.stack);
                reject(new Error(`HTTPS Catch: ${err.message}\n${stack}`));
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
            if (typeof(source) === 'object')
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
            if (typeof(source) === 'string')
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
        this.log(newMessage);
        if (errorLevel === 0)
        {
            this.error(newMessage);
        }

        if ((errorLevel === 0) || this.homey.settings.get('logEnabled'))
        {
            try
            {
                const nowTime = new Date(Date.now());

                this.diagLog += '\r\n* ';
                this.diagLog += nowTime.toJSON();
                this.diagLog += '\r\n';

                this.diagLog += newMessage;
                this.diagLog += '\r\n';
                if (this.diagLog.length > 60000)
                {
                    this.diagLog = this.diagLog.substr(this.diagLog.length - 60000);
                }

                if (!this.cloudOnly)
                {
                    this.homey.api.realtime('com.linktap.logupdated', { log: this.diagLog });
                }
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
                }, );

                // send mail with defined transport object
                const info = await transporter.sendMail(
                {
                    from: `"Homey User" <${Homey.env.MAIL_USER}>`, // sender address
                    to: Homey.env.MAIL_RECIPIENT, // list of receivers
                    subject: `LinkTap ${body.logType} log (${Homey.manifest.version})`, // Subject line
                    text: logData, // plain text body
                }, );

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
        return this.PostURL('getApiKey', body, false);
    }

}

module.exports = MyApp;
