'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const xmlrpc = require('homematic-xmlrpc');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const HMIP = fixtures.HMIP_ADDRESS;
const HMIP_MAINTENANCE = `${HMIP}:0`;
const SWITCH = fixtures.SWITCH_ADDRESS;

/** The fixture's descriptions with UNREACH and CONFIG_PENDING of the HmIP device flagged as service messages. */
function descriptionsWithServiceFlags() {
    const descriptions = structuredClone(fixtures.paramsetDescriptions);
    const maintenance = descriptions['HmIP-RF/HmIP-PDT/1.4.8/2/MAINTENANCE/VALUES'];
    maintenance.UNREACH.FLAGS = 9;
    maintenance.CONFIG_PENDING.FLAGS = 9;
    return descriptions;
}

/**
 * The fault code of a call: a BIN-RPC client resolves with the fault struct, an XML-RPC client
 * rejects with it; `undefined` when the call succeeded.
 */
async function faultCode(call) {
    try {
        const result = await call;
        return result && typeof result === 'object' ? result.faultCode : undefined;
    } catch (error) {
        return error.faultCode;
    }
}

/** A second switch of the fixture's type, with its channels, under another serial. */
function switchDescriptions(serial) {
    return fixtures
        .devices()
        .rfd.devices.filter((device) => device.ADDRESS === SWITCH || device.PARENT === SWITCH)
        .map((device) => {
            const copy = structuredClone(device);
            copy.ADDRESS = copy.ADDRESS.replace(SWITCH, serial);
            if (copy.PARENT) {
                copy.PARENT = serial;
            }
            if (copy.CHILDREN) {
                copy.CHILDREN = copy.CHILDREN.map((child) => child.replace(SWITCH, serial));
            }
            return copy;
        });
}

/** An XML-RPC callback server that records the events it receives. */
async function eventServer() {
    const events = [];
    const server = await new Promise((resolve) => {
        const created = xmlrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(created));
    });
    server.on('listDevices', (error, params, callback) => callback(null, []));
    server.on('newDevices', (error, params, callback) => callback(null, ''));
    server.on('deleteDevices', (error, params, callback) => callback(null, ''));
    server.on('event', (error, params, callback) => {
        events.push(params.slice(1));
        callback(null, '');
    });
    server.on('system.multicall', (error, params, callback) => {
        for (const call of params[0]) {
            events.push(call.params.slice(1));
        }
        callback(null, '');
    });
    server.on('NotFound', () => {});
    return {events, server, url: `http://127.0.0.1:${server.httpServer.address().port}`};
}

