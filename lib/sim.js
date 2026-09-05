'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const {createFaults} = require('./faults.js');
const {createBinrpcServer, createXmlrpcServer} = require('./servers.js');
const RegaSim = require('./rega.js');

const NOOP_LOG = {
    debug() {},
    info() {},
    warn() {},
    error() {},
};

/** interface key -> the name used in the keys of data/paramset-descriptions.json */
const PARAMSET_PREFIX = {
    rfd: 'BidCos-RF',
    wired: 'BidCos-Wired',
    hmip: 'HmIP-RF',
    virtual: 'VirtualDevices',
    cuxd: 'CUxD',
};

function shortenParams(params) {
    if (!params) {
        return;
    }

    const string = JSON.stringify(params);
    return string.length > 77 ? string.slice(0, 77) + '...' : string;
}

/**
 * Simulates the RPC interface processes and the ReGa of a Homematic CCU.
 *
 * @param {object} [options]
 * @param {object} [options.log] object with debug/info/warn/error methods
 * @param {object} [options.devices] {<iface>: {devices: []}} - device descriptions per interface
 * @param {object} [options.config] listenAddress, binrpcListenPort, xmlrpcListenPort
 * @param {string} [options.behaviorPath] directory with behaviour scripts
 * @param {object} [options.rega] ReGa mock options, see lib/rega.js - omit to not start it
 * @param {object} [options.paramsetDescriptions] replaces the bundled descriptions
 * @param {object} [options.faults] overrides for the fault table, see lib/faults.js
 */
class HmSim {
    constructor(options = {}) {
        const log = options.log || NOOP_LOG;
        this.log = log;
        this.options = options;

        const config = options.config || {};
        this.config = config;

        this.devices = options.devices || {rfd: {devices: []}, hmip: {devices: []}};
        this.paramsetDescriptions = options.paramsetDescriptions || require('../data/paramset-descriptions.json');

        const {table, fault} = createFaults(options.faults);
        this.faults = table;
        this.fault = fault;

        /** connected logic layers per interface: {<iface>: {<host:port>: client}} */
        this.clients = {};
        /** datapoint state per interface: {<iface>: {<address>: {VALUES: {}}}} */
        this.values = {sysvars: {}, programs: {}};
        /** device index per interface: {<iface>: Map<address, description>} */
        this.index = {};

        this.rpcMethods = this.buildRpcMethods();

        this.servers = {};
        this.ifaces = [];
        /** promises that resolve once each server is accepting connections, see whenReady() */
        this.ready = [];

        for (const iface of Object.keys(this.devices)) {
            this.initInterface(iface);
        }

        this.startServers();

        this.api = new EventEmitter();
        this.api.on('setValue', (iface, address, datapoint, value) => this.setValue(iface, address, datapoint, value));

        this.loadBehaviors(options.behaviorPath || path.join(__dirname, '..', 'behaviors'));

        if (options.rega) {
            this.regaSim = new RegaSim(options.rega, this.log);
            this.ready.push(this.regaSim.ready);
        }
    }

    /* ------------------------------------------------------------------ state */

    initInterface(iface) {
        if (!this.devices[iface]) {
            this.devices[iface] = {devices: []};
        }
        if (!Array.isArray(this.devices[iface].devices)) {
            this.devices[iface].devices = [];
        }

        this.clients[iface] = this.clients[iface] || {};
        this.values[iface] = this.values[iface] || {};
        this.reindex(iface);
        this.setDefaultValues(iface);
        if (!this.ifaces.includes(iface)) {
            this.ifaces.push(iface);
        }
    }

    reindex(iface) {
        const index = new Map();
        for (const device of this.devices[iface].devices) {
            index.set(device.ADDRESS, device);
        }
        this.index[iface] = index;
    }

    setDefaultValues(iface) {
        for (const device of this.devices[iface].devices) {
            if (!device.PARENT_TYPE || !device.PARAMSETS || !device.PARAMSETS.includes('VALUES')) {
                continue;
            }

            const description = this.getParamsetDescription(iface, device, 'VALUES');
            if (!description) {
                continue;
            }

            if (!this.values[iface][device.ADDRESS]) {
                this.values[iface][device.ADDRESS] = {VALUES: {}};
            }

            for (const [name, parameter] of Object.entries(description)) {
                if (this.values[iface][device.ADDRESS].VALUES[name] !== undefined) {
                    continue;
                }
                this.values[iface][device.ADDRESS].VALUES[name] =
                    parameter.TYPE === 'ENUM' && Array.isArray(parameter.VALUE_LIST)
                        ? parameter.VALUE_LIST.indexOf(parameter.DEFAULT)
                        : parameter.DEFAULT;
            }
        }
    }

