'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const xmlrpc = require('homematic-xmlrpc');

const {startSim, binrpcCall, xmlrpcCall, waitFor} = require('./helpers.js');

const fixture = require('../data/fixtures/devices.json');

/** The fixture's device set, plus an HmIP radio module whose `:0` reports the radio levels. */
function devicesWithModule() {
    const devices = structuredClone(fixture.devices);
    devices.hmip.devices.push(
        {
            ADDRESS: '00000000MOD001',
            CHILDREN: ['00000000MOD001:0'],
            FIRMWARE: '4.4.22',
            PARAMSETS: ['MASTER'],
            TYPE: 'RPI-RF-MOD',
            VERSION: 1,
        },
        {
            ADDRESS: '00000000MOD001:0',
            INDEX: 0,
            PARAMSETS: ['MASTER', 'VALUES'],
            PARENT: '00000000MOD001',
            PARENT_TYPE: 'RPI-RF-MOD',
            TYPE: 'MAINTENANCE',
            VERSION: 1,
        },
    );
    const level = (id) => ({TYPE: 'INTEGER', OPERATIONS: 5, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 100, UNIT: '%', ID: id});
    const paramsetDescriptions = {
        ...fixture.paramsetDescriptions,
        'HmIP-RF/RPI-RF-MOD/4.4.22/1/MAINTENANCE/VALUES': {
            DUTY_CYCLE_LEVEL: level('DUTY_CYCLE_LEVEL'),
            CARRIER_SENSE_LEVEL: level('CARRIER_SENSE_LEVEL'),
        },
    };
    return {devices, paramsetDescriptions};
}

const deviceOf = (iface, type) => fixture.devices[iface].devices.find((device) => device.TYPE === type).ADDRESS;
const SWITCH = deviceOf('rfd', 'HM-LC-Sw1-Pl');
const PDT = deviceOf('hmip', 'HmIP-PDT');

/** An XML-RPC callback server that collects every event, single or in a multicall. */
async function eventServer() {
    const events = [];
    const calls = [];
    const server = await new Promise((resolve) => {
        const created = xmlrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(created));
    });
    server.on('event', (error, params, callback) => {
        events.push(params.slice(1));
        callback(null, '');
    });
    server.on('system.multicall', (error, params, callback) => {
        for (const call of params[0]) {
            events.push(call.params.slice(1));
        }
        callback(
            null,
            params[0].map(() => ['']),
        );
    });
    for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'updateDevice']) {
        server.on(method, (error, params, callback) => {
            calls.push({method, params});
            callback(null, method === 'listDevices' ? [] : '');
        });
    }
    server.on('NotFound', () => {});
    return {
        events,
        calls,
        url: `http://127.0.0.1:${server.httpServer.address().port}`,
        has: (address, datapoint, value) =>
            events.some((event) => event[0] === address && event[1] === datapoint && event[2] === value),
        close: () => server.close(),
    };
}

