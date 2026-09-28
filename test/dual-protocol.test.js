'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;

/** One raw XML-RPC POST, so that status codes and a refused connection are visible. */
function post(port, {secure = false, headers = {}, method = 'listDevices'} = {}) {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params/></methodCall>`;
    return new Promise((resolve, reject) => {
        const request = (secure ? https : http).request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: '/',
                rejectUnauthorized: false,
                agent: false,
                headers: {'Content-Type': 'text/xml', 'Content-Length': body.length, ...headers},
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({status: response.statusCode, body: Buffer.concat(chunks).toString()}),
                );
            },
        );
        request.on('error', reject);
        request.end(body);
    });
}

/** A callback server of either protocol that records every call. */
async function callbackServer(protocol) {
    const calls = [];
    const server = await new Promise((resolve) => {
        const created =
            protocol === 'binrpc'
                ? binrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(created))
                : xmlrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(created));
    });
    for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'event', 'system.multicall']) {
        server.on(method, (error, params, callback) => {
            calls.push({method, params});
            callback(null, method === 'listDevices' ? [] : '');
        });
    }
    server.on('NotFound', () => {});
    const port = (server.server || server.httpServer).address().port;
    const url = protocol === 'binrpc' ? `xmlrpc_bin://127.0.0.1:${port}` : `http://127.0.0.1:${port}`;
    return {calls, url, close: () => server.close()};
}

describe('rfd and BidCos-Wired: BIN-RPC and XML-RPC on the same port', () => {
    let sim;
    let bin;
    let xml;
    let wiredBin;
    let wiredXml;

    before(async () => {
        const devices = fixtures.devices();
        devices.wired = {devices: []};
        const started = await startSim({devices, config: {wiredListenPort: 0}});
        sim = started.sim;
        bin = binrpcCall(started.ports.rfd);
        xml = xmlrpcCall(started.ports.rfd);
        wiredBin = binrpcCall(started.ports.wired);
        wiredXml = xmlrpcCall(started.ports.wired);
    });

    after(() => {
        bin.close();
        wiredBin.close();
        sim.close();
    });

    it('answers the read calls of the method table the same way over both', async () => {
        const calls = [
            ['system.listMethods', []],
            ['listDevices', []],
            ['getDeviceDescription', [fixtures.SWITCH_ADDRESS]],
            ['getParamsetDescription', [SWITCH, 'VALUES']],
            // not MASTER's description: BIN-RPC's double encoding rounds its ON_TIME MAX
            ['getParamset', [SWITCH, 'VALUES']],
            ['getParamset', [SWITCH, 'MASTER']],
            ['getValue', [SWITCH, 'STATE']],
            ['getLinks', []],
            ['getLinkPeers', [SWITCH]],
            ['listBidcosInterfaces', []],
            ['rssiInfo', []],
            ['getServiceMessages', []],
            ['getInstallMode', []],
            ['listTeams', []],
            ['system.methodHelp', ['getValue']],
        ];
        for (const [method, params] of calls) {
            assert.deepEqual(await xml(method, params), await bin(method, params), method);
        }
    });

    it('writes over XML-RPC and reads the value back over BIN-RPC', async () => {
        assert.equal(await xml('setValue', [SWITCH, 'STATE', true]), '');
        assert.equal(await bin('getValue', [SWITCH, 'STATE']), true);
        assert.equal(await xml('putParamset', [SWITCH, 'MASTER', {LOGGING: true}]), '');
        assert.equal((await bin('getParamset', [SWITCH, 'MASTER'])).LOGGING, true);
    });

    it('answers a fault as an XML-RPC fault and as a 0xff BIN-RPC message', async () => {
        await assert.rejects(xml('getValue', ['NOPE0000001:1', 'STATE']), {faultCode: -2});
        await assert.rejects(xml('noSuchMethod', []), (error) => error.faultCode !== undefined);
        // binrpcCall resolves with the fault struct
        assert.equal((await bin('getValue', ['NOPE0000001:1', 'STATE'])).faultCode, -2);
    });

    it('serves both on the BidCos-Wired port too', async () => {
        assert.deepEqual(await wiredXml('listDevices', []), []);
        assert.deepEqual(await wiredBin('listDevices', []), []);
    });

    it('sends BIN-RPC callbacks to a client that registered over XML-RPC', async () => {
        const callback = await callbackServer('binrpc');
        await xml('init', [callback.url, 'xml-to-bin']);
        await waitFor(() => callback.calls.some((call) => call.method === 'newDevices'), {what: 'newDevices'});
        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await waitFor(() => callback.calls.some((call) => call.method === 'event'), {what: 'event'});
        assert.deepEqual(callback.calls.find((call) => call.method === 'event').params, [
            'xml-to-bin',
            SWITCH,
            'WORKING',
            true,
        ]);
        await xml('init', [callback.url, '']);
        callback.close();
    });

    it('sends XML-RPC callbacks to a client that registered over BIN-RPC', async () => {
        const callback = await callbackServer('xmlrpc');
        await bin('init', [callback.url, 'bin-to-xml']);
        await waitFor(() => callback.calls.some((call) => call.method === 'newDevices'), {what: 'newDevices'});
        await bin('setValue', [SWITCH, 'STATE', false]);
        await waitFor(() => callback.calls.some((call) => call.method === 'system.multicall'), {what: 'multicall'});
        const events = callback.calls.find((call) => call.method === 'system.multicall').params[0];
        assert.ok(events.some((event) => event.params[1] === SWITCH && event.params[2] === 'STATE'));
        await bin('init', [callback.url, '']);
        callback.close();
    });

    it('keeps several requests on one XML-RPC connection apart from a BIN-RPC one', async () => {
        const results = await Promise.all([
            xml('getValue', [SWITCH, 'STATE']),
            bin('getValue', [SWITCH, 'STATE']),
            xml('getInstallMode', []),
            bin('getInstallMode', []),
        ]);
        assert.deepEqual(results, [false, false, 0, 0]);
    });

    it('comes back with both protocols after dropConnection', async () => {
        await sim.dropConnection('rfd');
        const again = binrpcCall(sim.ports.rfd);
        // a fresh connection: a keep-alive one of the client above was reset with the rest
        assert.equal((await post(sim.ports.rfd)).status, 200);
        assert.equal((await again('listDevices', [])).length, 6);
        again.close();
    });
});

