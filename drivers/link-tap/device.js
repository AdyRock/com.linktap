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

        this.registerCapabilityListener('watering_mode', this.onCapabilityWateringMode.bind(this));

        const searchData = await this.homey.app.getDeviceData();
        this.updateDeviceValues(searchData);

        this.onDeviceStatusPoll = this.onDeviceStatusPoll.bind(this);
        this.timerPollID = this.homey.setTimeout(this.onDeviceStatusPoll, (1000 * 30));

        if (this.hasCapability('alarm_fallen'))
        {
            await this.setCapabilityValue('alarm_fallen', false);
            await this.setCapabilityValue('alarm_broken', false);
            await this.setCapabilityValue('alarm_water', false);
        }
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
                await this.setUnavailable("Tap Linker Offline");
                return;
            }

            await this.setAvailable();

            await this.setCapabilityValue('watering_mode', tapLinker.workMode);
            await this.setCapabilityValue('measure_battery', parseInt(tapLinker.batteryStatus));
            await this.setCapabilityValue('signal_strength', tapLinker.signal);

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
            this.homey.app.updateLog("updateDeviceValues (" + dd.id + ") Error: " + this.homey.app.varToString(err));
        }
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
        let body;

        if (onOff)
        {
            const dd = this.getData();
            body = {
                gatewayId: dd.gatewayId,
                taplinkerId: dd.id,
            };

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

            body.autoBack = autoBack;
        }
        else
        {
            url = "activateInstantMode";
            body.action = false;
            body.duration = 0;
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
                if (this.cycles === 0)
                {
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
                    await this.setCapabilityValue('watering', this.isWatering);

                    this.driver.triggerWateringStarted(this);
                }

                if (!this.getCapabilityValue('water_on'))
                {
                    await this.setCapabilityValue('water_on', true);
                }

                await this.setCapabilityValue('time_remaining', parseInt(response.status.onDuration));

                if (response.status.vel)
                {
                    await this.setCapabilityValue('measure_water', parseInt(response.status.vel) / 1000);
                }

                if (response.status.vol)
                {
                    await this.setCapabilityValue('meter_water', parseInt(response.status.vol) / 1000);
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

                        if (this.cycles === 0)
                        {
                            this.isWatering = false;
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
            this.timerPollID = this.homey.setTimeout(this.onDeviceStatusPoll, (1000 * 30));
        }
    }
}

module.exports = LinkTapDevice;