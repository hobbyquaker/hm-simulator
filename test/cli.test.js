'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const binrpc = require('binrpc');

const {binrpcCall, xmlrpcCall, waitFor, emptyBehaviorPath} = require('./helpers.js');

const CLI = path.join(__dirname, '..', 'index.js');
const FIXTURE = path.join(__dirname, '..', 'data', 'fixtures', 'devices.json');
/** every child a test started, killed at the end whatever the tests did */
const children = new Set();
after(() => {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
        }
    }
});

const BASE = ['--binrpc-port', '0', '--xmlrpc-port', '0', '--rega-port', '0', '--no-behaviors', '-v', 'warn'];

/**
 * Starts the CLI and resolves with the ports it printed.
 * @returns {Promise<{child, ports, stderr: function(): string}>}
 */
function startCli(extra = []) {
    const child = spawn(process.execPath, [CLI, ...BASE, '--ports-json', '-', ...extra], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    return new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            const newline = stdout.indexOf('\n');
            if (newline !== -1) {
                resolve({child, ports: JSON.parse(stdout.slice(0, newline)), stderr: () => stderr});
            }
        });
        child.on('exit', (code) => reject(new Error(`exited with ${code}: ${stderr}`)));
    });
}

/** Runs the CLI to its end. */
function runCli(argv) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, ...argv], {stdio: ['ignore', 'pipe', 'pipe']});
        children.add(child);
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('exit', (code, signal) => resolve({code, signal, stdout, stderr}));
    });
}

function stop(child) {
    return new Promise((resolve) => {
        child.on('exit', (code) => resolve(code));
        child.kill('SIGTERM');
    });
}

function control(port, method, args) {
    const body = args === undefined ? '' : JSON.stringify(args);
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: '127.0.0.1',
                port,
                method: args === undefined ? 'GET' : 'POST',
                path: `/scenario/${method}`,
                headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)},
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () =>
                    resolve({status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString())}),
                );
            },
        );
        request.on('error', reject);
        request.end(body);
    });
}

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simulator-cli-'));

describe('command line: ports, control, signals', () => {
    let cli;
    let callbackServer;
    const calls = [];

    before(async () => {
        cli = await startCli(['--control-port', '0']);
        callbackServer = await new Promise((resolve) => {
            const server = binrpc.createServer({host: '127.0.0.1', port: 0}, () => resolve(server));
        });
        for (const method of ['listDevices', 'newDevices', 'deleteDevices', 'event', 'system.multicall']) {
            callbackServer.on(method, (error, params, callback) => {
                calls.push({method, params});
                callback(null, method === 'listDevices' ? [] : '');
            });
        }
        callbackServer.on('NotFound', () => {});
    });

    after(async () => {
        callbackServer.close();
        if (cli.child.exitCode === null) {
            await stop(cli.child);
        }
    });

    it('prints the ports it got as one JSON line', () => {
        for (const name of ['rfd', 'hmip', 'rega', 'control']) {
            assert.equal(typeof cli.ports[name], 'number', name);
            assert.ok(cli.ports[name] > 0, name);
        }
        // the log went to stderr
        assert.doesNotThrow(() => JSON.stringify(cli.ports));
    });

    it('serves the bundled devices on the reported ports, rfd in both protocols', async () => {
        const rfd = binrpcCall(cli.ports.rfd);
        const rfdDevices = await rfd('listDevices', []);
        assert.ok(rfdDevices.some((device) => device.ADDRESS === 'BidCoS-RF'));
        assert.deepEqual(await xmlrpcCall(cli.ports.rfd)('listDevices', []), rfdDevices);
        assert.ok((await xmlrpcCall(cli.ports.hmip)('listDevices', [])).length > 0);
        // the bundled virtual remote has a description since task 3's fallback
        assert.equal(await rfd('setValue', ['BidCoS-RF:1', 'PRESS_SHORT', true]), '');
        rfd.close();
    });

    it('drives fireEvent through the control port', async () => {
        const rfd = binrpcCall(cli.ports.rfd);
        await rfd('init', [`xmlrpc_bin://127.0.0.1:${callbackServer.server.address().port}`, 'cli']);
        await waitFor(() => calls.some((call) => call.method === 'newDevices'), {what: 'newDevices'});

        const answer = await control(cli.ports.control, 'fireEvent', ['rfd', 'BidCoS-RF:2', 'PRESS_LONG', true]);
        assert.deepEqual(answer, {status: 200, body: {result: true}});
        await waitFor(() => calls.some((call) => call.method === 'event'), {what: 'event'});
        assert.deepEqual(calls.find((call) => call.method === 'event').params, [
            'cli',
            'BidCoS-RF:2',
            'PRESS_LONG',
            true,
        ]);
        rfd.close();
    });

    it('answers getters, faults and unknown calls', async () => {
        const writeLog = await control(cli.ports.control, 'getWriteLog');
        assert.equal(writeLog.status, 200);
        assert.ok(Array.isArray(writeLog.body.result));

        const fault = await control(cli.ports.control, 'removeDevice', ['rfd', 'NOPE0000001']);
        assert.equal(fault.status, 400);
        assert.equal(fault.body.faultCode, -2);

        assert.equal((await control(cli.ports.control, 'close', [])).status, 404);
        assert.equal((await control(cli.ports.control, 'fireEvent', {not: 'an array'})).status, 400);
    });

    it('awaits an asynchronous call (dropConnection)', async () => {
        assert.equal((await control(cli.ports.control, 'dropConnection', ['rfd'])).status, 200);
        const rfd = binrpcCall(cli.ports.rfd);
        assert.ok((await rfd('listDevices', [])).length > 0);
        rfd.close();
    });

    it('exits 0 on SIGTERM', async () => {
        assert.equal(await stop(cli.child), 0);
    });
});