describe('the calls homematic-manager makes (task 15)', () => {
    let sim;
    let rfd;
    let rfdXml;
    let hmip;
    let wired;
    let virtual;

    before(async () => {
        const devices = fixtures.devices();
        devices.wired = {devices: []};
        ({sim} = await startSim({
            devices,
            paramsetDescriptions: descriptionsWithServiceFlags(),
            metadata: {hmip: {[`${HMIP}:1`]: {channelMode: 'shutter'}}},
            config: {wiredListenPort: 0, virtualListenPort: 0},
        }));
        rfd = binrpcCall(sim.ports.rfd);
        rfdXml = xmlrpcCall(sim.ports.rfd);
        hmip = xmlrpcCall(sim.ports.hmip);
        wired = xmlrpcCall(sim.ports.wired);
        virtual = xmlrpcCall(sim.ports.virtual, {path: '/groups'});
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    describe('getKeyMismatchDevice and scriptKeyMismatch', () => {
        it("answers '' while no device holds another key, on rfd and hmipserver alike", async () => {
            assert.equal(await rfd('getKeyMismatchDevice', [false]), '');
            assert.equal(await hmip('getKeyMismatchDevice', [true]), '');
            assert.equal(await faultCode(wired('getKeyMismatchDevice', [false])), -1);
        });

        it('hears the scripted device at the install mode, names it until reset, and pairs it with the right key', async () => {
            const serial = 'KEY0000001';
            sim.scriptKeyMismatch('rfd', serial, {key: 'their-key', devices: switchDescriptions(serial)});

            await rfd('setInstallMode', [true, 60, 1]);
            await waitFor(() => sim.keyMismatch.rfd === serial, {what: 'the key mismatch'});
            assert.equal(sim.getDevice('rfd', serial), false);
            assert.equal(await rfd('getKeyMismatchDevice', [false]), serial);
            assert.equal(await rfdXml('getKeyMismatchDevice', [true]), serial);
            assert.equal(await rfd('getKeyMismatchDevice', [false]), '');

            // the wrong key is a mismatch again
            await rfd('setTempKey', ['wrong']);
            await rfd('setInstallMode', [true, 60, 1]);
            await waitFor(() => sim.keyMismatch.rfd === serial, {what: 'the second key mismatch'});
            await rfd('getKeyMismatchDevice', [true]);

            await rfd('setTempKey', ['their-key']);
            await rfd('setInstallMode', [true, 60, 1]);
            await waitFor(() => sim.getDevice('rfd', serial) !== false, {what: 'the pairing'});
            assert.equal(await rfd('getKeyMismatchDevice', [false]), '');
            assert.equal(sim.keyMismatchScript.rfd, undefined);
            await rfd('setTempKey', ['']);
            sim.removeDevice('rfd', serial);
        });

        it('hears the device after the delay only', async () => {
            const serial = 'KEY0000002';
            sim.scriptKeyMismatch('rfd', serial, {delay: 150});
            await rfd('setInstallMode', [true, 60, 1]);
            assert.equal(await rfd('getKeyMismatchDevice', [false]), '');
            await waitFor(() => sim.keyMismatch.rfd === serial, {what: 'the delayed key mismatch'});
            await rfd('getKeyMismatchDevice', [true]);
            delete sim.keyMismatchScript.rfd;
        });

        it('addDevice with the serial faults and names it; with the right key it answers the description', async () => {
            const serial = 'KEY0000003';
            sim.scriptKeyMismatch('rfd', serial, {key: 'k3', devices: switchDescriptions(serial)});
            assert.equal(await faultCode(rfd('addDevice', [serial])), -1);
            assert.equal(await rfd('getKeyMismatchDevice', [true]), serial);
            assert.equal(await faultCode(rfd('addDevice', ['NOTINREACH'])), -2);

            await rfd('setTempKey', ['k3']);
            const description = await rfd('addDevice', [serial]);
            assert.equal(description.ADDRESS, serial);
            assert.equal(description.TYPE, 'HM-LC-Sw1-Pl');
            await rfd('setTempKey', ['']);
            sim.removeDevice('rfd', serial);
        });

        it('has no addDevice on hmipserver, and wants a serial', async () => {
            assert.equal(await faultCode(hmip('addDevice', ['X'])), -1);
            assert.throws(() => sim.scriptKeyMismatch('rfd', ''), TypeError);
        });
    });

    describe('setInstallModeWithWhitelist and scriptInclusion (Homematic Manager task 88)', () => {
        const SGTIN = '3014F711A000000000000088';
        const KEY = '00112233445566778899AABBCCDDEEFF';

        /** The fixture's HmIP device with its channels under another address. */
        function hmipDescriptions(address) {
            return fixtures
                .devices()
                .hmip.devices.filter((device) => device.ADDRESS === HMIP || device.PARENT === HMIP)
                .map((device) => {
                    const copy = structuredClone(device);
                    copy.ADDRESS = copy.ADDRESS.replace(HMIP, address);
                    if (copy.PARENT) {
                        copy.PARENT = address;
                    }
                    if (copy.CHILDREN) {
                        copy.CHILDREN = copy.CHILDREN.map((child) => child.replace(HMIP, address));
                    }
                    return copy;
                });
        }

        const whitelist = (key) => [{ADDRESS: '3014-F711-A000-0000-0000-0088', KEY_MODE: 'LOCAL', KEY: key}];

        it('opens and closes the install mode on hmipserver only, and refuses a list that is none', async () => {
            assert.equal(await hmip('setInstallModeWithWhitelist', [true, 30, whitelist(KEY)]), '');
            assert.ok(sim.getInstallMode('hmip') > 25);
            assert.deepEqual(sim.getInstallWhitelist('hmip'), [{ADDRESS: SGTIN, KEY_MODE: 'LOCAL', KEY}]);
            assert.equal(await hmip('getInstallMode', []), sim.getInstallMode('hmip'));
            assert.equal(await hmip('setInstallModeWithWhitelist', [false]), '');
            assert.equal(sim.getInstallMode('hmip'), 0);
            assert.deepEqual(sim.getInstallWhitelist('hmip'), []);

            assert.equal(await faultCode(hmip('setInstallModeWithWhitelist', [true, 30, 'nope'])), -321);
            assert.equal(await faultCode(hmip('setInstallModeWithWhitelist', [true, 30, [{KEY: KEY}]])), -321);
            assert.equal(await faultCode(rfd('setInstallModeWithWhitelist', [true, 30, whitelist(KEY)])), -1);

            // a plain install mode forgets the list
            await hmip('setInstallModeWithWhitelist', [true, 30, whitelist(KEY)]);
            await hmip('setInstallMode', [true, 30]);
            assert.deepEqual(sim.getInstallWhitelist('hmip'), []);
            await hmip('setInstallMode', [false]);
        });

        it('declines a device whose whitelist key is not its own, then pairs it with the right one', async () => {
            const address = '0001D3C99C0088';
            sim.scriptInclusion('hmip', SGTIN, {key: KEY.toLowerCase(), devices: hmipDescriptions(address)});

            await hmip('setInstallModeWithWhitelist', [true, 60, whitelist('FF112233445566778899AABBCCDDEEFF')]);
            await waitFor(() => sim.getInclusions('hmip').length === 1, {what: 'the declined request'});
            assert.equal(sim.getInclusions('hmip')[0].result, 'declined');
            assert.equal(sim.getInclusions('hmip')[0].sgtin, SGTIN);
            assert.equal(sim.getDevice('hmip', address), false);
            // hmipserver tells nobody: no key mismatch either
            assert.equal(await hmip('getKeyMismatchDevice', [false]), '');

            // not on the list: not admitted
            await hmip('setInstallModeWithWhitelist', [
                true,
                60,
                [{ADDRESS: '3014F711A000000000000099', KEY_MODE: 'LOCAL', KEY}],
            ]);
            await waitFor(() => sim.getInclusions('hmip').length === 2, {what: 'the request off the list'});
            assert.equal(sim.getInclusions('hmip')[1].result, 'ignored');
            assert.equal(sim.getDevice('hmip', address), false);

            // the right key, with dashes and in lower case as a client might send it
            await hmip('setInstallModeWithWhitelist', [true, 60, whitelist('00112233-44556677-8899aabb-ccddeeff')]);
            await waitFor(() => sim.getDevice('hmip', address) !== false, {what: 'the pairing'});
            assert.equal(sim.getInclusions('hmip')[2].result, 'paired');
            assert.equal(sim.inclusionScripts.hmip.size, 0);
            await hmip('setInstallMode', [false]);
            sim.removeDevice('hmip', address);
        });

        it('lets the device join a plain install mode and a key-server entry, and not a closed one', async () => {
            const address = '0001D3C99C0089';
            const sgtin = '3014F711A000000000000089';
            const before = sim.getInclusions('hmip').length;
            sim.scriptInclusion('hmip', sgtin, {key: KEY, devices: hmipDescriptions(address), delay: 50});
            await hmip('setInstallMode', [true, 60]);
            await hmip('setInstallMode', [false]);
            // closed before the request: nothing heard
            await new Promise((resolve) => setTimeout(resolve, 100));
            assert.equal(sim.getInclusions('hmip').length, before);

            await hmip('setInstallModeWithWhitelist', [true, 60, [{ADDRESS: sgtin, KEY_MODE: 'KEYSERVER'}]]);
            await waitFor(() => sim.getDevice('hmip', address) !== false, {what: 'the key-server pairing'});
            assert.equal(sim.getInclusions('hmip').at(-1).result, 'paired');
            await hmip('setInstallMode', [false]);
            sim.removeDevice('hmip', address);

            assert.throws(() => sim.scriptInclusion('hmip', ''), TypeError);
        });
    });

    describe('service message suppression (hmipserver)', () => {
        it("suppresses one parameter, or every service parameter with '', and ignores the rest", async () => {
            assert.deepEqual(await hmip('getSuppressedServiceMessages', [HMIP_MAINTENANCE]), []);
            assert.deepEqual(await hmip('getSuppressedServiceMessages', ['UNKNOWN:0']), []);

            assert.equal(await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'UNREACH', true]), '');
            assert.deepEqual(await hmip('getSuppressedServiceMessages', [HMIP_MAINTENANCE]), ['UNREACH']);

            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'RSSI_DEVICE', true]);
            assert.deepEqual(await hmip('getSuppressedServiceMessages', [HMIP_MAINTENANCE]), ['UNREACH']);

            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, '', true]);
            assert.deepEqual(await hmip('getSuppressedServiceMessages', [HMIP_MAINTENANCE]), [
                'CONFIG_PENDING',
                'UNREACH',
            ]);

            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, '', false]);
            assert.deepEqual(await hmip('getSuppressedServiceMessages', [HMIP_MAINTENANCE]), []);
        });

        it('leaves a suppressed message out, reports the value that raises none, and keeps the stored one', async () => {
            const client = await eventServer();
            await hmip('init', [client.url, 'suppression']);

            sim.setReachable('hmip', HMIP, false);
            assert.deepEqual(await hmip('getServiceMessages', []), [[HMIP_MAINTENANCE, 'UNREACH', true]]);

            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'UNREACH', true]);
            assert.deepEqual(await hmip('getServiceMessages', []), []);
            assert.equal(await hmip('getValue', [HMIP_MAINTENANCE, 'UNREACH']), false);
            assert.equal((await hmip('getParamset', [HMIP_MAINTENANCE, 'VALUES'])).UNREACH, false);
            assert.equal(sim.values.hmip[HMIP_MAINTENANCE].VALUES.UNREACH, true);
            await waitFor(() => client.events.some(([, name, value]) => name === 'UNREACH' && value === false), {
                what: 'the event with the suppressed value',
            });

            // a new occurrence stays suppressed
            client.events.length = 0;
            sim.setReachable('hmip', HMIP, false);
            await waitFor(() => client.events.some(([, name]) => name === 'UNREACH'), {what: 'the event'});
            assert.ok(client.events.filter(([, name]) => name === 'UNREACH').every(([, , value]) => value === false));
            assert.deepEqual(await hmip('getServiceMessages', []), []);

            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'UNREACH', false]);
            assert.deepEqual(await hmip('getServiceMessages', []), [[HMIP_MAINTENANCE, 'UNREACH', true]]);
            assert.equal(await hmip('getValue', [HMIP_MAINTENANCE, 'UNREACH']), true);

            sim.setReachable('hmip', HMIP, true);
            await hmip('init', [client.url, '']);
            client.server.close();
        });

        it('leaves out a suppressed message raised through the scenario API too', async () => {
            sim.setServiceMessage('hmip', HMIP_MAINTENANCE, 'CONFIG_PENDING', true);
            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'CONFIG_PENDING', true]);
            assert.deepEqual(await hmip('getServiceMessages', []), []);
            await hmip('suppressServiceMessages', [HMIP_MAINTENANCE, 'CONFIG_PENDING', false]);
            sim.setServiceMessage('hmip', HMIP_MAINTENANCE, 'CONFIG_PENDING', false);
            assert.deepEqual(await hmip('getServiceMessages', []), []);
        });

        it('is hmipserver only', async () => {
            assert.equal(await faultCode(rfd('suppressServiceMessages', [`${SWITCH}:0`, '', true])), -1);
            assert.equal(await faultCode(rfd('getSuppressedServiceMessages', [`${SWITCH}:0`])), -1);
        });
    });

    describe('metadata', () => {
        it('answers the seeded and the stored values; an unset key is empty on hmipserver', async () => {
            assert.equal(await hmip('getMetadata', [`${HMIP}:1`, 'channelMode']), 'shutter');
            assert.equal(await hmip('getMetadata', [`${HMIP}:1`, 'other']), '');
            assert.equal(await hmip('getMetadata', ['UNKNOWN', 'other']), '');
            assert.equal(await hmip('setMetadata', [`${HMIP}:1`, 'channelMode', 'blind']), '');
            assert.equal(await hmip('getMetadata', [`${HMIP}:1`, 'channelMode']), 'blind');
            assert.equal(await faultCode(hmip('getAllMetadata', [`${HMIP}:1`])), -1);
        });

        it('faults on rfd for a key that is not set, and knows only its own addresses', async () => {
            assert.equal(await faultCode(rfd('getMetadata', [SWITCH, 'nokey'])), -1);
            assert.equal(await faultCode(rfd('getAllMetadata', [SWITCH])), -1);
            assert.equal(await faultCode(rfd('setMetadata', ['UNKNOWN', 'k', 'v'])), -2);
            await rfd('setMetadata', [SWITCH, 'room', 'kitchen']);
            await rfdXml('setMetadata', [SWITCH, 'level', 3]);
            assert.equal(await rfd('getMetadata', [SWITCH, 'room']), 'kitchen');
            assert.deepEqual(await rfdXml('getAllMetadata', [SWITCH]), {room: 'kitchen', level: 3});
        });

        it('is not on VirtualDevices', async () => {
            assert.equal(await faultCode(virtual('getMetadata', ['X', 'k'])), -1);
        });
    });

    describe('listReplaceableDevices, getVersion, getLGWStatus, setInterfaceClock', () => {
        it('lists the unreachable devices of the same type on rfd, and answers empty on hmipserver', async () => {
            const serial = 'REP0000001';
            sim.addDevice('rfd', ...switchDescriptions(serial));
            // a device that still answers is not replaced
            assert.deepEqual(await rfd('listReplaceableDevices', [SWITCH]), []);
            sim.setReachable('rfd', serial, false);
            const replaceable = await rfd('listReplaceableDevices', [SWITCH]);
            assert.deepEqual(
                replaceable.map((device) => device.ADDRESS),
                [serial],
            );
            sim.setReachable('rfd', serial, true);
            assert.deepEqual(await rfd('listReplaceableDevices', [SWITCH]), []);
            assert.deepEqual(await rfd('listReplaceableDevices', ['ABC0000002']), []);
            assert.equal(await faultCode(rfd('listReplaceableDevices', ['UNKNOWN'])), -2);
            assert.equal(await hmip('listReplaceableDevices', [HMIP]), '');
            sim.removeDevice('rfd', serial);
        });

        it('answers the measured versions, and the configured one', async () => {
            assert.equal(await rfd('getVersion', []), '2.6.0');
            assert.equal(await hmip('getVersion', []), '3.89.11.20260919');
            assert.equal(await faultCode(virtual('getVersion', [])), -1);
            const {sim: other} = await startSim({interfaces: {rfd: {version: '1.2.3'}}});
            try {
                assert.equal(await xmlrpcCall(other.ports.rfd)('getVersion', []), '1.2.3');
            } finally {
                other.close();
            }
        });

        it('has no getLGWStatus unless one is configured', async () => {
            assert.equal(await faultCode(rfd('getLGWStatus', [])), -1);
            const status = {'HM-LGW': {CONNECTED: true}};
            const {sim: other} = await startSim({interfaces: {rfd: {lgwStatus: status}}});
            try {
                assert.deepEqual(await xmlrpcCall(other.ports.rfd)('getLGWStatus', []), status);
                assert.equal(await faultCode(xmlrpcCall(other.ports.hmip)('getLGWStatus', [])), -1);
            } finally {
                other.close();
            }
        });

        it('records setInterfaceClock', async () => {
            assert.equal(await rfd('setInterfaceClock', [1790000000, 120]), '');
            assert.equal(await hmip('setInterfaceClock', [1790000001, 60]), '');
            assert.deepEqual(
                sim.interfaceClocks.map(({iface, utc, offset}) => [iface, utc, offset]),
                [
                    ['rfd', 1790000000, 120],
                    ['hmip', 1790000001, 60],
                ],
            );
            assert.equal(await faultCode(wired('setInterfaceClock', [1])), -1);
            assert.equal(await faultCode(hmip('setInterfaceClock', ['x'])), -321);
        });

        it('lists every new method in system.listMethods, with help', async () => {
            const names = await hmip('system.listMethods', []);
            for (const method of [
                'getKeyMismatchDevice',
                'addDevice',
                'suppressServiceMessages',
                'getSuppressedServiceMessages',
                'getMetadata',
                'setMetadata',
                'getAllMetadata',
                'listReplaceableDevices',
                'getVersion',
                'getLGWStatus',
                'setInterfaceClock',
            ]) {
                assert.ok(names.includes(method), method);
                assert.notEqual(await hmip('system.methodHelp', [method]), '', method);
            }
        });
    });

    describe('getServiceMessagesFault', () => {
        it('answers getServiceMessages with the unknown-method fault where it is set', async () => {
            const {sim: other} = await startSim({
                config: {virtualListenPort: 0},
                interfaces: {hmip: {getServiceMessagesFault: true}, virtual: {getServiceMessagesFault: true}},
            });
            try {
                await assert.rejects(xmlrpcCall(other.ports.hmip)('getServiceMessages', []), (error) => {
                    assert.equal(error.faultCode, -1);
                    assert.match(error.faultString, /Invalid XML-RPC message/);
                    return true;
                });
                assert.equal(
                    await faultCode(xmlrpcCall(other.ports.virtual, {path: '/groups'})('getServiceMessages', [])),
                    -1,
                );
                const otherRfd = binrpcCall(other.ports.rfd);
                assert.deepEqual(await otherRfd('getServiceMessages', []), []);
                otherRfd.close();
            } finally {
                other.close();
            }
        });
    });

    describe('the control port', () => {
        it('lets scriptKeyMismatch through', () => {
            const {SCENARIO_METHODS} = require('../lib/control.js');
            assert.ok(SCENARIO_METHODS.has('scriptKeyMismatch'));
        });
    });
});
