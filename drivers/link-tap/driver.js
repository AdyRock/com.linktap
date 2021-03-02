/*jslint node: true */
'use strict';

const Homey = require('homey');

class LinkTapDriver extends Homey.Driver
{
    /**
     * onInit is called when the driver is initialized.
     */
    async onInit()
    {
        this.log('LinkTapDriver has been initialized');

        const activateInstantMode = this.homey.flow.getActionCard('activate_instant_mode');
        activateInstantMode
            .registerRunListener(async (args, state) =>
            {
                this.log("activate_instant_mode");
                return args.device.activateInstantMode(true, args.water_duration, (args.eco_mode === 'on'), args.on_time, args.off_time, (args.revert === 'on'));
            });

        const turnOffInstantMode = this.homey.flow.getActionCard("turn_off_instant_mode");
        turnOffInstantMode
            .registerRunListener(async (args, state) =>
            {
                this.log("turn_off_instant_mode");
                return args.device.activateInstantMode(false);
            });

        const activateWateringMode = this.homey.flow.getActionCard("activate_watering_mode");
        activateWateringMode
            .registerRunListener(async (args, state) =>
            {
                this.log("activate_watering_mode");
                return args.device.activateWateringMode(true, args.mode);
            });

        let wateringCondition = this.homey.flow.getConditionCard('is_watering');
        wateringCondition.registerRunListener(async (args, state) =>
        {
            return args.device.isWatering; // true or false
        });

        this.wateringStartedTrigger = this.homey.flow.getDeviceTriggerCard('watering_started');
        this.wateringFinishedTrigger = this.homey.flow.getDeviceTriggerCard('watering_finished');
    }

    triggerWateringStarted(device, tokens, state)
    {
        this.wateringStartedTrigger.trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error);
    }

    triggerWateringFinished(device, tokens, state)
    {
        this.wateringFinishedTrigger.trigger(device, tokens, state)
            .then(this.log)
            .catch(this.error);
    }
    /**
     * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
     * This should return an array with the data of devices that are available for pairing.
     */
    async onPairListDevices()
    {
        return this.homey.app.getDevices();
    }
}

module.exports = LinkTapDriver;