describe('device and radio health', () => {
    let sim;
    let rfd;
    let hmip;
    let callbacks;

    before(async () => {
        const {devices, paramsetDescriptions} = devicesWithModule();
        ({sim} = await startSim({
            devices,
            paramsetDescriptions,
            interfaces: {hmip: {firmwareUpdateDelay: 20}},
            bidcosInterfaces: {
                hmip: [{ADDRESS: '3014F711A000000000MOD001', TYPE: 'HMIP_CCU', CONNECTED: true, DEFAULT: true}],
            },
        }));
        rfd = binrpcCall(sim.ports.rfd);
        hmip = xmlrpcCall(sim.ports.hmip);
        callbacks = await eventServer();
        await rfd('init', [callbacks.url, 'rf']);
        await hmip('init', [callbacks.url, 'ip']);
        await waitFor(() => callbacks.calls.filter((call) => call.method === 'newDevices').length === 2, {
            what: 'both registrations',
        });
    });

    after(() => {
        rfd.close();
        callbacks.close();
        sim.close();
    });

    it('takes a BidCos device out of reach: UNREACH and STICKY_UNREACH, events and service messages', async () => {
        sim.setReachable('rfd', SWITCH, false);
        await waitFor(() => callbacks.has(`${SWITCH}:0`, 'STICKY_UNREACH', true), {what: 'STICKY_UNREACH event'});
        assert.ok(callbacks.has(`${SWITCH}:0`, 'UNREACH', true));
        assert.equal(await rfd('getValue', [`${SWITCH}:0`, 'UNREACH']), true);
        const messages = (await rfd('getServiceMessages', [])).filter((message) => message[0] === `${SWITCH}:0`);
        assert.deepEqual(messages.map((message) => message[1]).sort(), ['STICKY_UNREACH', 'UNREACH']);
    });

    it('accepts a write to an unreachable device by default', async () => {
        assert.equal(await rfd('setValue', [`${SWITCH}:1`, 'STATE', true]), '');
    });

    it('brings it back with STICKY_UNREACH left for the client to clear', async () => {
        sim.setReachable('rfd', `${SWITCH}:1`, true);
        await waitFor(() => callbacks.has(`${SWITCH}:0`, 'UNREACH', false), {what: 'UNREACH false'});
        let messages = (await rfd('getServiceMessages', [])).filter((message) => message[0] === `${SWITCH}:0`);
        assert.deepEqual(
            messages.map((message) => message[1]),
            ['STICKY_UNREACH'],
        );
        // the client acknowledges the sticky message
        assert.equal(await rfd('setValue', [`${SWITCH}:0`, 'STICKY_UNREACH', false]), '');
        messages = (await rfd('getServiceMessages', [])).filter((message) => message[0] === `${SWITCH}:0`);
        assert.deepEqual(messages, []);
    });

    it('takes an HmIP device out of reach without a sticky message', async () => {
        sim.setReachable('hmip', PDT, false);
        await waitFor(() => callbacks.has(`${PDT}:0`, 'UNREACH', true), {what: 'hmip UNREACH'});
        assert.equal(await hmip('getValue', [`${PDT}:0`, 'UNREACH']), true);
        assert.equal(callbacks.has(`${PDT}:0`, 'STICKY_UNREACH', true), false);
        sim.setReachable('hmip', PDT, true);
    });

    it('reports low battery with the datapoint the description has, or raises it as a message', async () => {
        sim.setLowBattery('rfd', SWITCH, true);
        await waitFor(() => callbacks.has(`${SWITCH}:0`, 'LOWBAT', true), {what: 'LOWBAT'});
        assert.ok((await rfd('getServiceMessages', [])).some((message) => message[1] === 'LOWBAT'));
        sim.setLowBattery('rfd', SWITCH, false);

        // the HmIP-PDT's description has no LOW_BAT: an event and a raised service message
        sim.setLowBattery('hmip', PDT, true);
        await waitFor(() => callbacks.has(`${PDT}:0`, 'LOW_BAT', true), {what: 'LOW_BAT'});
        assert.ok((await hmip('getServiceMessages', [])).some((message) => message[1] === 'LOW_BAT'));
        sim.setLowBattery('hmip', PDT, false);
        assert.equal(
            (await hmip('getServiceMessages', [])).some((message) => message[1] === 'LOW_BAT'),
            false,
        );
    });

    it('sets the duty cycle and carrier sense of the interfaces', async () => {
        sim.setDutyCycle('rfd', 42);
        assert.equal((await rfd('listBidcosInterfaces', []))[0].DUTY_CYCLE, 42);

        sim.setDutyCycle('hmip', 17);
        sim.setCarrierSense('hmip', 8);
        const [radio] = await hmip('listBidcosInterfaces', []);
        assert.equal(radio.DUTY_CYCLE, 17);
        assert.equal(radio.CARRIER_SENSE_LEVEL, 8);
        assert.equal(radio.ADDRESS, '3014F711A000000000MOD001');
        // the radio module reports them as events on its :0 channel
        await waitFor(() => callbacks.has('00000000MOD001:0', 'DUTY_CYCLE_LEVEL', 17), {what: 'DUTY_CYCLE_LEVEL'});
        await waitFor(() => callbacks.has('00000000MOD001:0', 'CARRIER_SENSE_LEVEL', 8), {what: 'CARRIER_SENSE_LEVEL'});
        assert.equal(await hmip('getValue', ['00000000MOD001:0', 'CARRIER_SENSE_LEVEL']), 8);
        assert.throws(() => sim.setDutyCycle('rfd', 'high'), /number/);
    });

    it('offers a firmware update and walks it to the end', async () => {
        sim.offerFirmware('hmip', PDT, '1.6.0');
        let description = await hmip('getDeviceDescription', [PDT]);
        assert.equal(description.AVAILABLE_FIRMWARE, '1.6.0');
        assert.equal(description.FIRMWARE_UPDATE_STATE, 'NEW_FIRMWARE_AVAILABLE');
        assert.ok(description.UPDATABLE);
        assert.equal(await hmip('getValue', [`${PDT}:0`, 'UPDATE_PENDING']), true);
        await waitFor(() => callbacks.calls.some((call) => call.method === 'updateDevice' && call.params[1] === PDT), {
            what: 'updateDevice',
        });

        assert.equal(await hmip('installFirmware', [PDT]), true);
        await waitFor(() => sim.getDevice('hmip', PDT).FIRMWARE === '1.6.0', {what: 'the new firmware'});
        description = await hmip('getDeviceDescription', [PDT]);
        assert.equal(description.FIRMWARE_UPDATE_STATE, 'UP_TO_DATE');
        assert.equal(await hmip('getValue', [`${PDT}:0`, 'UPDATE_PENDING']), false);
        const updates = callbacks.calls.filter((call) => call.method === 'updateDevice' && call.params[1] === PDT);
        assert.equal(updates.length, 4, 'offered, and three steps');
        // the channels still resolve their descriptions (the nearest firmware)
        assert.equal(await hmip('getValue', [`${PDT}:0`, 'UNREACH']), false);
    });

    it('leaves updateFirmware a recorded call when nothing was offered', async () => {
        assert.equal(await rfd('updateFirmware', [[SWITCH]]), true);
        assert.equal(sim.getDevice('rfd', SWITCH).FIRMWARE_UPDATE_STATE, undefined);
        assert.equal(sim.firmwareUpdates.at(-1).method, 'updateFirmware');
    });

    it('runs a timeline of scenario calls', async () => {
        const started = Date.now();
        const results = await sim.schedule([
            {at: 60, call: 'setReachable', args: ['rfd', SWITCH, true]},
            {at: 20, call: 'setReachable', args: ['rfd', SWITCH, false]},
        ]);
        assert.equal(results.length, 2);
        assert.ok(Date.now() - started >= 55);
        const unreachEvents = () =>
            callbacks.events.filter((event) => event[0] === `${SWITCH}:0` && event[1] === 'UNREACH');
        await waitFor(() => unreachEvents().at(-1)[2] === false, {what: 'the last UNREACH event'});
        const unreach = unreachEvents();
        assert.deepEqual(
            unreach.slice(-2).map((event) => event[2]),
            [true, false],
        );
        assert.throws(() => sim.schedule([{at: 0, call: 'close'}]), /close is no scenario call/);
    });
});

