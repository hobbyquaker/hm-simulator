'use strict';

const {EventEmitter} = require('node:events');
const net = require('node:net');
const {Duplex} = require('node:stream');

const binrpc = require('binrpc');
const binrpcProtocol = require('binrpc/lib/protocol.js');
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
function createXmlrpcServer({host, port, dispatch, tls, auth, path, onListening, onError, listen = true}) {
    const serverOptions = tls ? {host, port, ...tls} : {host, port};
    const listening = () => {
        if (typeof onListening === 'function') {
            onListening(server);
        }
    };
    const server = tls
        ? xmlrpc.createSecureServer(serverOptions, listening)
        : xmlrpc.createServer(serverOptions, listening);

    if (!listen) {
        // the connections come from createDualServer, see there; homematic-xmlrpc listens on the
        // next tick, so this is in time
        server.httpServer.listen = function () {
            return this;
        };
    }

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

/**
 * Reads BIN-RPC requests from one connection and answers them, as binrpc's server does, but with
 * the simulator's own encoder so that a fault goes out as message type 0xff.
 *
 * @param {net.Socket} socket
 * @param {function} dispatch (method, params, callback) - callback(fault, result)
 * @param {Buffer} [first] bytes already read from the socket
 */
function serveBinrpc(socket, dispatch, first) {
    let receiver = Buffer.alloc(0);

    const receive = (data) => {
        receiver = Buffer.concat([receiver, data]);
        while (receiver.length >= 8) {
            const length = receiver.readUInt32BE(4);
            if (receiver.length < length + 8) {
                return;
            }
            const message = receiver.subarray(0, length + 8);
            receiver = receiver.subarray(length + 8);

            let request;
            try {
                request = binrpcProtocol.decodeRequest(message);
            } catch {
                request = undefined;
            }
            const method = request && request.method;
            if (typeof method !== 'string' || method === '') {
                socket.write(encodeResponse(''));
                continue;
            }
            dispatch(method, request.params || [], (fault, result) => {
                if (!socket.destroyed) {
                    socket.write(fault ? encodeFault(fault) : encodeResponse(result));
                }
            });
        }
    };

    socket.on('data', receive);
    if (first) {
        receive(first);
    }
}

/**
 * A duplex stream over a socket that first yields `head`, the bytes already read from it.
 * @param {net.Socket} socket
 * @param {Buffer} head
 * @returns {Duplex}
 */
function replay(socket, head) {
    const stream = new Duplex({
        read() {
            socket.resume();
        },
        write(chunk, encoding, callback) {
            socket.write(chunk, encoding, callback);
        },
        final(callback) {
            socket.end();
            callback();
        },
        destroy(error, callback) {
            socket.destroy();
            callback(error);
        },
    });
    stream.push(head);
    socket.on('data', (data) => {
        if (!stream.push(data)) {
            socket.pause();
        }
    });
    socket.on('end', () => stream.push(null));
    socket.on('close', () => stream.destroy());
    return stream;
}

/** First bytes of a BIN-RPC message, and of a TLS handshake record. */
const BIN = Buffer.from('Bin', 'ascii');
const TLS_HANDSHAKE = 0x16;

/**
 * rfd's and hs485d's port: BIN-RPC and XML-RPC on the same port, as on a CCU.
 *
 * A connection whose first bytes are `Bin` is BIN-RPC; anything else is handed to an HTTP server
 * running the XML-RPC dispatch - with `tls` an HTTPS server, and a connection that does not start
 * with a TLS handshake is closed. BIN-RPC stays plain, and basic auth applies to the XML-RPC half
 * only: BIN-RPC has no such thing.
 *
 * @param {object} options as createXmlrpcServer, plus
 * @param {string[]} [options.protocols=['binrpc', 'xmlrpc']] what this port answers
 * @returns {{server: net.Server, close: function(): Promise<void>, on: function}} an emitter with
 *          `server` (the net server) and `close()`, like the other two server kinds
 */
function createDualServer({host, port, dispatch, tls, auth, onListening, onError, protocols}) {
    const accepts = new Set(protocols || ['binrpc', 'xmlrpc']);
    const emitter = new EventEmitter();
    const connections = new Set();

    const xmlrpcServer = (secure) =>
        createXmlrpcServer({host, port: 0, dispatch, tls: secure ? tls : null, auth, listen: false});
    // with tls the XML-RPC half is HTTPS only, as the simulator's xmlrpc servers are
    const http = accepts.has('xmlrpc') && !tls ? xmlrpcServer(false) : null;
    const https = accepts.has('xmlrpc') && tls ? xmlrpcServer(true) : null;

    const server = net.createServer((socket) => {
        connections.add(socket);
        socket.on('close', () => connections.delete(socket));
        socket.on('error', () => {});

        let head = Buffer.alloc(0);
        const sniff = (data) => {
            head = Buffer.concat([head, data]);
            if (head.length < BIN.length && BIN.subarray(0, head.length).equals(head)) {
                // could still be "Bin": wait for more
                return;
            }
            socket.removeListener('data', sniff);

            if (head.subarray(0, BIN.length).equals(BIN)) {
                if (accepts.has('binrpc')) {
                    serveBinrpc(socket, dispatch, head);
                } else {
                    socket.destroy();
                }
                return;
            }

            if (head[0] === TLS_HANDSHAKE && https) {
                // a TLS socket reads from the connection's handle, past anything unshifted: it
                // gets a stream that starts with the bytes already read
                https.httpServer.emit('connection', replay(socket, head));
                return;
            }
            if (!http) {
                socket.destroy();
                return;
            }
            socket.pause();
            socket.unshift(head);
            http.httpServer.emit('connection', socket);
            socket.resume();
        };
        socket.on('data', sniff);
    });

    server.on('error', (error) => {
        if (emitter.listenerCount('error') > 0) {
            emitter.emit('error', error);
        }
        if (typeof onError === 'function') {
            onError(error);
        }
    });

    server.listen(port, host, () => {
        emitter.emit('listening');
        if (typeof onListening === 'function') {
            onListening(emitter);
        }
    });

    emitter.server = server;
    emitter.close = () =>
        new Promise((resolve) => {
            server.close(() => resolve());
            for (const socket of connections) {
                socket.destroy();
            }
        });
    return emitter;
}

module.exports = {createBinrpcServer, createXmlrpcServer, createDualServer};
