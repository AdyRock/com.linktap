/*jslint node: true */
'use strict';

const Homey = require('homey');

class LinkTapLocalDriver extends Homey.Driver
{
    /**
     * onInit is called when the driver is initialized.
     */
    async onInit()
    {
        this.log('LinkTapLocalDriver initialising');

        this.wateringStartedTrigger = this.homey.flow.getDeviceTriggerCard('watering_started');
        this.wateringFinishedTrigger = this.homey.flow.getDeviceTriggerCard('watering_finished');
        this.wateringSkippedTrigger = this.homey.flow.getDeviceTriggerCard('watering_skipped');

        this.log('LinkTapLocalDriver has been initialized');
    }

    triggerWateringStarted(device)
    {
        this.wateringStartedTrigger.trigger(device, {}, {})
            .then(this.log)
            .catch(this.error);
    }

    triggerWateringFinished(device)
    {
        this.wateringFinishedTrigger.trigger(device, {}, {})
            .then(this.log)
            .catch(this.error);
    }

    triggerWateringSkipped(device)
    {
        this.wateringSkippedTrigger.trigger(device, {}, {})
            .then(this.log)
            .catch(this.error);
    }

    /**
     * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
     * This should return an array with the data of devices that are available for pairing.
     */
    async onPairListDevices()
    {
        return this.homey.app.getDevices(false);
    }

    async onPair(session)
    {
        session.setHandler("list_devices", async () =>
        {
            try
            {
                let devices = await this.onPairListDevices();
                return devices;
            }
            catch (err)
            {
                throw new Error(err.message);
            }
        });
    }
}

module.exports = LinkTapLocalDriver;