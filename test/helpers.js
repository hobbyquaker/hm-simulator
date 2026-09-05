'use strict';

const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const HmSim = require('../sim.js');
const fixtures = require('./fixtures.js');

/** A directory without behaviour scripts - the tests fire their own events. */
const emptyBehaviorPath = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simulator-behaviors-'));

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            server.close(() => resolve(port));
        });
    });
}

/**
 * Starts a simulator with the small test fixture on free ports.
 * @param {object} [options] merged into the constructor options
 * @returns {Promise<object>} {sim, binrpcPort, xmlrpcPort, ports}
 */
async function startSim(options = {}) {
    // port 0: the tests run in parallel, so the ports have to come from the OS
    const sim = new HmSim({
        devices: fixtures.devices(),
        paramsetDescriptions: fixtures.paramsetDescriptions,
        behaviorPath: emptyBehaviorPath,
        ...options,
        config: {
            listenAddress: '127.0.0.1',
            binrpcListenPort: 0,
            xmlrpcListenPort: 0,
            ...options.config,
        },
    });

    await sim.whenReady();

    return {sim, binrpcPort: sim.ports.rfd, xmlrpcPort: sim.ports.hmip, ports: sim.ports};
}

function promisify(client) {
    return (method, params = []) =>
        new Promise((resolve, reject) => {
            client.methodCall(method, params, (error, result) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(result);
                }
            });
        });
}

/** binrpc client that resolves with whatever the simulator answered, faults included. */
function binrpcCall(port) {
    const client = binrpc.createClient({host: '127.0.0.1', port, reconnectTimeout: 0});
    const call = promisify(client);
    call.close = () => {
        client.reconnectTimeout = 0;
        if (client.socket) {
            client.socket.destroy();
        }
    };
    return call;
}

/** xmlrpc client; faults arrive as the rejection reason. */
function xmlrpcCall(port, options = {}) {
    const client = xmlrpc.createClient({host: '127.0.0.1', port, path: '/', ...options});
    const call = promisify(client);
    call.close = () => {};
    return call;
}

function waitFor(predicate, {timeout = 5000, what = 'condition'} = {}) {
    return new Promise((resolve, reject) => {
        const until = Date.now() + timeout;
        const check = () => {
            const hit = predicate();
            if (hit) {
                resolve(hit);
            } else if (Date.now() > until) {
                reject(new Error('timeout waiting for ' + what));
            } else {
                setTimeout(check, 20);
            }
        };
        check();
    });
}

module.exports = {emptyBehaviorPath, freePort, startSim, binrpcCall, xmlrpcCall, waitFor, fixtures};
