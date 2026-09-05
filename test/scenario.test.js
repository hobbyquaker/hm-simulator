'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const binrpc = require('binrpc');

const {startSim, binrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;

const NEW_DEVICE = [
    {
        ADDRESS: 'SCN0000001',
        CHILDREN: ['SCN0000001:0', 'SCN0000001:1'],
        FIRMWARE: '1.9',
        PARAMSETS: ['MASTER'],
        TYPE: 'HM-LC-Sw1-Pl',
        VERSION: 1,
    },
    {
        ADDRESS: 'SCN0000001:0',
        INDEX: 0,
        PARAMSETS: ['MASTER', 'VALUES'],
        PARENT: 'SCN0000001',
        PARENT_TYPE: 'HM-LC-Sw1-Pl',
        TYPE: 'MAINTENANCE',
        VERSION: 1,
    },
    {
        ADDRESS: 'SCN0000001:1',
        INDEX: 1,
        PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
        PARENT: 'SCN0000001',
        PARENT_TYPE: 'HM-LC-Sw1-Pl',
        TYPE: 'SWITCH',
        VERSION: 1,
    },
];

describe('scenario api', () => {
    let sim;
    let rfd;
    let callbackServer;
    let calls;
    let callbackPort;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);

        callbackServer = await new Promise((resolve) => {
            const server = binrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(server));
        });
        callbackPort = callbackServer.server.address().port;
        calls = [];
        for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'event', 'system.multicall']) {
            callbackServer.on(method, (error, params, callback) => {
                calls.push({method, params});
                callback(null, method === 'listDevices' ? [] : '');
            });
        }
        callbackServer.on('NotFound', () => {});

        await rfd('init', [`xmlrpc_bin://127.0.0.1:${callbackPort}`, 'scenario']);
        await waitFor(() => calls.some((call) => call.method === 'newDevices'), {what: 'initial newDevices'});
    });

    after(() => {
        rfd.close();
        callbackServer.close();
        sim.close();
    });

    it('adds a device and announces it', async () => {
        const added = sim.addDevice('rfd', NEW_DEVICE);
        assert.equal(added.length, 3);
        await waitFor(() => calls.filter((call) => call.method === 'newDevices').length === 2, {what: 'newDevices'});
        assert.equal((await rfd('getDeviceDescription', ['SCN0000001:1'])).TYPE, 'SWITCH');
    });

    it('removes a device and announces it', async () => {
        sim.removeDevice('rfd', 'SCN0000001');
        await waitFor(() => calls.some((call) => call.method === 'deleteDevices'), {what: 'deleteDevices'});
        const deleted = calls.filter((call) => call.method === 'deleteDevices').pop();
        assert.deepEqual(deleted.params[1], ['SCN0000001', 'SCN0000001:0', 'SCN0000001:1']);
    });

    it('fires an event without validating it', async () => {
        const before = calls.filter((call) => call.method === 'event').length;
        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await waitFor(() => calls.filter((call) => call.method === 'event').length > before, {what: 'event'});
        const event = calls.filter((call) => call.method === 'event').pop();
        assert.deepEqual(event.params, ['scenario', SWITCH, 'WORKING', true]);
        // WORKING is read only for a client, but the device reports it
        assert.equal(await rfd('getValue', [SWITCH, 'WORKING']), true);
    });

    it('exposes the write log', async () => {
        await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]);
        const log = sim.getWriteLog();
        assert.equal(log.at(-1).paramset, 'MASTER');
        // the log is a copy, changing it does not change the simulator's state
        log.at(-1).values.LOGGING = false;
        assert.equal(sim.getWriteLog().at(-1).values.LOGGING, true);
    });

    // last, because it resets the sockets of the clients above
    it('drops the connection so that the logic layer has to init again', async () => {
        assert.equal(Object.keys(sim.clients.rfd).length, 1);
        await sim.dropConnection('rfd');
        assert.deepEqual(Object.keys(sim.clients.rfd), []);

        // the server is up again on the same port
        const again = binrpcCall(sim.ports.rfd);
        assert.equal((await again('listDevices', [])).length, 6);
        await again('init', [`xmlrpc_bin://127.0.0.1:${callbackPort}`, 'scenario']);
        assert.equal(Object.keys(sim.clients.rfd).length, 1);
        again.close();
    });
});

describe('fixtures generated from a paramset dump', () => {
    let sim;
    let hmip;

    before(async () => {
        const fixture = require('../data/fixtures/devices.json');
        const started = await startSim({
            devices: fixture.devices,
            paramsetDescriptions: fixture.paramsetDescriptions,
        });
        sim = started.sim;
        hmip = require('./helpers.js').xmlrpcCall(started.xmlrpcPort);
    });

    after(() => {
        hmip.close();
        sim.close();
    });

    it('offers the real device types', async () => {
        const types = new Set((await hmip('listDevices', [])).map((device) => device.TYPE));
        for (const type of ['HmIP-PDT', 'HmIPW-DRS8', 'HmIPW-DRI16', 'HmIPW-DRAP']) {
            assert.ok(types.has(type), `${type} missing`);
        }
        const rfdTypes = new Set(sim.devices.rfd.devices.map((device) => device.TYPE));
        assert.ok(rfdTypes.has('HM-LC-Sw1-Pl'));
        assert.ok(rfdTypes.has('HM-CC-RT-DN'));
    });

    it('has consistent channels', async () => {
        for (const device of await hmip('listDevices', [])) {
            if (device.PARENT) {
                assert.equal(device.ADDRESS, `${device.PARENT}:${device.INDEX}`);
            } else {
                assert.ok(device.CHILDREN.length > 0, device.ADDRESS);
            }
        }
    });

    it('answers real paramset descriptions for them', async () => {
        const drs8 = sim.devices.hmip.devices.find((device) => device.TYPE === 'HmIPW-DRS8');
        const channel = sim.devices.hmip.devices.find(
            (device) => device.PARENT === drs8.ADDRESS && device.TYPE === 'SWITCH_VIRTUAL_RECEIVER',
        );
        const description = await hmip('getParamsetDescription', [channel.ADDRESS, 'MASTER']);
        assert.ok(Object.keys(description).length > 0);
        const values = await hmip('getParamset', [channel.ADDRESS, 'VALUES']);
        assert.ok('STATE' in values, Object.keys(values).join(','));
    });
});
