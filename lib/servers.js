'use strict';

const {EventEmitter} = require('node:events');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const {encodeResponse, encodeFault} = require('./binrpc-codec.js');

/**
 * binrpc server.
 *
 * The dispatch is taken over from binrpc's own event based handling so that faults can be answered
 * with message type 0xff. binrpc decodes the request for us, we encode the response.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {function} options.dispatch (method, params, callback) - callback(fault, result)
 * @param {function} [options.onListening]
 * @returns {object} the binrpc Server instance
 */
function createBinrpcServer({host, port, dispatch, onListening, onError}) {
    const server = binrpc.createServer({host, port}, () => {
        if (typeof onListening === 'function') {
            onListening(server);
        }
    });

    server.handleCall = (request, socket) => {
        const method = request && request.method;
        const params = (request && request.params) || [];
        if (typeof method !== 'string' || method === '') {
            socket.write(encodeResponse(''));
            return;
        }

        dispatch(method, params, (fault, result) => {
            socket.write(fault ? encodeFault(fault) : encodeResponse(result));
        });
    };

    server.on('error', (error) => {
        if (typeof onError === 'function') {
            onError(error);
        }
    });

    return server;
}

// events of the xmlrpc server that are not RPC method names
const INTERNAL_EVENTS = new Set(['NotFound', 'error', 'listening', 'newListener', 'removeListener']);

function unauthorized(response, realm) {
    response.writeHead(401, {
        'WWW-Authenticate': `Basic realm="${realm}"`,
        'Content-Type': 'text/plain',
        Connection: 'close',
    });
    response.end('Unauthorized');
}

/**
 * xmlrpc server, optionally with TLS and/or HTTP basic auth.
 *
 * homematic-xmlrpc dispatches per method name and answers method names without a listener with an
 * empty string. To be able to answer unknown methods with a fault - and to avoid having to register
 * a listener per method - `listenerCount` and `emit` are wrapped so that every method call reaches
 * the simulator's dispatch.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {function} options.dispatch (method, params, callback) - callback(fault, result)
 * @param {object} [options.tls] {key, cert} - enables https
 * @param {object} [options.auth] {username, password, realm}
 * @param {string} [options.path] if set, other paths are answered with 404
 * @param {function} [options.onListening]
 * @returns {object} the homematic-xmlrpc Server instance
 */
function createXmlrpcServer({host, port, dispatch, tls, auth, path, onListening, onError}) {
    const serverOptions = tls ? {host, port, ...tls} : {host, port};
    const listening = () => {
        if (typeof onListening === 'function') {
            onListening(server);
        }
    };
    const server = tls
        ? xmlrpc.createSecureServer(serverOptions, listening)
        : xmlrpc.createServer(serverOptions, listening);

    server.listenerCount = function (eventName) {
        return INTERNAL_EVENTS.has(eventName) ? EventEmitter.prototype.listenerCount.call(this, eventName) : 1;
    };

    const originalEmit = server.emit;
    server.emit = function (eventName, ...args) {
        if (!INTERNAL_EVENTS.has(eventName) && args.length === 3 && typeof args[2] === 'function') {
            const [, params, callback] = args;
            dispatch(eventName, params || [], (fault, result) => {
                if (fault) {
                    callback({faultCode: fault.faultCode, faultString: fault.faultString});
                } else {
                    callback(null, result === undefined ? '' : result);
                }
            });
            return true;
        }

        return originalEmit.call(this, eventName, ...args);
    };

    server.on('NotFound', () => {});
    server.on('error', (error) => {
        if (typeof onError === 'function') {
            onError(error);
        }
    });

    if (auth || path) {
        const httpServer = server.httpServer;
        const [handleMethodCall] = httpServer.listeners('request');
        httpServer.removeAllListeners('request');
        const expected = auth
            ? 'Basic ' + Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')
            : null;
        httpServer.on('request', (request, response) => {
            if (path) {
                const requestPath = (request.url || '/').split('?')[0].replace(/\/+$/, '');
                if (requestPath !== path.replace(/\/+$/, '') && requestPath !== '') {
                    response.writeHead(404, {'Content-Type': 'text/plain'});
                    response.end('Not Found');
                    return;
                }
            }

            if (expected && request.headers.authorization !== expected) {
                unauthorized(response, auth.realm || 'hm-simulator');
                return;
            }

            handleMethodCall(request, response);
        });
    }

    return server;
}

module.exports = {createBinrpcServer, createXmlrpcServer};
