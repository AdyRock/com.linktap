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
            .catch(this.error);
    }

    triggerWateringFinished(device)
    {
        this.wateringFinishedTrigger.trigger(device, {}, {})
            .catch(this.error);
    }

    triggerWateringSkipped(device)
    {
        this.wateringSkippedTrigger.trigger(device, {}, {})
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

        session.setHandler('showView', async view =>
        {
            if (view === 'my_connect')
            {
                if (username && apiKey)
                {
                    if (await this.homey.app.registerWebhookURL(apiKey, username))
                    {
                        await session.nextView();
                    }
                }
            }
        });

        session.setHandler('list_devices', async () =>
        {
            try
            {
                const body = {
                    apiKey,
                    username,
                };
                return await this.onPairListDevices(body);
            }
            catch (err)
            {
                throw new Error(err.message);
            }
        });

        session.setHandler('connection_setup', async () =>
        {
            // Initialise page with last used token and user name
            return { username };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.username)
            {
                return { ok: false, err: this.homey.__('settings.missingUsername') };
            }
            if (!data.password)
            {
                return { ok: false, err: this.homey.__('settings.missingPassword') };
            }

            if (!await this.homey.app.registerWebhookURL(apiKey, data.username))
            {
                try
                {
                    // As the connection failed try to get a new apiKey
                    const res = await this.homey.app.getAPIKey(data);
                    apiKey = res.key;
                }
                catch (err)
                {
                    return { ok: false, err: err.message };
                }
            }

            if (!await this.homey.app.registerWebhookURL(apiKey, data.username))
            {
                return { ok: false, err: this.homey.__('failed') };
            }

            // Successful connection so save the credentials
            username = data.username;
            this.homey.app.apiKey = apiKey;
            this.homey.app.username = data.username;
            this.homey.settings.set('APIToken', this.homey.app.apiKey);
            this.homey.settings.set('UserName', this.homey.app.username);
            return { ok: true };
        });
    }

    async onRepair(session, device)
    {
        // Argument socket is an EventEmitter, similar to Driver.onPair
        // Argument device is a Homey.Device that's being repaired
        let apiKey = device.getStoreValue('apiKey');
        let username = device.getStoreValue('username');

        session.setHandler('connection_setup', async () =>
        {
            // Try an automatic repair first
            if (!await this.homey.app.registerWebhookURL(apiKey, username))
            {
                // The device store values are not good so try the app ones
                apiKey = this.homey.app.apiKey;
                username = this.homey.app.username;
                if (!await this.homey.app.registerWebhookURL(apiKey, username))
                {
                    // Still no good
                    apiKey = '';
                    return { username };
                }
            }
            await session.nextView();
            return { username };
        });

        session.setHandler('api_connection', async data =>
        {
            if (!data.username)
            {
                return { ok: false, err: this.homey.__('missingUsername') };
            }
            if (!data.password)
            {
                return { ok: false, err: this.homey.__('missingPassword') };
            }

            if (!apiKey)
            {
                try
                {
                    const res = await this.homey.app.getAPIKey(data);
                    apiKey = res.key;
                    this.homey.app.apiKey = apiKey;
                    this.homey.settings.set('APIToken', apiKey);
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
                this.homey.settings.set('APIToken', this.homey.app.apiKey);
                this.homey.settings.set('UserName', this.homey.app.username);
                device.setStoreValue('apiKey', data.apiKey);
                device.setStoreValue('username', data.username);
                device.username = data.username;
                device.apiKey = data.apiKey;
                device.setAvailable();
                device.updateDeviceValues();
                return { ok: true };
            }

            return { ok: false, err: this.homey.__('failed') };
        });
    }

}

module.exports = LinkTapDriver;
