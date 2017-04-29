#!/usr/bin/env node

const log = require('yalm');
log.setLevel('debug');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');
const config = require('./config.js');

const devices = {
    rfd: require('./data/devices-rfd.json'),
    hmip: require('./data/devices-hmip.json')
};

const clients = {
    rfd: {},
    hmip: {},
};

const values = {
    rfd: {},
    hmip: {}
};

const rfdServer = binrpc.createServer({host: config.listenAddress, port: config.binrpcListenPort});
log.info('binrpc server listening on', config.listenAddress, config.binrpcListenPort);

const hmipServer = xmlrpc.createServer({host: config.listenAddress, port: config.xmlrpcListenPort});
log.info('binrpc server listening on', config.listenAddress, config.xmlrpcListenPort);

const rpcMethods = {
    'system.listMethods': (err, iface, params, callback) => {
        callback(null, Object.keys(rpcMethods));
    },
    init: (err, iface, params, callback) => {
        let [url, id] = params;
        let [protocol, host, port] = url.split(':');
        host = host.replace(/^\/\//, '');
        if (protocol === 'xmlrpc_bin') {
            protocol = 'binrpc';
        }
        const clientId = [host, port].join(':');

        if (clientId === '') {
            log.debug('remove', iface, clients[iface][clientId].url);
            const client = clients[iface][clientId];
            // Todo ...
            if (client && typeof client.client.end === 'function') {
                client.client.end();
            }
            if (client && typeof client.client.close === 'function') {
                client.client.close();
            }
            if (client && typeof client.client.destroy === 'function') {
                client.client.destroy();
            }
            delete client;
        } else {
            clients[iface][clientId] = {
                id,
                url,
                client: (protocol === 'binrpc' ? binrpc : xmlrpc).createClient({host, port}),
                methodCall: (methodName, params, callback) => {
                    log.debug('rpc >', url, methodName, shortenParams(params));
                    clients[iface][clientId].client.methodCall(methodName, params, (err, res) => {
                        log.debug('rpc <', url, shortenParams(res));
                        if (typeof callback === 'function') callback(err, res);
                    });
                }
            };
            startInit(iface, clients[iface][clientId]);
        }
        callback(null, '');
    },
    listDevices: (err, iface, params, callback) => {
        callback(null, devices[iface].devices);
    },
    getParamsetDescription: (err, iface, params, callback) => {
        let [address, paramset] = params;
        callback(null, '');
    },
    ping: (err, iface, params, callback) => {
        if (iface === 'hmip') {
            // Todo Remove when https://github.com/eq-3/occu/issues/42 is fixed
            return;
        }
        let [id] = params;
        event(iface, ['CENTRAL', 'PONG', id]);
        callback(null, '');
    },
    setValue: (err, iface, params, callback) => {
        callback(null, '');
    },
    notFound: (methodName, iface, params) => {
        log.error('rpc', iface, '< unknown method', methodName, shortenParams(params));
    }
};

rpcMethods.NotFound = rpcMethods.notFound;

function event(iface, params) {
    Object.keys(clients[iface]).forEach(c => {
        const client = clients[iface][c];
        params.unshift(client.id);
        client.methodCall('event', params);
    });
}

function eventMulticall(iface, events) {
    Object.keys(clients[iface]).forEach(c => {
        const multicall = [];
        const client = clients[iface][c];
        events.forEach(singleEvent, index => {
            let ev = [client.id, singleEvent[0], singleEvent[1], singleEvent[2]];
            multicall.push(['event', ev]);
        });
        client.methodCall('system.multicall', multicall);
    });
}

function startInit(iface, client) {
    client.methodCall('listDevices', [client.id], function (err, clientDevices) {
        if (err) {
            log.error(err.toString());
        } else {
            checkDevices(iface, client, clientDevices);
        }
    });
}

function checkDevices(iface, client, clientDevices) {
    log.info(iface, 'client', client.url, 'knows', clientDevices.length, 'devices');

    let clientDeviceAddresses = [];
    clientDevices.forEach(clientDev => {
        clientDeviceAddresses.push(clientDev.ADDRESS);
    });
    let deviceAddresses = [];
    devices[iface].devices.forEach(dev => {
        deviceAddresses.push(dev.ADDRESS);
    });
    let newDevices = [];
    let deleteDevices = [];

    devices[iface].devices.forEach(dev => {
        const clientDeviceIndex = clientDeviceAddresses.indexOf(dev.ADDRESS);
        if (clientDeviceIndex === -1) {
            log.debug('device unknown by client', dev.ADDRESS);
            newDevices.push(dev);
        } else {
            let clientDev = clientDevices[clientDeviceIndex];
            if (iface === 'hmip') {
                if (
                    true || // Todo remove this line when https://github.com/eq-3/occu/issues/45 is fixed
                    // Todo is this correct? https://github.com/eq-3/occu/issues/43
                    clientDev.VERSION !== dev.VERSION ||
                    clientDev.AES_ACTIVE !== dev.AES_ACTIVE ||
                    clientDev.CHILDREN !== dev.CHILDREN ||
                    clientDev.DIRECTION !== dev.DIRECTION ||
                    clientDev.FIRMWARE !== dev.FIRMWARE ||
                    clientDev.FLAGS !== dev.FLAGS ||
                    clientDev.GROUP !== dev.GROUP ||
                    clientDev.INDEX !== dev.INDEX ||
                    clientDev.INTERFACE !== dev.INTERFACE ||
                    clientDev.LINK_SOURCE_ROLES !== dev.LINK_SOURCE_ROLES ||
                    clientDev.LINK_TARGET_ROLES !== dev.LINK_TARGET_ROLES ||
                    clientDev.PARAMSETS !== dev.PARAMSETS ||
                    clientDev.PARENT !== dev.PARENT ||
                    clientDev.PARENT_TYPE !== dev.PARENT_TYPE ||
                    clientDev.RF_ADDRESS !== dev.RF_ADDRESS ||
                    clientDev.ROAMING !== dev.ROAMING ||
                    clientDev.RX_MODE !== dev.RX_MODE ||
                    clientDev.TEAM !== dev.TEAM ||
                    clientDev.TEAM_CHANNELS !== dev.TEAM_CHANNELS ||
                    clientDev.TEAM_TAG !== dev.TEAM_TAG ||
                    clientDev.TYPE !== dev.TYPE
                ) {
                    // Todo log.debug('device mismatch', clientDev.ADDRESS);
                    deleteDevices.push(clientDev.ADDRESS);
                    newDevices.push(clientDev);
                }
            } else {
                if (clientDev.VERSION !== dev.VERSION) {
                    log.debug('device mismatch', clientDev.ADDRESS);
                    deleteDevices.push(clientDev.ADDRESS);
                    newDevices.push(clientDev);
                }
            }
        }
    });
    clientDevices.forEach(clientDev => {
        if (deviceAddresses.indexOf(clientDev.ADDRESS) === -1) {
            log.debug('device unknown', clientDev.ADDRESS);
            deleteDevices.push(clientDev.ADDRESS);
        }
    });
    if (deleteDevices.length > 0) {
        log.info(iface, 'client', client.url, 'should delete', deleteDevices.length, 'devices');
        client.methodCall('deleteDevices', [client.id, deleteDevices], () => {
            if (newDevices.length > 0) {
                log.info(iface, 'client', client.url, 'should add', newDevices.length, 'devices');
                client.methodCall('newDevices', [client.id, newDevices]);
            }
        });
    } else if (newDevices.length > 0) {
        log.info(iface, 'client', client.url, 'should add', newDevices.length, 'devices');
        client.methodCall('newDevices', [client.id, newDevices]);
    } else {
        log.info(iface, 'client', client.url, 'all devices known');
    }
}

rpcMethods['system.listmethods'] = (err, iface, params, callback) => {
    callback(null, Object.keys(rpcMethods));
};

Object.keys(rpcMethods).forEach(methodName => {
    rfdServer.on(methodName, (err, params, callback) => {
        log.debug('rpc rfd <', methodName, shortenParams(params));
        rpcMethods[methodName](err, 'rfd', params, callback)
    });
    hmipServer.on(methodName, (err, params, callback) => {
        log.debug('rpc hmip <', methodName, shortenParams(params));
        rpcMethods[methodName](err, 'hmip', params, callback)
    });
});

function shortenParams(params) {
    if (!params) {
        return
    }
    let str = JSON.stringify(params);
    if (str.length > 77) {
        return str.slice(0, 77) + '...';
    } else {
        return str;
    }
}

