'use strict';

const {describe, it, before, after, afterEach} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;
const HMIP_SWITCH = `${fixtures.HMIP_ADDRESS}:1`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * An XML-RPC callback server whose answers a test controls: per method 'answer' (the default) or
 * 'hang' (accept the request, never answer). `dropAll()` ends every connection - what ends a hang
 * on a real CCU.
 */
async function listener(behaviour = {}) {
    const calls = [];
    const sockets = new Set();
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks).toString();
            const method = (/<methodName>([^<]*)<\/methodName>/.exec(body) || [])[1];
            calls.push({method, body, at: Date.now()});
            if ((behaviour[method] || 'answer') === 'hang') {
                return;
            }
            const value =
                method === 'system.listMethods' || method === 'listDevices'
                    ? '<array><data></data></array>'
                    : '<string></string>';
            const xml = `<?xml version="1.0"?><methodResponse><params><param><value>${value}</value></param></params></methodResponse>`;
            response.writeHead(200, {'Content-Type': 'text/xml', 'Content-Length': Buffer.byteLength(xml)});
            response.end(xml);
        });
    });
    server.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
        calls,
        behaviour,
        url: `http://127.0.0.1:${server.address().port}`,
        methods: () => calls.map((call) => call.method),
        events: () => calls.filter((call) => /PONG|<methodName>event<|system\.multicall/.test(call.body)),
        dropAll() {
            for (const socket of sockets) {
                socket.destroy();
            }
        },
        close() {
            this.dropAll();
            server.close();
        },
    };
}

function refused(port) {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('connect', () => {
            socket.destroy();
            resolve(false);
        });
        socket.on('error', (error) => resolve(error.code === 'ECONNREFUSED'));
    });
}

/** A promise that tells whether it settled within `ms`. */
function settlesWithin(promise, ms) {
    return Promise.race([promise.then(() => true), sleep(ms).then(() => false)]);
}

describe('restartInterface, stopInterface, startInterface', () => {
    let sim;
    let client;

    // XML-RPC clients only: binrpc's client reconnects on its own after a restart reset it
    before(async () => {
        ({sim} = await startSim());
    });

    after(() => sim.close());

    afterEach(() => client && client.close());

    it('forgets the clients by default: no events until the client re-inits', async () => {
        client = await listener();
        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'restart']);
        await waitFor(() => client.methods().includes('newDevices'), {what: 'newDevices'});

        const restarted = sim.restartInterface('rfd', {downMs: 200});
        await sleep(50);
        assert.equal(await refused(sim.ports.rfd), true, 'the port is closed while down');
        await restarted;
        assert.equal(await refused(sim.ports.rfd), false);

        const before = client.calls.length;
        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await sleep(100);
        assert.equal(client.calls.length, before, 'nothing reaches a forgotten client');

        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'restart']);
        sim.fireEvent('rfd', SWITCH, 'WORKING', false);
        await waitFor(() => client.methods().includes('event'), {what: 'event after re-init'});
    });

    it('with forgetClients: false calls the clients back as rfd does with its handlers file', async () => {
        client = await listener();
        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'keep']);
        await waitFor(() => client.methods().includes('newDevices'), {what: 'newDevices'});
        client.calls.length = 0;

        await sim.restartInterface('rfd', {forgetClients: false});
        await waitFor(() => client.methods().includes('listDevices'), {what: 'listDevices after the restart'});
        assert.deepEqual(client.methods().slice(0, 2), ['system.listMethods', 'listDevices']);

        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await waitFor(() => client.methods().includes('event'), {what: 'event'});
    });

    it('keeps the port closed from stopInterface until startInterface', async () => {
        client = null;
        await sim.stopInterface('rfd');
        assert.equal(await refused(sim.ports.rfd), true);
        await sim.startInterface('rfd');
        const rfd = binrpcCall(sim.ports.rfd);
        assert.equal((await rfd('listDevices', [])).length, 6);
        rfd.close();
    });
});

