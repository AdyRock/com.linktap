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
        this.log('LinkTapDevice has been initialized');
        this.isWatering = false;
        this.OnOffChanged = false;
        this.OnOffChangedTimeout = null;

        if (!this.hasCapability('onoff'))
        {
            this.addCapability('onoff');
        }

        if (!this.hasCapability('clear_alarms'))
        {
            this.addCapability('clear_alarms');
        }

        this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
        this.registerCapabilityListener('clear_alarms', this.onCapabilityClearAlarms.bind(this));
        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));

        const searchData = await this.homey.app.getDeviceData();
        this.updateDeviceValues(searchData);

        this.onDeviceStatusPoll = this.onDeviceStatusPoll.bind(this);
        //        this.timerPollID = this.homey.setTimeout(this.onDeviceStatusPoll, (1000 * 30));

        if (this.hasCapability('alarm_fallen'))
        {
            await this.setCapabilityValue('alarm_fallen', false);
            await this.setCapabilityValue('alarm_broken', false);
            await this.setCapabilityValue('alarm_water', false);
            await this.setCapabilityValue('measure_water', 0);
        }

        await this.setCapabilityValue('onoff', this.isWatering);
        await this.setCapabilityValue('cycles_remaining', 0);
        await this.setCapabilityValue('time_remaining', 0);
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('LinkTapDevice has been added');
        const searchData = await this.homey.app.getDeviceData();
        this.updateDeviceValues(searchData);
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

    async updateDeviceMQTT(tapLinkData)
    {
        const dd = this.getData();

        try
        {
            // Check if the data is from our gateway
            if (tapLinkData.gw_id === dd.gatewayId);
            {
                // Yep, so get the device status
                const tapLinkers = tapLinkData.dev_stat;
                const tapLinker = tapLinkers.find(tapLinker => tapLinker.dev_id === dd.id);

                // Check the data is for our device
                if (tapLinker)
                {
                    if (tapLinkData.cmd === 9)
                    {
                        //Watering skipped notification
                        const tokens = {
                            past_rainfall: tapLinkData.rain[0],
                            forecast_rainfall: tapLinkData.rain[1]
                        };

                        this.driver.triggerWateringSkipped(this, tokens);
                    }
                    else
                    {
                        // Yep, so update the values
                        this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") response: " + this.homey.app.varToString(tapLinker));

                        if (!tapLinker.is_rf_linked)
                        {
                            await this.setUnavailable("LinkTap Offline");
                            return;
                        }

                        await this.setAvailable();

                        if (tapLinkData.is_manual_mode)
                        {
                            await this.setCapabilityValue('watering_mode', 'M');
                        }

                        if (this.OnOffChanged && (this.getCapabilityValue('onoff') !== tapLinker.is_watering))
                        {
                            // The new state has not activated yet
                        }
                        else
                        {
                            this.OnOffChanged = false;
                            this.homey.clearTimeout(this.OnOffChangedTimeout);
                            if (tapLinker.is_watering)
                            {
                                if (this.cycles === 0)
                                {
                                    this.cycles = 1;
                                    this.setCapabilityValue('cycles_remaining', this.cycles);
                                }

                                if (!this.isWatering)
                                {
                                    this.isWatering = true;
                                    await this.setCapabilityValue('onoff', this.isWatering);
                                    await this.setCapabilityValue('watering', this.isWatering);

                                    this.driver.triggerWateringStarted(this);
                                }
                            }
                            else
                            {
                                if (this.isWatering)
                                {
                                    this.isWatering = false;
                                    await this.setCapabilityValue('onoff', this.isWatering);
                                    await this.setCapabilityValue('watering', this.isWatering);
                                    this.driver.triggerWateringFinished(this);
                                    this.cycles = 0;
                                    this.setCapabilityValue('cycles_remaining', this.cycles);
                                }
                            }
                        }

                        await this.setCapabilityValue('measure_battery', tapLinker.battery);
                        await this.setCapabilityValue('signal_strength', -tapLinker.signal);
                        await this.setCapabilityValue('time_remaining', Math.ceil(tapLinker.remain_duration / 60));

                        if (tapLinker.is_flm_plugin)
                        {
                            if (!this.hasCapability('alarm_fallen'))
                            {
                                this.addCapability('alarm_fallen');
                                this.addCapability('alarm_broken');
                                this.addCapability('alarm_water');
                                this.addCapability('measure_water');
                                this.addCapability('meter_water');
                            }

                            await this.setCapabilityValue('alarm_fallen', tapLinker.is_fall);
                            await this.setCapabilityValue('alarm_broken', tapLinker.is_broken);
                            await this.setCapabilityValue('alarm_water', tapLinker.is_cutoff);
                            // TODO - add leak and clog
                            await this.setCapabilityValue('measure_water', tapLinker.speed );
                            await this.setCapabilityValue('meter_water', tapLinker.volume);
                        }
                        else
                        {
                            if (this.hasCapability('alarm_fallen'))
                            {
                                this.removeCapability('alarm_fallen');
                                this.removeCapability('alarm_broken');
                                this.removeCapability('alarm_water');
                                this.removeCapability('measure_water');
                                this.removeCapability('meter_water');
                            }
                        }
                    }
                }
            }
        }
        catch (err)
        {
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") Error: " + this.homey.app.varToString(err), 0);
        }
    }

    async updateDeviceValues(devices)
    {
        const dd = this.getData();

        try
        {
            const gateway = devices.find(gateway => gateway.gatewayId === dd.gatewayId);

            if (gateway.status !== 'Connected')
            {
                await this.setUnavailable("Gateway Offline");
                return;
            }

            const tapLinkers = gateway.taplinker;
            const tapLinker = tapLinkers.find(tapLinker => tapLinker.taplinkerId === dd.id);
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") response: " + this.homey.app.varToString(tapLinker));

            if (tapLinker.status !== 'Connected')
            {
                await this.setUnavailable("LinkTap Offline");
                return;
            }

            await this.setAvailable();

            await this.setCapabilityValue('watering_mode', tapLinker.workMode != 'N' ? tapLinker.workMode : null );
            await this.setCapabilityValue('measure_battery', parseInt(tapLinker.batteryStatus));
            await this.setCapabilityValue('signal_strength', -tapLinker.signal);

            if (typeof tapLinker.fall !== "undefined")
            {
                if (!this.hasCapability('alarm_fallen'))
                {
                    this.addCapability('alarm_fallen');
                    this.addCapability('alarm_broken');
                    this.addCapability('alarm_water');
                    this.addCapability('measure_water');
                    this.addCapability('meter_water');
                }

                await this.setCapabilityValue('alarm_fallen', tapLinker.fall);
                await this.setCapabilityValue('alarm_broken', tapLinker.valveBroken);
                await this.setCapabilityValue('alarm_water', tapLinker.noWater);
                await this.setCapabilityValue('measure_water', tapLinker.vel / 1000);
            }
            else
            {
                if (this.hasCapability('alarm_fallen'))
                {
                    this.removeCapability('alarm_fallen');
                    this.removeCapability('alarm_broken');
                    this.removeCapability('alarm_water');
                    this.removeCapability('measure_water');
                    this.removeCapability('meter_water');
                }
            }
        }
        catch (err)
        {
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") Error: " + this.homey.app.varToString(err), 0);
        }
    }

    async onCapabilityClearAlarms(value)
    {
        const dd = this.getData();

        const message = {
            "cmd":11,
            "gw_id":dd.gatewayId,
            "dev_id":dd.id,
            "alert":0
        };

        this.homey.app.publishMQTTMessage(message);
    }

    async onCapabilityOnOff(value)
    {
        this.OnOffChanged = true;
        this.OnOffChangedTimeout = this.homey.setTimeout(() => { this.OnOffChanged = false; }, 20 * 1000);
        const dd = this.getData();

        if (value === false)
        {
            const message = {
                "cmd":7,
                "gw_id":dd.gatewayId,
                "dev_id":dd.id,
            };
    
            this.homey.app.publishMQTTMessage(message);    
        }
        else
        {
            const settings = this.getSettings();
            const message = {
                "cmd":6,
                "gw_id":dd.gatewayId,
                "dev_id":dd.id,
                "duration":settings.watering_duration
            };
    
            this.homey.app.publishMQTTMessage(message);    
        }

        // //Instant mode
        // const settings = this.getSettings();
        // return this.activateInstantMode(value,
        //     settings.watering_duration,
        //     settings.eco_mode,
        //     settings.on_duration,
        //     settings.off_duration,
        //     settings.revert);
    }

    async onCapabilityWateringMode(value)
    {
        if (value === 'M')
        {
            //Instant mode
            const settings = this.getSettings();
            return this.activateInstantMode(true,
                settings.watering_duration,
                settings.eco_mode,
                settings.on_duration,
                settings.off_duration,
                settings.revert);
        }
        else
        {
            // All other modes
            this.activateWateringMode(value);
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

        let response = await this.homey.app.PostURL(url, body);
        if (response.result !== "ok")
        {
            throw (new Error(response.result));
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

            await this.setCapabilityValue('cycles_remaining', this.cycles);

            if (this.hasCapability('meter_water'))
            {
                await this.setCapabilityValue('meter_water', 0);
            }
            body.autoBack = autoBack;
        }
        else
        {
            body.action = false;
            body.duration = 1;

            await this.setCapabilityValue('time_remaining', 0);
            this.isWatering = false;
            await this.setCapabilityValue('onoff', this.isWatering);
            this.cycles = 0;
            this.setCapabilityValue('cycles_remaining', this.cycles);

            if (this.getCapabilityValue('water_on'))
            {
                await this.setCapabilityValue('water_on', false);
                this.driver.triggerWateringFinished(this);
            }
        }

        let response = await this.homey.app.PostURL(url, body);
        if (response.result !== "ok")
        {
            throw (new Error(response.result));
        }
    }

    async onDeviceStatusPoll()
    {
        const dd = this.getData();

        try
        {
            let body = {
                taplinkerId: dd.id,
            };

            const url = "getWateringStatus";
            let response = await this.homey.app.PostURL(url, body);
            this.homey.app.updateLog("onDeviceStatusPoll (" + dd.id + ") response: " + this.homey.app.varToString(response));
            if (response.status)
            {
                if (!this.cycles)
                {
                    await this.setAvailable();

                    if (this.hasCapability('meter_water'))
                    {
                        await this.setCapabilityValue('meter_water', 0);
                    }

                    this.cycles = 1;
                    if (response.status.ecoTotal)
                    {
                        // Eco mode is on
                        this.cycles = Math.ceil(response.status.ecoTotal / response.status.ecoOn);
                    }
                    this.setCapabilityValue('cycles_remaining', this.cycles);
                }

                if (!this.isWatering)
                {
                    this.isWatering = true;
                    await this.setCapabilityValue('onoff', this.isWatering);
                    await this.setCapabilityValue('watering', this.isWatering);

                    this.driver.triggerWateringStarted(this);
                }

                if (!this.getCapabilityValue('water_on'))
                {
                    await this.setCapabilityValue('water_on', true);
                }

                if (response.status.total === '-1')
                {
                    // Turned on via the button
                    //duration *= -1;
                    this.setCapabilityOptions('time_remaining', { 'title': this.homey.__('timeActive') });
                }
                else
                {
                    this.setCapabilityOptions('time_remaining', { 'title': this.homey.__('timeRemaining') });
                }

                await this.setCapabilityValue('time_remaining', parseInt(response.status.onDuration));

                if (response.status.vel && this.hasCapability('measure_water'))
                {
                    await this.setCapabilityValue('measure_water', parseInt(response.status.vel) / 1000);

                    // let vol = this.getCapabilityValue('meter_water');
                    // vol += (response.status.vel / 2000);
                    // await this.setCapabilityValue('meter_water', vol);
                }

                if (response.status.vol && this.hasCapability('meter_water'))
                {
                    // let vol = this.getCapabilityValue('meter_water');
                    // vol += (response.status.vol / 1000);
                    await this.setCapabilityValue('meter_water', (response.status.vol / 1000));
                }
            }
            else
            {
                if (this.isWatering)
                {
                    if (this.getCapabilityValue('water_on'))
                    {
                        await this.setCapabilityValue('water_on', false);
                        await this.setCapabilityValue('time_remaining', 0);

                        this.cycles--;
                        this.setCapabilityValue('cycles_remaining', this.cycles);

                        if (!this.cycles)
                        {
                            this.isWatering = false;
                            await this.setCapabilityValue('onoff', this.isWatering);
                            await this.setCapabilityValue('watering', this.isWatering);

                            this.driver.triggerWateringFinished(this);
                        }
                    }
                }
            }
        }
        catch (err)
        {
            this.homey.app.updateLog("onDeviceStatusPoll (" + dd.id + ") error: " + this.homey.app.varToString(err), 0);
        }
        finally
        {
            //this.timerPollID = this.homey.setTimeout(this.onDeviceStatusPoll, (1000 * 30));
        }
    }
}

module.exports = LinkTapDevice;