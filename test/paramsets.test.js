'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;
const HMIP_SWITCH = `${fixtures.HMIP_ADDRESS}:1`;

describe('getParamset / putParamset / getValue', () => {
    let sim;
    let rfd;
    let hmip;

    before(async () => {
        // the fault table below is exercised with the strict mode; the measured 'bidcos' and
        // 'hmip' behaviour has its own suite in config-pending.test.js
        const started = await startSim({
            interfaces: {rfd: {configPendingMode: 'strict'}, hmip: {configPendingMode: 'strict'}},
        });
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
        hmip = xmlrpcCall(started.xmlrpcPort);
    });

    after(() => {
        rfd.close();
        hmip.close();
        sim.close();
    });

    it('answers getParamset MASTER with the defaults of the description', async () => {
        const master = await rfd('getParamset', [SWITCH, 'MASTER']);
        assert.equal(master.LOGGING, false);
        assert.equal(master.STATUSINFO_MINDELAY, 2);
        // ENUM values are stored and answered as the index
        assert.equal(master.SEQUENCE, 0);
    });

    it('answers getParamset VALUES with the current values', async () => {
        await rfd('setValue', [SWITCH, 'STATE', true]);
        const values = await rfd('getParamset', [SWITCH, 'VALUES']);
        assert.equal(values.STATE, true);
        assert.equal(values.WORKING, false);
    });

    it('keeps what putParamset MASTER wrote', async () => {
        assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true, STATUSINFO_MINDELAY: 7}]), '');
        const master = await rfd('getParamset', [SWITCH, 'MASTER']);
        assert.equal(master.LOGGING, true);
        assert.equal(master.STATUSINFO_MINDELAY, 7);
        // untouched parameters keep their default
        assert.equal(master.POWERUP_ACTION, 0);
    });

    it('accepts an ENUM by name and by index and stores the index', async () => {
        await rfd('putParamset', [SWITCH, 'MASTER', {SEQUENCE: 'ON'}]);
        assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).SEQUENCE, 1);
        await rfd('putParamset', [SWITCH, 'MASTER', {SEQUENCE: 0}]);
        assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).SEQUENCE, 0);
    });

    it('writes VALUES through putParamset', async () => {
        await rfd('putParamset', [SWITCH, 'VALUES', {STATE: false, INHIBIT: true}]);
        assert.equal(await rfd('getValue', [SWITCH, 'STATE']), false);
        assert.equal(await rfd('getValue', [SWITCH, 'INHIBIT']), true);
    });

    it('records every accepted putParamset in the write log', () => {
        const log = sim.getWriteLog();
        assert.ok(log.length >= 3);
        assert.equal(log[0].address, SWITCH);
        assert.equal(log[0].paramset, 'MASTER');
        assert.deepEqual(log[0].values, {LOGGING: true, STATUSINFO_MINDELAY: 7});
    });

    it('answers getDeviceDescription', async () => {
        const description = await rfd('getDeviceDescription', [SWITCH]);
        assert.equal(description.TYPE, 'SWITCH');
        assert.equal(description.PARENT, fixtures.SWITCH_ADDRESS);
    });

    it('answers system.methodHelp', async () => {
        assert.match(await rfd('system.methodHelp', ['putParamset']), /^void putParamset/);
        assert.equal(await rfd('system.methodHelp', ['nope']), '');
    });

    describe('faults', () => {
        it('unknown address', async () => {
            const result = await rfd('getParamset', ['NOPE:1', 'MASTER']);
            assert.equal(result.faultCode, -2);
            assert.equal(result.faultString, 'Invalid device');
        });

        it('unknown paramset', async () => {
            const result = await rfd('getParamset', [SWITCH, 'NOSUCHSET']);
            assert.equal(result.faultCode, -2);
        });

        it('getParamsetDescription of an unknown address', async () => {
            // hmipserver answers -2 Invalid device, rfd -2 Unknown instance (3.89.11): the table's unknownInstance
            for (const address of ['NOPE0000001', 'NOPE0000001:1']) {
                const result = await rfd('getParamsetDescription', [address, 'MASTER']);
                assert.equal(result.faultCode, -2, address);
                assert.equal(result.faultString, 'Invalid device', address);
            }
        });

        it('getParamsetDescription of a paramset the channel does not have', async () => {
            // hmipserver: -3 Unknown Paramset: NOSUCHSET; rfd: -3 Unknown paramset on a channel without LINK
            const result = await rfd('getParamsetDescription', [`${fixtures.SWITCH_ADDRESS}:0`, 'LINK']);
            assert.equal(result.faultCode, -3);
            assert.equal(result.faultString, 'Unknown Paramset');
            assert.equal((await rfd('getParamsetDescription', [SWITCH, 'NOSUCHSET'])).faultCode, -3);
            assert.equal((await rfd('getParamsetDescription', [SWITCH, ''])).faultCode, -321);
            assert.ok((await rfd('getParamsetDescription', [SWITCH, 'LINK'])).SHORT_ON_TIME);
        });

        it('unknown parameter', async () => {
            const result = await rfd('putParamset', [SWITCH, 'MASTER', {NOT_A_PARAMETER: 1}]);
            assert.equal(result.faultCode, -5);
            assert.equal(result.faultString, 'Unknown Parameter for value key');
            const value = await rfd('getValue', [SWITCH, 'NOT_A_DATAPOINT']);
            assert.equal(value.faultCode, -5);
        });

        it('read only parameter', async () => {
            const result = await rfd('putParamset', [SWITCH, 'MASTER', {SERIAL: 'x'}]);
            assert.equal(result.faultCode, -5);
            assert.equal(result.faultString, 'Invalid parameter or value');
        });

        it('wrong type', async () => {
            const result = await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: 'yes'}]);
            assert.equal(result.faultCode, -5);
            const setValue = await rfd('setValue', [SWITCH, 'STATE', 'on']);
            assert.equal(setValue.faultCode, -5);
        });

        it('out of range', async () => {
            const tooBig = await rfd('putParamset', [SWITCH, 'MASTER', {STATUSINFO_MINDELAY: 99}]);
            assert.equal(tooBig.faultCode, -5);
            const tooSmall = await rfd('putParamset', [SWITCH, 'MASTER', {STATUSINFO_MINDELAY: 0}]);
            assert.equal(tooSmall.faultCode, -5);
            const noSuchEnum = await rfd('putParamset', [SWITCH, 'MASTER', {SEQUENCE: 'MAYBE'}]);
            assert.equal(noSuchEnum.faultCode, -5);
        });

        it('a rejected putParamset changes nothing', async () => {
            const before = await rfd('getParamset', [SWITCH, 'MASTER']);
            await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: false, NOT_A_PARAMETER: 1}]);
            assert.deepEqual(await rfd('getParamset', [SWITCH, 'MASTER']), before);
        });

        it('arrive as an xmlrpc fault on the hmip interface', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_SWITCH, 'MASTER', {ON_TIME: 99999}]), (error) => {
                assert.equal(error.faultCode, -5);
                return true;
            });
        });
    });

    it('the behaviour script api stays lenient', () => {
        // no throw, only a log line - behaviour scripts must not be able to kill the simulator
        sim.api.emit('setValue', 'rfd', SWITCH, 'NOT_A_DATAPOINT', true);
        sim.api.emit('setValue', 'rfd', 'NOPE:1', 'STATE', true);
    });

    it('the behaviour script api may report datapoints a client cannot write', async () => {
        // WORKING is OPERATIONS 5 (read + event): a device reports it, a client cannot set it
        assert.equal((await rfd('setValue', [SWITCH, 'WORKING', true])).faultCode, -5);
        sim.api.emit('setValue', 'rfd', SWITCH, 'WORKING', true);
        assert.equal(await rfd('getValue', [SWITCH, 'WORKING']), true);
    });
});

