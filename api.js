'use strict';

module.exports = {
    async getLog({ homey })
    {
        return homey.app.diagLog;
    },
    async getDetect({ homey })
    {
        return homey.app.detectedDevices;
    },
    async getAPIKey({ homey, body })
    {
        return homey.app.getAPIKey(body);
    },
    async clearLog({ homey })
    {
        homey.app.diagLog = '';
        return 'OK';
    },
    async sendLog({ homey, body })
    {
        return homey.app.sendLog(body);
    },
};
