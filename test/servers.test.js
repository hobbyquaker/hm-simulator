'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');

const {startSim, binrpcCall, xmlrpcCall} = require('./helpers.js');

const VIRTUAL_DEVICES = [
    {
        ADDRESS: 'INT0000001',
        CHILDREN: ['INT0000001:1'],
        FIRMWARE: '1.0',
        PARAMSETS: ['MASTER'],
        TYPE: 'HM-CC-VG-1',
        VERSION: 1,
    },
    {
        ADDRESS: 'INT0000001:1',
        INDEX: 1,
        PARAMSETS: ['MASTER', 'VALUES'],
        PARENT: 'INT0000001',
        PARENT_TYPE: 'HM-CC-VG-1',
        TYPE: 'HEATING_CLIMATECONTROL_TRANSCEIVER',
        VERSION: 1,
    },
];

const CUXD_DEVICES = [
    {
        ADDRESS: 'CUX2801001',
        CHILDREN: ['CUX2801001:1'],
        FIRMWARE: '1.0',
        PARAMSETS: ['MASTER'],
        TYPE: 'HM-LC-Sw1-Pl',
        VERSION: 1,
    },
    {
        ADDRESS: 'CUX2801001:1',
        INDEX: 1,
        PARAMSETS: ['MASTER', 'VALUES'],
        PARENT: 'CUX2801001',
        PARENT_TYPE: 'HM-LC-Sw1-Pl',
        TYPE: 'SWITCH',
        VERSION: 1,
    },
];

describe('VirtualDevices and CUxD servers', () => {
    let sim;
    let virtual;
    let cuxd;
    let virtualPort;

    before(async () => {
        const started = await startSim({
            devices: {
                rfd: {devices: []},
                hmip: {devices: []},
                virtual: {devices: VIRTUAL_DEVICES},
                cuxd: {devices: CUXD_DEVICES},
            },
            config: {virtualListenPort: 0, cuxdListenPort: 0},
        });
        sim = started.sim;
        virtualPort = started.ports.virtual;
        virtual = xmlrpcCall(virtualPort, {path: '/groups'});
        cuxd = binrpcCall(started.ports.cuxd);
    });

    after(() => {
        virtual.close();
        cuxd.close();
        sim.close();
    });

    it('serves VirtualDevices over xmlrpc on /groups', async () => {
        const devices = await virtual('listDevices', []);
        assert.equal(devices.length, 2);
        assert.equal(devices[0].TYPE, 'HM-CC-VG-1');
    });

    it('answers 404 on another path', async () => {
        await assert.rejects(xmlrpcCall(virtualPort, {path: '/nope'})('listDevices', []), (error) => {
            assert.match(error.message, /Not Found/);
            return true;
        });
    });

    it('serves CUxD over binrpc', async () => {
        const devices = await cuxd('listDevices', []);
        assert.equal(devices.length, 2);
        assert.equal(devices[0].ADDRESS, 'CUX2801001');
    });

    it('keeps the interfaces apart', async () => {
        assert.equal((await cuxd('getDeviceDescription', ['INT0000001'])).faultCode, -2);
    });
});

describe('TLS and basic auth', () => {
    let sim;
    let port;

    before(async () => {
        const started = await startSim({
            tls: true,
            auth: {username: 'Admin', password: 'secret'},
        });
        sim = started.sim;
        port = started.xmlrpcPort;
    });

    after(() => sim.close());

    const request = (headers) =>
        new Promise((resolve, reject) => {
            const body = '<?xml version="1.0"?><methodCall><methodName>listDevices</methodName><params/></methodCall>';
            const req = https.request(
                {
                    host: '127.0.0.1',
                    port,
                    method: 'POST',
                    path: '/',
                    rejectUnauthorized: false,
                    headers: {'Content-Type': 'text/xml', 'Content-Length': body.length, ...headers},
                },
                (response) => {
                    const chunks = [];
                    response.on('data', (chunk) => chunks.push(chunk));
                    response.on('end', () =>
                        resolve({status: response.statusCode, body: Buffer.concat(chunks).toString()}),
                    );
                },
            );
            req.on('error', reject);
            req.end(body);
        });

    it('serves https with a generated certificate', async () => {
        const authorization = 'Basic ' + Buffer.from('Admin:secret').toString('base64');
        const {status, body} = await request({Authorization: authorization});
        assert.equal(status, 200);
        assert.match(body, /methodResponse/);
    });

    it('rejects a request without credentials', async () => {
        const {status} = await request({});
        assert.equal(status, 401);
    });

    it('rejects wrong credentials', async () => {
        const authorization = 'Basic ' + Buffer.from('Admin:wrong').toString('base64');
        const {status} = await request({Authorization: authorization});
        assert.equal(status, 401);
    });

    it('exposes the generated certificate', () => {
        assert.match(sim.tls.cert, /^-----BEGIN CERTIFICATE-----/);
        assert.match(sim.tls.key, /PRIVATE KEY/);
    });
});