describe('command line: devices, config, TLS, auth', () => {
    it('loads a device file with its descriptions', async () => {
        const cli = await startCli(['--devices', FIXTURE, '--no-rega']);
        const devices = await xmlrpcCall(cli.ports.hmip)('listDevices', []);
        const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        assert.equal(devices.length, fixture.devices.hmip.devices.length);
        assert.equal(cli.ports.rega, undefined);
        await stop(cli.child);
    });

    it('loads a dumped fixture with its links and radio modules', async () => {
        const file = path.join(__dirname, '..', 'data', 'fixtures', 'lab-2026-09.json');
        const lab = JSON.parse(fs.readFileSync(file, 'utf8'));
        const cli = await startCli(['--devices', file, '--wired-port', '0', '--no-rega']);
        const hmip = xmlrpcCall(cli.ports.hmip);
        assert.equal((await hmip('getLinks', [])).length, lab.links.hmip.length);
        assert.deepEqual(await hmip('listBidcosInterfaces', []), lab.bidcosInterfaces.hmip);
        const wired = binrpcCall(cli.ports.wired);
        assert.equal((await wired('listDevices', [])).length, lab.devices.wired.devices.length);
        wired.close();
        await stop(cli.child);
    });

    it('takes the constructor options from a config file, paths relative to it, flags on top', async () => {
        const config = path.join(temporary, 'sim.json');
        fs.writeFileSync(
            config,
            JSON.stringify({
                devices: path.relative(temporary, FIXTURE),
                behaviorPath: emptyBehaviorPath,
                config: {binrpcListenPort: 1},
                interfaces: {rfd: {serviceMessagesEmptyAsString: true}},
            }),
        );
        // --binrpc-port 0 of BASE overrides the config's port 1
        const cli = await startCli(['--config', config, '--wired-port', '0']);
        const rfd = binrpcCall(cli.ports.rfd);
        assert.equal(await rfd('getServiceMessages', []), '');
        assert.ok((await rfd('listDevices', [])).some((device) => device.TYPE === 'HM-LC-Sw1-Pl'));
        assert.equal(typeof cli.ports.wired, 'number');
        rfd.close();
        await stop(cli.child);
    });

    it('serves TLS with the certificate it wrote, and basic auth', async () => {
        const certFile = path.join(temporary, 'cert.pem');
        const cli = await startCli(['--tls', '--tls-cert-out', certFile, '--auth', 'Admin:se:cret']);
        const ca = fs.readFileSync(certFile, 'utf8');
        assert.match(ca, /BEGIN CERTIFICATE/);

        const body = '<?xml version="1.0"?><methodCall><methodName>listDevices</methodName><params/></methodCall>';
        const status = (headers) =>
            new Promise((resolve, reject) => {
                const request = https.request(
                    {
                        host: '127.0.0.1',
                        port: cli.ports.hmip,
                        method: 'POST',
                        path: '/',
                        ca,
                        checkServerIdentity: () => undefined,
                        headers: {'Content-Type': 'text/xml', 'Content-Length': body.length, ...headers},
                    },
                    (response) => {
                        response.resume();
                        resolve(response.statusCode);
                    },
                );
                request.on('error', reject);
                request.end(body);
            });
        assert.equal(await status({Authorization: 'Basic ' + Buffer.from('Admin:se:cret').toString('base64')}), 200);
        assert.equal(await status({}), 401);
        await stop(cli.child);
    });

    it('writes the ports to a file', async () => {
        const file = path.join(temporary, 'ports.json');
        const child = spawn(process.execPath, [CLI, ...BASE, '--ports-json', file], {stdio: 'ignore'});
        children.add(child);
        await waitFor(() => fs.existsSync(file), {what: 'ports file'});
        const ports = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(typeof ports.rfd, 'number');
        await stop(child);
    });
});

describe('command line: errors', () => {
    it('exits non-zero with the port when it is taken', async () => {
        const blocker = net.createServer();
        await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const taken = blocker.address().port;
        const result = await runCli([...BASE, '--xmlrpc-port', String(taken)]);
        blocker.close();
        assert.equal(result.code, 1);
        assert.match(result.stderr, new RegExp(String(taken)));
    });

    it('refuses a port that is no number', async () => {
        const result = await runCli(['--binrpc-port', 'abc']);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /--binrpc-port wants a port number/);
    });

    it('lists every flag in --help', async () => {
        const result = await runCli(['--help']);
        assert.equal(result.code, 0);
        for (const flag of [
            '--ports-json',
            '--config',
            '--devices',
            '--tls',
            '--auth',
            '--control-port',
            '--wired-port',
        ]) {
            assert.match(result.stdout, new RegExp(flag));
        }
    });
});
