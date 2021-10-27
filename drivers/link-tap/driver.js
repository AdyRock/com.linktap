/* jslint node: true */

'use strict';

const Homey = require('homey');

class LinkTapDriver extends Homey.Driver
{

    /**
     * onInit is called when the driver is initialized.
     */
    async onInit()
    {
        this.log('LinkTapDriver initialising');

        this.wateringStartedTrigger = this.homey.flow.getDeviceTriggerCard('watering_started');
        this.wateringFinishedTrigger = this.homey.flow.getDeviceTriggerCard('watering_finished');
        this.wateringSkippedTrigger = this.homey.flow.getDeviceTriggerCard('watering_skipped');

        this.log('LinkTapDriver has been initialized');
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
        return this.homey.app.getLinkTapDevices(true, {});
    }

    async onPair(session)
    {
        const oldAPICode = this.homey.app.APIToken;
        const oldUserName = this.homey.app.UserName;

        session.setHandler('list_devices', async () =>
        {
            try
            {
                const devices = await this.onPairListDevices();
                this.homey.settings.set('APIToken', this.homey.app.APIToken);
                this.homey.settings.set('UserName', this.homey.app.UserName);
                return devices;
            }
            catch (err)
            {
                this.homey.app.APIToken = oldAPICode;
                this.homey.app.UserName = oldUserName;
                throw new Error(err.message);
            }
        });

        session.setHandler('connection_setup', async () =>
        {
            // Initialise page with last used token and user name
            return { APIToken: this.homey.app.APIToken, userName: this.homey.app.UserName };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.userName)
            {
                return { ok: false, err: this.homey.__('missingUsername') };
            }
            if (!data.APIToken && !data.password)
            {
                return { ok: false, err: this.homey.__('missingAPIToken') };
            }

            if (!data.APIToken)
            {
                try
                {
                    await this.homey.app.getAPIKey(data);
                }
                catch (err)
                {
                    return { ok: false, err: err.message };
                }
            }

            this.homey.app.APIToken = data.APIToken;
            this.homey.app.UserName = data.userName;
            return { ok: true };
        });
    }

    async onRepair(session, device)
    {
        // Argument socket is an EventEmitter, similar to Driver.onPair
        // Argument device is a Homey.Device that's being repaired

        session.setHandler('connection_setup', async () =>
        {
            return { APIToken: this.homey.app.APIToken, userName: this.homey.app.UserName };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.userName)
            {
                return { ok: false, err: this.homey.__('missingUsername') };
            }
            if (!data.APIToken && !data.password)
            {
                return { ok: false, err: this.homey.__('missingAPIToken') };
            }

            if (!data.APIToken)
            {
                try
                {
                    await this.homey.app.getAPIKey(data);
                }
                catch (err)
                {
                    return { ok: false, err: err.message };
                }
            }

            this.homey.app.APIToken = data.APIToken;
            this.homey.app.UserName = data.UserName;
            return { ok: true };
        });
    }

}

module.exports = LinkTapDriver;
