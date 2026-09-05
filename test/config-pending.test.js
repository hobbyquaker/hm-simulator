'use strict';

const {describe, it, beforeEach, afterEach} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;
const MAINTENANCE = `${fixtures.SWITCH_ADDRESS}:0`;
const HMIP_CHANNEL = `${fixtures.HMIP_ADDRESS}:1`;
const HMIP_MAINTENANCE = `${fixtures.HMIP_ADDRESS}:0`;

/** the whole writeable MASTER paramset of the SWITCH channel in the fixture */
const FULL_MASTER = {LOGGING: false, ON_TIME: 0, POWERUP_ACTION: 0, STATUSINFO_MINDELAY: 2, SEQUENCE: 0};
/** the whole writeable MASTER paramset of the HmIP fixture channel */
const FULL_HMIP_MASTER = {CHANNEL_OPERATION_MODE: 0, ON_TIME: 0};

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

    describe('strict', () => {
        beforeEach(() => start({interfaces: {rfd: {configPendingMode: 'strict'}}}));

        it('rejects an invalid MASTER write and raises nothing', async () => {
            const result = await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true, NOPE: 1}]);
            assert.equal(result.faultCode, -5);
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
                    ['STATUSINFO_MINDELAY', -5],
                    ['SEQUENCE', -5],
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
        beforeEach(() =>
            start({
                interfaces: {rfd: {configPendingMode: 'strict', configPendingOnWrite: true, configPendingDelay: 60}},
            }),
        );

        it('raises CONFIG_PENDING on a valid write and clears it after the delay', async () => {
            await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), true);
            assert.deepEqual(sim.getConfigPending('rfd'), [{address: fixtures.SWITCH_ADDRESS, sticky: false}]);

            await waitFor(() => sim.getConfigPending('rfd').length === 0, {what: 'CONFIG_PENDING to clear'});
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), false);
        });
    });

    /*
     * The two modes below are not hypotheses any more: they are what the two interface processes of
     * a CCU on firmware 3.89.8 were measured to do on 2026-09-05, for Homematic Manager roadmap
     * task 6. The write-up with the raw answers is `docs/config-pending.md` in that repository.
     */
    describe('bidcos, as rfd 3.89.8 was measured', () => {
        beforeEach(() => start({interfaces: {rfd: {configPendingDelay: 60}}}));

        it('is the default for the rfd interface, and hmip for hmipserver', () => {
            assert.equal(sim.interfaceOption('rfd', 'configPendingMode'), 'bidcos');
            assert.equal(sim.interfaceOption('hmip', 'configPendingMode'), 'hmip');
        });

        it('drops a parameter the channel does not have without a word', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {NOPE: 1}]), '');
            const master = await rfd('getParamset', [SWITCH, 'MASTER']);
            assert.equal(master.NOPE, undefined);
            assert.deepEqual(sim.getConfigPending('rfd'), []);
            assert.deepEqual(
                sim
                    .getWriteLog()
                    .pop()
                    .rejected.map((item) => item.name),
                ['NOPE'],
            );
        });

        it('clamps a number into MIN..MAX instead of faulting', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {STATUSINFO_MINDELAY: 99}]), '');
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).STATUSINFO_MINDELAY, 15);
        });

        it('coerces a string in an INTEGER to a number', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {STATUSINFO_MINDELAY: 'not-a-number'}]), '');
            // parses to NaN, becomes 0, is clamped to MIN
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).STATUSINFO_MINDELAY, 1);
        });

        it('ignores an integer where a BOOL belongs and an ENUM name that does not exist', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: 1, SEQUENCE: 'MAYBE'}]), '');
            const master = await rfd('getParamset', [SWITCH, 'MASTER']);
            assert.equal(master.LOGGING, false);
            assert.equal(master.SEQUENCE, 0);
            assert.deepEqual(sim.getConfigPending('rfd'), []);
        });

        it('takes an ENUM as its name and as its index', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {SEQUENCE: 'ON'}]), '');
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).SEQUENCE, 1);
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {SEQUENCE: 0}]), '');
            assert.equal((await rfd('getParamset', [SWITCH, 'MASTER'])).SEQUENCE, 0);
        });

        it('queues a real change as CONFIG_PENDING until the device takes it', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), [{address: fixtures.SWITCH_ADDRESS, sticky: false}]);
            assert.equal(await rfd('getValue', [MAINTENANCE, 'CONFIG_PENDING']), true);
            await waitFor(() => sim.getConfigPending('rfd').length === 0, {what: 'CONFIG_PENDING to clear'});
        });

        it('raises nothing when the write changes nothing', async () => {
            assert.equal(await rfd('putParamset', [SWITCH, 'MASTER', FULL_MASTER]), '');
            assert.deepEqual(sim.getConfigPending('rfd'), []);
        });
    });

    describe('hmip, as hmipserver 3.89.8 was measured', () => {
        let hmip;

        beforeEach(async () => {
            const started = await start();
            hmip = xmlrpcCall(started.xmlrpcPort);
        });

        it('accepts a number outside MIN..MAX without checking it', async () => {
            assert.equal(await hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {ON_TIME: 99999}]), '');
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).ON_TIME, 99999);
            assert.deepEqual(sim.getConfigPending('hmip'), []);
        });

        it('takes an ENUM as its name and as its index', async () => {
            assert.equal(await hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {CHANNEL_OPERATION_MODE: 'DIMMER'}]), '');
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).CHANNEL_OPERATION_MODE, 1);
            assert.equal(await hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {CHANNEL_OPERATION_MODE: 0}]), '');
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).CHANNEL_OPERATION_MODE, 0);
        });

        it('keeps a wrongly typed value, faults, and gets stuck in CONFIG_PENDING', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {ON_TIME: 'not-a-number'}]), (error) => {
                assert.equal(error.faultCode, -5);
                assert.equal(error.faultString, 'Invalid parameter or value');
                return true;
            });
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).ON_TIME, 'not-a-number');
            assert.deepEqual(sim.getConfigPending('hmip'), [{address: fixtures.HMIP_ADDRESS, sticky: true}]);
            assert.equal(await hmip('getValue', [HMIP_MAINTENANCE, 'CONFIG_PENDING']), true);
        });

        it('is repaired by a valid full MASTER write', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {ON_TIME: 'not-a-number'}]));
            assert.equal(await hmip('putParamset', [HMIP_CHANNEL, 'MASTER', FULL_HMIP_MASTER]), '');
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).ON_TIME, 0);
            assert.deepEqual(sim.getConfigPending('hmip'), []);
            assert.equal(await hmip('getValue', [HMIP_MAINTENANCE, 'CONFIG_PENDING']), false);
        });

        it('keeps a parameter the channel does not have for ever and faults on every later write', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {NOPE: 1}]), (error) => {
                assert.equal(error.faultCode, -5);
                return true;
            });
            // no CONFIG_PENDING: nothing the device knows about changed, so nothing is pending
            assert.deepEqual(sim.getConfigPending('hmip'), []);
            assert.deepEqual(sim.getPoisonedChannels('hmip'), [HMIP_CHANNEL]);
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).NOPE, 1);

            // even an empty struct faults now: the fault comes from the stored configuration
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {}]));
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', FULL_HMIP_MASTER]));
            // ... but the valid values of that write did arrive
            assert.equal((await hmip('getParamset', [HMIP_CHANNEL, 'MASTER'])).ON_TIME, 0);
        });

        it('leaves VALUES and the other channels of the device alone', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {NOPE: 1}]));
            assert.equal(await hmip('putParamset', [HMIP_CHANNEL, 'VALUES', {STATE: true}]), '');
            assert.equal(await hmip('setValue', [HMIP_CHANNEL, 'STATE', false]), '');
            assert.equal(await hmip('putParamset', [HMIP_MAINTENANCE, 'MASTER', {}]), '');
        });

        it('offers no BidCos maintenance method to repair it', async () => {
            for (const method of ['clearConfigCache', 'restoreConfigToDevice']) {
                await assert.rejects(hmip(method, [fixtures.HMIP_ADDRESS]), (error) => {
                    assert.equal(error.faultCode, -1);
                    assert.equal(error.faultString, 'Generic error');
                    return true;
                });
            }
            await assert.rejects(hmip('determineParameter', [HMIP_CHANNEL, 'MASTER', 'ON_TIME']), (error) => {
                assert.equal(error.faultCode, -1);
                return true;
            });
        });

        it('forgets the poisoned channel when the device is deleted and paired again', async () => {
            await assert.rejects(hmip('putParamset', [HMIP_CHANNEL, 'MASTER', {NOPE: 1}]));
            assert.deepEqual(sim.getPoisonedChannels('hmip'), [HMIP_CHANNEL]);
            sim.removeDevice('hmip', fixtures.HMIP_ADDRESS);
            assert.deepEqual(sim.getPoisonedChannels('hmip'), []);
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

    describe('the rfd getServiceMessages shape', () => {
        it('answers an empty string instead of an empty array when asked to', async () => {
            await start({interfaces: {rfd: {serviceMessagesEmptyAsString: true}}});
            assert.equal(await rfd('getServiceMessages', []), '');
            sim.setServiceMessage('rfd', MAINTENANCE, 'STICKY_UNREACH', true);
            assert.deepEqual(await rfd('getServiceMessages', []), [[MAINTENANCE, 'STICKY_UNREACH', true]]);
        });

        it('answers an empty array by default', async () => {
            await start();
            assert.deepEqual(await rfd('getServiceMessages', []), []);
        });
    });
});
