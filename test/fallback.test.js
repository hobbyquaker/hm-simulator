'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const binrpc = require('binrpc');

const HmSim = require('../sim.js');
const {firmwareParts, compareFirmware} = require('../lib/paramset-index.js');
const {startSim, binrpcCall, waitFor, emptyBehaviorPath, fixtures} = require('./helpers.js');

const TYPE = 'HM-LC-Sw1-Pl';

/** The fixture's switch as a device of its own, with another serial, firmware and type. */
function switchDevice(serial, firmware, type = TYPE) {
    const source = fixtures
        .devices()
        .rfd.devices.filter(
            (device) => device.ADDRESS === fixtures.SWITCH_ADDRESS || device.PARENT === fixtures.SWITCH_ADDRESS,
        );
    return source.map((device) => {
        const copy = JSON.parse(JSON.stringify(device).replaceAll(fixtures.SWITCH_ADDRESS, serial));
        if (copy.PARENT) {
            copy.PARENT_TYPE = type;
        } else {
            copy.FIRMWARE = firmware;
            copy.TYPE = type;
        }
        return copy;
    });
}

/**
 * The fixture's descriptions, plus the switch's again for firmware 2.0 and 2.0.20200101, each
 * with a datapoint of its own in SWITCH/VALUES so that a test can tell which one was used.
 */
function descriptions() {
    const result = {...fixtures.paramsetDescriptions};
    for (const [firmware, marker] of [
        ['2.0', 'FROM_2_0'],
        ['2.0.20200101', 'FROM_2_0_DATED'],
    ]) {
        for (const [key, description] of Object.entries(fixtures.paramsetDescriptions)) {
            if (!key.startsWith(`BidCos-RF/${TYPE}/1.9/`)) {
                continue;
            }
            const copy = JSON.parse(JSON.stringify(description));
            if (key.endsWith('/SWITCH/VALUES')) {
                copy[marker] = {
                    TYPE: 'BOOL',
                    OPERATIONS: 5,
                    FLAGS: 1,
                    DEFAULT: true,
                    MIN: false,
                    MAX: true,
                    ID: marker,
                };
            }
            result[key.replace('/1.9/', `/${firmware}/`)] = copy;
        }
    }
    return result;
}

describe('firmware comparison', () => {
    it('compares part by part, numerically, with a build date as the last part', () => {
        assert.deepEqual(firmwareParts('2.31.25.20180526'), [2, 31, 25, 20180526]);
        assert.ok(compareFirmware(firmwareParts('2.9'), firmwareParts('2.10')) < 0);
        assert.ok(compareFirmware(firmwareParts('2.31.25'), firmwareParts('2.31.25.20180526')) < 0);
        assert.equal(compareFirmware(firmwareParts('1.4'), firmwareParts('1.4')), 0);
        assert.deepEqual(firmwareParts('1.x'), [1, -1]);
    });
});