    getDevice(iface, address) {
        const device = this.index[iface] && this.index[iface].get(address);
        if (!device) {
            this.log.error(iface, 'unknown device', address);
            return false;
        }
        return device;
    }

    /**
     * Builds the key of the paramset description cache:
     * `<interface>/<deviceType>/<firmware>/<version>/<channelType>/<paramset>`
     */
    paramsetName(iface, device, paramset) {
        if (!device) {
            return;
        }

        let channelType = '';
        let parent = device;
        if (device.PARENT) {
            channelType = device.TYPE;
            parent = this.index[iface] ? this.index[iface].get(device.PARENT) : undefined;
            if (!parent) {
                return;
            }
        }

        const prefix = PARAMSET_PREFIX[iface] || iface;
        return [prefix, parent.TYPE, parent.FIRMWARE, parent.VERSION, channelType, paramset].join('/');
    }

    getParamsetDescription(iface, device, paramset) {
        if (typeof device === 'string') {
            device = this.index[iface] ? this.index[iface].get(device) : undefined;
        }

        const name = this.paramsetName(iface, device, paramset);
        return name === undefined ? undefined : this.paramsetDescriptions[name];
    }

    /* ------------------------------------------------------------------ rpc */

    buildRpcMethods() {
        const methods = {
            'system.listMethods': (iface) => this.methodNames(iface),
            'system.multicall': (iface, params) => this.multicall(iface, params),
            init: (iface, params) => this.init(iface, params),
            listDevices: (iface) => this.devices[iface].devices,
            getParamsetDescription: (iface, params) => this.getParamsetDescription(iface, params[0], params[1]),
            ping: (iface, params) => this.ping(iface, params),
            setValue: (iface, params) => {
                this.setValue(iface, params[0], params[1], params[2]);
                return '';
            },
        };

        // the CCU accepts the lower case spelling as well
        methods['system.listmethods'] = methods['system.listMethods'];

        return methods;
    }

    methodNames() {
        return Object.keys(this.rpcMethods);
    }

    multicall(iface, params) {
        const calls = (params && params[0]) || [];
        const results = [];
        for (const call of calls) {
            try {
                results.push([this.callMethod(iface, call.methodName, call.params || [])]);
            } catch (error) {
                results.push({faultCode: error.faultCode, faultString: error.faultString});
            }
        }
        return results;
    }

    callMethod(iface, method, params) {
        const handler = this.rpcMethods[method];
        if (!handler) {
            this.log.error('rpc', iface, '< unknown method', method, shortenParams(params));
            throw this.fault('unknownMethod', method);
        }
        const result = handler(iface, params || []);
        return result === undefined ? '' : result;
    }

    /**
     * @param {string} iface
     * @param {string} method
     * @param {Array} params
     * @param {function} callback (fault, result)
     */
    dispatch(iface, method, params, callback) {
        this.log.debug('rpc', iface, '<', method, shortenParams(params));
        let result;
        try {
            result = this.callMethod(iface, method, params);
        } catch (error) {
            if (error.faultCode === undefined) {
                this.log.error('rpc', iface, method, error.stack || error.message);
                callback(this.fault('invalidArguments', error.message));
                return;
            }
            callback(error);
            return;
        }
        callback(null, result);
    }

