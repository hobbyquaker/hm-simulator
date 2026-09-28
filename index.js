#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');

const HmSim = require('./sim.js');
const {createControlServer} = require('./lib/control.js');
const pkg = require('./package.json');

const HELP = `hm-simulator ${pkg.version} - simulates a Homematic CCU

Usage: hm-simulator [options]

  --listen-address <ip>     default 127.0.0.1
  --binrpc-port <port>      rfd (BIN-RPC and XML-RPC), default 2001
  --xmlrpc-port <port>      hmipserver, default 2010
  --wired-port <port>       BidCos-Wired, off unless given or configured
  --virtual-port <port>     VirtualDevices, off unless given
  --cuxd-port <port>        CUxD, off unless given
  --rega-port <port>        ReGa mock, default 8181
  --no-rega                 do not start the ReGa mock
                            every port may be 0: the system picks a free one
  --ports-json <file|->     once every server listens, write the ports as JSON to the file, or
                            as one line to stdout with "-" (the log then goes to stderr)
  --config <file>           constructor options as a .json or .js file; the flags override it
  --devices <file>          a device file: {devices: {rfd, hmip, ...}, paramsetDescriptions}, such
                            as data/fixtures/devices.json; default: the bundled rfd and hmip lists
  --tls                     serve the XML-RPC servers over TLS with a generated certificate
  --tls-cert-out <file>     write that certificate (PEM) to the file
  --auth <user:password>    HTTP basic auth for the XML-RPC servers and ReGa
  --behavior-path <dir>     behaviour scripts, default the bundled examples
  --no-behaviors            no behaviour scripts
  --control-port <port>     the scenario API over HTTP on 127.0.0.1, off unless given
  -v, --verbosity <level>   error|warn|info|debug, default info
  --version
  -h, --help`;

function fail(message) {
    console.error(`hm-simulator: ${message}`);
    process.exit(1);
}

let args;
try {
    ({values: args} = parseArgs({
        options: {
            'listen-address': {type: 'string'},
            'binrpc-port': {type: 'string'},
            'xmlrpc-port': {type: 'string'},
            'wired-port': {type: 'string'},
            'virtual-port': {type: 'string'},
            'cuxd-port': {type: 'string'},
            'rega-port': {type: 'string'},
            'no-rega': {type: 'boolean', default: false},
            'ports-json': {type: 'string'},
            config: {type: 'string'},
            devices: {type: 'string'},
            tls: {type: 'boolean', default: false},
            'tls-cert-out': {type: 'string'},
            auth: {type: 'string'},
            'behavior-path': {type: 'string'},
            'no-behaviors': {type: 'boolean', default: false},
            'control-port': {type: 'string'},
            verbosity: {type: 'string', short: 'v', default: 'info'},
            version: {type: 'boolean', default: false},
            help: {type: 'boolean', short: 'h', default: false},
        },
    }));
} catch (error) {
    fail(error.message);
}

if (args.version) {
    console.log(pkg.version);
    process.exit(0);
}

if (args.help) {
    console.log(HELP);
    process.exit(0);
}

// with the ports on stdout, stdout carries nothing else
const toStderr = args['ports-json'] === '-';
const LEVELS = ['error', 'warn', 'info', 'debug'];
const level = LEVELS.indexOf(args.verbosity) === -1 ? 2 : LEVELS.indexOf(args.verbosity);
const logAt = (index, method) =>
    level >= index ? (...arguments_) => console[method](new Date().toISOString(), ...arguments_) : () => {};

const log = {
    error: logAt(0, 'error'),
    warn: logAt(1, toStderr ? 'error' : 'warn'),
    info: logAt(2, toStderr ? 'error' : 'log'),
    debug: logAt(3, toStderr ? 'error' : 'log'),
};

function port(value, name) {
    if (value === undefined) {
        return undefined;
    }
    const number = Number(value);
    if (value === '' || !Number.isInteger(number) || number < 0 || number > 65535) {
        fail(`--${name} wants a port number, got ${value}`);
    }
    return number;
}

function readJson(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        fail(`cannot read ${file}: ${error.message}`);
    }
}

/**
 * A device file: `{devices: {rfd, hmip, ...}, paramsetDescriptions}` (a fixture), or only the
 * `{rfd, hmip, ...}` part.
 */
function loadDevices(file) {
    const content = readJson(file);
    return content.devices && !Array.isArray(content.devices)
        ? {devices: content.devices, paramsetDescriptions: content.paramsetDescriptions}
        : {devices: content};
}

