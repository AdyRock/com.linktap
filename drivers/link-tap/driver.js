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
    async onPairListDevices(body)
    {
        return this.homey.app.getLinkTapDevices(true, body);
    }

    async onPair(session)
    {
        let { apiKey } = this.homey.app;
        let { username } = this.homey.app;

        session.setHandler('list_devices', async () =>
        {
            try
            {
                const body = {
                    apiKey,
                    username,
                };
                const devices = await this.onPairListDevices(body);

                // Save the settings for next time
                this.homey.app.apiKey = apiKey;
                this.homey.app.username = username;
                this.homey.settings.set('APIToken', this.homey.app.apiKey);
                this.homey.settings.set('UserName', this.homey.app.username);
                return devices;
            }
            catch (err)
            {
                throw new Error(err.message);
            }
        });

        session.setHandler('connection_setup', async () =>
        {
            // Initialise page with last used token and user name
            return { apiKey, username };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.username)
            {
                return { ok: false, err: this.homey.__('missingUsername') };
            }
            if (!data.apiKey && !data.password)
            {
                return { ok: false, err: this.homey.__('missingAPIToken') };
            }

            if (!data.apiKey)
            {
                try
                {
                    // As the apiKey is not specified get a new one
                    await this.homey.app.getAPIKey(data);
                }
                catch (err)
                {
                    return { ok: false, err: err.message };
                }
            }

            apiKey = data.apiKey;
            username = data.username;
            return { ok: true };
        });
    }

    async onRepair(session, device)
    {
        // Argument socket is an EventEmitter, similar to Driver.onPair
        // Argument device is a Homey.Device that's being repaired

        session.setHandler('connection_setup', async () =>
        {
            const apiKey = device.getStoreValue('apiKey');
            const username = device.getStoreValue('username');
            return { apiKey, username };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.username)
            {
                return { ok: false, err: this.homey.__('missingUsername') };
            }
            if (!data.apiKey && !data.password)
            {
                return { ok: false, err: this.homey.__('missingAPIToken') };
            }

            if (!data.apiKey)
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

            if (await this.homey.app.registerWebhookURL(data.apiKey, data.username))
            {
                this.homey.app.apiKey = data.apiKey;
                this.homey.app.username = data.username;
                device.setStoreValue('apiKey', data.apiKey);
                device.setStoreValue('username', data.username);
                device.setAvailable();
                device.updateDeviceValues();
                return { ok: true };
            }

            return { ok: false, err: 'Failed to connect' };
        });
    }

}

module.exports = LinkTapDriver;
