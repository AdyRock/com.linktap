/*jslint node: true */
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

        this.onDeviceUpdateVol = this.onDeviceUpdateVol.bind(this);

        if (!this.hasCapability('onoff'))
        {
            this.addCapability('onoff')
                .then(this.setCapabilityValue('onoff', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('clear_alarms'))
        {
            this.addCapability('clear_alarms').catch(this.error);
        }

        if (!this.hasCapability('alarm_fallen'))
        {
            this.addCapability('alarm_fallen')
                .then(this.setCapabilityValue('alarm_fallen', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('alarm_broken'))
        {
            this.addCapability('alarm_broken')
                .then(this.setCapabilityValue('alarm_broken', false).catch(this.error))
                .catch(this.error);
        }

        if (!this.hasCapability('alarm_freeze'))
        {
            this.addCapability('alarm_freeze')
                .then(this.setCapabilityValue('alarm_freeze', false).catch(this.error))
                .catch(this.error);
        }

        if (this.hasCapability('signal_strength'))
        {
            this.removeCapability('signal_strength').catch(this.error);
        }

        if (this.hasCapability('measure_battery'))
        {
            this.removeCapability('measure_battery').catch(this.error);
            this.addCapability('alarm_battery')
                .then(this.setCapabilityValue('alarm_battery', false).catch(this.error))
                .catch(this.error);
        }

        this.setCapabilityValue('cycles_remaining', 0).catch(this.error);
        this.setCapabilityValue('time_remaining', 0).catch(this.error);

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('clear_alarms', this.onCapabilityClearAlarms.bind(this));
        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));

        this.updateDeviceValues();

        this.log('LinkTapDevice has been initialized');
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('LinkTapDevice has been added');

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
        clearTimeout(this.timerPollID);
    }

    async updateDeviceValues()
    {
        this.__updateDeviceValues()
            .then(success =>
            {
                if (!success)
                {
                    this.homey.setTimeout(async () =>
                    {
                        // Try again after 5 minutes as it could be failing with the cached data
                        this.updateDeviceValues();
                    }, 1000 * 60 * 5);
                }
            });
    }

    async __updateDeviceValues()
    {
        const devices = await this.homey.app.getDeviceData(false);

        if (devices === null)
        {
            return false;
        }

        const dd = this.getData();

        try
        {
            const gateway = devices.find(gateway => gateway.gatewayId === dd.gatewayId);

            if (gateway.status !== 'Connected')
            {
                this.setUnavailable("Gateway Offline").catch(this.error);
                return false;
            }

            const tapLinkers = gateway.taplinker;
            const tapLinker = tapLinkers.find(tapLinker => tapLinker.taplinkerId === dd.id);
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") response: " + this.homey.app.varToString(tapLinker));

            if (tapLinker.status !== 'Connected')
            {
                this.setUnavailable("LinkTap Offline").catch(this.error);
                return false;
            }

            await this.setAvailable();

            // Standard capabilities available to all device types
            this.setCapabilityValue('watering_mode', tapLinker.workMode != 'N' ? tapLinker.workMode : null).catch(this.error);
            this.setCapabilityValue('onoff', tapLinker.watering === true).catch(this.error);
            this.setCapabilityValue('alarm_battery', parseInt(tapLinker.batteryStatus) < 30).catch(this.error);
            this.setCapabilityValue('alarm_freeze', false).catch(this.error);
            this.setCapabilityValue('watering', tapLinker.watering === true).catch(this.error);
            this.setCapabilityValue('water_on', tapLinker.watering === true).catch(this.error);

            if (typeof tapLinker.fall !== "undefined")
            {
                if (!this.hasCapability('alarm_fallen'))
                {
                    this.addCapability('alarm_fallen').catch(this.error);
                    this.addCapability('alarm_broken').catch(this.error);
                }
                this.setCapabilityValue('alarm_fallen', tapLinker.fall).catch(this.error);
                this.setCapabilityValue('alarm_broken', tapLinker.valveBroken).catch(this.error);
            }
            else
            {
                if (this.hasCapability('alarm_fallen'))
                {
                    this.removeCapability('alarm_fallen').catch(this.error);
                    this.removeCapability('alarm_broken').catch(this.error);
                }
            }

            // Some capabilities are only available when a flow meter is fitted.
            await this.setupFlowMeterCapabilities(tapLinker.flowMeterStatus);

            if (tapLinker.flowMeterStatus === 'on')
            {
                this.setCapabilityValue('alarm_water', tapLinker.noWater).catch(this.error);
                this.setCapabilityValue('measure_water', tapLinker.vel / 1000).catch(this.error);
                this.setCapabilityValue('meter_water', 0).catch(this.error);
                this.setCapabilityValue('alarm_high_flow', tapLinker.leakFlag).catch(this.error);
                this.setCapabilityValue('alarm_low_flow', tapLinker.clogFlag).catch(this.error);
            }
        }
        catch (err)
        {
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") Error: " + err.message, 0);
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
        const dd = this.getData();
        let url = "dismissAlarm";
        let body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
            alarm: ''
        };

        if (this.getCapabilityValue('alarm_water'))
        {
            body.alarm = 'noWater';
            this.homey.app.PostURL(url, body).catch(this.Error);
        }

        if (this.getCapabilityValue('alarm_broken'))
        {
            body.alarm = 'valveBroken';
            this.homey.app.PostURL(url, body).catch(this.Error);
        }

        if (this.getCapabilityValue('alarm_fallen'))
        {
            body.alarm = 'fallFlag';
            this.homey.app.PostURL(url, body).catch(this.Error);
        }

        if (this.getCapabilityValue('alarm_low_flow'))
        {
            body.alarm = 'pcFlag';
            this.homey.app.PostURL(url, body).catch(this.Error);
        }

        if (this.getCapabilityValue('alarm_high_flow'))
        {
            body.alarm = 'pbFlag';
            this.homey.app.PostURL(url, body).catch(this.Error);
        }

        this.setCapabilityValue('alarm_freeze', false);
    }

    async onCapabilityOnOff(value)
    {
        const dd = this.getData();

        //Instant mode
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
        if (value === 'M')
        {
            //Instant mode
            const settings = this.getSettings();
            return await this.activateInstantMode(true,
                settings.watering_duration,
                settings.eco_mode,
                settings.on_duration,
                settings.off_duration,
                settings.revert);
        }
        else
        {
            // All other modes
            await this.activateWateringMode(value);
        }
    }

    async activateWateringMode(mode)
    {
        const dd = this.getData();
        let url;
        let body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id,
        };

        if (mode === 'I')
        {
            url = "activateIntervalMode";
        }
        else if (mode === 'O')
        {
            url = "activateOddEvenMode";
        }
        else if (mode === 'T')
        {
            url = "activateSevenDayMode";
        }
        else if (mode === 'Y')
        {
            url = "activateMonthMode";
        }

        try
        {
            let response = await this.homey.app.PostURL(url, body);
            if (response.result !== "ok")
            {
                throw (new Error(response.result));
            }
        }
        catch (err)
        {
            throw (new Error(err.message));
        }
    }

    async activateInstantMode(onOff, duration, eco_option, ecoOn, ecoOff, autoBack)
    {
        let url = "activateInstantMode";
        const dd = this.getData();
        let body = {
            gatewayId: dd.gatewayId,
            taplinkerId: dd.id
        };

        if (onOff)
        {
            body.action = true;

            if (!duration)
            {
                duration = 5;
            }

            body.duration = duration;

            if (eco_option)
            {
                if (ecoOn > duration)
                {
                    throw (new Error("Eco On must be shorted than Duration"));
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
            body.action = false;
            body.duration = 0;
        }

        let response = await this.homey.app.PostURL(url, body);
        if (response.result !== "ok")
        {
            throw (new Error(response.result));
        }
    }

    async onDeviceUpdateVol()
    {
        let vel = this.getCapabilityValue('measure_water');
        let vol = this.getCapabilityValue('meter_water');
        vol += vel / 30;
        this.setCapabilityValue('meter_water', vol);
    }

    async processWebhookMessage(message)
    {
        const dd = this.getData();
        if ((dd.id === message.deviceId) && (dd.gatewayId === message.gatewayId))
        {
            // message is for this device
            if (message.event === 'watering start')
            {
                this.setCapabilityValue('watering_mode', message.workMode);
                this.isWatering = true;
                this.setCapabilityValue('onoff', this.isWatering).catch(this.error);
                this.setCapabilityValue('watering', this.isWatering).catch(this.error);
                this.driver.triggerWateringStarted(this);
            }
            else if ((message.msg === 'wateringOn') || (message.event === 'wateringOn'))
            {
                this.setCapabilityValue('water_on', true).catch(this.error);
                this.setCapabilityValue('time_remaining', message.onMin).catch(this.error);
                this.setCapabilityValue('watering', this.isWatering).catch(this.error);

                if (message.ecoFlag === 1)
                {
                    this.cycles = Math.ceil(message.ecoTotal / message.totalMin);
                    this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);
                    if (message.onMin === message.totalMin)
                    {
                        this.setCapabilityOptions('time_remaining', { 'title': this.homey.__('timeRemaining') });
                    }
                }
                else if (message.ecoFlag !== 3)
                {
                    this.cycles = 1;
                    this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);
                    if ((message.onMin === 0) && (message.totalMin === '-1'))
                    {
                        // Turned on via the button
                        this.setCapabilityOptions('time_remaining', { 'title': this.homey.__('timeActive') });
                    }
                }

                if (message.vol != undefined)
                {
                    this.setCapabilityValue('meter_water', message.vol / 1000).catch(this.error);
                    this.setCapabilityValue('measure_water', message.vel / 1000).catch(this.error);

                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                    }
                    this.timerVolUpdate = this.homey.setInterval(this.onDeviceUpdateVol, (1000 * 2));
                }
            }
            else if (message.msg === 'wateringOff')
            {
                if (this.cycles > 0 && this.isWatering)
                {
                    if (this.timerVolUpdate)
                    {
                        this.homey.clearInterval(this.timerVolUpdate);
                        this.timerVolUpdate = null;
                    }

                    this.setCapabilityValue('water_on', false).catch(this.error);
                    this.setCapabilityValue('time_remaining', 0).catch(this.error);

                    if (message.vol != undefined)
                    {
                        this.setCapabilityValue('meter_water', message.vol / 1000).catch(this.error);
                        this.setCapabilityValue('measure_water', 0).catch(this.error);
                    }

                    if ((message.ecoFlag === 3) || (message.ecoFlag === 1))
                    {
                        this.cycles--;
                        this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);
                    }
                }
            }
            else if (message.msg === 'flowMeterValue')
            {
                this.setCapabilityValue('measure_water', message.vel / 1000).catch(this.error);
            }
            else if (message.event === 'watering end')
            {
                if (this.timerVolUpdate)
                {
                    this.homey.clearInterval(this.timerVolUpdate);
                    this.timerVolUpdate = null;
                }

                this.setCapabilityValue('water_on', false).catch(this.error);
                this.setCapabilityValue('time_remaining', 0).catch(this.error);

                this.cycles = 0;
                this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);

                this.isWatering = false;
                this.setCapabilityValue('watering', this.isWatering).catch(this.error);
                this.setCapabilityValue('onoff', this.isWatering).catch(this.error);
                let data = message.content.split(/[(,]+/);
                if (data.length > 1)
                {
                    let vol = Number((data[1].split(' '))[0]);
                    this.setCapabilityValue('meter_water', vol).catch(this.error);
                }
                this.setCapabilityValue('measure_water', 0).catch(this.error);
                this.driver.triggerWateringFinished(this);
            }
            else if (message.event === 'watering cycle skipped')
            {
                this.driver.triggerWateringSkipped(this);
            }
            else if (message.msg === 'gatewayOnline')
            {
                this.setAvailable().catch(this.error);
            }
            else if (message.msg === 'gatewayOffline')
            {
                this.setUnavailable().catch(this.error);
            }
            else if (message.msg === 'deviceOffline')
            {
                this.setUnavailable().catch(this.error);
            }
            else if (message.msg === 'deviceOnline')
            {
                this.setAvailable().catch(this.error);
            }
            else if (message.event === 'battery low alert')
            {
                this.setCapabilityValue('alarm_battery', true).catch(this.error);
            }
            else if (message.event === 'battery good')
            {
                this.setCapabilityValue('alarm_battery', false).catch(this.error);
            }
            else if (message.event === 'water cut-off alert')
            {
                this.setCapabilityValue('alarm_water', true).catch(this.error);
            }
            else if (message.event === 'unusually high flow alert')
            {
                this.setCapabilityValue('alarm_high_flow', true).catch(this.error);
            }
            else if (message.event === 'unusually low flow alert')
            {
                this.setCapabilityValue('alarm_low_flow', true).catch(this.error);
            }
            else if (message.event === 'valve broken alert')
            {
                this.setCapabilityValue('alarm_broken', true).catch(this.error);
            }
            else if (message.event === 'device fall alert')
            {
                this.setCapabilityValue('alarm_fallen', true).catch(this.error);
            }
            else if (message.event === 'manual button pressed')
            {

            }
            else if (message.event === 'freeze alert')
            {
                this.setCapabilityValue('alarm_freeze', true).catch(this.error);
            }
            else if (message.event === 'alarm clear')
            {
                if (message.title === 'noWater')
                {
                    this.setCapabilityValue('alarm_water', false).catch(this.error);
                }
                else if (message.title === 'valveBroken')
                {
                    this.setCapabilityValue('alarm_broken', false).catch(this.error);
                }
                else if (message.title === 'fallFlag')
                {
                    this.setCapabilityValue('alarm_fallen', false).catch(this.error);
                }
                else if (message.title === 'pcFlag')
                {
                    this.setCapabilityValue('alarm_low_flow', false).catch(this.error);
                }
                else if (message.title === 'pbFlag')
                {
                    this.setCapabilityValue('alarm_high_flow', false).catch(this.error);
                }
            }
            else if (message.msg === 'flowMeterStatus')
            {
                this.setupFlowMeterCapabilities(message.status)
                    .then(this.updateDeviceValues());
            }
        }
    }
}

module.exports = LinkTapDevice;