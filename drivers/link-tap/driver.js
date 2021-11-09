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
        return this.homey.app.getLinkTapDevices(body);
    }

    async onPair(session)
    {
        let { apiKey } = this.homey.app;
        let { username } = this.homey.app;
        let listDevicesDisplayed = false;

        session.setHandler('showView', async view =>
        {
            // if (!listDevicesDisplayed && (view === 'my_connect'))
            // {
            //     if (username && apiKey)
            //     {
            //         // Check if we can connect with the specified credentials
            //         if (await this.homey.app.registerWebhookURL(apiKey, username))
            //         {
            //             // Valid credentials to by pass the login screen
            //             await session.nextView();
            //         }
            //     }
            // }
        });

        session.setHandler('list_devices', async () =>
        {
            listDevicesDisplayed = true;
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
            return { username, password: apiKey ? 'apiKey-apiKey' : '' };
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

            if (data.password !== 'apiKey-apiKey')
            {
                try
                {
                    // Get the current apiKey using the username and password
                    const res = await this.homey.app.getAPIKey(data);
                    if (res.key)
                    {
                        apiKey = res.key;
                    }
                    else
                    {
                        // Get a new apiKey using the username and password
                        data.replace = true;
                        const res = await this.homey.app.getAPIKey(data);
                        apiKey = res.key;
                    }
                }
                catch (err)
                {
                    if (err.message === 'HTTPS Error - 400')
                    {
                        return { ok: false, err: this.homey.__('pair.failed') };
                    }
                }
            }

            if (!apiKey)
            {
                return { ok: false, err: this.homey.__('pair.failed') };
            }

            if (!await this.homey.app.registerWebhookURL(apiKey, data.username))
            {
                return { ok: false, err: this.homey.__('pair.failed') };
            }

            // Successful connection so save the credentials
            username = data.username;
            this.homey.app.apiKey = apiKey;
            this.homey.app.username = username;
            this.homey.settings.set('APIToken', apiKey);
            this.homey.settings.set('UserName', username);
            return { ok: true };
        });
    }

    async onRepair(session, device)
    {
        // Argument socket is an EventEmitter, similar to Driver.onPair
        // Argument device is a Homey.Device that's being repaired
        let apiKey = device.getStoreValue('apiKey');
        const username = device.getStoreValue('username');

        session.setHandler('connection_setup', async () =>
        {
            // Try an automatic repair first
            if (!await this.homey.app.registerWebhookURL(apiKey, username))
            {
                // Check if the global API key is different for the same username
                if ((apiKey !== this.homey.app.apiKey) && (username === this.homey.app.username))
                {
                    // The device store values are not good so try the app ones
                    apiKey = this.homey.app.apiKey;
                    if (!await this.homey.app.registerWebhookURL(apiKey, username))
                    {
                        // Still no good
                        apiKey = '';
                        return { ok: false, username };
                    }

                    // The global API key is good so update the device store and connect
                    device.setStoreValue('apiKey', apiKey);
                    device.apiKey = apiKey;
                    device.setAvailable();
                    device.updateDeviceValues();
                    return { ok: true, username };
                }

                apiKey = '';
                return { ok: false, username };
            }

            // Connected OK with the device credentials
            return { ok: true, username };
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

            try
            {
                // Get the API key using the username and password
                const res = await this.homey.app.getAPIKey(data);
                apiKey = res.key;
                this.homey.app.apiKey = apiKey;
                this.homey.settings.set('APIToken', apiKey);
            }
            catch (err)
            {
                return { ok: false, err: err.message };
            }

            if (await this.homey.app.registerWebhookURL(apiKey, data.username))
            {
                this.homey.app.apiKey = apiKey;
                this.homey.app.username = data.username;
                this.homey.settings.set('APIToken', this.homey.app.apiKey);
                this.homey.settings.set('UserName', this.homey.app.username);
                device.setStoreValue('apiKey', apiKey);
                device.setStoreValue('username', data.username);
                device.username = data.username;
                device.apiKey = apiKey;
                device.setAvailable();
                device.updateDeviceValues();
                return { ok: true };
            }

            return { ok: false, err: this.homey.__('pair.failed') };
        });
    }

}

module.exports = LinkTapDriver;
