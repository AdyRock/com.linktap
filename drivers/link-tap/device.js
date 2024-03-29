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
        this.cycles = 0;
        this.abortTimer = null;
        this.previousWateringMode = null;

        this.onDeviceUpdateVol = this.onDeviceUpdateVol.bind(this);
        this.abortWatering = this.abortWatering.bind(this);

        this.username = this.getStoreValue('username');
        this.apiKey = this.getStoreValue('apiKey');
        this.type = this.getStoreValue('type');
        this.waterTotal = this.getStoreValue('waterTotal');

        this.volUnits = this.getSetting('volume_units');
        if (!this.waterTotal)
        {
            this.waterTotal = 0;
        }

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

        const dd = this.getData();
        this.homey.app.registerHomeyWebhook(dd.gatewayId);
        
        if (!this.hasCapability('onoff'))
        {
            await this.addCapabilityLog('onoff');
            await this.setCapabilityValueLog('onoff', false);
        }

        if (!this.hasCapability('clear_alarms'))
        {
            await this.addCapabilityLog('clear_alarms').catch(this.error);
        }

        if (!this.hasCapability('time_elapsed'))
        {
            await this.addCapabilityLog('time_elapsed');
            await this.setCapabilityValueLog('time_elapsed', 0);

            // Ensure the correct tite is set for the time_remaining as it might have been changed by the old version
            await this.setCapabilityOptions('time_remaining', { title: this.homey.__('timeRemaining') });
        }

        if (!this.hasCapability('alarm_freeze'))
        {
            await this.addCapabilityLog('alarm_freeze');
            await this.setCapabilityValueLog('alarm_freeze', false);
        }

        if (this.hasCapability('signal_strength'))
        {
            // Signal strength is no longer part of the API that we use
            await this.removeCapabilityLog('signal_strength');
        }

        if (this.hasCapability('alarm_battery'))
        {
            await this.removeCapabilityLog('alarm_battery');
            await this.addCapabilityLog('measure_battery');
        }

        if (this.hasCapability('meter_water') && !this.hasCapability('meter_water.total'))
        {
            await this.addCapabilityLog('meter_water.total');
        }

        await this.setCapabilityValueLog('cycles_remaining', 0);
        await this.setCapabilityValueLog('time_remaining', 0);
        await this.setCapabilityValueLog('time_elapsed', 0);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('clear_alarms', this.onCapabilityClearAlarms.bind(this));
        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));
        this.registerCapabilityListener('button.send_log', this.onCapabilitySedLog.bind(this));

        if (this.hasCapability('meter_water.total'))
        {
            if (this.getCapabilityOptions('meter_water.total').units !== 'm³')
            {
                this.setCapabilityOptions('meter_water.total', {"title": "Total water used", 'units':'m³'});
                this.waterTotal /= 1000;
                this.setStoreValue('waterTotal', this.waterTotal);
                this.setCapabilityValue('meter_water.total', this.waterTotal).catch(this.error);

            }
        }

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
            if (tapLinker === undefined)
            {
                this.homey.app.updateLog(`updateDeviceValues (${dd.id}) Device not found in gateway`);
                this.setUnavailable(this.homey.__('notFound')).catch(this.error);
                return false;
            }
            this.homey.app.updateLog(`updateDeviceValues (${dd.id}) response: ${this.homey.app.varToString(tapLinker)}`);

            if (tapLinker.status !== 'Connected')
            {
                this.homey.app.updateLog('updateDeviceValues Valve status is not connected');
                this.setUnavailable(this.homey.__('ltOffline')).catch(this.error);
                return false;
            }

            await this.setAvailable();

            this.type = tapLinker.dType;
            this.setStoreValue('type', this.type);

            // Standard capabilities available to all device types
            this.setCapabilityValueLog('watering_mode', tapLinker.workMode !== 'N' ? tapLinker.workMode : null);
            this.setCapabilityValueLog('onoff', tapLinker.watering === true);
            this.setCapabilityValueLog('measure_battery', parseInt(tapLinker.batteryStatus, 10));
            this.setCapabilityValueLog('alarm_freeze', false);
            this.setCapabilityValueLog('watering', tapLinker.watering === true);
            this.setCapabilityValueLog('water_on', tapLinker.watering === true);

            // Some capabilities are only available on G2 models
            if ((this.type === 5) || (this.type === 10))
            {

                // G2 or G2S
                if (!this.hasCapability('alarm_fallen'))
                {
                    await this.addCapabilityLog('alarm_fallen');
                    await this.setCapabilityValueLog('alarm_fallen', tapLinker.fall);
                }
    
                if (!this.hasCapability('alarm_broken'))
                {
                    await this.addCapabilityLog('alarm_broken');
                    await this.setCapabilityValueLog('alarm_broken', tapLinker.valveBroken);
                }
            }
            else
            {
                if (this.hasCapability('alarm_fallen'))
                {
                    await this.removeCapabilityLog('alarm_fallen');
                }
            }

            // Some capabilities are only available when a flow meter is fitted.
            await this.setupFlowMeterCapabilities(tapLinker.flowMeterStatus);

            if (tapLinker.flowMeterStatus === 'on')
            {
                await this.setCapabilityValueLog('alarm_water', tapLinker.noWater);
                await this.setCapabilityValueLog('measure_water', tapLinker.vel / 1000);
                await this.setCapabilityValueLog('meter_water', 0);
                await this.setCapabilityValueLog('alarm_high_flow', tapLinker.leakFlag);
                await this.setCapabilityValueLog('alarm_low_flow', tapLinker.clogFlag);
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
        this.homey.app.updateLog(`setupFlowMeterCapabilities: ${FlowMeterConnected}`);

        if (FlowMeterConnected === 'on')
        {
            // Flow meter is connected so make sure we have all the capabilities

            if (!this.hasCapability('measure_water'))
            {
                await this.addCapabilityLog('measure_water');
            }

            if (!this.hasCapability('meter_water'))
            {
                await this.addCapabilityLog('meter_water');
            }
            
            if (!this.hasCapability('meter_water.total'))
            {
                await this.addCapabilityLog('meter_water.total');
            }
    
            if (!this.hasCapability('alarm_water'))
            {
                await this.addCapabilityLog('alarm_water');
            }

            if (!this.hasCapability('alarm_high_flow'))
            {
                await this.addCapabilityLog('alarm_high_flow');
            }

            if (!this.hasCapability('alarm_low_flow'))
            {
                await this.addCapabilityLog('alarm_low_flow');
            }
        }
        else
        {
            if (this.hasCapability('alarm_water'))
            {
                await this.removeCapabilityLog('alarm_water');
            }

            if (this.hasCapability('measure_water'))
            {
                await this.removeCapabilityLog('measure_water');
            }

            if (this.hasCapability('meter_water'))
            {
                await this.removeCapabilityLog('meter_water');
            }

            if (this.hasCapability('meter_water.total'))
            {
                await this.removeCapabilityLog('meter_water.total');
            }
    
            if (this.hasCapability('alarm_high_flow'))
            {
                await this.removeCapabilityLog('alarm_high_flow');
            }

            if (this.hasCapability('alarm_low_flow'))
            {
                await this.removeCapabilityLog('alarm_low_flow');
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

        if (this.hasCapability('alarm_water') && this.getCapabilityValue('alarm_water'))
        {
            body.alarm = 'noWater';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_broken') && this.getCapabilityValue('alarm_broken'))
        {
            body.alarm = 'valveBroken';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_fallen') && this.getCapabilityValue('alarm_fallen'))
        {
            body.alarm = 'fallFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_low_flow') && this.getCapabilityValue('alarm_low_flow'))
        {
            body.alarm = 'pcFlag';
            this.homey.app.PostURL(url, body).catch(this.error);
        }

        if (this.hasCapability('alarm_high_flow') && this.getCapabilityValue('alarm_high_flow'))
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
            if (autoBack)
            {
                this.previousWateringMode = this.getCapabilityValue('watering_mode');
            }
            else
            {
                this.previousWateringMode = null;
            }
        }
        else
        {
            // Cancel watering doesn't generate the 'watering end' webhook event when Eco mode is active so setup a backup to tidy up
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
        //this.setCapabilityValueLog('time_elapsed', 0).catch(this.error);

        this.cycles = 0;
        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

        this.setCapabilityValueLog('watering', false).catch(this.error);
        this.setCapabilityValueLog('onoff', false).catch(this.error);
        this.setCapabilityValueLog('measure_water', 0).catch(this.error);
        this.driver.triggerWateringFinished(this);
        if (this.previousWateringMode)
        {
            this.setCapabilityValueLog('watering_mode', this.previousWateringMode).catch(this.error);
        }
    }

    async onDeviceUpdateVol()
    {
        const vel = this.getCapabilityValue('measure_water');
        let vol = this.getCapabilityValue('meter_water');
        vol += vel / 30;
        this.setCapabilityValue('meter_water', vol).catch(this.error);
        this.setCapabilityValue('meter_water.total', this.waterTotal + (vol / 1000)).catch(this.error);
    }

    async processWebhookMessage(message)
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
                    // A watering plan has started or or manual mode was turned on
                    this.setAvailable().catch(this.error);

                    if (this.abortTimer)
                    {
                        this.homey.clearTimeout(this.abortTimer);
                        this.abortTimer = null;
                    }

                    this.setCapabilityValueLog('onoff', true).catch(this.error);
                    this.setCapabilityValueLog('watering', true).catch(this.error);
                    this.activeTime = 0;
                    this.setCapabilityValueLog('watering_mode', message.workMode);
                    this.driver.triggerWateringStarted(this);
                }
                else if (event === 'wateringOn')
                {
                    // The water flow (valve) has turned on (also occurs about once per minute)
                    this.setAvailable().catch(this.error);
                    this.setCapabilityValueLog('water_on', true).catch(this.error);
                    this.setCapabilityValueLog('watering', true).catch(this.error);

                    if (message.ecoFlag === 1)
                    {
                        // The ecoFlag is set so the water will switch off / on during the plan so calculate the number of times it will happens
                        // totalMin is the total request watering time (valve on)
                        // ecoTotal is the time it will turn on for each cycle
                        this.cycles = Math.ceil(message.ecoTotal / message.totalMin);
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);

                        if (message.onMin === message.totalMin)
                        {
                            // Manual mode was started so the time reported will be the run time instead of time remaining as the total time is unknown
                            this.manualWateringMode = false;
                        }
                    }
                    else if (message.ecoFlag !== 3)
                    {
                        this.cycles = 1;
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                        if ((message.onMin === 0) && (message.totalMin === -1))
                        {
                            // Turned on via the button
                            this.manualWateringMode = true;
                            this.setCapabilityValueLog('time_remaining', null).catch(this.error);
                        }
                    }

                    if (this.manualWateringMode)
                    {
                        // Elapsed time is reported during manual mode
                        this.setCapabilityValueLog('time_elapsed', message.onMin).catch(this.error);
                    }
                    else
                    {
                        // Remaining time is reported for a plan
                        this.setCapabilityValueLog('time_elapsed', this.activeTime).catch(this.error);
                        this.setCapabilityValueLog('time_remaining', message.onMin).catch(this.error);
                        this.activeTime++;
                    }
                    
                    if (message.vol !== undefined)
                    {
                        let vol = message.vol / 1000;
                        this.setCapabilityValueLog('meter_water', vol).catch(this.error);
                        this.setCapabilityValueLog('meter_water.total', this.waterTotal + (vol / 1000)).catch(this.error);

                        this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);

                        if (this.timerVolUpdate)
                        {
                            this.homey.clearInterval(this.timerVolUpdate);
                        }
                        this.timerVolUpdate = this.homey.setInterval(this.onDeviceUpdateVol, (1000 * 2));
                    }

                    if (message.battery)
                    {
                        this.setCapabilityValueLog('measure_battery', parseInt(message.battery, 10));
                    }

                }
                else if (event === 'wateringOff')
                {
                    this.setAvailable().catch(this.error);
                    this.setCapabilityValueLog('water_on', false).catch(this.error);
                    this.setCapabilityValueLog('time_remaining', 0).catch(this.error);
    
                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                        this.timerVolUpdate = null;
                    }

                    if (message.vol !== undefined)
                    {
                        let vol = message.vol / 1000;
                        this.setCapabilityValueLog('meter_water', vol).catch(this.error);
                        this.setCapabilityValueLog('meter_water.total', this.waterTotal + (vol / 1000)).catch(this.error);

                        this.setCapabilityValueLog('measure_water', 0).catch(this.error);
                    }

                    if (this.cycles > 0)
                    {
                        this.cycles--;
                        this.setCapabilityValueLog('cycles_remaining', this.cycles).catch(this.error);
                    }

                    if (!this.manualWateringMode)
                    {
                        this.setCapabilityValueLog('time_elapsed', this.activeTime).catch(this.error);
                    }

                    if (message.battery)
                    {
                        this.setCapabilityValueLog('measure_battery', parseInt(message.battery, 10));
                    }
                }
                else if (event === 'flowMeterValue')
                {
                    // A new water flow rate reading
                    this.setCapabilityValueLog('measure_water', message.vel / 1000).catch(this.error);
                }
                else if (event === 'watering end')
                {
                    this.setAvailable().catch(this.error);
                    // The watering plan has ended or manual mode has been switched off
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

                    this.setCapabilityValueLog('watering', false).catch(this.error);
                    this.setCapabilityValueLog('onoff', false).catch(this.error);

                    // Docode the total volume from the message
                    const data = message.content.split(/[(,]+/);
                    if (data.length > 1)
                    {
                        let vol = Number((data[1].split(' '))[0]);
                        this.setCapabilityValueLog('meter_water', vol).catch(this.error);
                        this.waterTotal += (vol / 1000);
                        this.setStoreValue('waterTotal', this.waterTotal);

                        this.setCapabilityValueLog('meter_water.total', this.waterTotal).catch(this.error);
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
                    await this.setAvailable().catch(this.error);
                }
                else if (event === 'gatewayOffline')
                {
                    await this.setUnavailable(this.homey.__('gwOffline')).catch(this.error);
                }
                else if (event === 'deviceOffline')
                {
                    await this.setUnavailable(this.homey.__('ltOffline')).catch(this.error);
                }
                else if (event === 'deviceOnline')
                {
                    await this.setAvailable().catch(this.error);
                }
                else if (event === 'battery low alert')
                {
                    this.setCapabilityValueLog('alarm_battery', 0).catch(this.error);
                }
                else if (event === 'battery good')
                {
                    this.setCapabilityValueLog('alarm_battery', 100).catch(this.error);
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
                    await this.setupFlowMeterCapabilities(message.status);
                    this.updateDeviceValues();
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
        try
        {
            await this.setCapabilityValue(capability, value);
        }
        catch(err)
        {
            this.homey.app.updateLog(`setCapabilityValueLog error ${capability} ${err.message}`);
        }
    }

    async addCapabilityLog(capability)
    {
        this.homey.app.updateLog(`addCapabilityLog ${capability}`);
        try
        {
            await this.addCapability(capability);
        }
        catch(err)
        {
            this.homey.app.updateLog(`addCapabilityLog error ${capability} ${err.message}`);
        }
    }

    async removeCapabilityLog(capability)
    {
        this.homey.app.updateLog(`removeCapabilityLog ${capability}`);
        try
        {
            await this.removeCapability(capability);
        }
        catch(err)
        {
            this.homey.app.updateLog(`removeCapabilityLog error ${capability} ${err.message}`);
        }
    }
}

module.exports = LinkTapDevice;