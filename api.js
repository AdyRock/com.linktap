module.exports = {
    async getLog({ homey, query })
    {
        return homey.app.diagLog;
    },
    async getDetect({ homey, query })
    {
        return homey.app.detectedDevices;
    },
    async getAPIKey({ homey, body })
    {
        return await homey.app.getAPIKey(body);
    },
    async clearLog({ homey, body })
    {
        homey.app.diagLog = "";
        return 'OK';
    },
    async sendLog({ homey, body })
    {
        return await homey.app.sendLog(body);
    }
};