describe('startDelay', () => {
    it('opens the port only after the delay; whenReady does not wait for it', async () => {
        const started = Date.now();
        const {sim, ports} = await startSim({interfaces: {hmip: {startDelay: 300}}});
        assert.ok(Date.now() - started < 300);
        assert.equal(typeof ports.hmip, 'number');
        assert.equal(await refused(ports.hmip), true);
        const until = Date.now() + 3000;
        while ((await refused(ports.hmip)) && Date.now() < until) {
            await sleep(25);
        }
        assert.ok((await xmlrpcCall(ports.hmip)('listDevices', [])).length > 0);
        sim.close();
    });
});

describe('ping and PONG', () => {
    let sim;
    let client;

    before(async () => {
        ({sim} = await startSim({interfaces: {rfd: {pingDelay: 150}, hmip: {pong: true}}}));
        client = await listener();
        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'pinger']);
        await xmlrpcCall(sim.ports.hmip)('init', [client.url, 'pinger-ip']);
        await waitFor(() => client.methods().filter((method) => method === 'newDevices').length === 2, {
            what: 'both registrations',
        });
    });

    after(() => {
        client.close();
        sim.close();
    });

    it('sends the PONG after pingDelay', async () => {
        const sent = Date.now();
        await xmlrpcCall(sim.ports.rfd)('ping', ['pinger']);
        await waitFor(() => client.calls.find((call) => /PONG/.test(call.body) && /pinger</.test(call.body)), {
            what: 'PONG',
        });
        const pong = client.calls.find((call) => /PONG/.test(call.body) && /pinger</.test(call.body));
        assert.ok(pong.at - sent >= 140, `PONG after ${pong.at - sent} ms`);
    });

    it('answers ping on hmip with a PONG when asked to, and not by default', async () => {
        await xmlrpcCall(sim.ports.hmip)('ping', ['ip']);
        await waitFor(() => client.calls.some((call) => /PONG/.test(call.body) && /pinger-ip/.test(call.body)), {
            what: 'hmip PONG',
        });

        const {sim: plain} = await startSim();
        const quiet = await listener();
        await xmlrpcCall(plain.ports.hmip)('init', [quiet.url, 'quiet']);
        await waitFor(() => quiet.methods().includes('newDevices'), {what: 'newDevices'});
        await xmlrpcCall(plain.ports.hmip)('ping', ['quiet']);
        await sleep(100);
        assert.equal(
            quiet.calls.some((call) => /PONG/.test(call.body)),
            false,
        );
        quiet.close();
        plain.close();
    });
});