describe('a device whose firmware has no paramset description', () => {
    let sim;
    let rfd;
    let callbackServer;
    const events = [];
    const warnings = [];

    before(async () => {
        const devices = fixtures.devices();
        devices.rfd.devices.push(
            ...switchDevice('FBK0000001', '1.0'), // below every known firmware -> 1.9
            ...switchDevice('FBK0000002', '1.9.5'), // between 1.9 and 2.0 -> 1.9
            ...switchDevice('FBK0000003', '9.9'), // above every known firmware -> the dated 2.0
            ...switchDevice('FBK0000004', '2.0.20250101'), // a dated build -> the dated 2.0
            ...switchDevice('FBK0000005', '2.0', 'HM-NO-SUCH-TYPE'), // no description of the type at all
        );
        const started = await startSim({
            devices,
            paramsetDescriptions: descriptions(),
            log: {debug() {}, info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {}},
        });
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);

        callbackServer = await new Promise((resolve) => {
            const server = binrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(server));
        });
        for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'event', 'system.multicall']) {
            callbackServer.on(method, (error, params, callback) => {
                if (method === 'system.multicall') {
                    events.push(...params[0].map((call) => call.params));
                }
                callback(null, method === 'listDevices' ? [] : '');
            });
        }
        callbackServer.on('NotFound', () => {});
        await rfd('init', [`xmlrpc_bin://127.0.0.1:${callbackServer.server.address().port}`, 'fallback']);
    });

    after(() => {
        rfd.close();
        callbackServer.close();
        sim.close();
    });

    it('uses the lowest firmware above when there is none below', async () => {
        const description = await rfd('getParamsetDescription', ['FBK0000001:1', 'VALUES']);
        assert.ok(description.STATE);
        assert.equal(description.FROM_2_0, undefined);
        assert.equal((await rfd('getParamset', ['FBK0000001:1', 'VALUES'])).STATE, false);
    });

    it('sets a value and sends the event over the fallback description', async () => {
        assert.equal(await rfd('setValue', ['FBK0000001:1', 'STATE', true]), '');
        assert.equal(await rfd('getValue', ['FBK0000001:1', 'STATE']), true);
        await waitFor(() => events.some((event) => event[1] === 'FBK0000001:1' && event[2] === 'STATE'), {
            what: 'STATE event',
        });
        assert.deepEqual(
            events.find((event) => event[1] === 'FBK0000001:1' && event[2] === 'STATE'),
            ['fallback', 'FBK0000001:1', 'STATE', true],
        );
    });

    it('uses the highest firmware at or below the device', async () => {
        const description = await rfd('getParamsetDescription', ['FBK0000002:1', 'VALUES']);
        assert.equal(description.FROM_2_0, undefined);
        assert.equal(description.FROM_2_0_DATED, undefined);
    });

    it('uses the highest known firmware for a device above every one', async () => {
        const description = await rfd('getParamsetDescription', ['FBK0000003:1', 'VALUES']);
        assert.ok(description.FROM_2_0_DATED);
        // the default values come from the fallback description too
        assert.equal(await rfd('getValue', ['FBK0000003:1', 'FROM_2_0_DATED']), true);
    });

    it('orders a dated build after its version', async () => {
        const description = await rfd('getParamsetDescription', ['FBK0000004:1', 'VALUES']);
        assert.ok(description.FROM_2_0_DATED);
    });

    it('writes MASTER through the fallback', async () => {
        assert.equal(await rfd('putParamset', ['FBK0000002:1', 'MASTER', {LOGGING: true}]), '');
        assert.equal((await rfd('getParamset', ['FBK0000002:1', 'MASTER'])).LOGGING, true);
    });

    it('still faults for a type without any description, and lists it', async () => {
        assert.equal((await rfd('getParamset', ['FBK0000005:1', 'VALUES'])).faultCode, -2);
        assert.equal(await rfd('getParamsetDescription', ['FBK0000005:1', 'VALUES']), '');

        const missing = sim.getMissingParamsetDescriptions();
        assert.deepEqual(
            missing.find((entry) => entry.key === 'BidCos-RF/HM-NO-SUCH-TYPE/2.0/1/SWITCH/VALUES'),
            {iface: 'rfd', key: 'BidCos-RF/HM-NO-SUCH-TYPE/2.0/1/SWITCH/VALUES', usedKey: null},
        );
        assert.deepEqual(
            missing.find((entry) => entry.key === `BidCos-RF/${TYPE}/1.0/1/SWITCH/VALUES`),
            {
                iface: 'rfd',
                key: `BidCos-RF/${TYPE}/1.0/1/SWITCH/VALUES`,
                usedKey: `BidCos-RF/${TYPE}/1.9/1/SWITCH/VALUES`,
            },
        );
        // the fixture's own devices match their descriptions exactly
        assert.equal(
            missing.some((entry) => entry.key.includes('/1.9/')),
            false,
        );
    });

    it('logs each substitution once', () => {
        const key = `BidCos-RF/${TYPE}/1.0/1/SWITCH/VALUES`;
        const logged = warnings.filter((line) => line.includes(key));
        assert.equal(logged.length, 1);
        assert.match(logged[0], new RegExp(`missing, using BidCos-RF/${TYPE}/1\\.9/1/SWITCH/VALUES`));
    });
});

describe('paramsetFallback: false', () => {
    let sim;
    let rfd;

    before(async () => {
        const devices = fixtures.devices();
        devices.rfd.devices.push(...switchDevice('FBK0000011', '1.0'));
        const started = await startSim({devices, paramsetDescriptions: descriptions(), paramsetFallback: false});
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    it('keeps the exact keys only', async () => {
        // binrpcCall resolves with the fault
        assert.equal((await rfd('getValue', ['FBK0000011:1', 'STATE'])).faultCode, -2);
        assert.equal((await rfd('setValue', ['FBK0000011:1', 'STATE', true])).faultCode, -2);
        assert.equal(await rfd('getParamsetDescription', ['FBK0000011:1', 'VALUES']), '');
        const missing = sim.getMissingParamsetDescriptions();
        assert.ok(missing.length > 0);
        assert.ok(missing.every((entry) => entry.usedKey === null));
    });
});

describe('the bundled default data', () => {
    let sim;
    let rfd;

    before(async () => {
        sim = new HmSim({
            devices: {rfd: require('../data/devices-rfd.json')},
            behaviorPath: emptyBehaviorPath,
            config: {listenAddress: '127.0.0.1', binrpcListenPort: 0},
        });
        await sim.whenReady();
        rfd = binrpcCall(sim.ports.rfd);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    it('has a description for every paramset of the CCU virtual remote (HM-RCV-50 2.27.8)', async () => {
        const missing = sim.getMissingParamsetDescriptions();
        assert.ok(missing.length > 0, 'the bundled HM-RCV-50 firmware has no description of its own');
        assert.deepEqual(
            missing.filter((entry) => entry.usedKey === null),
            [],
        );
        assert.ok(missing.every((entry) => entry.usedKey.includes('/HM-RCV-50/2.31.25/')));
    });

    it('presses a virtual button', async () => {
        assert.equal(await rfd('setValue', ['BidCoS-RF:1', 'PRESS_SHORT', true]), '');
        assert.equal(typeof (await rfd('getParamset', ['BidCoS-RF:0', 'VALUES'])), 'object');
    });
});
