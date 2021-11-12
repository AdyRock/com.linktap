/* jslint node: true */

'use strict';

const Homey = require('homey');

class LinkTapDevice extends Homey.Device
{

    /**
     * onInit is called when the device is initialized.
     */
    async onInit()
    {
        this.log('LinkTapDevice initialising');
        this.isWatering = false;
        this.cycles = 0;
        this.abortTimer = null;

        this.onDeviceUpdateVol = this.onDeviceUpdateVol.bind(this);
        this.abortWatering = this.abortWatering.bind(this);

        this.username = this.getStoreValue('username');
        this.apiKey = this.getStoreValue('apiKey');

        // Old devices used the global credentials so use those if the local ones are not defined
        if (!this.apiKey)
        {
            // Update the values
            this.apiKey = this.homey.app.apiKey;
            this.username = this.homey.app.username;

            this.setStoreValue('username', this.username);
            this.setStoreValue('apiKey', this.apiKey);
        }

        // Check the connection with the credentials
        if (!await this.homey.app.registerWebhookURL(this.apiKey, this.username))
        {
            // No good. Check if the global API key is different for the same usernam
            if ((this.apiKey !== this.homey.app.apiKey) && (this.username === this.homey.app.username))
            {
                // The device store values are not good so try the app ones
                this.apiKey = this.homey.app.apiKey;
                if (!await this.homey.app.registerWebhookURL(this.apiKey, this.username))
                {
                    // Still no good
                    this.setUnavailable(this.homey.__('connectionFailed'));
                }
                else
                {
                    // Connect OK so save the API key
                    this.setStoreValue('apiKey', this.apiKey);
                }
            }
            else
            {
                this.setUnavailable(this.homey.__('connectionFailed'));
            }
        }

        if (!this.hasCapability('onoff'))
        {
            this.addCapability('onoff')
                .then(this.setCapabilityValueLog('onoff', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('clear_alarms'))
        {
            this.addCapability('clear_alarms').catch(this.error);
        }

        if (!this.hasCapability('alarm_fallen'))
        {
            this.addCapability('alarm_fallen')
                .then(this.setCapabilityValueLog('alarm_fallen', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('alarm_broken'))
        {
            this.addCapability('alarm_broken')
                .then(this.setCapabilityValueLog('alarm_broken', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('alarm_freeze'))
        {
            this.addCapability('alarm_freeze')
                .then(this.setCapabilityValueLog('alarm_freeze', false).catch(this.error))
                .catch(this.error);
        }

        if (this.hasCapability('signal_strength'))
        {
            // Signal strength is no longer part of the API that we use
            this.removeCapability('signal_strength').catch(this.error);
        }

        if (this.hasCapability('measure_battery'))
        {
            // The new webhook only provides a good / bad status
            this.removeCapability('measure_battery').catch(this.error);
            this.addCapability('alarm_battery')
                .then(this.setCapabilityValueLog('alarm_battery', false).catch(this.error))
                .catch(this.error);
        }

        this.setCapabilityValueLog('cycles_remaining', 0).catch(this.error);
        this.setCapabilityValueLog('time_remaining', 0).catch(this.error);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('clear_alarms', this.onCapabilityClearAlarms.bind(this));
        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));
        this.registerCapabilityListener('button.send_log', this.onCapabilitySedLog.bind(this));

        // Try to fetch the initial values
        this.updateDeviceValues();

        this.log('LinkTapDevice has been initialized');
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('LinkTapDevice has been added');

        // Try to fetch the initial values
        this.updateDeviceValues();
    }

    /**
     * onSettings is called when the user updates the device's settings.
     * @param {object} event the onSettings event data
     * @param {object} event.oldSettings The old settings object
     * @param {object} event.newSettings The new settings object
     * @param {string[]} event.changedKeys An array of keys changed since the previous version
     * @returns {Promise<string|void>} return a custom message that will be displayed
     */
    async onSettings({ oldSettings, newSettings, changedKeys })
    {
        this.log('LinkTapDevice settings where changed');
    }

    /**
     * onRenamed is called when the user updates the device's name.
     * This method can be used this to synchronise the name to the device.
     * @param {string} name The new name
     */
    async onRenamed(name)
    {
        this.log('LinkTapDevice was renamed');
    }

    /**
     * onDeleted is called when the user deleted the device.
     */
    async onDeleted()
    {
        this.log('LinkTapDevice has been deleted');
    }

    updateDeviceValues()
    {
        this.__updateDeviceValues()
            .then(success =>
            {
                if (!success)
                {
                    this.homey.app.updateLog('updateDeviceValues retry in 5 minutes');

                    // Try again after 5 minutes as it could be failing with the cached data
                    this.homey.setTimeout(() =>
                    {
                        this.updateDeviceValues();
                    }, 1000 * 60 * 5);
                }
            });
    }

    async __updateDeviceValues()
    {
        this.homey.app.updateLog('updateDeviceValues');

        const body = {
            apiKey: this.apiKey,
            username: this.username,
        };

        // Get new data via the API (don't use the cache)
        const devices = await this.homey.app.getDeviceData(true, body);

        if (devices === null)
        {
            this.homey.app.updateLog('updateDeviceValues no new device data available');
            return false;
        }

        const dd = this.getData();

        try
        {
            const gateway = devices.find(gateway => gateway.gatewayId === dd.gatewayId);

            if (gateway.status !== 'Connected')
            {
                this.homey.app.updateLog('updateDeviceValues Gateway status is not connected');
                this.setUnavailable(this.homey.__('gwOffline')).catch(this.error);
                return false;
            }

            const tapLinkers = gateway.taplinker;
            const tapLinker = tapLinkers.find(tapLinkerEntry => tapLinkerEntry.taplinkerId === dd.id);
            this.homey.app.updateLog(`updateDeviceValues (${dd.id}) response: ${this.homey.app.varToString(tapLinker)}`);

            if (tapLinker.status !== 'Connected')
            {
                this.homey.app.updateLog('updateDeviceValues Valve status is not connected');
                this.setUnavailable(this.homey.__('ltOffline')).catch(this.error);
                return false;
            }

            await this.setAvailable();

            // Standard capabilities available to all device types
            this.setCapabilityValueLog('watering_mode', tapLinker.workMode !== 'N' ? tapLinker.workMode : null).catch(this.error);
            this.setCapabilityValueLog('onoff', tapLinker.watering === true).catch(this.error);
            this.setCapabilityValueLog('alarm_battery', parseInt(tapLinker.batteryStatus, 10) < 30).catch(this.error);
            this.setCapabilityValueLog('alarm_freeze', false).catch(this.error);
            this.setCapabilityValueLog('watering', tapLinker.watering === true).catch(this.error);
            this.setCapabilityValueLog('water_on', tapLinker.watering === true).catch(this.error);

            // Some capabilities are only available on G2 models
            if (typeof tapLinker.fall !== 'undefined')
            {
                if (!this.hasCapability('alarm_fallen'))
                {
                    this.addCapability('alarm_fallen').catch(this.error);
                    this.addCapability('alarm_broken').catch(this.error);
                }
                this.setCapabilityValueLog('alarm_fallen', tapLinker.fall).catch(this.error);
                this.setCapabilityValueLog('alarm_broken', tapLinker.valveBroken).catch(this.error);
            }
            else if (this.hasCapability('alarm_fallen'))
            {
                this.removeCapability('alarm_fallen').catch(this.error);
                this.removeCapability('alarm_broken').catch(this.error);
            }

            // Some capabilities are only available when a flow meter is fitted.
            await this.setupFlowMeterCapabilities(tapLinker.flowMeterStatus);

            if (tapLinker.flowMeterStatus === 'on')
            {
                this.setCapabilityValueLog('alarm_water', tapLinker.noWater).catch(this.error);
                this.setCapabilityValueLog('measure_water', tapLinker.vel / 1000).catch(this.error);
                this.setCapabilityValueLog('meter_water', 0).catch(this.error);
                this.setCapabilityValueLog('alarm_high_flow', tapLinker.leakFlag).catch(this.error);
                this.setCapabilityValueLog('alarm_low_flow', tapLinker.clogFlag).catch(this.error);
            }
        }
        catch (err)
        {
            this.homey.app.updateLog(`updateDeviceValues (${dd.id}) Error: ${err.message}`, 0);
            return false;
        }

        return true;
    }

    async setupFlowMeterCapabilities(FlowMeterConnected)
    {
        if (FlowMeterConnected === 'on')
        {
            // Flow meter is connected so make sure we have all the capabilities

            if (!this.hasCapability('measure_water'))
            {
                this.addCapability('measure_water').catch(this.error);
            }

            if (!this.hasCapability('meter_water'))
            {
                this.addCapability('meter_water').catch(this.error);
            }

            if (!this.hasCapability('alarm_water'))
            {
                this.addCapability('alarm_water').catch(this.error);
            }

            if (!this.hasCapability('alarm_high_flow'))
            {
                this.addCapability('alarm_high_flow').catch(this.error);
            }

            if (!this.hasCapability('alarm_low_flow'))
            {
                this.addCapability('alarm_low_flow').catch(this.error);
            }
        }
        else
        {
            if (this.hasCapability('alarm_water'))
            {
                this.removeCapability('alarm_water').catch(this.error);
            }

            if (this.hasCapability('measure_water'))
            {
                this.removeCapability('measure_water').catch(this.error);
            }

            if (this.hasCapability('meter_water'))
            {
                this.removeCapability('meter_water').catch(this.error);
            }

            if (this.hasCapability('alarm_high_flow'))
            {
                this.removeCapability('alarm_high_flow').catch(this.error);
            }

            if (this.hasCapability('alarm_low_flow'))
            {
                this.removeCapability('alarm_low_flow').catch(this.error);
            }
        }
    }

    async onCapabilityClearAlarms(value)
    {
        // Send a message for each active alarm to clear it
        const dd = this.getData();
        const url = 'dismissAlarm';
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            alarm: '',
            apiKey: this.apiKey,
            username: this.username,
        };

        if (this.getCapabilityValue('alarm_water'))
        {
            body.alarm = 'noWater';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.getCapabilityValue('alarm_broken'))
        {
            body.alarm = 'valveBroken';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.getCapabilityValue('alarm_fallen'))
        {
            body.alarm = 'fallFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.getCapabilityValue('alarm_low_flow'))
        {
            body.alarm = 'pcFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.getCapabilityValue('alarm_high_flow'))
        {
            body.alarm = 'pbFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        this.setCapabilityValueLog('alarm_freeze', false).catch(this.error);
    }

    async onCapabilitySedLog(value)
    {
        const body = {
            notify: true,
            logType: "diag"
        };

        this.homey.app.sendLog(body);
    }

    async onCapabilityOnOff(value)
    {
        // Instant mode
        this.homey.app.updateLog(`onCapabilityOnOff ${value}`);

        const settings = this.getSettings();
        return this.activateInstantMode(value,
            settings.watering_duration,
            settings.eco_mode,
            settings.on_duration,
            settings.off_duration,
            settings.revert);
    }

    async onCapabilityWateringMode(value)
    {
        this.homey.app.updateLog(`onCapabilityWateringMode ${value}`);

        if (value === 'M')
        {
            // Instant mode
            const settings = this.getSettings();
            return this.activateInstantMode(true,
                settings.watering_duration,
                settings.eco_mode,
                settings.on_duration,
                settings.off_duration,
                settings.revert);
        }

        // All other modes
        return this.activateWateringMode(value);
    }

    async activateWateringMode(mode)
    {
        this.homey.app.updateLog(`activateWateringMode ${mode}`);

        const dd = this.getData();
        let url;
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            apiKey: this.apiKey,
            username: this.username,
        };

        if (mode === 'I')
        {
            url = 'activateIntervalMode';
        }
        else if (mode === 'O')
        {
            url = 'activateOddEvenMode';
        }
        else if (mode === 'T')
        {
            url = 'activateSevenDayMode';
        }
        else if (mode === 'Y')
        {
            url = 'activateMonthMode';
        }
        else if (mode === 'D')
        {
            url = 'activateCalendarMode';
        }

        try
        {
            this.homey.app.updateLog(`activateWateringMode mode: ${mode}`);

            const response = await this.homey.app.PostURL(url, body);
            if (response.result !== 'ok')
            {
                throw (new Error(response.result));
            }
        }
        catch (err)
        {
            if (err.message === 'HTTPS Error - 400')
            {
                let errMsg = this.homey.__('wateringModeUndefined.' + mode);
                throw (new Error(errMsg));
            }
            if (err.message === 'HTTPS Error - 404')
            {
                let errMsg = this.homey.__('wateringModeNotSupported.' + mode);
                throw (new Error(errMsg));
            }
            throw (new Error(err.message));
        }
    }

    async activateInstantMode(onOff, duration, ecoOption, ecoOn, ecoOff, autoBack)
    {
        this.homey.app.updateLog(`activateInstantMode ${onOff}`);

        const url = 'activateInstantMode';
        const dd = this.getData();
        const body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            action: false,
            duration: 0,
            apiKey: this.apiKey,
            username: this.username,
        };

        if (onOff)
        {
            body.action = true;

            if (!duration)
            {
                duration = 5;
            }

            body.duration = duration;

            if (ecoOption)
            {
                if (ecoOn > duration)
                {
                    throw (new Error('Eco On must be shorter than Duration'));
                }

                body.eco = true;
                body.ecoOn = ecoOn;
                body.ecoOff = ecoOff;
                this.cycles = Math.ceil(duration / ecoOn);
            }
            else
            {
                this.cycles = 1;
                body.eco = false;
            }
            body.autoBack = autoBack;
        }
        else
        {
            this.abortTimer = this.homey.setTimeout(() =>
            {
                // Switch of watering if no activity for 1 minute
                this.abortWatering();
            }, 1000 * 60 * 1);
        }

        this.homey.app.updateLog(`activateInstantMode onOff: ${onOff}`);

        const response = await this.homey.app.PostURL(url, body);
        if (response.result !== 'ok')
        {
            throw (new Error(response.result));
        }
    }

    abortWatering()
    {
        if (this.abortTimer)
        {
            this.homey.clearTimeout(this.abortTimer);
            this.abortTimer = null;
        }

        this.homey.app.updateLog('abortWatering');

        if (this.timerVolUpdate)
        {
            this.homey.clearInterval(this.timerVolUpdate);
            this.timerVolUpdate = null;
        }

        this.setCapabilityValueLog('water_on', false).catch(this.error);
        this.setCapabilityValueLog('time_remaining', 0).catch(this.error);

        this.cycles = 0;
        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

        this.isWatering = false;
        this.setCapabilityValueLog('watering', this.isWatering).catch(this.error);
        this.setCapabilityValueLog('onoff', this.isWatering).catch(this.error);
        this.setCapabilityValueLog('measure_water', 0).catch(this.error);
        this.driver.triggerWateringFinished(this);
    }

    async onDeviceUpdateVol()
    {
        const vel = this.getCapabilityValue('measure_water');
        let vol = this.getCapabilityValue('meter_water');
        vol += vel / 30;
        this.setCapabilityValueLog('meter_water', vol).catch(this.error);
    }

    processWebhookMessage(message)
    {
        try
        {
            const dd = this.getData();
            if ((dd.id === message.deviceId) && (dd.gatewayId === message.gatewayId))
            {
                // message is for this device
                let event = message.event ? message.event : message.msg;

                this.homey.app.updateLog(`processWebhookMessage ${event}`);

                if (event === 'watering start')
                {
                    if (this.abortTimer)
                    {
                        this.homey.clearTimeout(this.abortTimer);
                        this.abortTimer = null;
                    }

                    this.isWatering = true;
                    this.setCapabilityValueLog('onoff', this.isWatering).catch(this.error);
                    this.setCapabilityValueLog('watering', this.isWatering).catch(this.error);
                    //this.setCapabilityValueLog('watering_mode', message.workMode).catch(this.error);
                    this.driver.triggerWateringStarted(this);
                }
                else if (event === 'wateringOn')
                {
                    this.setCapabilityValueLog('water_on', true).catch(this.error);
                    this.setCapabilityValueLog('time_remaining', message.onMin).catch(this.error);
                    this.setCapabilityValueLog('watering', this.isWatering).catch(this.error);

                    if (message.ecoFlag === 1)
                    {
                        this.cycles = Math.ceil(message.ecoTotal / message.totalMin);
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                        if (message.onMin === message.totalMin)
                        {
                            this.setCapabilityOptions('time_remaining', { title: this.homey.__('timeRemaining') });
                        }
                    }
                    else if (message.ecoFlag !== 3)
                    {
                        this.cycles = 1;
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                        if ((message.onMin === 0) && (message.totalMin === -1))
                        {
                            // Turned on via the button
                            this.setCapabilityOptions('time_remaining', { title: this.homey.__('timeActive') });
                        }
                    }

                    if (message.vol !== undefined)
                    {
                        this.setCapabilityValueLog('meter_water', message.vol / 1000).catch(this.error);
                        this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);

                        if (this.timerVolUpdate)
                        {
                            this.homey.clearInterval(this.timerVolUpdate);
                        }
                        this.timerVolUpdate = this.homey.setInterval(this.onDeviceUpdateVol, (1000 * 2));
                    }
                }
                else if (event === 'wateringOff')
                {
                    if (this.cycles > 0 && this.isWatering)
                    {
                        if (this.timerVolUpdate)
                        {
                            this.homey.clearInterval(this.timerVolUpdate);
                            this.timerVolUpdate = null;
                        }

                        this.setCapabilityValueLog('water_on', false).catch(this.error);
                        this.setCapabilityValueLog('time_remaining', 0).catch(this.error);

                        if (message.vol !== undefined)
                        {
                            this.setCapabilityValueLog('meter_water', message.vol / 1000).catch(this.error);
                            this.setCapabilityValueLog('measure_water', 0).catch(this.error);
                        }

                        if ((message.ecoFlag === 3) || (message.ecoFlag === 1))
                        {
                            this.cycles--;
                            this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                        }
                    }
                }
                else if (event === 'flowMeterValue')
                {
                    this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);
                }
                else if (event === 'watering end')
                {
                    if (this.abortTimer)
                    {
                        this.homey.clearTimeout(this.abortTimer);
                        this.abortTimer = null;
                    }

                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                        this.timerVolUpdate = null;
                    }

                    this.setCapabilityValueLog('water_on', false).catch(this.error);
                    this.setCapabilityValueLog('time_remaining', 0).catch(this.error);

                    this.cycles = 0;
                    this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

                    this.isWatering = false;
                    this.setCapabilityValueLog('watering', this.isWatering).catch(this.error);
                    this.setCapabilityValueLog('onoff', this.isWatering).catch(this.error);
                    const data = message.content.split(/[(,]+/);
                    if (data.length > 1)
                    {
                        const vol = Number((data[1].split(' '))[0]);
                        this.setCapabilityValueLog('meter_water', vol).catch(this.error);
                    }
                    this.setCapabilityValueLog('measure_water', 0).catch(this.error);
                    this.driver.triggerWateringFinished(this);
                }
                else if (event === 'watering cycle skipped')
                {
                    this.driver.triggerWateringSkipped(this);
                }
                else if (event === 'gatewayOnline')
                {
                    this.setAvailable().catch(this.error);
                }
                else if (event === 'gatewayOffline')
                {
                    this.setUnavailable(this.homey.__('gwOffline')).catch(this.error);
                }
                else if (event === 'deviceOffline')
                {
                    this.setUnavailable(this.homey.__('ltOffline')).catch(this.error);
                }
                else if (event === 'deviceOnline')
                {
                    this.setAvailable().catch(this.error);
                }
                else if (event === 'battery low alert')
                {
                    this.setCapabilityValueLog('alarm_battery', true).catch(this.error);
                }
                else if (event === 'battery good')
                {
                    this.setCapabilityValueLog('alarm_battery', false).catch(this.error);
                }
                else if (event === 'water cut-off alert')
                {
                    this.setCapabilityValueLog('alarm_water', true).catch(this.error);
                }
                else if (event === 'unusually high flow alert')
                {
                    this.setCapabilityValueLog('alarm_high_flow', true).catch(this.error);
                }
                else if (event === 'unusually low flow alert')
                {
                    this.setCapabilityValueLog('alarm_low_flow', true).catch(this.error);
                }
                else if (event === 'valve broken alert')
                {
                    this.setCapabilityValueLog('alarm_broken', true).catch(this.error);
                }
                else if (event === 'device fall alert')
                {
                    this.setCapabilityValueLog('alarm_fallen', true).catch(this.error);
                }
                else if (event === 'manual button pressed')
                {
                    // Add a handler in here in the future
                }
                else if (event === 'freeze alert')
                {
                    this.setCapabilityValueLog('alarm_freeze', true).catch(this.error);
                }
                else if (event === 'alarm clear')
                {
                    if (message.title === 'noWater')
                    {
                        this.setCapabilityValueLog('alarm_water', false).catch(this.error);
                    }
                    else if (message.title === 'valveBroken')
                    {
                        this.setCapabilityValueLog('alarm_broken', false).catch(this.error);
                    }
                    else if (message.title === 'fallFlag')
                    {
                        this.setCapabilityValueLog('alarm_fallen', false).catch(this.error);
                    }
                    else if (message.title === 'pcFlag')
                    {
                        this.setCapabilityValueLog('alarm_low_flow', false).catch(this.error);
                    }
                    else if (message.title === 'pbFlag')
                    {
                        this.setCapabilityValueLog('alarm_high_flow', false).catch(this.error);
                    }
                }
                else if (event === 'flowMeterStatus')
                {
                    this.setupFlowMeterCapabilities(message.status)
                        .then(this.updateDeviceValues());
                }
            }
        }
        catch(err)
        {
            this.homey.app.updateLog(`processWebhookMessage error ${err.message}`);
        }
    }

    async setCapabilityValueLog(capability, value)
    {
        this.homey.app.updateLog(`setCapability ${capability}: ${value}`);
        this.setCapabilityValue(capability, value).catch( error => this.homey.app.updateLog(`setCapability error ${capability}: ${error}`));
    }
}

module.exports = LinkTapDevice;