#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

const log = require('yalm');

log.setLevel('debug');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');
const config = require('./config.js');

const devices = {
    rfd: require('./data/devices-rfd.json'),
    hmip: require('./data/devices-hmip.json')
};

const paramsetDescriptions = require('./data/paramset-descriptions.json');

const clients = {
    rfd: {},
    hmip: {}
};

const values = {
    rfd: {},
    hmip: {}
};

setDefaultValues('rfd');
setDefaultValues('hmip');

function setDefaultValues(iface) {
    devices[iface].devices.forEach(dev => {
        if (dev.PARENT_TYPE) {
            if (dev.PARAMSETS.indexOf('VALUES') !== -1) {
                const ps = getParamsetDescription(dev, 'VALUES');
                Object.keys(ps).forEach(dp => {
                    if (!values[iface][dev.ADDRESS]) {
                        values[iface][dev.ADDRESS] = {
                            VALUES: {}
                        };
                    }
                    if (ps[dp].type === 'ENUM') {
                        values[iface][dev.ADDRESS].VALUES[dp] = ps[dp].VALUE_LIST.indexOf(ps[dp].DEFAULT);
                    } else {
                        values[iface][dev.ADDRESS].VALUES[dp] = ps[dp].DEFAULT;
                    }
                });
            }
        }
    });
}

const rfdServer = binrpc.createServer({host: config.listenAddress, port: config.binrpcListenPort});
log.info('binrpc server listening on', config.listenAddress, config.binrpcListenPort);

const hmipServer = xmlrpc.createServer({host: config.listenAddress, port: config.xmlrpcListenPort});
log.info('binrpc server listening on', config.listenAddress, config.xmlrpcListenPort);