    init(iface, params) {
        const [url, id] = params;
        let [protocol, host, port] = String(url).split(':');
        host = host.replace(/^\/\//, '');
        if (protocol === 'xmlrpc_bin') {
            protocol = 'binrpc';
        }

        const clientId = [host, port].join(':');

        if (id === '' || id === undefined) {
            const client = this.clients[iface][clientId];
            if (client) {
                this.log.debug('remove', iface, client.url);
                closeClient(client.client);
                delete this.clients[iface][clientId];
            }
        } else {
            const transport = protocol === 'binrpc' ? binrpc : xmlrpc;
            const client = {
                id,
                url,
                client: transport.createClient({host, port}),
                methodCall: (methodName, methodParams, callback) => {
                    this.log.debug('rpc >', url, methodName, shortenParams(methodParams));
                    client.client.methodCall(methodName, methodParams, (error, result) => {
                        this.log.debug('rpc <', url, shortenParams(result));
                        if (typeof callback === 'function') {
                            callback(error, result);
                        }
                    });
                },
            };
            this.clients[iface][clientId] = client;
            this.startInit(iface, client);
        }

        return '';
    }

    ping(iface, params) {
        if (iface === 'hmip') {
            // hmipserver does not answer ping with a PONG event, see
            // https://github.com/eq-3/occu/issues/42
            return '';
        }

        this.event(iface, ['CENTRAL', 'PONG', params[0]]);
        return '';
    }

    /* ------------------------------------------------------------------ events */

    /**
     * Sends one `event` call to every connected logic layer.
     * @param {string} iface
     * @param {Array} params [address, datapoint, value] - the interface id is prepended per client
     */
    event(iface, params) {
        for (const key of Object.keys(this.clients[iface] || {})) {
            const client = this.clients[iface][key];
            client.methodCall('event', [client.id, ...params]);
        }
    }

    eventMulticall(iface, events) {
        for (const key of Object.keys(this.clients[iface] || {})) {
            const client = this.clients[iface][key];
            const multicall = events.map((singleEvent) => ({
                methodName: 'event',
                params: [client.id, singleEvent[0], singleEvent[1], singleEvent[2]],
            }));
            client.methodCall('system.multicall', [multicall]);
        }
    }

    startInit(iface, client) {
        client.methodCall('listDevices', [client.id], (error, clientDevices) => {
            if (error) {
                this.log.error(error.toString());
            } else {
                this.checkDevices(iface, client, clientDevices);
            }
        });
    }

    checkDevices(iface, client, clientDevices) {
        clientDevices = clientDevices || [];
        this.log.info(iface, 'client', client.url, 'knows', clientDevices.length, 'devices');

        const clientDeviceAddresses = clientDevices.map((device) => device.ADDRESS);
        const deviceAddresses = this.devices[iface].devices.map((device) => device.ADDRESS);
        const newDevices = [];
        const deleteDevices = [];

        for (const device of this.devices[iface].devices) {
            const clientDeviceIndex = clientDeviceAddresses.indexOf(device.ADDRESS);
            if (clientDeviceIndex === -1) {
                this.log.debug('device unknown by client', device.ADDRESS);
                newDevices.push(device);
            } else if (iface === 'hmip') {
                // the CCU sends every HmIP device again on every init, see
                // https://github.com/eq-3/occu/issues/45
                deleteDevices.push(device.ADDRESS);
                newDevices.push(device);
            } else if (clientDevices[clientDeviceIndex].VERSION !== device.VERSION) {
                this.log.debug('device mismatch', device.ADDRESS);
                deleteDevices.push(device.ADDRESS);
                newDevices.push(device);
            }
        }

        for (const clientDevice of clientDevices) {
            if (!deviceAddresses.includes(clientDevice.ADDRESS)) {
                this.log.debug('device unknown', clientDevice.ADDRESS);
                deleteDevices.push(clientDevice.ADDRESS);
            }
        }

        const addNew = () => {
            if (newDevices.length > 0) {
                this.log.info(iface, 'client', client.url, 'should add', newDevices.length, 'devices');
                client.methodCall('newDevices', [client.id, newDevices]);
            }
        };

        if (deleteDevices.length > 0) {
            this.log.info(iface, 'client', client.url, 'should delete', deleteDevices.length, 'devices');
            client.methodCall('deleteDevices', [client.id, deleteDevices], addNew);
        } else if (newDevices.length > 0) {
            addNew();
        } else {
            this.log.info(iface, 'client', client.url, 'all devices known');
        }
    }

    /* ------------------------------------------------------------------ values */

    setValue(iface, address, datapoint, value) {
        this.log.debug('setValue', iface, address, datapoint, value);
        const device = this.getDevice(iface, address);
        if (!device) {
            return;
        }

        const description = this.getParamsetDescription(iface, address, 'VALUES');
        const parameter = description && description[datapoint];
        if (!parameter) {
            this.log.error('unknown params', address, datapoint);
            return;
        }

        switch (parameter.TYPE) {
            case 'ACTION':
            case 'BOOL':
                if (typeof value !== 'boolean') {
                    this.log.error('type mismatch', address, datapoint, parameter.TYPE);
                    return;
                }
                break;
            case 'INTEGER':
            case 'FLOAT':
                if (typeof value !== 'number') {
                    this.log.error('type mismatch', address, datapoint, parameter.TYPE);
                    return;
                }
                if (value < parameter.MIN || value > parameter.MAX) {
                    this.log.error('range error', address, datapoint, parameter.MIN, parameter.MAX);
                    return;
                }
                break;
            default:
        }

        if (!this.values[iface][address]) {
            this.values[iface][address] = {VALUES: {}};
        }
        this.values[iface][address].VALUES[datapoint] = value;

        if (parameter.OPERATIONS & 4) {
            const events =
                parameter.TYPE === 'ACTION'
                    ? [[address, datapoint, value]]
                    : Object.keys(this.values[iface][address].VALUES).map((name) => [
                          address,
                          name,
                          this.values[iface][address].VALUES[name],
                      ]);
            this.eventMulticall(iface, events);
        }
    }

    /* ------------------------------------------------------------------ servers */

    startServers() {
        const {listenAddress, binrpcListenPort, xmlrpcListenPort} = this.config;

        if (this.devices.rfd) {
            this.rfdServer = createBinrpcServer({
                host: listenAddress,
                port: binrpcListenPort,
                dispatch: (method, params, callback) => this.dispatch('rfd', method, params, callback),
                onListening: this.listeningCallback('rfd binrpc', listenAddress, binrpcListenPort),
            });
            this.servers.rfd = this.rfdServer;
        }

        if (this.devices.hmip) {
            this.hmipServer = createXmlrpcServer({
                host: listenAddress,
                port: xmlrpcListenPort,
                dispatch: (method, params, callback) => this.dispatch('hmip', method, params, callback),
                onListening: this.listeningCallback('hmip xmlrpc', listenAddress, xmlrpcListenPort),
            });
            this.servers.hmip = this.hmipServer;
        }
    }

    /** Registers a `whenReady()` promise and returns the callback that resolves it. */
    listeningCallback(name, host, port) {
        let resolve;
        this.ready.push(
            new Promise((r) => {
                resolve = r;
            }),
        );
        return () => {
            this.log.info(name, 'server listening on', host, port);
            resolve();
        };
    }

    /**
     * Resolves once every server the simulator started is accepting connections.
     * @returns {Promise<void>}
     */
    async whenReady() {
        await Promise.all(this.ready);
    }

    /* ------------------------------------------------------------------ misc */

    loadBehaviors(behaviorPath) {
        let files;
        try {
            files = fs.readdirSync(behaviorPath);
        } catch (error) {
            this.log.warn('behavior path not readable', behaviorPath, error.message);
            return;
        }

        for (const file of files) {
            if (file.endsWith('.js')) {
                this.log.info('loading behavior', file);
                require(path.join(behaviorPath, file))(this.api);
            }
        }
    }

    close() {
        this.api.removeAllListeners();
        for (const server of Object.values(this.servers)) {
            if (typeof server.close === 'function') {
                server.close();
            }
        }

        for (const iface of Object.keys(this.clients)) {
            for (const key of Object.keys(this.clients[iface])) {
                closeClient(this.clients[iface][key].client);
                delete this.clients[iface][key];
            }
        }

        if (this.regaSim) {
            this.regaSim.close();
        }
    }
}

/** Closes a binrpc or xmlrpc client so that it stops holding the event loop open. */
function closeClient(client) {
    if (!client) {
        return;
    }

    // binrpc clients reconnect on their own until that is switched off
    if (typeof client.reconnectTimeout === 'number') {
        client.reconnectTimeout = 0;
    }
    if (client.socket && typeof client.socket.destroy === 'function') {
        client.socket.destroy();
    }
    for (const method of ['end', 'close', 'destroy']) {
        if (typeof client[method] === 'function') {
            client[method]();
        }
    }
}

module.exports = HmSim;
