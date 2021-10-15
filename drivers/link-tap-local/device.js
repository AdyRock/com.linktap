/*jslint node: true */
'use strict';

const Homey = require('homey');

class LinkTapLocalDevice extends Homey.Device
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
        this.cycles = 0;

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

        if (this.hasCapability('alarm_fallen'))
        {
            this.setCapabilityValue('alarm_fallen', false).catch(this.error);
            this.setCapabilityValue('alarm_broken', false).catch(this.error);
            this.setCapabilityValue('alarm_water', false).catch(this.error);
            this.setCapabilityValue('measure_water', 0).catch(this.error);
        }

        this.setCapabilityValue('onoff', this.isWatering).catch(this.error);
        this.setCapabilityValue('cycles_remaining', 0).catch(this.error);
        this.setCapabilityValue('time_remaining', 0).catch(this.error);
    }

    /**
     * onAdded is called when the user adds the device, called just after pairing.
     */
    async onAdded()
    {
        this.log('LinkTapDevice has been added');
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

    async updateDeviceMQTT(tapLinkData)
    {
        const dd = this.getData();

        try
        {
            // Check if the data is from our gateway
            if (tapLinkData.gw_id === dd.gatewayId);
            {
                // Yep, check if a watering skipped cmd
                if (tapLinkData.cmd === 9)
                {
                    // {"cmd":9,"gw_id":"23CA291F004B1200","dev_id":"E9527F1F004B1200","rain":[6.850000,1.260000]}
                    // yep, so check if for this device
                    if (tapLinkData.dev_id === dd.id)
                    {
                        //Watering skipped notification
                        const tokens = {
                            past_rainfall: tapLinkData.rain[0],
                            forecast_rainfall: tapLinkData.rain[1]
                        };

                        this.driver.triggerWateringSkipped(this, tokens);
                    }
                }
                else if (tapLinkData.cmd === 3)
                {
                    // {"cmd":3,"gw_id":"23CA291F004B1200","dev_stat":[{"dev_id":"E9527F1F004B1200","plan_mode":6,"plan_sn":490642583,"is_rf_linked":true,"is_flm_plugin":true,"is_fall":false,"is_broken":false,"is_cutoff":false,"is_leak":false,"is_clog":false,"signal":61,"battery":100,"child_lock":0,"is_manual_mode":false,"is_watering":false,"is_final":false,"total_duration":0,"remain_duration":0,"speed":0.00,"volume":0.00}]}
                    // Status update command
                    const tapLinkers = tapLinkData.dev_stat;
                    const tapLinker = tapLinkers.find(tapLinker => tapLinker.dev_id === dd.id);

                    // Check the data is for this device
                    if (tapLinker)
                    {
                        // Yep, so update the values
                        if (!tapLinker.is_rf_linked)
                        {
                            await this.setUnavailable("LinkTap Offline");
                            return;
                        }

                        await this.setAvailable();

                        if (tapLinker.is_manual_mode)
                        {
                            this.setCapabilityValue('watering_mode', 'M').catch(this.error);
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
                                    this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);
                                }

                                if (!this.isWatering)
                                {
                                    this.isWatering = true;
                                    this.setCapabilityValue('onoff', true).catch(this.error);
                                    this.setCapabilityValue('watering', true).catch(this.error);

                                    this.driver.triggerWateringStarted(this);
                                }
                                this.setCapabilityValue('watering_on', true).catch(this.error);
                                this.setCapabilityValue('time_remaining', Math.ceil(tapLinker.remain_duration / 60)).catch(this.error);
                            }
                            else
                            {
                                this.setCapabilityValue('watering_on', false).catch(this.error);
                                if (this.isWatering && tapLinker.is_final)
                                {
                                    // The final cycle has completed
                                    this.isWatering = false;
                                    this.setCapabilityValue('watering', false).catch(this.error);
                                    this.setCapabilityValue('onoff', false).catch(this.error);
                                    this.driver.triggerWateringFinished(this);
                                    this.cycles = 0;
                                    this.setCapabilityValue('cycles_remaining', this.cycles).catch(this.error);
                                }
                                this.setCapabilityValue('time_remaining', 0).catch(this.error);
                            }
                        }

                        this.setCapabilityValue('measure_battery', tapLinker.battery).catch(this.error);
                        this.setCapabilityValue('signal_strength', -tapLinker.signal).catch(this.error);

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

                            this.setCapabilityValue('alarm_fallen', tapLinker.is_fall).catch(this.error);
                            this.setCapabilityValue('alarm_broken', tapLinker.is_broken).catch(this.error);
                            this.setCapabilityValue('alarm_water', tapLinker.is_cutoff).catch(this.error);
                            // TODO - add leak and clog
                            this.setCapabilityValue('measure_water', tapLinker.speed).catch(this.error);
                            this.setCapabilityValue('meter_water', tapLinker.volume).catch(this.error);
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

    async onCapabilityClearAlarms(value)
    {
        const dd = this.getData();

        const message = {
            "cmd": 11,
            "gw_id": dd.gatewayId,
            "dev_id": dd.id,
            "alert": 0
        };

        this.homey.app.publishMQTTMessage(message);
    }

    async onCapabilityOnOff(value, opts)
    {
        this.OnOffChanged = true;
        this.OnOffChangedTimeout = this.homey.setTimeout(() => { this.OnOffChanged = false; }, 20 * 1000);
        const dd = this.getData();

        if (value === false)
        {
            const message = {
                "cmd": 7,
                "gw_id": dd.gatewayId,
                "dev_id": dd.id,
            };

            this.homey.app.publishMQTTMessage(message);
        }
        else
        {
            const settings = this.getSettings();
            const message = {
                "cmd": 6,
                "gw_id": dd.gatewayId,
                "dev_id": dd.id,
                "duration": opts ? opts.duration : (settings.watering_duration * 60)
            };

            this.homey.app.publishMQTTMessage(message);
        }
    }

    async onCapabilityWateringMode(value)
    {
        const dd = this.getData();
        const xref = ['', 'M', 'T', 'O', 'I', 'Y'];

        let mode = xref.findIndex((entry) =>
        {
            return (entry === value);
        });

        const message = {
            "cmd": 4,
            "gw_id": dd.gatewayId,
            "dev_id": dd.id,
            "mode": mode
        };

        this.homey.app.publishMQTTMessage(message);
    }
}

module.exports = LinkTapLocalDevice;