const rpcMethods = {
    'system.listMethods': (err, iface, params, callback) => {
        callback(null, Object.keys(rpcMethods));
    },
    init: (err, iface, params, callback) => {
        const [url, id] = params;
        let [protocol, host, port] = url.split(':');
        host = host.replace(/^\/\//, '');
        if (protocol === 'xmlrpc_bin') {
            protocol = 'binrpc';
        }
        const clientId = [host, port].join(':');

        if (clientId === '') {
            log.debug('remove', iface, clients[iface][clientId].url);
            let client = clients[iface][clientId];
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
            client = null;
            delete clients[iface][clientId];
        } else {
            clients[iface][clientId] = {
                id,
                url,
                client: (protocol === 'binrpc' ? binrpc : xmlrpc).createClient({host, port}),
                methodCall: (methodName, params, callback) => {
                    log.debug('rpc >', url, methodName, shortenParams(params));
                    clients[iface][clientId].client.methodCall(methodName, params, (err, res) => {
                        log.debug('rpc <', url, shortenParams(res));
                        if (typeof callback === 'function') {
                            callback(err, res);
                        }
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
        const [address, paramset] = params;
        callback(null, getParamsetDescription(getDevice(iface, address), paramset));
    },
    ping: (err, iface, params, callback) => {
        if (iface === 'hmip') {
            // Todo Remove when https://github.com/eq-3/occu/issues/42 is fixed
            return;
        }
        const [id] = params;
        event(iface, ['CENTRAL', 'PONG', id]);
        callback(null, '');
    },
    setValue: (err, iface, params, callback) => {
        const [address, datapoint, value] = params;
        setValue(iface, address, datapoint, value);
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
        events.forEach(singleEvent => {
            const ev = [client.id, singleEvent[0], singleEvent[1], singleEvent[2]];
            multicall.push({methodName: 'event', params: ev});
        });
        client.methodCall('system.multicall', [multicall]);
    });
}

function startInit(iface, client) {
    client.methodCall('listDevices', [client.id], (err, clientDevices) => {
        if (err) {
            log.error(err.toString());
        } else {
            checkDevices(iface, client, clientDevices);
        }
    });
}

function checkDevices(iface, client, clientDevices) {
    log.info(iface, 'client', client.url, 'knows', clientDevices.length, 'devices');

    const clientDeviceAddresses = [];
    clientDevices.forEach(clientDev => {
        clientDeviceAddresses.push(clientDev.ADDRESS);
    });
    const deviceAddresses = [];
    devices[iface].devices.forEach(dev => {
        deviceAddresses.push(dev.ADDRESS);
    });
    const newDevices = [];
    const deleteDevices = [];

    devices[iface].devices.forEach(dev => {
        const clientDeviceIndex = clientDeviceAddresses.indexOf(dev.ADDRESS);
        if (clientDeviceIndex === -1) {
            log.debug('device unknown by client', dev.ADDRESS);
            newDevices.push(dev);
        } else {
            const clientDev = clientDevices[clientDeviceIndex];
            if (iface === 'hmip') {
                // eslint-disable-next-line no-constant-condition
                if (
                    // Todo remove next line when https://github.com/eq-3/occu/issues/45 is fixed
                    true ||
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
            } else if (clientDev.VERSION !== dev.VERSION) {
                log.debug('device mismatch', clientDev.ADDRESS);
                deleteDevices.push(clientDev.ADDRESS);
                newDevices.push(clientDev);
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
        rpcMethods[methodName](err, 'rfd', params, callback);
    });
    hmipServer.on(methodName, (err, params, callback) => {
        log.debug('rpc hmip <', methodName, shortenParams(params));
        rpcMethods[methodName](err, 'hmip', params, callback);
    });
});

function shortenParams(params) {
    if (!params) {
        return;
    }
    const str = JSON.stringify(params);
    if (str.length > 77) {
        return str.slice(0, 77) + '...';
    }
    return str;
}

function getDevice(iface, address) {
    const devs = devices[iface].devices;
    for (let i = 0; i < devs.length; i++) {
        if (devs[i].ADDRESS === address) {
            return devs[i];
        }
    }
    log.error(iface, 'unknown device', address);
    return false;
}

function getParamsetDescription(dev, paramset) {
    const paramsets = paramsetDescriptions[[dev.PARENT_TYPE, dev.VERSION, dev.TYPE].join('/')];
    if (paramsets) {
        return paramsets[paramset];
    }
}

function setValue(iface, address, datapoint, value) {
    log.debug('setValue', iface, address, datapoint, value);
    const dev = getDevice(iface, address);
    if (dev) {
        const ps = getParamsetDescription(dev, 'VALUES');
        if (ps && ps[datapoint]) {
            switch (ps[datapoint].TYPE) {
                case 'ACTION':
                case 'BOOL':
                    if (typeof value !== 'boolean') {
                        log.error('type mismatch', address, datapoint, ps[datapoint].TYPE);
                        return;
                    }
                    break;
                case 'INTEGER':
                case 'FLOAT':
                    if (typeof value !== 'number') {
                        log.error('type mismatch', address, datapoint, ps[datapoint].TYPE);
                        return;
                    }
                    if ((value < ps[datapoint].MIN) || (value > ps[datapoint].MAx)) {
                        log.error('range error', address, datapoint, ps[datapoint].MIN, ps[datapoint].MAX);
                        return;
                    }
                    break;
                default:
            }
            values[iface][address].VALUES[datapoint] = value;

            if (ps[datapoint].OPERATIONS & 4) {
                const events = [];
                if (ps[datapoint].TYPE === 'ACTION') {
                    events.push([address, datapoint, values[iface][address].VALUES[datapoint]]);
                } else {
                    Object.keys(values[iface][address].VALUES).forEach(dp => {
                        events.push([address, dp, values[iface][address].VALUES[dp]]);
                    });
                }
                eventMulticall(iface, events);
            }
        } else {
            log.error('unknown params', address, datapoint);
        }
    }
}

const api = new EventEmitter();

api.on('setValue', setValue);

function loadBehaviors() {
    const p = path.join(__dirname, 'behaviors');
    const files = fs.readdirSync(p);
    files.forEach(file => {
        if (file.match(/\.js$/)) {
            log.info('loading behavior', file);
            require(path.join(p, file))(api);
        }
    });
}

loadBehaviors();
