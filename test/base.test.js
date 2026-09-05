'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall, fixtures} = require('./helpers.js');

describe('base rpc methods', () => {
    let sim;
    let rfd;
    let hmip;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
        hmip = xmlrpcCall(started.xmlrpcPort);
    });

    after(() => {
        rfd.close();
        hmip.close();
        sim.close();
    });

    it('answers system.listMethods on both transports', async () => {
        const viaBinrpc = await rfd('system.listMethods', []);
        const viaXmlrpc = await hmip('system.listMethods', []);
        assert.ok(viaBinrpc.includes('listDevices'));
        assert.ok(viaBinrpc.includes('getParamsetDescription'));
        assert.deepEqual(viaBinrpc, viaXmlrpc);
    });

    it('lists the devices of the interface it was asked on', async () => {
        const rfdDevices = await rfd('listDevices', []);
        const hmipDevices = await hmip('listDevices', []);
        assert.equal(rfdDevices.length, 6);
        assert.equal(hmipDevices.length, 3);
        assert.equal(rfdDevices[0].ADDRESS, fixtures.SWITCH_ADDRESS);
        assert.equal(hmipDevices[0].TYPE, 'HmIP-PDT');
    });

    it('returns paramset descriptions', async () => {
        const description = await rfd('getParamsetDescription', [`${fixtures.SWITCH_ADDRESS}:1`, 'VALUES']);
        assert.equal(description.STATE.TYPE, 'BOOL');
        assert.equal(description.STATE.OPERATIONS, 7);
    });

    it('answers ping with a PONG event on rfd', async () => {
        // no logic layer is connected, so the call only has to succeed
        assert.equal(await rfd('ping', ['test']), '');
    });

    it('sets and keeps values', async () => {
        await rfd('setValue', [`${fixtures.SWITCH_ADDRESS}:1`, 'STATE', true]);
        assert.equal(sim.values.rfd[`${fixtures.SWITCH_ADDRESS}:1`].VALUES.STATE, true);
    });

    it('fills VALUES with the defaults of the description', () => {
        assert.equal(sim.values.rfd[`${fixtures.SWITCH_ADDRESS}:1`].VALUES.WORKING, false);
        assert.equal(sim.values.hmip[`${fixtures.HMIP_ADDRESS}:0`].VALUES.RSSI_DEVICE, 0);
    });

    it('answers an unknown method with a fault', async () => {
        const viaBinrpc = await rfd('doesNotExist', []);
        assert.equal(viaBinrpc.faultCode, -1);
        assert.equal(viaBinrpc.faultString, 'Invalid XML-RPC message');

        await assert.rejects(hmip('doesNotExist', []), (error) => {
            assert.equal(error.faultCode, -1);
            return true;
        });
    });

    it('runs a system.multicall', async () => {
        const result = await rfd('system.multicall', [
            [
                {methodName: 'setValue', params: [`${fixtures.SWITCH_ADDRESS}:1`, 'STATE', false]},
                {methodName: 'doesNotExist', params: []},
            ],
        ]);
        assert.deepEqual(result[0], ['']);
        assert.equal(result[1].faultCode, -1);
    });
});
