'use strict';

const {describe, it, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;
const MAINTENANCE = `${fixtures.SWITCH_ADDRESS}:0`;

/** the whole writeable MASTER paramset of the SWITCH channel in the fixture */
const FULL_MASTER = {LOGGING: false, ON_TIME: 0, POWERUP_ACTION: 0, STATUSINFO_MINDELAY: 2, SEQUENCE: 0};

describe('CONFIG_PENDING semantics', () => {
    let sim;
    let rfd;

    afterEach(() => {
        rfd.close();
        sim.close();
    });

    const start = async (options) => {
        const started = await startSim(options);
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
        return started;
    };

    describe('strict (the default)', () => {
        beforeEach(() => start());

        it('rejects an invalid MASTER write and raises nothing', async () => {
            const result = await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true, NOPE: 1}]);
            assert.equal(result.faultCode, -4);
            assert.deepEqual(sim.getConfigPending('rfd'), []);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), false);
            // nothing of the write survived
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).LOGGING, false);
        });

        it('accepts a valid MASTER write without raising CONFIG_PENDING', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), []);
        });
    });

    describe('pending', () => {
        beforeEach(() => start({interfaces: {rfd: {configPendingMode: 'pending'}}}));

        it('accepts an invalid MASTER write, keeps the valid parameters and gets stuck', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true, NOPE: 1}]), '');
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).LOGGING, true);
            assert.deepEqual(sim.getConfigPending('rfd'), [{address: fixtures.SWITCH_ADDRESS, sticky: true}]);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), true);
        });

        it('records what was rejected in the write log', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {STATUSINFO_MINDELAY: 99, SEQUENCE: 'MAYBE'}]);
            const entry = sim.getWriteLog().pop();
            assert.equal(entry.rejected.length, 2);
            assert.deepEqual(
                entry.rejected.map((item) => [item.name, item.faultCode]),
                [
                    ['STATUSINFO_MINDELAY', -7],
                    ['SEQUENCE', -7],
                ],
            );
        });

        it('stays pending after another partial valid write', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]);
            await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]);
            assert.equal(sim.getConfigPending('rfd')[0].sticky, true);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), true);
        });

        it('clears on a valid full MASTER write', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]);
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', FULL_MASTER]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), []);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), false);
        });

        it('clears on clearConfigCache', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]);
            assert.equal(await rfd('clearConfigCache', [fixtures.SWITCH_ADDRESS]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), []);
        });

        it('clears on restoreConfigToDevice', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]);
            assert.equal(await rfd('restoreConfigToDevice', [fixtures.SWITCH_ADDRESS]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), []);
        });
    });

    describe('the ordinary BidCos queue', () => {
        beforeEach(() => start({interfaces: {rfd: {configPendingOnWrite: true, configPendingDelay: 60}}}));

        it('raises CONFIG_PENDING on a valid write and clears it after the delay', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), true);
            assert.deepEqual(sim.getConfigPending('rfd'), [{address: fixtures.SWITCH_ADDRESS, sticky: false}]);

            await waitFor(() => sim.getConfigPending('rfd').length === 0, {what: 'CONFIG_PENDING to clear'});
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), false);
        });
    });

    describe('per interface', () => {
        it('can run rfd in pending and hmip in strict mode at the same time', async () => {
            const started = await start({
                interfaces: {rfd: {configPendingMode: 'pending'}, hmip: {configPendingMode: 'strict'}},
            });
            const hmip = xmlrpcCall(started.xmlrpcPort);

            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]), '');
            assert.equal(sim.getConfigPending('rfd').length, 1);

            await assert.rejects(hmip('putParamset', [`${fixtures.HMIP_ADDRESS}:1`, 'MASTER', {NOPE: 1}]));
            assert.deepEqual(sim.getConfigPending('hmip'), []);
        });
    });
});
