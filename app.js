/*jslint node: true */
'use strict';

if (process.env.DEBUG === '1')
{
    require('inspector').open(9222, '0.0.0.0', true);
}

const Homey = require('homey');
const https = require("https");
const nodemailer = require("nodemailer");

class MyApp extends Homey.App
{
    /**
     * onInit is called when the app is initialized.
     */
    async onInit()
    {
        this.log('MyApp has been initialized');
        this.diagLog = "";

        if (process.env.DEBUG === '1')
        {
            this.homey.settings.set('debugMode', true);
        }
        else
        {
            this.homey.settings.set('debugMode', false);
        }

        this.homey.settings.on('set', (key) =>
        {
            if (key === 'APIToken')
            {
                this.APIToken = this.homey.settings.get('APIToken');
            }
            else if (key === 'UserName')
            {
                this.UserName = this.homey.settings.get('UserName');
            }
        });

        this.APIToken = this.homey.settings.get('APIToken');
        this.UserName = this.homey.settings.get('UserName');
        this.lastDetectionTime = this.homey.settings.get('lastDetectionTime');
        this.detectedDevices = this.homey.settings.get('detectedDevices');

        this.onDevicePoll = this.onDevicePoll.bind(this);
        this.restartPolling(5);
    }

    restartPolling(initialDelay)
    {
        clearTimeout(this.timerPollID);
        this.timerPollID = this.homey.setTimeout(this.onDevicePoll, (1000 * initialDelay));
    }

    async onDevicePoll()
    {
        const searchData = await this.getDeviceData();
        const promises = [];
        const drivers = this.homey.drivers.getDrivers();
        for (const driver in drivers)
        {
            let devices = this.homey.drivers.getDriver(driver).getDevices();
            let numDevices = devices.length;
            for (var i = 0; i < numDevices; i++)
            {
                let device = devices[i];
                if (device.updateDeviceValues)
                {
                    promises.push(device.updateDeviceValues(searchData));
                }
            }
        }

        await Promise.all(promises);

        this.timerPollID = this.homey.setTimeout(this.onDevicePoll, (1000 * 60 * 5));
    }

    async getDeviceData()
    {
        let searchData;

        if (process.env.DEBUG === '1')
        {
            const simData = this.homey.settings.get('simData');
            if (simData)
            {
                return JSON.parse(simData);
            }
        }

        if (!this.lastDetectionTime || (Date.now() - this.lastDetectionTime > (1000 * 60 * 5)))
        {
            // More than 5 minutes since last request
            //https://www.link-tap.com/api/getAllDevices
            const url = "getAllDevices";
            let response = await this.PostURL(url, {});
            searchData = response.devices;
            this.detectedDevices = this.varToString(searchData);
            this.lastDetectionTime = Date.now();
            this.homey.settings.set('detectedDevices', this.detectedDevices);
            this.homey.settings.set('lastDetectionTime', this.lastDetectionTime);
            this.homey.api.realtime('com.linktap.detectedDevicesUpdated', { 'devices': this.detectedDevices });
        }
        else
        {
            searchData = JSON.parse(this.detectedDevices);
        }

        return searchData;
    }

    async getDevices()
    {
        const devices = [];
        const searchData = await this.getDeviceData();

        if (searchData)
        {
            // Create an array of devices
            for (const gateway of searchData)
            {
                for (const tapLinker of gateway.taplinker)
                {
                    this.updateLog("Found LinkTap: ");
                    this.updateLog(tapLinker);

                    let data = {};
                    data = {
                        "id": tapLinker.taplinkerId,
                        "gatewayId": gateway.gatewayId,
                    };

                    // Add this device to the table
                    devices.push(
                    {
                        "name": tapLinker.location + " - " + tapLinker.taplinkerName,
                        data
                    });
                }
            }
            return devices;
        }
        else
        {
            this.updateLog("HTTPS Error: Nothing returned");
            throw (new Error("HTTPS Error: Nothing returned"));
        }
    }