describe('ENUM defaults', () => {
    it('starts an ENUM whose DEFAULT is the index at that index, not -1', async () => {
        const fixture = require('../data/fixtures/devices.json');
        const {sim, binrpcPort} = await startSim({
            devices: JSON.parse(JSON.stringify(fixture.devices)),
            paramsetDescriptions: fixture.paramsetDescriptions,
        });
        const rfd = binrpcCall(binrpcPort);
        // HM-CC-RT-DN: FAULT_REPORTING has DEFAULT 0 and the service flag
        const thermostat = sim.devices.rfd.devices.find((device) => device.TYPE === 'CLIMATECONTROL_RT_TRANSCEIVER');
        assert.equal(await rfd('getValue', [thermostat.ADDRESS, 'FAULT_REPORTING']), 0);
        assert.deepEqual(await rfd('getServiceMessages', []), []);
        rfd.close();
        sim.close();
    });
});

describe("rfd's fault table", () => {
    it('answers an unknown address and a device address as rfd 3.89.11 was measured to', async () => {
        const {FAULT_TABLES} = require('../lib/faults.js');
        const {sim, binrpcPort} = await startSim({faults: FAULT_TABLES.bidcos});
        const rfd = binrpcCall(binrpcPort);
        try {
            const description = await rfd('getParamsetDescription', ['NOPE0000001:1', 'MASTER']);
            assert.deepEqual(description, {faultCode: -2, faultString: 'Unknown instance'});
            const paramset = await rfd('getParamsetDescription', [`${fixtures.SWITCH_ADDRESS}:0`, 'LINK']);
            assert.deepEqual(paramset, {faultCode: -3, faultString: 'Unknown paramset'});
        } finally {
            rfd.close();
            sim.close();
        }
    });
});
