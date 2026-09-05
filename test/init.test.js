'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const {startSim, binrpcCall, xmlrpcCall, freePort, waitFor, fixtures} = require('./helpers.js');

/** A logic layer: a callback server that records what the simulator calls on it. */
function logicLayer(server) {
    const calls = [];
    const record = (method) => (error, params, callback) => {
        calls.push({method, params});
        if (method === 'listDevices') {
            callback(null, []);
        } else {
            callback(null, '');
        }
    };
    for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'event', 'system.multicall']) {
        server.on(method, record(method));
    }
    server.on('NotFound', () => {});
    return calls;
}

describe('init and the outgoing calls', () => {
    let sim;
    let rfd;
    let hmip;
    let binrpcCallbackServer;
    let xmlrpcCallbackServer;
    let binrpcCalls;
    let xmlrpcCalls;
    let binrpcCallbackPort;
    let xmlrpcCallbackPort;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
        hmip = xmlrpcCall(started.xmlrpcPort);

        binrpcCallbackPort = await freePort();
        binrpcCallbackServer = binrpc.createServer({host: '127.0.0.1', port: binrpcCallbackPort});
        binrpcCalls = logicLayer(binrpcCallbackServer);

        xmlrpcCallbackPort = await freePort();
        xmlrpcCallbackServer = xmlrpc.createServer({host: '127.0.0.1', port: xmlrpcCallbackPort});
        xmlrpcCalls = logicLayer(xmlrpcCallbackServer);
    });

    after(() => {
        rfd.close();
        hmip.close();
        sim.close();
        binrpcCallbackServer.close();
        xmlrpcCallbackServer.close();
    });

    it('asks a new binrpc logic layer for its devices and sends the missing ones', async () => {
        assert.equal(await rfd('init', [`xmlrpc_bin://127.0.0.1:${binrpcCallbackPort}`, 'sim-rfd']), '');

        await waitFor(() => binrpcCalls.some((call) => call.method === 'newDevices'), {what: 'newDevices'});
        const listDevices = binrpcCalls.find((call) => call.method === 'listDevices');
        assert.deepEqual(listDevices.params, ['sim-rfd']);
        const newDevices = binrpcCalls.find((call) => call.method === 'newDevices');
        assert.equal(newDevices.params[0], 'sim-rfd');
        assert.equal(newDevices.params[1].length, 6);
    });

    it('sends events to the connected logic layer', async () => {
        await rfd('setValue', [`${fixtures.SWITCH_ADDRESS}:1`, 'STATE', true]);
        await waitFor(() => binrpcCalls.some((call) => call.method === 'system.multicall'), {what: 'event'});
        const multicall = binrpcCalls.filter((call) => call.method === 'system.multicall').pop();
        const events = multicall.params[0];
        assert.ok(events.some((event) => event.params[2] === 'STATE' && event.params[3] === true));
        assert.equal(events[0].params[0], 'sim-rfd');
    });

    it('answers ping with a PONG event', async () => {
        const before = binrpcCalls.filter((call) => call.method === 'event').length;
        await rfd('ping', ['sim-rfd']);
        await waitFor(() => binrpcCalls.filter((call) => call.method === 'event').length > before, {what: 'PONG'});
        const event = binrpcCalls.filter((call) => call.method === 'event').pop();
        assert.deepEqual(event.params, ['sim-rfd', 'CENTRAL', 'PONG', 'sim-rfd']);
    });

    it('drops the client on an init with an empty id', async () => {
        assert.equal(await rfd('init', [`xmlrpc_bin://127.0.0.1:${binrpcCallbackPort}`, '']), '');
        assert.deepEqual(Object.keys(sim.clients.rfd), []);
    });

    it('works the same way over xmlrpc', async () => {
        assert.equal(await hmip('init', [`http://127.0.0.1:${xmlrpcCallbackPort}`, 'sim-hmip']), '');
        await waitFor(() => xmlrpcCalls.some((call) => call.method === 'newDevices'), {what: 'newDevices'});
        const newDevices = xmlrpcCalls.find((call) => call.method === 'newDevices');
        assert.equal(newDevices.params[1].length, 3);
        await hmip('init', [`http://127.0.0.1:${xmlrpcCallbackPort}`, '']);
    });
});
