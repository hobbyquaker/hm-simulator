'use strict';

const http = require('node:http');

/**
 * The scenario calls the control endpoint lets through. Everything a test does to a simulator it
 * does not run in its own process: devices, events, service messages, interface processes, and
 * reading back what the simulator saw.
 */
const SCENARIO_METHODS = new Set([
    'addDevice',
    'removeDevice',
    'fireEvent',
    'setValue',
    'setServiceMessage',
    'scriptNewDevices',
    'scriptKeyMismatch',
    'dropConnection',
    'stopInterface',
    'startInterface',
    'restartInterface',
    'fireEvents',
    'injectFault',
    'clearFaults',
    'getCallbackLog',
    'setReachable',
    'setLowBattery',
    'setDutyCycle',
    'setCarrierSense',
    'offerFirmware',
    'schedule',
    'getDevice',
    'getWriteLog',
    'getConfigPending',
    'getPoisonedChannels',
    'getMissingParamsetDescriptions',
    'getTempKey',
    'getInstallMode',
]);

function send(response, status, body) {
    const json = JSON.stringify(body === undefined ? null : body);
    response.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json)});
    response.end(json);
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

/**
 * The scenario API over HTTP, for a simulator that runs in a process of its own (the CLI's
 * `--control-port`). Loopback only.
 *
 * - `POST /scenario/<method>` with a JSON array of arguments, `GET /scenario/<method>` without;
 *   answers `{"result": …}`, a fault as 400 `{"error", "faultCode", "faultString"}`, an unknown
 *   method as 404.
 * - `GET /ports`: the ports the simulator listens on.
 *
 * `setValue` is the device reporting a value, as a behaviour script does (`sim.api`), not a client
 * writing one.
 *
 * @param {object} sim a HmSim
 * @param {object} options
 * @param {number} options.port
 * @param {function} [options.log] (…args) for errors
 * @returns {Promise<http.Server>} once listening
 */
function createControlServer(sim, {port, log = () => {}}) {
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/ports' && request.method === 'GET') {
            send(response, 200, sim.ports);
            return;
        }

        const match = /^\/scenario\/([A-Za-z]+)$/.exec(url.pathname);
        if (!match || !['GET', 'POST'].includes(request.method)) {
            send(response, 404, {error: 'not found'});
            return;
        }
        const method = match[1];
        if (!SCENARIO_METHODS.has(method) || typeof sim[method] !== 'function') {
            send(response, 404, {error: `unknown scenario call ${method}`});
            return;
        }

        let args = [];
        if (request.method === 'POST') {
            const body = await readBody(request);
            try {
                args = body.trim() === '' ? [] : JSON.parse(body);
            } catch (error) {
                send(response, 400, {error: `body is no JSON: ${error.message}`});
                return;
            }
            if (!Array.isArray(args)) {
                send(response, 400, {error: 'body must be a JSON array of arguments'});
                return;
            }
        }

        try {
            const result =
                method === 'setValue'
                    ? sim.setValue(args[0], args[1], args[2], args[3], {internal: true})
                    : await sim[method](...args);
            send(response, 200, {result});
        } catch (error) {
            if (error.faultCode !== undefined) {
                send(response, 400, {error: error.message, faultCode: error.faultCode, faultString: error.faultString});
                return;
            }
            log('control', method, error.stack || error.message);
            send(response, 500, {error: error.message});
        }
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', reject);
            resolve(server);
        });
    });
}

module.exports = {createControlServer, SCENARIO_METHODS};