describe('injectFault', () => {
    let sim;
    let rfd;
    let hmip;

    before(async () => {
        ({sim} = await startSim());
        rfd = binrpcCall(sim.ports.rfd);
        hmip = xmlrpcCall(sim.ports.hmip);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    afterEach(() => sim.clearFaults());

    it('delays an answer, over both transports', async () => {
        sim.injectFault({method: 'getValue', times: 2, delayMs: 200});
        let started = Date.now();
        assert.equal(await rfd('getValue', [SWITCH, 'STATE']), false);
        assert.ok(Date.now() - started >= 190);
        started = Date.now();
        assert.equal(await hmip('getValue', [HMIP_SWITCH, 'STATE']), false);
        assert.ok(Date.now() - started >= 190);
        // used up
        started = Date.now();
        await rfd('getValue', [SWITCH, 'STATE']);
        assert.ok(Date.now() - started < 150);
    });

    it('answers a fault by its name in the fault table, or as given', async () => {
        sim.injectFault({iface: 'rfd', method: 'setValue', fault: 'notReachable'});
        const answer = await rfd('setValue', [SWITCH, 'STATE', true]);
        assert.equal(answer.faultCode, sim.faults.notReachable.faultCode);

        sim.injectFault({iface: 'hmip', method: 'listDevices', fault: {faultCode: -32603, faultString: 'nope'}});
        await assert.rejects(hmip('listDevices', []), {faultCode: -32603});
        assert.ok((await hmip('listDevices', [])).length > 0);
        assert.throws(() => sim.injectFault({fault: 'noSuchFault'}), /noSuchFault/);
    });

    it('only hits the interface it names', async () => {
        sim.injectFault({iface: 'hmip', method: '*', fault: 'unknownInstance'});
        assert.equal((await rfd('listDevices', [])).length, 6);
        await assert.rejects(hmip('getInstallMode', []));
    });

    it('never answers a hung call', async () => {
        sim.injectFault({iface: 'hmip', method: 'getInstallMode', hang: true});
        assert.equal(await settlesWithin(hmip('getInstallMode', []), 300), false);
        // the next one is answered
        assert.equal(await hmip('getInstallMode', []), 0);
    });

    it('closes the connection instead of answering, over XML-RPC', async () => {
        sim.injectFault({iface: 'hmip', method: 'listDevices', closeSocket: true});
        await assert.rejects(hmip('listDevices', []), /socket hang up|ECONNRESET/);
    });

    it('closes the connection instead of answering, over BIN-RPC', async () => {
        sim.injectFault({iface: 'rfd', method: 'listDevices', closeSocket: true});
        const closed = await new Promise((resolve) => {
            const socket = net.connect(sim.ports.rfd, '127.0.0.1', () => {
                const name = Buffer.from('listDevices');
                const body = Buffer.alloc(4 + name.length + 4);
                body.writeUInt32BE(name.length, 0);
                name.copy(body, 4);
                body.writeUInt32BE(0, 4 + name.length);
                const header = Buffer.alloc(8);
                header.write('Bin', 0, 'ascii');
                header.writeUInt8(0, 3);
                header.writeUInt32BE(body.length, 4);
                socket.write(Buffer.concat([header, body]));
            });
            socket.on('data', () => resolve(false));
            socket.on('close', () => resolve(true));
            socket.on('error', () => {});
        });
        assert.equal(closed, true);
    });

    it('keeps a rule with times -1 until clearFaults', async () => {
        sim.injectFault({iface: 'rfd', method: 'getInstallMode', times: -1, fault: 'unknownMethod'});
        for (let index = 0; index < 3; index++) {
            assert.equal((await rfd('getInstallMode', [])).faultCode, sim.faults.unknownMethod.faultCode);
        }
        sim.clearFaults();
        assert.equal(await rfd('getInstallMode', []), 0);
    });
});

describe("listenerModel 'measured': hmipserver", () => {
    it('holds every event back while one registration hangs in listDevices, until its connection ends', async () => {
        const {sim} = await startSim({interfaces: {hmip: {listenerModel: 'measured'}}});
        const good = await listener();
        const hanging = await listener({listDevices: 'hang'});
        const hmip = xmlrpcCall(sim.ports.hmip);

        await hmip('init', [good.url, 'good']);
        await waitFor(() => good.methods().includes('newDevices'), {what: 'good registered'});

        // init answers at once although the listDevices callback hangs
        assert.equal(await settlesWithin(hmip('init', [hanging.url, 'hanging']), 200), true);
        await waitFor(() => hanging.methods().includes('listDevices'), {what: 'the hanging listDevices'});

        sim.fireEvent('hmip', HMIP_SWITCH, 'STATE', true);
        await sleep(200);
        assert.equal(good.methods().includes('event'), false, 'the event waits');
        // hmipserver still answers calls
        assert.equal(await hmip('getInstallMode', []), 0);

        hanging.dropAll();
        await waitFor(() => good.methods().includes('event'), {what: 'the queued event'});
        // the one that hung is not called again
        const calls = hanging.calls.length;
        sim.fireEvent('hmip', HMIP_SWITCH, 'STATE', false);
        await waitFor(() => good.methods().filter((method) => method === 'event').length === 2, {what: 'next event'});
        assert.equal(hanging.calls.length, calls);

        good.close();
        hanging.close();
        sim.close();
    });

    it("delivers at once under the default 'isolated' model", async () => {
        const {sim} = await startSim();
        const good = await listener();
        const hanging = await listener({listDevices: 'hang'});
        const hmip = xmlrpcCall(sim.ports.hmip);
        await hmip('init', [good.url, 'good']);
        await waitFor(() => good.methods().includes('newDevices'), {what: 'good registered'});
        await hmip('init', [hanging.url, 'hanging']);
        sim.fireEvent('hmip', HMIP_SWITCH, 'STATE', true);
        await waitFor(() => good.methods().includes('event'), {what: 'event'});
        good.close();
        hanging.close();
        sim.close();
    });
});

describe("listenerModel 'measured': rfd", () => {
    it('calls system.listMethods and listDevices back before init answers', async () => {
        const {sim} = await startSim({interfaces: {rfd: {listenerModel: 'measured'}}});
        const client = await listener();
        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'ordered']);
        const answered = Date.now();
        assert.deepEqual(client.methods().slice(0, 2), ['system.listMethods', 'listDevices']);
        assert.ok(client.calls[1].at <= answered);
        client.close();
        sim.close();
    });

    it('answers nobody while a callback hangs in system.listMethods, then registers the client anyway', async () => {
        const {sim} = await startSim({interfaces: {rfd: {listenerModel: 'measured', deliveryTimeout: 200}}});
        const hanging = await listener({'system.listMethods': 'hang'});
        const rfd = binrpcCall(sim.ports.rfd);
        const init = xmlrpcCall(sim.ports.rfd)('init', [hanging.url, 'hanging']);

        assert.equal(await settlesWithin(init, 200), false, 'init does not return');
        assert.equal(await settlesWithin(rfd('listDevices', []), 200), false, 'nobody else is answered');

        // the connection ends: three more tries, all answered by a closed connection, then registered
        hanging.behaviour['system.listMethods'] = 'answer';
        hanging.dropAll();
        await init;
        assert.ok(hanging.methods().filter((method) => method === 'system.listMethods').length >= 2);
        assert.equal((await rfd('listDevices', [])).length, 6);
        assert.equal(Object.keys(sim.clients.rfd).length, 1);

        // a registered client that does not take a callback within deliveryTimeout is dropped
        hanging.behaviour.event = 'hang';
        hanging.behaviour['system.multicall'] = 'hang';
        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await waitFor(() => Object.keys(sim.clients.rfd).length === 0, {what: 'the client dropped'});
        const log = sim.getCallbackLog().filter((entry) => entry.method === 'event');
        assert.match(log.at(-1).error, /no answer within 200 ms/);

        rfd.close();
        hanging.close();
        sim.close();
    });
});

describe('fireEvents and the callback log', () => {
    it('sends a burst as system.multicall batches and logs every callback', async () => {
        const {sim} = await startSim();
        const client = await listener();
        await xmlrpcCall(sim.ports.rfd)('init', [client.url, 'burst']);
        await waitFor(() => client.methods().includes('newDevices'), {what: 'newDevices'});

        const events = [1, 2, 3, 4, 5].map((index) => [SWITCH, 'WORKING', index % 2 === 0]);
        assert.equal(sim.fireEvents('rfd', events, {batch: 2}), 5);
        await waitFor(() => client.methods().filter((method) => method === 'system.multicall').length === 3, {
            what: 'three batches',
        });
        assert.equal(sim.values.rfd[SWITCH].VALUES.WORKING, false);

        const log = sim.getCallbackLog().filter((entry) => entry.client === client.url);
        assert.deepEqual(
            log.map((entry) => entry.method),
            ['listDevices', 'newDevices', 'system.multicall', 'system.multicall', 'system.multicall'],
        );
        for (const entry of log) {
            assert.equal(entry.iface, 'rfd');
            assert.equal(entry.error, null);
            assert.ok(entry.answeredAt >= entry.sentAt);
        }
        client.close();
        sim.close();
    });
});