function loadConfig(file) {
    const absolute = path.resolve(file);
    let options;
    try {
        options = /\.c?js$/.test(absolute) ? require(absolute) : readJson(absolute);
    } catch (error) {
        fail(`cannot load ${file}: ${error.message}`);
    }
    options = {...options};
    const base = path.dirname(absolute);
    // devices and paramsetDescriptions may be paths, relative to the file
    if (typeof options.devices === 'string') {
        const loaded = loadDevices(path.resolve(base, options.devices));
        options.devices = loaded.devices;
        if (loaded.paramsetDescriptions && options.paramsetDescriptions === undefined) {
            options.paramsetDescriptions = loaded.paramsetDescriptions;
        }
    }
    if (typeof options.paramsetDescriptions === 'string') {
        options.paramsetDescriptions = readJson(path.resolve(base, options.paramsetDescriptions));
    }
    if (typeof options.behaviorPath === 'string') {
        options.behaviorPath = path.resolve(base, options.behaviorPath);
    }
    return options;
}

const options = args.config ? loadConfig(args.config) : {};

if (args.devices) {
    const loaded = loadDevices(path.resolve(args.devices));
    options.devices = loaded.devices;
    if (loaded.paramsetDescriptions) {
        options.paramsetDescriptions = loaded.paramsetDescriptions;
    }
}
if (!options.devices) {
    options.devices = {
        rfd: require('./data/devices-rfd.json'),
        hmip: require('./data/devices-hmip.json'),
    };
}
// a copy: the simulator changes the lists it is given
options.devices = JSON.parse(JSON.stringify(options.devices));

const config = {...options.config};
const listenAddress = args['listen-address'] || config.listenAddress || '127.0.0.1';
config.listenAddress = listenAddress;
config.binrpcListenPort = port(args['binrpc-port'], 'binrpc-port') ?? config.binrpcListenPort ?? 2001;
config.xmlrpcListenPort = port(args['xmlrpc-port'], 'xmlrpc-port') ?? config.xmlrpcListenPort ?? 2010;
config.virtualListenPort = port(args['virtual-port'], 'virtual-port') ?? config.virtualListenPort;
config.cuxdListenPort = port(args['cuxd-port'], 'cuxd-port') ?? config.cuxdListenPort;
config.wiredListenPort = port(args['wired-port'], 'wired-port') ?? config.wiredListenPort;
if (config.wiredListenPort !== undefined && !options.devices.wired) {
    options.devices.wired = {devices: []};
}
if (options.devices.wired && config.wiredListenPort === undefined) {
    config.wiredListenPort = 2000;
}
options.config = config;

if (args['no-rega']) {
    delete options.rega;
} else {
    options.rega = {port: 8181, listenAddress, ...options.rega};
    if (args['rega-port'] !== undefined) {
        options.rega.port = port(args['rega-port'], 'rega-port');
    }
}

if (args.tls) {
    options.tls = true;
}
if (args.auth !== undefined) {
    const separator = args.auth.indexOf(':');
    if (separator < 1) {
        fail('--auth wants user:password');
    }
    options.auth = {username: args.auth.slice(0, separator), password: args.auth.slice(separator + 1)};
}
if (args['no-behaviors']) {
    options.behaviorPath = false;
} else if (args['behavior-path'] !== undefined) {
    options.behaviorPath = path.resolve(args['behavior-path']);
}
options.log = log;

const controlPort = port(args['control-port'], 'control-port');

/** Writes a file so that a reader never sees half of it. */
function writeAtomically(file, content) {
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, content);
    fs.renameSync(temporary, file);
}

let hmSim;
let control;

function shutdown(code) {
    if (control) {
        control.close();
    }
    if (hmSim) {
        hmSim.close();
    }
    process.exit(code);
}

async function main() {
    hmSim = new HmSim(options);
    try {
        await hmSim.whenReady();
    } catch (error) {
        // EADDRINUSE and friends name the address and the port
        console.error(`hm-simulator: ${error.message}`);
        shutdown(1);
    }

    if (controlPort !== undefined) {
        try {
            control = await createControlServer(hmSim, {port: controlPort, log: log.error});
        } catch (error) {
            console.error(`hm-simulator: control port: ${error.message}`);
            shutdown(1);
        }
    }

    if (args['tls-cert-out'] && hmSim.tls) {
        writeAtomically(path.resolve(args['tls-cert-out']), hmSim.tls.cert);
    }

    const ports = {...hmSim.ports};
    if (hmSim.regaSim) {
        ports.rega = hmSim.regaSim.port;
    }
    if (control) {
        ports.control = control.address().port;
    }
    log.info('listening', JSON.stringify(ports));

    if (args['ports-json'] === '-') {
        process.stdout.write(JSON.stringify(ports) + '\n');
    } else if (args['ports-json']) {
        writeAtomically(path.resolve(args['ports-json']), JSON.stringify(ports) + '\n');
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        log.info('got', signal, '- shutting down');
        shutdown(0);
    });
}

main();
