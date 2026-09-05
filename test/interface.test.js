'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, waitFor, fixtures} = require('./helpers.js');

const DEVICE = fixtures.SWITCH_ADDRESS;
const MAINTENANCE = `${DEVICE}:0`;

describe('interface and service methods', () => {
    let sim;
    let rfd;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    it('lists the BidCos interfaces', async () => {
        const interfaces = await rfd('listBidcosInterfaces', []);
        assert.equal(interfaces.length, 1);
        assert.equal(interfaces[0].DEFAULT, true);
        assert.equal(typeof interfaces[0].ADDRESS, 'string');
        assert.equal(interfaces[0].DUTY_CYCLE, 0);
    });

    it('assigns a device to an interface', async () => {
        assert.equal(await rfd('setBidcosInterface', [DEVICE, 'OEQ0123456', true]), '');
        assert.equal((await rfd('getDeviceDescription', [DEVICE])).ROAMING, 1);
        assert.equal((await rfd('setBidcosInterface', [DEVICE, 'NOPE', false])).faultCode, -2);
    });

    it('answers rssiInfo for every device', async () => {
        const info = await rfd('rssiInfo', []);
        assert.deepEqual(Object.keys(info).sort(), [DEVICE, 'ABC0000002']);
        assert.deepEqual(info[DEVICE], {OEQ0123456: [-65, 0]});
    });

    it('collects service messages from datapoints with the service flag', async () => {
        assert.deepEqual(await rfd('getServiceMessages', []), []);
        sim.api.emit('setValue', 'rfd', MAINTENANCE, 'STICKY_UNREACH', true);
        // STICKY_UNREACH has no service flag in the fixture, so it does not show up on its own
        assert.deepEqual(await rfd('getServiceMessages', []), []);

        sim.setServiceMessage('rfd', MAINTENANCE, 'STICKY_UNREACH', true);
        assert.deepEqual(await rfd('getServiceMessages', []), [[MAINTENANCE, 'STICKY_UNREACH', true]]);

        sim.setServiceMessage('rfd', MAINTENANCE, 'STICKY_UNREACH', false);
        assert.deepEqual(await rfd('getServiceMessages', []), []);
    });

    it('runs the install mode', async () => {
        assert.equal(await rfd('getInstallMode', []), 0);
        assert.equal(await rfd('setInstallMode', [true, 60, 1]), '');
        const remaining = await rfd('getInstallMode', []);
        assert.ok(remaining > 55 && remaining <= 60, `got ${remaining}`);
        await rfd('setInstallMode', [false]);
        assert.equal(await rfd('getInstallMode', []), 0);
    });

    it('lets a scenario script new devices into the install mode', async () => {
        sim.scriptNewDevices(
            'rfd',
            [
                {
                    ADDRESS: 'NEW0000001',
                    CHILDREN: [],
                    FIRMWARE: '1.9',
                    PARAMSETS: ['MASTER'],
                    TYPE: 'HM-LC-Sw1-Pl',
                    VERSION: 1,
                },
            ],
            10,
        );
        await rfd('setInstallMode', [true, 60, 1]);
        await waitFor(() => sim.index.rfd.has('NEW0000001'), {what: 'new device'});
        assert.equal((await rfd('listDevices', [])).length, 7);
        await rfd('setInstallMode', [false]);
    });

    it('deletes a device with its channels and links', async () => {
        await rfd('addLink', ['ABC0000002:1', `${DEVICE}:1`, '', '']);
        assert.equal(await rfd('deleteDevice', ['ABC0000002', 0]), '');
        assert.equal((await rfd('getDeviceDescription', ['ABC0000002'])).faultCode, -2);
        assert.equal((await rfd('getDeviceDescription', ['ABC0000002:1'])).faultCode, -2);
        assert.deepEqual(await rfd('getLinks', []), []);
        assert.equal((await rfd('deleteDevice', [`${DEVICE}:1`, 0])).faultCode, -8);
    });

    it('replaces a device and keeps its configuration', async () => {
        sim.addDevices('rfd', [
            {
                ADDRESS: 'REP0000001',
                CHILDREN: ['REP0000001:0', 'REP0000001:1'],
                FIRMWARE: '1.9',
                PARAMSETS: ['MASTER'],
                TYPE: 'HM-LC-Sw1-Pl',
                VERSION: 1,
            },
            {
                ADDRESS: 'REP0000001:0',
                INDEX: 0,
                PARAMSETS: ['MASTER', 'VALUES'],
                PARENT: 'REP0000001',
                PARENT_TYPE: 'HM-LC-Sw1-Pl',
                TYPE: 'MAINTENANCE',
                VERSION: 1,
            },
            {
                ADDRESS: 'REP0000001:1',
                INDEX: 1,
                PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
                PARENT: 'REP0000001',
                PARENT_TYPE: 'HM-LC-Sw1-Pl',
                TYPE: 'SWITCH',
                VERSION: 1,
            },
        ]);

        await rfd('putParamset', [`${DEVICE}:1`, 'MASTER', {STATUSINFO_MINDELAY: 9}]);
        assert.equal(await rfd('replaceDevice', [DEVICE, 'REP0000001']), '');
        assert.equal((await rfd('getParamset', ['REP0000001:1', 'MASTER'])).STATUSINFO_MINDELAY, 9);
        assert.equal((await rfd('getDeviceDescription', [DEVICE])).faultCode, -2);
    });

    it('takes reportValueUsage', async () => {
        assert.equal(await rfd('reportValueUsage', ['REP0000001:1', 'STATE', 1]), '');
        assert.equal(sim.valueUsage.pop().valueId, 'STATE');
        assert.equal((await rfd('reportValueUsage', ['NOPE:1', 'STATE', 1])).faultCode, -2);
    });

    it('answers the firmware stubs', async () => {
        assert.equal(await rfd('updateFirmware', [['REP0000001']]), true);
        assert.equal(await rfd('installFirmware', ['REP0000001']), true);
        assert.equal(sim.firmwareUpdates.length, 2);
        assert.equal((await rfd('updateFirmware', [['NOPE']])).faultCode, -2);
    });

    it('clears and restores the config cache', async () => {
        await rfd('putParamset', ['REP0000001:1', 'MASTER', {LOGGING: true}]);
        assert.equal(await rfd('clearConfigCache', ['REP0000001']), '');
        assert.equal((await rfd('getParamset', ['REP0000001:1', 'MASTER'])).LOGGING, false);
        assert.equal(await rfd('restoreConfigToDevice', ['REP0000001']), '');
        assert.equal((await rfd('clearConfigCache', ['NOPE'])).faultCode, -2);
    });

    it('answers determineParameter', async () => {
        assert.equal(await rfd('determineParameter', ['REP0000001:1', 'MASTER', 'LOGGING']), '');
        assert.equal((await rfd('determineParameter', ['REP0000001:1', 'MASTER', 'NOPE'])).faultCode, -4);
    });
});
