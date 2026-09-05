#!/usr/bin/env node

'use strict';

const {parseArgs} = require('node:util');

const HmSim = require('./sim.js');
const pkg = require('./package.json');

const {values: args} = parseArgs({
    options: {
        'listen-address': {type: 'string', default: '127.0.0.1'},
        'binrpc-port': {type: 'string', default: '2001'},
        'xmlrpc-port': {type: 'string', default: '2010'},
        'virtual-port': {type: 'string'},
        'cuxd-port': {type: 'string'},
        'rega-port': {type: 'string', default: '8181'},
        'no-rega': {type: 'boolean', default: false},
        verbosity: {type: 'string', short: 'v', default: 'info'},
        version: {type: 'boolean', default: false},
        help: {type: 'boolean', short: 'h', default: false},
    },
});

if (args.version) {
    console.log(pkg.version);
    process.exit(0);
}

if (args.help) {
    console.log(`hm-simulator ${pkg.version} - simulates a Homematic CCU

Usage: hm-simulator [options]

  --listen-address <ip>   default 127.0.0.1
  --binrpc-port <port>    rfd, default 2001
  --xmlrpc-port <port>    hmipserver, default 2010
  --virtual-port <port>   VirtualDevices, off unless given
  --cuxd-port <port>      CUxD, off unless given
  --rega-port <port>      ReGa mock, default 8181
  --no-rega               do not start the ReGa mock
  -v, --verbosity <level> error|warn|info|debug, default info
  --version
  -h, --help`);
    process.exit(0);
}

const LEVELS = ['error', 'warn', 'info', 'debug'];
const level = LEVELS.indexOf(args.verbosity) === -1 ? 2 : LEVELS.indexOf(args.verbosity);
const logAt = (index, method) =>
    level >= index ? (...arguments_) => console[method](new Date().toISOString(), ...arguments_) : () => {};

const log = {
    error: logAt(0, 'error'),
    warn: logAt(1, 'warn'),
    info: logAt(2, 'log'),
    debug: logAt(3, 'log'),
};

const port = (value) => (value === undefined ? undefined : Number.parseInt(value, 10));

const hmSim = new HmSim({
    log,
    devices: {
        rfd: require('./data/devices-rfd.json'),
        hmip: require('./data/devices-hmip.json'),
    },
    config: {
        listenAddress: args['listen-address'],
        binrpcListenPort: port(args['binrpc-port']),
        xmlrpcListenPort: port(args['xmlrpc-port']),
        virtualListenPort: port(args['virtual-port']),
        cuxdListenPort: port(args['cuxd-port']),
    },
    rega: args['no-rega'] ? undefined : {port: port(args['rega-port']), listenAddress: args['listen-address']},
});

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log.info('got', signal, '- shutting down');
        hmSim.close();
        process.exit(0);
    });
}
