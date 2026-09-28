'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const xmlrpc = require('homematic-xmlrpc');

const {startSim, binrpcCall, xmlrpcCall, waitFor, fixtures} = require('./helpers.js');

const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;
const KEY = 'ABC0000002:1';

/** One raw XML-RPC POST with the body as given, so that its encoding is under the test's control. */
function postRaw(port, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: '127.0.0.1',
                port,
                method: 'POST',
                path: '/',
                agent: false,
                headers: {'Content-Type': 'text/xml', 'Content-Length': body.length, ...headers},
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            },
        );
        request.on('error', reject);
        request.end(body);
    });
}

describe('the calls openccu-lite makes', () => {
    let sim;
    let rfd;
    let hmip;
    let wired;

    before(async () => {
        const devices = fixtures.devices();
        devices.wired = {devices: []};
        ({sim} = await startSim({devices, config: {wiredListenPort: 0, virtualListenPort: 0}}));
        rfd = binrpcCall(sim.ports.rfd);
        hmip = xmlrpcCall(sim.ports.hmip);
        wired = xmlrpcCall(sim.ports.wired);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    it('calls back a url with a path, as a callback server that serves several interfaces', async () => {
        const calls = [];
        const server = await new Promise((resolve) => {
            const created = xmlrpc.createServer({host: '127.0.0.1', port: 0, path: '/cb/BidCos-RF'}, () =>
                resolve(created),
            );
        });
        for (const method of ['listDevices', 'newDevices', 'system.multicall', 'event']) {
            server.on(method, (error, params, callback) => {
                calls.push(method);
                callback(null, method === 'listDevices' ? [] : '');
            });
        }
        server.on('NotFound', () => {});
        // homematic-xmlrpc answers every path; the test checks what the simulator asked for
        const paths = [];
        server.httpServer.prependListener('request', (request) => paths.push(request.url));
        const url = `http://127.0.0.1:${server.httpServer.address().port}/cb/BidCos-RF`;

        await xmlrpcCall(sim.ports.rfd)('init', [url, 'occulited_BidCos-RF']);
        await waitFor(() => calls.includes('newDevices'), {what: 'newDevices'});
        sim.fireEvent('rfd', SWITCH, 'WORKING', true);
        await waitFor(() => calls.includes('event'), {what: 'event'});
        assert.ok(paths.length >= 3);
        assert.ok(
            paths.every((path) => path === '/cb/BidCos-RF'),
            paths.join(' '),
        );

        await xmlrpcCall(sim.ports.rfd)('init', [url, '']);
        assert.equal(Object.keys(sim.clients.rfd).length, 0);
        server.close();
    });

    it('identifies a registration by its url exactly, scheme included', async () => {
        const server = await new Promise((resolve) => {
            const created = xmlrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(created));
        });
        server.on('listDevices', (error, params, callback) => callback(null, []));
        server.on('NotFound', () => {});
        const port = server.httpServer.address().port;

        await hmip('init', [`http://127.0.0.1:${port}`, 'exact']);
        await hmip('init', [`xmlrpc_bin://127.0.0.1:${port}`, '']);
        assert.deepEqual(Object.keys(sim.clients.hmip), [`http://127.0.0.1:${port}`]);
        await hmip('init', [`http://127.0.0.1:${port}`, '']);
        assert.deepEqual(Object.keys(sim.clients.hmip), []);
        server.close();
    });

    it('refuses an init url that is none', async () => {
        await assert.rejects(hmip('init', ['nonsense', 'x']), (error) => error.faultCode !== undefined);
    });

    it('reads a request declared ISO-8859-1 as such', async () => {
        // read back over XML-RPC: binrpc's client decodes BIN-RPC strings as UTF-8, the CCU sends ISO-8859-1
        const read = async () => (await xmlrpcCall(sim.ports.rfd)('getLinkInfo', [SWITCH, KEY])).NAME;
        await rfd('addLink', [SWITCH, KEY, 'link', '']);
        const body = Buffer.concat([
            Buffer.from(
                '<?xml version="1.0" encoding="ISO-8859-1"?><methodCall><methodName>setLinkInfo</methodName><params>' +
                    `<param><value>${SWITCH}</value></param><param><value>${KEY}</value></param><param><value>`,
                'latin1',
            ),
            Buffer.from('Küche', 'latin1'),
            Buffer.from('</value></param><param><value></value></param></params></methodCall>', 'latin1'),
        ]);
        await postRaw(sim.ports.rfd, body);
        assert.equal(await read(), 'Küche');

        // the same over the charset of the Content-Type header, and UTF-8 stays UTF-8
        const header = Buffer.from(body.toString('latin1').replace(' encoding="ISO-8859-1"', ''), 'latin1');
        await postRaw(sim.ports.rfd, header, {'Content-Type': 'text/xml; charset=iso-8859-1'});
        assert.equal(await read(), 'Küche');
        await xmlrpcCall(sim.ports.rfd)('setLinkInfo', [SWITCH, KEY, 'Grüße', '']);
        assert.equal(await read(), 'Grüße');
    });

    it('answers logLevel on the BidCos processes, an empty string on hmipserver', async () => {
        assert.equal(await rfd('logLevel', []), 5);
        assert.equal(await rfd('logLevel', [2]), 2);
        assert.equal(await xmlrpcCall(sim.ports.rfd)('logLevel', []), 2);
        assert.equal(await wired('logLevel', [4]), 4);
        assert.equal(await hmip('logLevel', []), '');
        assert.equal((await rfd('logLevel', ['loud'])).faultCode, sim.faults.invalidArguments.faultCode);
        await assert.rejects(xmlrpcCall(sim.ports.virtual, {path: '/groups'})('logLevel', []));
    });

    it('records changeKey on rfd and hmipserver, and has none on BidCos-Wired', async () => {
        assert.equal(await xmlrpcCall(sim.ports.rfd)('changeKey', ['secret']), '');
        assert.equal(await hmip('changeKey', ['other']), '');
        assert.deepEqual(
            sim.keyChanges.map(({iface, key}) => [iface, key]),
            [
                ['rfd', 'secret'],
                ['hmip', 'other'],
            ],
        );
        await assert.rejects(wired('changeKey', ['x']), {faultCode: sim.faults.unknownMethod.faultCode});
    });

    it('answers refreshDeployedDeviceFirmwareList on rfd and hmipserver', async () => {
        assert.equal(await rfd('refreshDeployedDeviceFirmwareList', []), '');
        assert.equal(await hmip('refreshDeployedDeviceFirmwareList', []), '');
        assert.deepEqual(
            sim.firmwareListRefreshes.map((entry) => entry.iface),
            ['rfd', 'hmip'],
        );
        await assert.rejects(wired('refreshDeployedDeviceFirmwareList', []), {
            faultCode: sim.faults.unknownMethod.faultCode,
        });
    });
});