    async PostURL(url, body)
    {
        if (!this.UserName)
        {
            throw (new Error("HTTPS: No user name specified"));
        }

        if (!this.APIToken)
        {
            throw (new Error("HTTPS: No API Key specified"));
        }

        //this.updateLog("POST to: " + url + "\r\n" + this.varToString(body) + "\r\n");

        body.username = this.UserName;
        body.apiKey = this.APIToken;

        let bodyText = JSON.stringify(body);
        //this.updateLog(bodyText);

        return new Promise((resolve, reject) =>
        {
            try
            {
                const safeUrl = encodeURI(url);

                let https_options = {
                    host: "www.link-tap.com",
                    path: "/api/" + safeUrl,
                    method: "POST",
                    headers:
                    {
                        "Content-type": "application/json",
                        "Content-Length": bodyText.length
                    },
                };

                //this.updateLog(https_options);

                let req = https.request(https_options, (res) =>
                {
                    let body = [];
                    res.on('data', (chunk) =>
                    {
                        //this.updateLog("Post: retrieve data");
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
                            return;
                        }
                        else
                        {
                            this.updateLog("HTTPS Error: " + res.statusCode);
                            reject(new Error("HTTPS Error - " + res.statusCode));
                            return;
                        }
                    });
                });

                req.on('error', (err) =>
                {
                    this.updateLog(err);
                    reject(new Error("HTTPS Catch: " + err));
                    return;
                });

                req.setTimeout(5000, function()
                {
                    req.destroy();
                    reject(new Error("HTTP Catch: Timeout"));
                    return;
                });

                req.write(bodyText);
                req.end();
            }
            catch (err)
            {
                this.updateLog(this.varToString(err));
                reject(new Error("HTTPS Catch: " + err));
                return;
            }
        });
    }

    varToString(source)
    {
        try
        {
            if (source === null)
            {
                return "null";
            }
            if (source === undefined)
            {
                return "undefined";
            }
            if (source instanceof Error)
            {
                let stack = source.stack.replace('/\\n/g', '\n');
                return source.message + '\n' + stack;
            }
            if (typeof(source) === "object")
            {
                const getCircularReplacer = () =>
                {
                    const seen = new WeakSet();
                    return (key, value) =>
                    {
                        if (typeof value === "object" && value !== null)
                        {
                            if (seen.has(value))
                            {
                                return;
                            }
                            seen.add(value);
                        }
                        return value;
                    };
                };

                return JSON.stringify(source, getCircularReplacer(), 2);
            }
            if (typeof(source) === "string")
            {
                return source;
            }
        }
        catch (err)
        {
            this.log("VarToString Error: ", err);
        }

        return source.toString();
    }

    updateLog(newMessage, errorLevel = 1)
    {
        if ((errorLevel == 0) || this.homey.settings.get('logEnabled'))
        {
            console.log(newMessage);

            const nowTime = new Date(Date.now());

            this.diagLog += "\r\n* ";
            this.diagLog += (nowTime.getHours());
            this.diagLog += ":";
            this.diagLog += nowTime.getMinutes();
            this.diagLog += ":";
            this.diagLog += nowTime.getSeconds();
            this.diagLog += ".";
            let milliSeconds = nowTime.getMilliseconds().toString();
            if (milliSeconds.length == 2)
            {
                this.diagLog += '0';
            }
            else if (milliSeconds.length == 1)
            {
                this.diagLog += '00';
            }
            this.diagLog += milliSeconds;
            this.diagLog += ": ";
            this.diagLog += "\r\n";

            this.diagLog += newMessage;
            this.diagLog += "\r\n";
            if (this.diagLog.length > 60000)
            {
                this.diagLog = this.diagLog.substr(this.diagLog.length - 60000);
            }
            this.homey.api.realtime('com.linktap.logupdated', { 'log': this.diagLog });
        }
    }

    async sendLog(body)
    {
        let tries = 5;

        let logData;
        if (body.logType == "diag")
        {
            logData = Homey.ManagerSettings.get('diagLog');
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
                    gateway.location =
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
                throw (new Error("No data to send"));
            }

            logData = this.varToString(logData);
        }

        while (tries-- > 0)
        {
            try
            {
                // create reusable transporter object using the default SMTP transport
                let transporter = nodemailer.createTransport(
                {
                    host: Homey.env.MAIL_HOST, //Homey.env.MAIL_HOST,
                    port: 465,
                    ignoreTLS: false,
                    secure: true, // true for 465, false for other ports
                    auth:
                    {
                        user: Homey.env.MAIL_USER, // generated ethereal user
                        pass: Homey.env.MAIL_SECRET // generated ethereal password
                    },
                    tls:
                    {
                        // do not fail on invalid certs
                        rejectUnauthorized: false
                    }
                });

                // send mail with defined transport object
                let info = await transporter.sendMail(
                {
                    from: '"Homey User" <' + Homey.env.MAIL_USER + '>', // sender address
                    to: Homey.env.MAIL_RECIPIENT, // list of receivers
                    subject: "LinkTap " + body.logType + " log", // Subject line
                    text: logData // plain text body
                });

                this.updateLog("Message sent: " + info.messageId);
                // Message sent: <b658f8ca-6296-ccf4-8306-87d57a0b4321@example.com>

                // Preview only available when sending through an Ethereal account
                console.log("Preview URL: ", nodemailer.getTestMessageUrl(info));
                return this.homey.__('settings.logSent');
            }
            catch (err)
            {
                this.updateLog("Send log error: " + err.stack, 0);
            }
        }

        return (this.homey.__('settings.logSendFailed'));
    }
}

module.exports = MyApp;