describe('interfaces.<iface>.protocols', () => {
    it("['binrpc'] is the old BIN-RPC-only server", async () => {
        const {sim, ports} = await startSim({interfaces: {rfd: {protocols: ['binrpc']}}});
        const bin = binrpcCall(ports.rfd);
        assert.equal((await bin('listDevices', [])).length, 6);
        // binrpc reads the HTTP request as a message header and waits for the rest of it
        const answered = await new Promise((resolve) => {
            const socket = net.connect(ports.rfd, '127.0.0.1', () => {
                socket.write('POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\n\r\n');
            });
            socket.on('data', () => resolve(true));
            socket.on('error', () => resolve(false));
            setTimeout(() => {
                socket.destroy();
                resolve(false);
            }, 300);
        });
        assert.equal(answered, false);
        bin.close();
        sim.close();
    });

    it("['xmlrpc'] closes a BIN-RPC connection", async () => {
        const {sim, ports} = await startSim({interfaces: {rfd: {protocols: ['xmlrpc']}}});
        assert.equal((await post(ports.rfd)).status, 200);
        const closed = await new Promise((resolve) => {
            const socket = net.connect(ports.rfd, '127.0.0.1', () => {
                socket.write(
                    Buffer.from('Bin\u0000\u0000\u0000\u0000\u0008\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'),
                );
            });
            socket.on('close', () => resolve(true));
            socket.on('error', () => {});
        });
        assert.equal(closed, true);
        sim.close();
    });
});

describe('TLS and basic auth on the XML-RPC half', () => {
    let sim;
    let port;
    const authorization = 'Basic ' + Buffer.from('Admin:secret').toString('base64');

    before(async () => {
        const started = await startSim({tls: true, auth: {username: 'Admin', password: 'secret'}});
        sim = started.sim;
        port = started.ports.rfd;
    });

    after(() => sim.close());

    it('serves XML-RPC over TLS with the credentials', async () => {
        const {status, body} = await post(port, {secure: true, headers: {Authorization: authorization}});
        assert.equal(status, 200);
        assert.match(body, /methodResponse/);
    });

    it('answers 401 without them', async () => {
        assert.equal((await post(port, {secure: true})).status, 401);
    });

    it('does not answer plain HTTP', async () => {
        await assert.rejects(post(port, {headers: {Authorization: authorization}}));
    });

    it('keeps BIN-RPC plain and without auth, as on a CCU', async () => {
        const bin = binrpcCall(port);
        assert.equal((await bin('listDevices', [])).length, 6);
        bin.close();
    });
});