describe("unreachWrites: 'fault'", () => {
    it('answers notReachable to a write to an unreachable device, over both transports', async () => {
        const {sim} = await startSim({
            devices: structuredClone(fixture.devices),
            paramsetDescriptions: fixture.paramsetDescriptions,
            interfaces: {rfd: {unreachWrites: 'fault'}, hmip: {unreachWrites: 'fault'}},
        });
        const rfd = binrpcCall(sim.ports.rfd);
        const hmip = xmlrpcCall(sim.ports.hmip);
        sim.setReachable('rfd', SWITCH, false);
        sim.setReachable('hmip', PDT, false);

        assert.equal(
            (await rfd('setValue', [`${SWITCH}:1`, 'STATE', true])).faultCode,
            sim.faults.notReachable.faultCode,
        );
        await assert.rejects(hmip('putParamset', [`${PDT}:3`, 'VALUES', {STATE: true}]), {
            faultCode: sim.faults.notReachable.faultCode,
        });
        // reading still works, and the device takes writes again once it is back
        assert.equal(await rfd('getValue', [`${SWITCH}:0`, 'UNREACH']), true);
        sim.setReachable('rfd', SWITCH, true);
        assert.equal(await rfd('setValue', [`${SWITCH}:1`, 'STATE', true]), '');
        rfd.close();
        sim.close();
    });
});
