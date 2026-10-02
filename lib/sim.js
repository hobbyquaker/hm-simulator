'use strict';

const fs = require('node:fs');
const path = require('node:path');
const EventEmitter = require('node:events');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

const {createFaults} = require('./faults.js');
const {
    WRITEABLE,
    castValue,
    defaultValue,
    defaultParamset,
    hmipStoredValue,
    bidcosStoredValue,
} = require('./validate.js');
const {createBinrpcServer, createXmlrpcServer, createDualServer} = require('./servers.js');
const {resolveTls} = require('./tls.js');
const RegaSim = require('./rega.js');
const {ParamsetIndex} = require('./paramset-index.js');
const {SCENARIO_METHODS} = require('./control.js');
const METHOD_HELP = require('./method-help.js');

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

/** how many calls to registered clients getCallbackLog() keeps */
const CALLBACK_LOG_SIZE = 10000;

/** the interfaces that speak the BidCos protocol, and therefore have setTempKey */
const BIDCOS_INTERFACES = new Set(['rfd', 'wired']);

/** FLAGS bit of a link whose sender rfd counts as broken (bit 2 is the receiver) */
const LINK_SENDER_BROKEN = 1;

/** The device part of a channel address: `ABC0000001:1` -> `ABC0000001`. */
function deviceOf(address) {
    const colon = String(address).indexOf(':');
    return colon === -1 ? String(address) : String(address).slice(0, colon);
}

/** device types of the HmIP radio modules, which carry DUTY_CYCLE_LEVEL and CARRIER_SENSE_LEVEL */
const RADIO_MODULE_TYPES = new Set(['RPI-RF-MOD', 'HmIP-RFUSB', 'HmIP-RFUSB-TK', 'HMIP-CCU3', 'HmIP-CCU3']);

/** the steps of a firmware update after updateFirmware/installFirmware, see offerFirmware() */
const FIRMWARE_UPDATE_STEPS = ['DO_UPDATE_PENDING', 'PERFORMING_UPDATE', 'UP_TO_DATE'];

/** paramset keys that are not the address of a linked peer channel */
const STANDARD_PARAMSETS = new Set(['MASTER', 'VALUES', 'SERVICE']);

/** FLAGS bit of a datapoint that is a service message (1 visible, 2 internal, 4 transform, 8 service) */
const SERVICE_FLAG = 8;

/**
 * Per interface behaviour, overridable with the `interfaces` option.
 *
 * configPendingMode
 *   'hmip'    - what hmipserver 3.89.8 really does, measured for Homematic Manager task 6 (see
 *               putMasterHmip): everything is stored before it is checked, an unknown parameter
 *               poisons the channel for good, a wrong type raises a sticky CONFIG_PENDING, a
 *               number outside MIN..MAX is accepted without a word. The default for `hmip`.
 *   'bidcos'  - what rfd 3.89.8 really does (see putMasterBidcos): no fault ever, unknown
 *               parameters dropped, values clamped or ignored, CONFIG_PENDING while the
 *               configuration is queued for the device. The default for `rfd` and `wired`.
 *   'strict'  - an invalid putParamset MASTER is answered with a fault and nothing is written.
 *               The hypothesis of hm-simulator 1.0 before the measurement; still the default for
 *               the interfaces that were not measured, and the strictest thing to test against.
 *   'pending' - the write is accepted, the valid parameters are stored, and CONFIG_PENDING is
 *               raised on the device's :0 channel and stays until a valid full MASTER write or
 *               clearConfigCache. The other hypothesis of 1.0; kept so both can still be tested.
 * listenerModel
 *   'isolated' - every registered client on its own (the default).
 *   'measured' - what the interface processes did with a callback server that accepts the
 *               connection and never answers (measured 2026-09-25 on firmware 3.89.8), see init().
 * pong, pingDelay
 *   whether `ping` sends the CENTRAL/PONG event (not on hmip), and after how many milliseconds.
 * startDelay
 *   milliseconds after whenReady() until the port accepts connections: a process that starts late.
 * deliveryTimeout
 *   'measured' BidCos only: milliseconds after which an unanswered callback drops the client.
 * unreachWrites
 *   what a setValue/putParamset to an unreachable device answers: 'accept' (the default) or
 *   'fault' (notReachable). The simulator's model; not measured yet.
 * firmwareUpdateDelay
 *   milliseconds per step of a firmware update, see offerFirmware().
 * protocols
 *   rfd and wired only: what their port answers, ['binrpc', 'xmlrpc'] (both, as on a CCU) unless
 *   set; ['binrpc'] is the BIN-RPC-only server of 1.1.
 * configPendingOnWrite
 *   raise CONFIG_PENDING for every accepted MASTER write, the way a BidCos battery device queues
 *   the configuration until it wakes up. Clears after configPendingDelay milliseconds. Implied by
 *   'bidcos', which raises it for every write that changes something.
 */
const INTERFACE_DEFAULTS = {
    // interface process lifecycle, see restartInterface() and the listener models in init()
    listenerModel: 'isolated',
    pong: true,
    pingDelay: 0,
    startDelay: 0,
    deliveryTimeout: 10000,
    // device health, see setReachable() and offerFirmware()
    unreachWrites: 'accept',
    firmwareUpdateDelay: 0,
    configPendingMode: 'strict',
    configPendingOnWrite: false,
    configPendingDelay: 0,
    // rfd answers the empty string instead of an empty array when it has no service message; the
    // real shape, off by default because it breaks every consumer that assumes an array
    serviceMessagesEmptyAsString: false,
    // answer getServiceMessages with the unknown-method fault, as VirtualDevices, CUxD and
    // hmipserver were seen to on 3.89.x ("Invalid XML-RPC message"); off by default
    getServiceMessagesFault: false,
};

/**
 * Per interface defaults where the lab measured a behaviour (task 6). Anything not listed keeps
 * the value from INTERFACE_DEFAULTS.
 */
const MEASURED_INTERFACE_DEFAULTS = {
    // hmipserver answers ping without a PONG event, see https://github.com/eq-3/occu/issues/42
    hmip: {configPendingMode: 'hmip', pong: false, version: '3.89.11.20260919'},
    rfd: {configPendingMode: 'bidcos', version: '2.6.0'},
    // hs485d's getVersion was not measured; rfd's answer stands in
    wired: {configPendingMode: 'bidcos', version: '2.6.0'},
};

/** the interfaces with the metadata methods: rfd and hs485d fault on a key that is not set, hmipserver answers '' */
const METADATA_INTERFACES = new Set(['rfd', 'wired', 'hmip']);

/** what listBidcosInterfaces answers when the `bidcosInterfaces` option does not say otherwise */
const DEFAULT_BIDCOS_INTERFACES = {
    rfd: [
        {
            ADDRESS: 'OEQ0123456',
            DESCRIPTION: 'HM-MOD-RPI-PCB',
            CONNECTED: true,
            DEFAULT: true,
            FIRMWARE_VERSION: '2.8.6',
            TYPE: 'CCU2',
            DUTY_CYCLE: 0,
        },
    ],
    wired: [
        {
            ADDRESS: 'HMW-LGW-1',
            DESCRIPTION: 'HMW-LGW',
            CONNECTED: true,
            DEFAULT: true,
            FIRMWARE_VERSION: '1.1.2',
            TYPE: 'HMW_LGW',
        },
    ],
    hmip: [
        {
            ADDRESS: 'XEQ0123456',
            DESCRIPTION: 'eQ-3 HmIP-RFUSB',
            CONNECTED: true,
            DEFAULT: true,
            FIRMWARE_VERSION: '1.4.6',
            TYPE: 'HMIP_CCU',
            DUTY_CYCLE: 0,
        },
    ],
};

/** True when a MASTER write covers every writeable parameter of the description. */
function isFullMasterWrite(description, set) {
    for (const [name, parameter] of Object.entries(description)) {
        if (parameter.OPERATIONS & 2 && set[name] === undefined) {
            return false;
        }
    }
    return true;
}

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
 * @param {string|false} [options.behaviorPath] directory with behaviour scripts, `false` for none
 * @param {object} [options.rega] ReGa mock options, see lib/rega.js - omit to not start it
 * @param {object} [options.paramsetDescriptions] replaces the bundled descriptions
 * @param {boolean} [options.paramsetFallback=true] a device whose firmware has no description uses
 *        the nearest firmware of the same type and VERSION; `false` for exact keys only
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
        this.paramsetFallback = options.paramsetFallback !== false;
        /** requested key -> the key used for it (a fallback) or null, see resolveParamsetKey() */
        this.paramsetResolved = new Map();
        this.paramsetIndex = new ParamsetIndex(this.paramsetDescriptions);

        const {table, fault} = createFaults(options.faults);
        this.faults = table;
        this.fault = fault;

        /** connected logic layers per interface: {<iface>: {<host:port>: client}} */
        this.clients = {};
        /** datapoint state per interface: {<iface>: {<address>: {VALUES: {}}}} */
        this.values = {sysvars: {}, programs: {}};
        /** device index per interface: {<iface>: Map<address, description>} */
        this.index = {};
        /** every putParamset the simulator accepted, see getWriteLog() */
        this.writeLog = [];
        /** links per interface: {<iface>: [{SENDER, RECEIVER, FLAGS, NAME, DESCRIPTION}]} */
        this.links = {};
        /** service messages raised through the scenario API: {<iface>: [[address, name, value]]} */
        this.serviceMessages = {};
        /** end of the install mode per interface, as an epoch timestamp */
        this.installMode = {};
        /** the temporary AES key of the BidCos interfaces, see setTempKey */
        this.tempKey = {};
        /** devices that appear when the install mode is switched on, see scriptNewDevices() */
        this.newDevicesScript = {};
        /** every reportValueUsage the simulator was told about */
        this.valueUsage = [];
        /** every updateFirmware/installFirmware call */
        this.firmwareUpdates = [];
        /** every refreshDeployedDeviceFirmwareList call: [{iface, ts}] */
        this.firmwareListRefreshes = [];
        /** every changeKey call: [{iface, key, ts}] */
        this.keyChanges = [];
        /** the log level of each interface process, see logLevel() */
        this.logLevels = {};
        /** pending timers, cleared by close() */
        this.timers = new Set();
        /** devices with a pending configuration: {<iface>: Map<deviceAddress, {sticky}>} */
        this.configPending = {};
        /** channels whose stored MASTER carries a parameter the device does not have */
        this.poisonedChannels = {};
        /** faults waiting for the next matching calls, see injectFault() */
        this.injectedFaults = [];
        /** every call the simulator made to a registered client, see getCallbackLog() */
        this.callbackLog = [];
        /** per interface: a promise every incoming call waits for while the process is busy */
        this.gates = {};
        /** per interface: deliveries held back while a registration hangs, see init() */
        this.held = {};
        /** interfaces whose port is closed, see stopInterface() */
        this.stopped = new Set();
        /** interfaces that open their port only after `startDelay` */
        this.delayedStarts = {};
        /** devices that are unreachable: {<iface>: Set<deviceAddress>}, see setReachable() */
        this.unreachable = {};
        /** what listBidcosInterfaces reports on top of the configured answer: {<iface>: {DUTY_CYCLE, ...}} */
        this.radio = {};
        /** a device that holds another system's key: {<iface>: {serial, key, devices, delay}}, see scriptKeyMismatch() */
        this.keyMismatchScript = {};
        /** the serial getKeyMismatchDevice answers: {<iface>: serial} */
        this.keyMismatch = {};
        /** suppressed service messages (hmipserver): {<iface>: Map<channelAddress, Set<parameter>>} */
        this.suppressed = {};
        /** metadata per interface and address: {<iface>: {<address>: {<key>: value}}} */
        this.metadata = structuredClone(options.metadata || {});
        /** every setInterfaceClock call: [{iface, utc, offset, ts}] */
        this.interfaceClocks = [];

        this.rpcMethods = this.buildRpcMethods();

        // interfaces with a port but without a device list still need their state
        if (config.virtualListenPort !== undefined && !this.devices.virtual) {
            this.devices.virtual = {devices: []};
        }
        if (config.cuxdListenPort !== undefined && !this.devices.cuxd) {
            this.devices.cuxd = {devices: []};
        }

        this.servers = {};
        /** how to (re)create the server of an interface, see dropConnection() */
        this.serverFactories = {};
        this.ifaces = [];
        /** promises that resolve once each server is accepting connections, see whenReady() */
        this.ready = [];
        /** the port each server actually listens on, filled in once it is listening */
        this.ports = {};

        for (const iface of Object.keys(this.devices)) {
            this.initInterface(iface);
        }

        this.startServers();

        this.api = new EventEmitter();
        // a behaviour script is the *device* acting, not a client: it may report datapoints a
        // client is not allowed to write (PRESS_SHORT, UNREACH, ...), and a bad script only logs
        this.api.on('setValue', (iface, address, datapoint, value) =>
            this.setValue(iface, address, datapoint, value, {internal: true}),
        );

        // `behaviorPath: false`: no behaviour scripts at all
        if (options.behaviorPath !== false) {
            this.loadBehaviors(options.behaviorPath || path.join(__dirname, '..', 'behaviors'));
        }

        if (options.rega) {
            // the ReGa mock inherits TLS and basic auth unless its own options say otherwise
            this.regaSim = new RegaSim(
                {
                    ...(this.tls ? {tls: this.tls} : {}),
                    ...(this.auth ? {auth: this.auth} : {}),
                    ...options.rega,
                },
                this.log,
            );
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
        this.links[iface] = this.links[iface] || (this.options.links && this.options.links[iface]) || [];
        this.serviceMessages[iface] =
            this.serviceMessages[iface] || (this.options.serviceMessages && this.options.serviceMessages[iface]) || [];
        if (this.options.newDevices && this.options.newDevices[iface] && !this.newDevicesScript[iface]) {
            this.newDevicesScript[iface] = {delay: 0, ...this.options.newDevices[iface]};
        }
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
                this.values[iface][device.ADDRESS].VALUES[name] = defaultValue(parameter);
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
        if (name === undefined) {
            return undefined;
        }
        const key = this.resolveParamsetKey(name);
        return key === null ? undefined : this.paramsetDescriptions[key];
    }

    /**
     * The key whose description stands in for `name`: `name` itself when the set has it, otherwise
     * the same type, VERSION, channel type and paramset of the nearest firmware (the highest one at
     * or below the device's, else the lowest above it) unless `paramsetFallback` is off, else null.
     *
     * A device reports the firmware it runs, and a description set only has the firmwares somebody
     * dumped: without this, the bundled `HM-RCV-50` (firmware 2.27.8, descriptions from 2.31.25 on)
     * answers `Invalid device` for every channel `listDevices` reports (PR #1). Each substitution
     * and each miss is logged once.
     *
     * @param {string} name `<interface>/<type>/<firmware>/<version>/<channelType>/<paramset>`
     * @returns {string|null}
     */
    resolveParamsetKey(name) {
        if (this.paramsetDescriptions[name]) {
            return name;
        }
        const index = this.currentParamsetIndex();
        if (this.paramsetResolved.has(name)) {
            return this.paramsetResolved.get(name);
        }

        const used = this.paramsetFallback ? index.nearest(name) : null;
        this.paramsetResolved.set(name, used);
        if (used) {
            this.log.warn('paramset description', name, 'missing, using', used);
        } else {
            this.log.warn('paramset description', name, 'missing');
        }
        return used;
    }

    /** The firmware index of the descriptions, rebuilt when somebody replaced sim.paramsetDescriptions. */
    currentParamsetIndex() {
        if (this.paramsetIndex.descriptions !== this.paramsetDescriptions) {
            this.paramsetIndex = new ParamsetIndex(this.paramsetDescriptions);
            this.paramsetResolved.clear();
        }
        return this.paramsetIndex;
    }

    /**
     * Every paramset the devices announce in `PARAMSETS` whose description is not in the set under
     * its exact key, with the key the simulator uses instead (`null`: none, the paramset faults).
     * An empty list means the device data and the descriptions match exactly.
     *
     * @returns {Array<{iface: string, key: string, usedKey: string|null}>}
     */
    getMissingParamsetDescriptions() {
        const missing = new Map();
        for (const iface of this.ifaces) {
            for (const device of this.devices[iface].devices) {
                for (const paramset of device.PARAMSETS || []) {
                    const key = this.paramsetName(iface, device, paramset);
                    if (key === undefined || this.paramsetDescriptions[key] || missing.has(`${iface} ${key}`)) {
                        continue;
                    }
                    const usedKey = this.paramsetFallback ? this.currentParamsetIndex().nearest(key) : null;
                    missing.set(`${iface} ${key}`, {iface, key, usedKey});
                }
            }
        }
        return [...missing.values()];
    }

    /* ------------------------------------------------------------------ paramsets */

    /** The device or channel, or a fault if this interface does not know the address. */
    requireDevice(iface, address) {
        const device = this.index[iface] && this.index[iface].get(address);
        if (!device) {
            throw this.fault('unknownInstance', `${iface}/${address}`);
        }
        return device;
    }

    requireParamsetDescription(iface, device, paramset) {
        const description = this.getParamsetDescription(iface, device, paramset);
        if (!description) {
            throw this.fault('unknownParamset', `${device.ADDRESS}/${paramset}`);
        }
        return description;
    }

    /** Everything the simulator remembers about one device or channel. */
    stateOf(iface, address) {
        if (!this.values[iface][address]) {
            this.values[iface][address] = {VALUES: {}};
        }
        return this.values[iface][address];
    }

    /**
     * The stored values of one paramset, filled with the defaults of its description on first use.
     * @param {string} iface
     * @param {string} address
     * @param {string} paramset MASTER, VALUES, SERVICE or the address of a linked peer channel
     */
    storedParamset(iface, address, paramset) {
        const device = this.requireDevice(iface, address);
        const state = this.stateOf(iface, address);

        if (!STANDARD_PARAMSETS.has(paramset)) {
            // link paramsets are addressed by the peer channel's address
            if (!this.index[iface].has(paramset) || !this.findLink(iface, address, paramset)) {
                throw this.fault('unknownParamset', `${address}/${paramset}`);
            }
            const description = this.requireParamsetDescription(iface, device, 'LINK');
            state.LINKS = state.LINKS || {};
            if (!state.LINKS[paramset]) {
                state.LINKS[paramset] = defaultParamset(description);
            }
            return {device, description, values: state.LINKS[paramset]};
        }

        const description = this.requireParamsetDescription(iface, device, paramset);
        if (!state[paramset]) {
            state[paramset] = defaultParamset(description);
        }
        return {device, description, values: state[paramset]};
    }

    getDeviceDescription(iface, address) {
        return this.requireDevice(iface, address);
    }

    /**
     * The RPC `getParamsetDescription`: unlike {@link getParamsetDescription}, which the simulator
     * calls for itself, an address the interface does not know is a fault (rfd `-2 Unknown instance`,
     * hmipserver `-2 Invalid device`, measured on 3.89.11), and so is a paramset the channel does not
     * list in `PARAMSETS` (`-3` on both). A paramset the channel has but the description set lacks
     * still answers `''`, logged once by {@link resolveParamsetKey} - that is a gap in the fixture,
     * not something an interface process does.
     * @param {string} iface
     * @param {string} address device or channel address
     * @param {string} paramset MASTER, VALUES, LINK or SERVICE
     */
    describeParamset(iface, address, paramset) {
        const device = this.requireDevice(iface, address);
        if (typeof paramset !== 'string' || paramset === '') {
            throw this.fault('invalidArguments', 'paramset type');
        }
        if (Array.isArray(device.PARAMSETS) && !device.PARAMSETS.includes(paramset)) {
            throw this.fault('unknownParamsetDescription', `${address}/${paramset}`);
        }
        return this.getParamsetDescription(iface, device, paramset);
    }

    getValue(iface, address, datapoint) {
        const {description, values} = this.storedParamset(iface, address, 'VALUES');
        if (!description[datapoint]) {
            throw this.fault('unknownParameter', `${address}/${datapoint}`);
        }
        const value = values[datapoint] === undefined ? defaultValue(description[datapoint]) : values[datapoint];
        return this.reportedValue(iface, address, datapoint, value);
    }

    /**
     * @param {string} iface
     * @param {string} address device or channel address
     * @param {string} key MASTER, VALUES, SERVICE or the address of a linked peer channel
     */
    getParamset(iface, address, key) {
        if (typeof key !== 'string' || key === '') {
            throw this.fault('invalidArguments', 'paramset key');
        }
        const {values} = this.storedParamset(iface, address, key);
        if (key !== 'VALUES' || !this.suppressed[iface] || !this.suppressed[iface].has(address)) {
            return {...values};
        }
        const reported = {};
        for (const [name, value] of Object.entries(values)) {
            reported[name] = this.reportedValue(iface, address, name, value);
        }
        return reported;
    }

    /**
     * @param {string} iface
     * @param {string} address
     * @param {string} key MASTER, VALUES, SERVICE or the address of a linked peer channel
     * @param {object} set parameter name -> value
     */
    putParamset(iface, address, key, set) {
        if (typeof key !== 'string' || key === '') {
            throw this.fault('invalidArguments', 'paramset key');
        }
        if (!set || typeof set !== 'object' || Array.isArray(set)) {
            throw this.fault('invalidArguments', 'paramset');
        }

        if (key === 'VALUES') {
            const {description} = this.storedParamset(iface, address, 'VALUES');
            for (const name of Object.keys(set)) {
                castValue(description, name, set[name], this.fault);
            }
            for (const name of Object.keys(set)) {
                this.setValue(iface, address, name, set[name], {strict: true});
            }
            return '';
        }

        const {description, values} = this.storedParamset(iface, address, key);
        if (key === 'MASTER') {
            return this.putMaster(iface, address, description, values, set);
        }

        const casted = {};
        for (const name of Object.keys(set)) {
            casted[name] = castValue(description, name, set[name], this.fault);
        }
        Object.assign(values, casted);
        this.writeLog.push({iface, address, paramset: key, values: {...set}, ts: Date.now()});
        return '';
    }

    /** The MASTER write, with the CONFIG_PENDING semantics of the interface, see setConfigPending. */
    putMaster(iface, address, description, values, set) {
        const mode = this.interfaceOption(iface, 'configPendingMode');
        if (mode === 'hmip') {
            return this.putMasterHmip(iface, address, description, values, set);
        }
        if (mode === 'bidcos') {
            return this.putMasterBidcos(iface, address, description, values, set);
        }

        const casted = {};
        const rejected = [];

        for (const name of Object.keys(set)) {
            try {
                casted[name] = castValue(description, name, set[name], this.fault);
            } catch (error) {
                if (mode === 'strict') {
                    throw error;
                }
                rejected.push({name, value: set[name], faultCode: error.faultCode, reason: error.message});
            }
        }

        Object.assign(values, casted);
        this.writeLog.push({iface, address, paramset: 'MASTER', values: {...set}, rejected, ts: Date.now()});

        if (rejected.length > 0) {
            this.log.warn(iface, address, 'MASTER write with', rejected.length, 'rejected parameters');
            this.setConfigPending(iface, address, {sticky: true});
        } else if (mode === 'pending' && isFullMasterWrite(description, set)) {
            this.clearConfigPending(iface, address);
        } else if (this.interfaceOption(iface, 'configPendingOnWrite')) {
            this.setConfigPending(iface, address, {sticky: false});
        }

        return '';
    }

    /**
     * hmipserver's MASTER write, as measured on firmware 3.89.8.
     *
     * Everything in the struct is stored first, whether it belongs to the channel or not and
     * whether its type fits or not. Only then is the resulting configuration checked, and the call
     * faults when it cannot be transferred to the device. Three consequences, all measured:
     *
     * - a parameter the channel does not have is kept **for ever**: it cannot be overwritten,
     *   there is no method that removes it, and from then on every putParamset on this channel
     *   faults - including one with an empty struct;
     * - a value of the wrong type is kept too, and raises a sticky CONFIG_PENDING on the device,
     *   which a valid full MASTER write clears again;
     * - a number outside MIN..MAX is simply accepted. hmipserver does not range-check.
     */
    putMasterHmip(iface, address, description, values, set) {
        const poisoned = (this.poisonedChannels[iface] = this.poisonedChannels[iface] || new Set());
        const rejected = [];
        let changedKnown = false;

        for (const name of Object.keys(set)) {
            const parameter = description[name];
            if (!parameter) {
                values[name] = set[name];
                poisoned.add(address);
                rejected.push({name, value: set[name], reason: 'not in the paramset description'});
                continue;
            }
            if (!(parameter.OPERATIONS & WRITEABLE)) {
                rejected.push({name, value: set[name], reason: 'not writeable'});
                continue;
            }
            const stored = hmipStoredValue(parameter, set[name]);
            if (values[name] !== stored.value) {
                changedKnown = true;
            }
            values[name] = stored.value;
            if (!stored.valid) {
                rejected.push({name, value: set[name], reason: 'not valid for this parameter'});
            }
        }

        this.writeLog.push({iface, address, paramset: 'MASTER', values: {...set}, rejected, ts: Date.now()});

        const invalid = Object.keys(values).filter(
            (name) => description[name] && !hmipStoredValue(description[name], values[name]).valid,
        );
        if (invalid.length > 0 && changedKnown) {
            this.setConfigPending(iface, address, {sticky: true});
        } else if (invalid.length === 0) {
            this.clearConfigPending(iface, address);
        }

        if (invalid.length > 0 || poisoned.has(address)) {
            this.log.warn(iface, address, 'MASTER configuration cannot be transferred to the device');
            throw this.fault('invalidValue', address);
        }
        return '';
    }

    /**
     * rfd's MASTER write, as measured on firmware 3.89.8.
     *
     * rfd never faults on a value: it drops a parameter the device does not have, ignores what it
     * cannot use, clamps a number into MIN..MAX and coerces a string to a number - and answers
     * `ok` to all of it. CONFIG_PENDING means only "a configuration is queued for the device" and
     * clears when the device takes it, which on a battery device is when it next wakes up
     * (`configPendingDelay` stands in for that).
     */
    putMasterBidcos(iface, address, description, values, set) {
        const rejected = [];
        let changed = false;

        for (const name of Object.keys(set)) {
            const parameter = description[name];
            if (!parameter) {
                rejected.push({name, value: set[name], reason: 'not in the paramset description, dropped'});
                continue;
            }
            if (!(parameter.OPERATIONS & WRITEABLE)) {
                rejected.push({name, value: set[name], reason: 'not writeable, dropped'});
                continue;
            }
            const stored = bidcosStoredValue(parameter, set[name]);
            if (stored === undefined) {
                rejected.push({name, value: set[name], reason: 'not usable for this parameter, ignored'});
                continue;
            }
            if (values[name] !== stored) {
                values[name] = stored;
                changed = true;
            }
        }

        this.writeLog.push({iface, address, paramset: 'MASTER', values: {...set}, rejected, ts: Date.now()});

        if (changed) {
            this.setConfigPending(iface, address, {sticky: false});
        }
        return '';
    }

    /* ------------------------------------------------------------------ CONFIG_PENDING */

    interfaceOption(iface, name) {
        const configured = this.options.interfaces && this.options.interfaces[iface];
        if (configured && configured[name] !== undefined) {
            return configured[name];
        }
        const measured = MEASURED_INTERFACE_DEFAULTS[iface];
        if (measured && measured[name] !== undefined) {
            return measured[name];
        }
        return INTERFACE_DEFAULTS[name];
    }

    /** The device an address belongs to. */
    deviceAddressOf(iface, address) {
        const device = this.requireDevice(iface, address);
        return device.PARENT || device.ADDRESS;
    }

    /**
     * Raises CONFIG_PENDING on the device's :0 channel.
     *
     * `sticky` is the case Homematic Manager issue #98 describes: the interface process kept a
     * configuration the device never acknowledged, and the flag stays until a valid full MASTER
     * write or clearConfigCache. Without `sticky` it is the ordinary BidCos case - the config is
     * queued until the battery device wakes up - and it clears itself after `configPendingDelay`.
     */
    setConfigPending(iface, address, {sticky = false} = {}) {
        const deviceAddress = this.deviceAddressOf(iface, address);
        const pending = (this.configPending[iface] = this.configPending[iface] || new Map());
        const wasSticky = (pending.get(deviceAddress) || {}).sticky === true;
        pending.set(deviceAddress, {sticky: sticky || wasSticky});

        this.writeConfigPending(iface, deviceAddress, true);

        if (!sticky && !wasSticky) {
            const delay = this.interfaceOption(iface, 'configPendingDelay');
            this.timer(() => {
                const entry = this.configPending[iface] && this.configPending[iface].get(deviceAddress);
                if (entry && !entry.sticky) {
                    this.clearConfigPending(iface, deviceAddress);
                }
            }, delay);
        }
    }

    clearConfigPending(iface, address) {
        // the delayed clear of a BidCos write can arrive after the device was deleted
        if (!this.index[iface] || !this.index[iface].has(address)) {
            if (this.configPending[iface]) {
                this.configPending[iface].delete(address);
            }
            return;
        }
        const deviceAddress = this.deviceAddressOf(iface, address);
        if (this.configPending[iface]) {
            this.configPending[iface].delete(deviceAddress);
        }
        this.writeConfigPending(iface, deviceAddress, false);
    }

    writeConfigPending(iface, deviceAddress, value) {
        const maintenance = `${deviceAddress}:0`;
        const description = this.getParamsetDescription(iface, maintenance, 'VALUES');
        if (description && description.CONFIG_PENDING) {
            this.setValue(iface, maintenance, 'CONFIG_PENDING', value, {internal: true});
        }
    }

    /**
     * Device addresses with a pending configuration.
     * @param {string} iface
     * @returns {Array<{address: string, sticky: boolean}>}
     */
    getConfigPending(iface) {
        return [...(this.configPending[iface] || new Map())].map(([address, entry]) => ({
            address,
            sticky: Boolean(entry.sticky),
        }));
    }

    /**
     * Channels whose stored MASTER carries a parameter their description does not have, in the
     * 'hmip' CONFIG_PENDING mode. Every putParamset on such a channel faults, and nothing but
     * deleting and pairing the device again clears it - which is what `removeDevice` does here.
     * @param {string} iface
     * @returns {string[]} channel addresses
     */
    getPoisonedChannels(iface) {
        return [...(this.poisonedChannels[iface] || new Set())];
    }

    methodHelp(name) {
        return METHOD_HELP[name] || '';
    }

    /* ------------------------------------------------------------------ links */

    findLink(iface, address, peer) {
        return (this.links[iface] || []).find(
            (link) =>
                (link.SENDER === address && link.RECEIVER === peer) ||
                (link.SENDER === peer && link.RECEIVER === address),
        );
    }

    /** Channel addresses of a device, or the address itself if it is already a channel. */
    channelsOf(iface, address) {
        const device = this.requireDevice(iface, address);
        return device.PARENT ? [address] : device.CHILDREN || [];
    }

    /**
     * @param {string} iface
     * @param {Array} params [address, flags] - without an address all links of the interface
     * @returns {Array} link structs
     */
    getLinks(iface, params) {
        const [address, flags = 0] = params || [];
        let links = this.links[iface] || [];

        if (address) {
            const addresses = new Set(this.channelsOf(iface, address));
            links = links.filter((link) => addresses.has(link.SENDER) || addresses.has(link.RECEIVER));
        }

        // rfd (measured, firmware 3.89.11): the list of *all* links carries FLAGS bit 1 (SENDER_BROKEN)
        // on every device-internal link - a relay's own button on the relay, a dimmer's channel on its
        // virtual channels - although the link works; asked for one address, the same link comes with
        // its stored flags, 0. The simulator does the same on rfd, whatever `flags` asks for.
        const internalBroken = iface === 'rfd' && !address;
        return links.map((link) => this.linkStruct(iface, link, flags, internalBroken));
    }

    /** Sender and receiver on one device: `ABC0000001:1` and `ABC0000001:2`, or the same channel. */
    isInternalLink(link) {
        return deviceOf(link.SENDER) === deviceOf(link.RECEIVER);
    }

    linkStruct(iface, link, flags, internalBroken = false) {
        const result = {
            SENDER: link.SENDER,
            RECEIVER: link.RECEIVER,
            FLAGS: (link.FLAGS || 0) | (internalBroken && this.isInternalLink(link) ? LINK_SENDER_BROKEN : 0),
            NAME: link.NAME || '',
            DESCRIPTION: link.DESCRIPTION || '',
        };

        // flags & 2: the link paramsets, flags & 4: the descriptions of both channels
        if (flags & 2) {
            result.SENDER_PARAMSET = this.linkParamsetOrEmpty(iface, link.SENDER, link.RECEIVER);
            result.RECEIVER_PARAMSET = this.linkParamsetOrEmpty(iface, link.RECEIVER, link.SENDER);
        }
        if (flags & 4) {
            result.SENDER_DESCRIPTION = this.index[iface].get(link.SENDER) || {};
            result.RECEIVER_DESCRIPTION = this.index[iface].get(link.RECEIVER) || {};
        }

        return result;
    }

    linkParamsetOrEmpty(iface, address, peer) {
        try {
            return {...this.storedParamset(iface, address, peer).values};
        } catch {
            return {};
        }
    }

    /**
     * The peers of a channel: the other end of every link it is on, the own channel once for a link
     * with itself. For a device address rfd answers `-1 Failure` (measured, 3.89.11); hmipserver
     * answers the channels' lists one after the other, a peer linked with two of the channels twice
     * (measured, 3.89.11) - the simulator does the same on every interface but `rfd`.
     * @param {string} iface
     * @param {Array} params [address]
     * @returns {string[]} channel addresses
     */
    getLinkPeers(iface, params) {
        const [address] = params || [];
        const device = this.requireDevice(iface, address);
        if (iface === 'rfd' && !device.PARENT) {
            // rfd's -1 Failure; -1 Generic error under hmipserver's default table
            throw this.fault('notSupported', `getLinkPeers of a device address: ${address}`);
        }

        const peers = [];
        for (const channel of this.channelsOf(iface, address)) {
            for (const link of this.links[iface] || []) {
                if (link.SENDER === channel) {
                    peers.push(link.RECEIVER);
                } else if (link.RECEIVER === channel) {
                    peers.push(link.SENDER);
                }
            }
        }
        return peers;
    }

    addLink(iface, params) {
        const [sender, receiver, name = '', description = ''] = params || [];
        for (const address of [sender, receiver]) {
            const device = this.requireDevice(iface, address);
            if (device.PARAMSETS && !device.PARAMSETS.includes('LINK')) {
                throw this.fault('notSupported', `${address} has no LINK paramset`);
            }
        }

        this.links[iface] = this.links[iface] || [];
        const existing = this.links[iface].find((link) => link.SENDER === sender && link.RECEIVER === receiver);
        if (existing) {
            existing.NAME = name;
            existing.DESCRIPTION = description;
            return '';
        }

        this.links[iface].push({SENDER: sender, RECEIVER: receiver, FLAGS: 0, NAME: name, DESCRIPTION: description});
        this.log.info(iface, 'link added', sender, '->', receiver);
        return '';
    }

    requireLink(iface, sender, receiver) {
        const link = (this.links[iface] || []).find((item) => item.SENDER === sender && item.RECEIVER === receiver);
        if (!link) {
            throw this.fault('unknownLink', `${sender} -> ${receiver}`);
        }
        return link;
    }

    removeLink(iface, params) {
        const [sender, receiver] = params || [];
        this.requireLink(iface, sender, receiver);
        this.links[iface] = this.links[iface].filter((link) => !(link.SENDER === sender && link.RECEIVER === receiver));

        for (const [address, peer] of [
            [sender, receiver],
            [receiver, sender],
        ]) {
            const state = this.values[iface][address];
            if (state && state.LINKS) {
                delete state.LINKS[peer];
            }
        }

        this.log.info(iface, 'link removed', sender, '->', receiver);
        return '';
    }

    getLinkInfo(iface, params) {
        const link = this.requireLink(iface, params[0], params[1]);
        return {NAME: link.NAME || '', DESCRIPTION: link.DESCRIPTION || ''};
    }

    setLinkInfo(iface, params) {
        const [sender, receiver, name = '', description = ''] = params || [];
        const link = this.requireLink(iface, sender, receiver);
        link.NAME = name;
        link.DESCRIPTION = description;
        return '';
    }

    /**
     * Applies a link paramset the way pressing the linked sender would.
     *
     * The real interface process makes the receiver run the action the link paramset describes;
     * the simulator writes back every parameter of the link paramset that the receiver also has in
     * VALUES (ON_TIME, STATE, LEVEL, ...). Everything else is only recorded in the write log.
     */
    activateLinkParamset(iface, params) {
        const [address, peer, longPress = false] = params || [];
        const {values} = this.storedParamset(iface, address, peer);
        const {description: valuesDescription} = this.storedParamset(iface, address, 'VALUES');

        for (const [name, value] of Object.entries(values)) {
            if (valuesDescription[name] && valuesDescription[name].OPERATIONS & 2) {
                this.setValue(iface, address, name, value);
            }
        }

        this.writeLog.push({
            iface,
            address,
            paramset: peer,
            values: {...values},
            method: 'activateLinkParamset',
            longPress: Boolean(longPress),
            ts: Date.now(),
        });
        return '';
    }

    /* ------------------------------------------------------------------ interface and service */

    /** Devices (not channels) of an interface. */
    deviceList(iface) {
        return this.devices[iface].devices.filter((device) => !device.PARENT);
    }

    /**
     * Receive levels: {<deviceAddress>: {<interfaceAddress>: [rssiPeer, rssiDevice]}}.
     * The values come from RSSI_PEER/RSSI_DEVICE of the device's :0 channel when the description
     * has them, otherwise from the `defaultRssi` option.
     */
    rssiInfo(iface) {
        const interfaceAddress = this.listBidcosInterfaces(iface)[0].ADDRESS;
        const result = {};
        for (const device of this.deviceList(iface)) {
            const maintenance = this.values[iface][`${device.ADDRESS}:0`];
            const values = (maintenance && maintenance.VALUES) || {};
            const fallback = this.options.defaultRssi === undefined ? -65 : this.options.defaultRssi;
            result[device.ADDRESS] = {
                [interfaceAddress]: [
                    values.RSSI_PEER === undefined ? fallback : values.RSSI_PEER,
                    values.RSSI_DEVICE === undefined ? fallback : values.RSSI_DEVICE,
                ],
            };
        }
        return result;
    }

    listBidcosInterfaces(iface) {
        const configured = this.options.bidcosInterfaces && this.options.bidcosInterfaces[iface];
        const list = configured || DEFAULT_BIDCOS_INTERFACES[iface] || DEFAULT_BIDCOS_INTERFACES.rfd;
        const radio = this.radio[iface];
        return radio ? list.map((entry) => ({...entry, ...radio})) : list;
    }

    setBidcosInterface(iface, params) {
        const [deviceId, interfaceId, roaming = false] = params || [];
        const device = this.requireDevice(iface, deviceId);
        const known = this.listBidcosInterfaces(iface).some((entry) => entry.ADDRESS === interfaceId);
        if (!known) {
            throw this.fault('unknownInstance', interfaceId);
        }
        device.INTERFACE = interfaceId;
        device.ROAMING = roaming ? 1 : 0;
        return '';
    }

    /**
     * Pending service messages as [channelAddress, datapoint, value] triples.
     *
     * Everything that is set and has the SERVICE flag (FLAGS & 8) in its VALUES description counts,
     * plus what was raised through the scenario API.
     */
    getServiceMessages(iface) {
        if (this.interfaceOption(iface, 'getServiceMessagesFault')) {
            throw this.fault('unknownMethod', `${iface}/getServiceMessages`);
        }
        const messages = [];
        for (const address of Object.keys(this.values[iface])) {
            const description = this.getParamsetDescription(iface, address, 'VALUES');
            if (!description) {
                continue;
            }
            for (const [name, value] of Object.entries(this.values[iface][address].VALUES || {})) {
                const parameter = description[name];
                if (parameter && parameter.FLAGS & SERVICE_FLAG && value && !this.isSuppressed(iface, address, name)) {
                    messages.push([address, name, value]);
                }
            }
        }

        for (const message of this.serviceMessages[iface] || []) {
            if (this.isSuppressed(iface, message[0], message[1])) {
                continue;
            }
            if (!messages.some((entry) => entry[0] === message[0] && entry[1] === message[1])) {
                messages.push([...message]);
            }
        }

        // rfd answers the empty string, not an empty array, when there is nothing pending
        // (measured for task 6). Off by default: it breaks everything that assumes an array,
        // which is exactly why an application should be tested against it once.
        if (messages.length === 0 && this.interfaceOption(iface, 'serviceMessagesEmptyAsString')) {
            return '';
        }

        return messages;
    }

    /**
     * @param {string} iface
     * @param {Array} params [on, time, mode] - mode 1 is "install mode with a specific device"
     */
    setInstallMode(iface, params) {
        const [on, time = 60, mode = 1] = params || [];
        if (!on) {
            this.installMode[iface] = 0;
            return '';
        }

        this.installMode[iface] = Date.now() + Number(time) * 1000;
        this.log.info(iface, 'install mode on for', time, 'seconds, mode', mode);

        const scripted = this.newDevicesScript[iface];
        if (scripted) {
            delete this.newDevicesScript[iface];
            this.timer(() => this.addDevices(iface, scripted.devices), scripted.delay);
        }

        const mismatch = this.keyMismatchScript[iface];
        if (mismatch) {
            this.timer(() => this.hearKeyMismatchDevice(iface, mismatch), mismatch.delay);
        }

        return '';
    }

    /* ------------------------------------------------------------------ key mismatch */

    /**
     * A device that holds another system's security key comes into reach of the next install mode
     * (or of an `addDevice` with its serial) - the case of Homematic Manager task 76.
     *
     * rfd hears the device but cannot pair it: nothing joins and nobody is told; the serial is only
     * what `getKeyMismatchDevice` answers. Once the temporary key (`setTempKey`) is the device's
     * `key`, the next install mode pairs it: `devices` (the description and its channels) join with
     * `newDevices`, and the script is used up. Without `devices` the device is never paired.
     *
     * @param {string} iface
     * @param {string} serial
     * @param {object} [script]
     * @param {string} [script.key=''] the passphrase the device was taught in with
     * @param {Array} [script.devices=[]] its description and channel descriptions
     * @param {number} [script.delay=0] milliseconds between the install mode and the device being heard
     */
    scriptKeyMismatch(iface, serial, {key = '', devices = [], delay = 0} = {}) {
        if (typeof serial !== 'string' || serial === '') {
            throw new TypeError('scriptKeyMismatch wants a serial');
        }
        this.keyMismatchScript[iface] = {serial, key: String(key), devices: devices || [], delay};
    }

    /** The scripted device is heard: paired when the temporary key is its own, else a key mismatch. */
    hearKeyMismatchDevice(iface, script) {
        if (this.keyMismatchScript[iface] !== script) {
            return undefined;
        }
        if (script.key !== '' && this.getTempKey(iface) === script.key && script.devices.length > 0) {
            delete this.keyMismatchScript[iface];
            this.addDevices(iface, script.devices);
            this.log.info(iface, script.serial, 'paired with the temporary key');
            return this.index[iface].get(script.devices[0].ADDRESS) || script.devices[0];
        }
        this.keyMismatch[iface] = script.serial;
        this.log.info(iface, script.serial, 'heard, but it holds another key');
        return undefined;
    }

    /**
     * `getKeyMismatchDevice(reset)` - the serial of the last device that could not be paired
     * because it holds another key, `''` when there is none (measured on rfd and hmipserver,
     * firmware 3.89.11). `true` clears it after the answer.
     */
    getKeyMismatchDevice(iface, params) {
        if (iface !== 'rfd' && iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/getKeyMismatchDevice`);
        }
        const [reset = false] = params || [];
        const serial = this.keyMismatch[iface] || '';
        if (reset) {
            delete this.keyMismatch[iface];
        }
        return serial;
    }

    /**
     * `addDevice(serial)` - rfd pairs one device by its serial. The simulator knows only the device
     * of scriptKeyMismatch(): with the right temporary key it joins and its description is the
     * answer; otherwise it is the key mismatch and the call faults. Any other serial is not in reach
     * (`unknownInstance`). BidCos only.
     */
    addDeviceBySerial(iface, params) {
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/addDevice`);
        }
        const [serial] = params || [];
        const script = this.keyMismatchScript[iface];
        if (!script || script.serial !== serial) {
            throw this.fault('unknownInstance', `${iface}/${serial}`);
        }
        const paired = this.hearKeyMismatchDevice(iface, script);
        if (!paired) {
            throw this.fault('notSupported', `${serial} holds another key`);
        }
        return paired;
    }

    /* ------------------------------------------------------------------ service message suppression */

    /**
     * `suppressServiceMessages(channelAddress, parameter, suppress)` - hmipserver only (eQ-3's HmIP
     * addendum; rfd does not have it). `parameter` is one of the channel's service parameters, or
     * `''` for all of them; a parameter without the service flag is ignored. Measured on firmware
     * 3.89.11: answered with an empty value, `''` suppressed every service parameter of the
     * channel, `LEVEL` nothing. A suppressed message is left out of `getServiceMessages`, and the
     * datapoint reports the value that raises no message (`false`, `0`) - the addendum's words; that
     * a change of the suppression sends that value as an event is the simulator's model.
     */
    suppressServiceMessages(iface, params) {
        if (iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/suppressServiceMessages`);
        }
        const [address, parameter = '', suppress = true] = params || [];
        if (typeof address !== 'string' || typeof parameter !== 'string') {
            throw this.fault('invalidArguments', 'suppressServiceMessages wants a channel address and a parameter');
        }
        const description = this.getParamsetDescription(iface, address, 'VALUES') || {};
        const names = Object.keys(description).filter(
            (name) => description[name].FLAGS & SERVICE_FLAG && (parameter === '' || parameter === name),
        );
        const table = (this.suppressed[iface] = this.suppressed[iface] || new Map());
        const set = table.get(address) || new Set();
        for (const name of names) {
            const before = this.reportedValue(iface, address, name);
            if (suppress) {
                set.add(name);
            } else {
                set.delete(name);
            }
            table.set(address, set);
            const after = this.reportedValue(iface, address, name);
            if (before !== after && description[name].OPERATIONS & 4) {
                this.event(iface, [address, name, after]);
            }
        }
        if (set.size === 0) {
            table.delete(address);
        }
        return '';
    }

    /**
     * `getSuppressedServiceMessages(channelAddress)` - the suppressed parameters of a channel, sorted;
     * `[]` for an address hmipserver does not know (measured, firmware 3.89.11). hmipserver only.
     */
    getSuppressedServiceMessages(iface, params) {
        if (iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/getSuppressedServiceMessages`);
        }
        const [address] = params || [];
        const set = this.suppressed[iface] && this.suppressed[iface].get(address);
        return set ? [...set].sort() : [];
    }

    isSuppressed(iface, address, name) {
        const set = this.suppressed[iface] && this.suppressed[iface].get(address);
        return Boolean(set && set.has(name));
    }

    /** The stored value, or for a suppressed service message the value that raises no message. */
    reportedValue(iface, address, name, value) {
        const stored =
            value === undefined
                ? ((this.values[iface] && this.values[iface][address]) || {VALUES: {}}).VALUES[name]
                : value;
        if (!this.isSuppressed(iface, address, name)) {
            return stored;
        }
        return typeof stored === 'boolean' || stored === undefined ? false : 0;
    }

    /* ------------------------------------------------------------------ metadata */

    requireMetadataInterface(iface, method) {
        if (!METADATA_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/${method}`);
        }
    }

    /**
     * `getMetadata(address, key)` - a value stored with `setMetadata` or the `metadata` option. A key
     * that is not set: hmipserver answers an empty value, rfd the fault `-1 Failure` - also for an
     * address it does not know (measured, firmware 3.89.11). rfd, hs485d and hmipserver.
     */
    getMetadata(iface, params) {
        this.requireMetadataInterface(iface, 'getMetadata');
        const [address, key] = params || [];
        const stored = this.metadata[iface] && this.metadata[iface][address];
        if (stored && Object.hasOwn(stored, key)) {
            return stored[key];
        }
        if (iface === 'hmip') {
            return '';
        }
        throw this.fault('notSupported', `no metadata ${key} on ${address}`);
    }

    /**
     * `setMetadata(address, key, value)` - stores a value. rfd and hs485d know only their own
     * addresses (`unknownInstance`); hmipserver takes any (the simulator's model).
     */
    setMetadata(iface, params) {
        this.requireMetadataInterface(iface, 'setMetadata');
        const [address, key, value] = params || [];
        if (typeof address !== 'string' || typeof key !== 'string' || key === '') {
            throw this.fault('invalidArguments', 'setMetadata wants an address and a key');
        }
        if (iface !== 'hmip') {
            this.requireDevice(iface, address);
        }
        this.metadata[iface] = this.metadata[iface] || {};
        this.metadata[iface][address] = this.metadata[iface][address] || {};
        this.metadata[iface][address][key] = value;
        return '';
    }

    /**
     * `getAllMetadata(address)` - every key of an address. rfd and hs485d only (hmipserver does not
     * list it); nothing stored is the fault `-1 Failure`, as measured on rfd.
     */
    getAllMetadata(iface, params) {
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/getAllMetadata`);
        }
        const [address] = params || [];
        const stored = this.metadata[iface] && this.metadata[iface][address];
        if (!stored || Object.keys(stored).length === 0) {
            throw this.fault('notSupported', `no metadata on ${address}`);
        }
        return {...stored};
    }

    /* ------------------------------------------------------------------ interface information */

    /**
     * `listReplaceableDevices(address)` - the devices a device can take the place of. rfd: the other
     * devices of the same `TYPE` that are unreachable (`setReachable(iface, address, false)`) - a
     * device that still answers is not replaced (the simulator's model, after what the CCU's WebUI
     * offers; measured: `[]` for rfd's own `BidCoS-RF`, `-2 Unknown instance` for an address it does
     * not know). hmipserver answers with an empty HTTP body whatever it is asked (measured, firmware
     * 3.89.11), which the simulator answers as `''`.
     */
    listReplaceableDevices(iface, params) {
        const [address] = params || [];
        if (iface === 'hmip') {
            return '';
        }
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/listReplaceableDevices`);
        }
        const device = this.requireDevice(iface, address);
        if (device.PARENT) {
            return [];
        }
        const unreachable = this.unreachable[iface] || new Set();
        return this.deviceList(iface).filter(
            (entry) => entry.TYPE === device.TYPE && entry.ADDRESS !== address && unreachable.has(entry.ADDRESS),
        );
    }

    /**
     * `getVersion()` - the version string of the interface process: `interfaces.<iface>.version`,
     * by default what rfd (`2.6.0`) and hmipserver (the firmware, `3.89.11.20260919`) answered on
     * firmware 3.89.11. VirtualDevices and CUxD: unknown-method.
     */
    getVersion(iface) {
        const version = this.interfaceOption(iface, 'version');
        if (version === undefined) {
            throw this.fault('unknownMethod', `${iface}/getVersion`);
        }
        return version;
    }

    /**
     * `getLGWStatus()` - rfd on firmware 3.89.11 answers `unknown method name`, measured on two
     * systems; `interfaces.rfd.lgwStatus` makes it answer that value instead, for a client that
     * shows it. BidCos only.
     */
    getLGWStatus(iface) {
        const status = BIDCOS_INTERFACES.has(iface) ? this.interfaceOption(iface, 'lgwStatus') : undefined;
        if (status === undefined) {
            throw this.fault('unknownMethod', `${iface}/getLGWStatus`);
        }
        return status;
    }

    /**
     * `setInterfaceClock(utcSeconds, offsetMinutes)` - rfd and hmipserver set the clock they send the
     * devices. Recorded in `sim.interfaceClocks` (`{iface, utc, offset, ts}`) and answered with an
     * empty string (the simulator's model; not measured - it changes the system's clock).
     */
    setInterfaceClock(iface, params) {
        if (iface !== 'rfd' && iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/setInterfaceClock`);
        }
        const [utc, offset = 0] = params || [];
        if (!Number.isFinite(Number(utc))) {
            throw this.fault('invalidArguments', 'setInterfaceClock wants the UTC seconds');
        }
        this.interfaceClocks.push({iface, utc: Number(utc), offset: Number(offset), ts: Date.now()});
        return '';
    }

    /**
     * `setTempKey(passphrase)` - the temporary key a BidCos device is taught in with.
     *
     * A HomeMatic device can be paired with a passphrase instead of the interface's own key, and a
     * device that was taught in that way can only be paired again when the same passphrase is
     * offered. rfd takes it as one string argument and answers with the empty string; it applies to
     * the pairings that follow, so an application sends it *before* `setInstallMode` or
     * `addDevice`. An empty string clears it back to the interface's key.
     *
     * Only the BidCos processes have the method - hmipserver answers an unknown-method fault, which
     * is what an application has to handle when a user types it into the wrong interface.
     *
     * The simulator does no cryptography: it remembers the key so a test can assert that the call
     * happened, in which order, and with what. `sim.getTempKey(iface)` reads it back.
     *
     * @param {string} iface
     * @param {Array} params [passphrase]
     */
    setTempKey(iface, params) {
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/setTempKey`);
        }
        const [key] = params || [];
        if (key !== undefined && typeof key !== 'string') {
            throw this.fault('invalidArguments', 'setTempKey wants a string');
        }
        this.tempKey[iface] = key === undefined ? '' : key;
        this.log.info(iface, this.tempKey[iface] === '' ? 'temporary key cleared' : 'temporary key set');
        return '';
    }

    /**
     * `logLevel(level)` - rfd and hs485d set their log level and answer it; without a level they
     * answer the one in force (5 on the rfd measured 2026-09-28). hmipserver lists the
     * method but answers it with an empty HTTP body; the simulator answers an empty string there.
     * Elsewhere unknown-method.
     *
     * @param {string} iface
     * @param {Array} params [level]
     */
    logLevel(iface, params) {
        if (iface === 'hmip') {
            return '';
        }
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/logLevel`);
        }
        const [level] = params || [];
        if (level !== undefined) {
            if (!Number.isInteger(level)) {
                throw this.fault('invalidArguments', 'logLevel wants an integer');
            }
            this.logLevels[iface] = level;
        }
        return this.logLevels[iface] === undefined ? 5 : this.logLevels[iface];
    }

    /**
     * `changeKey(passphrase)` - the interface's security key. rfd stores it and re-keys every
     * AES-capable device; hmipserver lists the method too. The simulator does no cryptography: the
     * call is recorded in `sim.keyChanges` (`{iface, key, ts}`) and answered with an empty string.
     * BidCos-Wired has no such method (unknown-method).
     *
     * @param {string} iface
     * @param {Array} params [passphrase]
     */
    changeKey(iface, params) {
        if (iface !== 'rfd' && iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/changeKey`);
        }
        const [key] = params || [];
        if (typeof key !== 'string') {
            throw this.fault('invalidArguments', 'changeKey wants a string');
        }
        this.keyChanges.push({iface, key, ts: Date.now()});
        this.log.info(iface, 'security key changed');
        return '';
    }

    /**
     * `refreshDeployedDeviceFirmwareList()` - rfd and hmipserver read the directory of deployed
     * device firmware again and answer an empty value (measured 2026-09-28); hs485d and
     * VirtualDevices have no such method. Recorded in `sim.firmwareListRefreshes`.
     */
    refreshDeployedDeviceFirmwareList(iface) {
        if (iface !== 'rfd' && iface !== 'hmip') {
            throw this.fault('unknownMethod', `${iface}/refreshDeployedDeviceFirmwareList`);
        }
        this.firmwareListRefreshes.push({iface, ts: Date.now()});
        return '';
    }

    /* ------------------------------------------------------------------ teams */

    /**
     * `listTeams()` - the team pseudo devices of a BidCos interface, with their channels.
     *
     * rfd keeps smoke detectors (and the other devices with a `TEAM_TAG`) in *teams*. A team is a
     * pseudo device whose address is `*` plus the serial of the device it was made from
     * (`*NEQ0448334`, type `HM-Sec-SD-2-Team`); its team channel carries the members in
     * `TEAM_CHANNELS`, and every member channel names the team channel in `TEAM`. The team devices
     * come with `listDevices` as well; `listTeams` is only them. hmipserver has no teams.
     *
     * @param {string} iface
     */
    listTeams(iface) {
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/listTeams`);
        }
        return this.devices[iface].devices.filter((device) => device.ADDRESS.startsWith('*'));
    }

    /**
     * `setTeam(channelAddress, teamAddress)` - puts a channel into a team.
     *
     * The shape is rfd's, as Homematic Manager task 58 read it from a CCU3: every detector starts in
     * a team of its own (`*<its serial>`); joining another team takes it out of the old one. That a
     * team nobody is left in is deleted (`deleteDevices`) is the simulator's model, not a measurement. An empty
     * `teamAddress` puts the channel back into a team of its own, which is created again
     * (`newDevices`) with the type of the team it leaves. Channel and team must carry the same
     * `TEAM_TAG`; there is no call that creates a team. The changed channels are announced with
     * `updateDevice`. BidCos only.
     *
     * @param {string} iface
     * @param {Array} params [channelAddress, teamAddress]
     */
    setTeam(iface, params) {
        if (!BIDCOS_INTERFACES.has(iface)) {
            throw this.fault('unknownMethod', `${iface}/setTeam`);
        }
        const [channelAddress, teamAddress = ''] = params || [];
        if (typeof channelAddress !== 'string' || typeof teamAddress !== 'string') {
            throw this.fault('invalidArguments', 'setTeam wants two strings');
        }
        const channel = this.requireDevice(iface, channelAddress);
        if (!channel.PARENT || !channel.TEAM_TAG || Array.isArray(channel.TEAM_CHANNELS)) {
            throw this.fault('invalidArguments', `${channelAddress} cannot be in a team`);
        }
        const oldTeam = channel.TEAM ? this.index[iface].get(channel.TEAM) : undefined;
        const ownDevice = `*${channel.PARENT}`;
        const ownTeam = `${ownDevice}:1`;
        const target = teamAddress === '' ? ownTeam : teamAddress;
        if (channel.TEAM === target) {
            return '';
        }

        let team = this.index[iface].get(target);
        if (team === undefined && target === ownTeam) {
            team = this.createTeam(iface, channel, oldTeam);
        }
        if (team === undefined) {
            throw this.fault('unknownInstance', `${iface}/${target}`);
        }
        if (!Array.isArray(team.TEAM_CHANNELS) || team.TEAM_TAG !== channel.TEAM_TAG) {
            throw this.fault('invalidArguments', `${target} is no team for ${channelAddress}`);
        }

        const changed = [channelAddress, target];
        if (oldTeam) {
            oldTeam.TEAM_CHANNELS = (oldTeam.TEAM_CHANNELS || []).filter((member) => member !== channelAddress);
            changed.push(oldTeam.ADDRESS);
        }
        team.TEAM_CHANNELS = [...team.TEAM_CHANNELS.filter((member) => member !== channelAddress), channelAddress];
        channel.TEAM = target;
        this.log.info(iface, 'team', channelAddress, '->', target);

        for (const address of changed) {
            if (this.index[iface].has(address) && !(oldTeam && address === oldTeam.ADDRESS)) {
                this.tellClientsParams(iface, 'updateDevice', [address, 0]);
            }
        }
        // a team nobody is in any more is gone
        if (oldTeam && oldTeam.TEAM_CHANNELS.length === 0 && oldTeam.PARENT) {
            this.deleteDevice(iface, oldTeam.PARENT);
        } else if (oldTeam) {
            this.tellClientsParams(iface, 'updateDevice', [oldTeam.ADDRESS, 0]);
        }
        return '';
    }

    /**
     * A team of a channel's own, `*<serial>`, shaped like the team it leaves (or, without one, as
     * `<PARENT_TYPE>-Team` with a `<TYPE>_TEAM` channel), and announced with `newDevices`.
     */
    createTeam(iface, channel, like) {
        const parent = this.index[iface].get(channel.PARENT) || {};
        const likeDevice = like && like.PARENT ? this.index[iface].get(like.PARENT) : undefined;
        const address = `*${channel.PARENT}`;
        const type = likeDevice ? likeDevice.TYPE : `${channel.PARENT_TYPE}-Team`;
        const device = {
            ADDRESS: address,
            TYPE: type,
            VERSION: likeDevice ? likeDevice.VERSION : parent.VERSION || 1,
            FIRMWARE: likeDevice ? likeDevice.FIRMWARE : parent.FIRMWARE || '1.0',
            CHILDREN: [`${address}:0`, `${address}:1`],
            PARAMSETS: ['MASTER'],
            FLAGS: 9,
        };
        const maintenance = {
            ADDRESS: `${address}:0`,
            TYPE: 'MAINTENANCE',
            VERSION: device.VERSION,
            PARENT: address,
            PARENT_TYPE: type,
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 0,
        };
        const teamChannel = {
            ADDRESS: `${address}:1`,
            TYPE: like ? like.TYPE : `${channel.TYPE}_TEAM`,
            VERSION: device.VERSION,
            PARENT: address,
            PARENT_TYPE: type,
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 1,
            TEAM_TAG: channel.TEAM_TAG,
            TEAM_CHANNELS: [],
        };
        this.addDevices(iface, [device, maintenance, teamChannel]);
        return this.index[iface].get(teamChannel.ADDRESS);
    }

    /** The temporary key an interface was last given, `''` when there is none. */
    getTempKey(iface) {
        return this.tempKey[iface] || '';
    }

    /** Remaining seconds of the install mode, 0 when it is off. */
    getInstallMode(iface) {
        const until = this.installMode[iface] || 0;
        return Math.max(0, Math.ceil((until - Date.now()) / 1000));
    }

    deleteDevice(iface, address, flags = 0) {
        const device = this.requireDevice(iface, address);
        if (device.PARENT) {
            throw this.fault('notSupported', 'only devices can be deleted');
        }

        const addresses = [address, ...(device.CHILDREN || [])];
        this.devices[iface].devices = this.devices[iface].devices.filter((entry) => !addresses.includes(entry.ADDRESS));
        for (const entry of addresses) {
            delete this.values[iface][entry];
            // deleting the device is the only thing that removes a poisoned channel configuration
            if (this.poisonedChannels[iface]) {
                this.poisonedChannels[iface].delete(entry);
            }
            if (this.suppressed[iface]) {
                this.suppressed[iface].delete(entry);
            }
            if (this.metadata[iface]) {
                delete this.metadata[iface][entry];
            }
        }
        if (this.configPending[iface]) {
            this.configPending[iface].delete(address);
        }
        this.links[iface] = (this.links[iface] || []).filter(
            (link) => !addresses.includes(link.SENDER) && !addresses.includes(link.RECEIVER),
        );
        this.reindex(iface);
        this.log.info(iface, 'device deleted', address, 'flags', flags);
        this.tellClients(iface, 'deleteDevices', addresses);
        return '';
    }

    /**
     * Takes over the configuration of one device to another one. The CCU uses this after a device
     * was exchanged; the new device keeps the old one's paramsets and links, the old one is gone.
     */
    replaceDevice(iface, oldAddress, newAddress) {
        const oldDevice = this.requireDevice(iface, oldAddress);
        const newDevice = this.requireDevice(iface, newAddress);
        if (oldDevice.PARENT || newDevice.PARENT) {
            throw this.fault('notSupported', 'only devices can be replaced');
        }
        if (oldDevice.TYPE !== newDevice.TYPE) {
            throw this.fault('notSupported', `${oldDevice.TYPE} cannot be replaced by ${newDevice.TYPE}`);
        }

        const oldChannels = [oldAddress, ...(oldDevice.CHILDREN || [])];
        const newChannels = [newAddress, ...(newDevice.CHILDREN || [])];
        for (const [index, from] of oldChannels.entries()) {
            const to = newChannels[index];
            if (to && this.values[iface][from]) {
                this.values[iface][to] = this.values[iface][from];
            }
        }

        for (const link of this.links[iface] || []) {
            const senderIndex = oldChannels.indexOf(link.SENDER);
            const receiverIndex = oldChannels.indexOf(link.RECEIVER);
            if (senderIndex !== -1) {
                link.SENDER = newChannels[senderIndex];
            }
            if (receiverIndex !== -1) {
                link.RECEIVER = newChannels[receiverIndex];
            }
        }

        this.deleteDevice(iface, oldAddress);
        return true;
    }

    reportValueUsage(iface, params) {
        const [address, valueId, refCounter = 0] = params || [];
        this.requireDevice(iface, address);
        this.valueUsage.push({iface, address, valueId, refCounter, ts: Date.now()});
        return '';
    }

    /**
     * Firmware update stub: the addresses are remembered (sim.firmwareUpdates) and the call
     * answers true. No device state changes - what a real update does to a device is out of scope.
     */
    updateFirmware(iface, params) {
        const addresses = Array.isArray(params[0]) ? params[0] : [params[0]];
        for (const address of addresses) {
            this.requireDevice(iface, address);
        }
        this.firmwareUpdates.push({iface, addresses, method: 'updateFirmware', ts: Date.now()});
        for (const address of addresses) {
            this.performFirmwareUpdate(iface, address);
        }
        return true;
    }

    installFirmware(iface, params) {
        const address = params[0];
        this.requireDevice(iface, address);
        this.firmwareUpdates.push({iface, addresses: [address], method: 'installFirmware', ts: Date.now()});
        this.performFirmwareUpdate(iface, address);
        return true;
    }

    /**
     * `clearConfigCache`, `restoreConfigToDevice` and `determineParameter` are BidCos methods.
     * hmipserver lists them in `system.listMethods` and answers `-1 Generic error` to all three -
     * measured in the lab for task 6, and the reason a "repair configuration" action must not
     * offer them on an HmIP device.
     */
    requireBidcosMaintenance(iface, method) {
        if (this.interfaceOption(iface, 'configPendingMode') === 'hmip') {
            throw this.fault('notSupported', method);
        }
    }

    /** Drops the interface process' cached configuration of a device. */
    clearConfigCache(iface, address) {
        this.requireBidcosMaintenance(iface, 'clearConfigCache');
        const device = this.requireDevice(iface, address);
        for (const channel of [address, ...(device.CHILDREN || [])]) {
            const state = this.values[iface][channel];
            if (state) {
                delete state.MASTER;
            }
        }
        this.clearConfigPending(iface, address);
        this.log.info(iface, 'config cache cleared', address);
        return '';
    }

    /**
     * Writes the cached configuration back to the device. The stored MASTER values stay as they
     * are and a pending configuration is resolved - this is the BidCos recovery path.
     */
    restoreConfigToDevice(iface, address) {
        this.requireBidcosMaintenance(iface, 'restoreConfigToDevice');
        this.requireDevice(iface, address);
        this.clearConfigPending(iface, address);
        this.log.info(iface, 'config restored to device', address);
        return '';
    }

    /** Re-reads one parameter from the device; the simulator has nothing to re-read. */
    determineParameter(iface, params) {
        this.requireBidcosMaintenance(iface, 'determineParameter');
        const [address, paramsetKey, parameterId] = params || [];
        const {description} = this.storedParamset(iface, address, paramsetKey);
        if (!description[parameterId]) {
            throw this.fault('unknownParameter', parameterId);
        }
        return '';
    }

    /**
     * Adds devices at runtime and tells the connected logic layers about them.
     * @param {string} iface
     * @param {Array} list device and channel descriptions
     * @returns {Array} the descriptions that were not known yet
     */
    addDevices(iface, list) {
        const added = [];
        for (const device of list || []) {
            if (!this.index[iface].has(device.ADDRESS)) {
                this.devices[iface].devices.push(device);
                added.push(device);
            }
        }

        if (added.length > 0) {
            this.reindex(iface);
            this.setDefaultValues(iface);
            this.log.info(iface, 'added', added.length, 'devices');
            this.tellClients(iface, 'newDevices', added);
        }

        return added;
    }

    /* ------------------------------------------------------------------ device and radio health */

    /** The device of an address, its maintenance channel `:0` and that channel's VALUES description. */
    maintenanceOf(iface, address) {
        const entry = this.requireDevice(iface, address);
        const device = entry.PARENT ? this.requireDevice(iface, entry.PARENT) : entry;
        const channel = `${device.ADDRESS}:0`;
        const description =
            (this.index[iface].has(channel) && this.getParamsetDescription(iface, channel, 'VALUES')) || {};
        return {device, channel, description};
    }

    /**
     * Reports a datapoint of the maintenance channel: stored and sent the way the description says
     * (a service message by its FLAGS), or - when the description does not have it - as an event and
     * a service message raised through setServiceMessage().
     */
    reportMaintenance(iface, channel, description, datapoint, value) {
        if (description[datapoint]) {
            this.setValue(iface, channel, datapoint, value, {internal: true});
            return;
        }
        if (typeof value === 'boolean') {
            this.setServiceMessage(iface, channel, datapoint, value);
        }
        this.fireEvent(iface, channel, datapoint, value);
    }

    /**
     * A device goes out of reach or comes back: `UNREACH` on its `:0` channel, and on the BidCos
     * interfaces `STICKY_UNREACH`, which stays after the device is back until a client writes it
     * `false` - as rfd does. What a write to the device answers meanwhile is the `unreachWrites`
     * option ('accept', or 'fault' with notReachable).
     *
     * @param {string} iface
     * @param {string} address the device or one of its channels
     * @param {boolean} reachable
     */
    setReachable(iface, address, reachable) {
        const {device, channel, description} = this.maintenanceOf(iface, address);
        const unreachable = (this.unreachable[iface] = this.unreachable[iface] || new Set());
        if (reachable) {
            unreachable.delete(device.ADDRESS);
        } else {
            unreachable.add(device.ADDRESS);
        }
        this.reportMaintenance(iface, channel, description, 'UNREACH', !reachable);
        const sticky = description.STICKY_UNREACH || (BIDCOS_INTERFACES.has(iface) && !description.UNREACH);
        if (!reachable && sticky) {
            this.reportMaintenance(iface, channel, description, 'STICKY_UNREACH', true);
        }
        this.log.info(iface, device.ADDRESS, reachable ? 'reachable again' : 'unreachable');
    }

    /** Throws notReachable for a write to an unreachable device when `unreachWrites` is 'fault'. */
    requireReachable(iface, address) {
        if (this.interfaceOption(iface, 'unreachWrites') !== 'fault' || !this.unreachable[iface]) {
            return;
        }
        const entry = this.index[iface] && this.index[iface].get(address);
        const deviceAddress = entry ? entry.PARENT || entry.ADDRESS : address;
        if (this.unreachable[iface].has(deviceAddress)) {
            throw this.fault('notReachable', address);
        }
    }

    /**
     * Low battery: `LOW_BAT` or `LOWBAT` on the device's `:0` channel, whichever its description has
     * (`LOW_BAT` on hmip, `LOWBAT` on BidCos without one).
     */
    setLowBattery(iface, address, low) {
        const {channel, description} = this.maintenanceOf(iface, address);
        let datapoint = iface === 'hmip' ? 'LOW_BAT' : 'LOWBAT';
        if (description.LOW_BAT) {
            datapoint = 'LOW_BAT';
        } else if (description.LOWBAT) {
            datapoint = 'LOWBAT';
        }
        this.reportMaintenance(iface, channel, description, datapoint, Boolean(low));
    }

    /**
     * The radio module of an interface, if the device list has it: the device whose address is the
     * last 14 characters of the interface's address (an SGTIN), or one of a radio module's types.
     */
    radioModule(iface) {
        const address = String((this.listBidcosInterfaces(iface)[0] || {}).ADDRESS || '');
        const devices = this.deviceList(iface);
        return (
            devices.find((device) => device.ADDRESS === address.slice(-14) || device.ADDRESS === address) ||
            devices.find((device) => RADIO_MODULE_TYPES.has(device.TYPE))
        );
    }

    /**
     * Sets a radio level of an interface: in what `listBidcosInterfaces` answers, and on hmip as
     * the event of the radio module's `:0` channel, when the device list has a radio module.
     */
    setRadioLevel(iface, field, datapoint, percent) {
        if (typeof percent !== 'number' || Number.isNaN(percent)) {
            throw new TypeError(`${field} wants a number`);
        }
        this.radio[iface] = {...this.radio[iface], [field]: percent};
        const module = iface === 'hmip' ? this.radioModule(iface) : undefined;
        if (module) {
            const {channel, description} = this.maintenanceOf(iface, module.ADDRESS);
            this.reportMaintenance(iface, channel, description, datapoint, percent);
        }
    }

    /** The duty cycle of an interface in percent: `DUTY_CYCLE`, on hmip also `DUTY_CYCLE_LEVEL`. */
    setDutyCycle(iface, percent) {
        this.setRadioLevel(iface, 'DUTY_CYCLE', 'DUTY_CYCLE_LEVEL', percent);
    }

    /** The carrier sense level of an interface in percent: `CARRIER_SENSE_LEVEL`. */
    setCarrierSense(iface, percent) {
        this.setRadioLevel(iface, 'CARRIER_SENSE_LEVEL', 'CARRIER_SENSE_LEVEL', percent);
    }

    /**
     * A firmware update becomes available for a device: `AVAILABLE_FIRMWARE`,
     * `FIRMWARE_UPDATE_STATE: 'NEW_FIRMWARE_AVAILABLE'` and `UPDATABLE` in its description,
     * `UPDATE_PENDING` on `:0` where the description has it, and `updateDevice` to the clients.
     * A following `updateFirmware`/`installFirmware` walks `FIRMWARE_UPDATE_STATE` through
     * DO_UPDATE_PENDING, PERFORMING_UPDATE and UP_TO_DATE, one step per `firmwareUpdateDelay`, and
     * sets `FIRMWARE` at the end. The state names are the RPC specification's; the timing is a model.
     *
     * @param {string} iface
     * @param {string} address the device
     * @param {string} version
     */
    offerFirmware(iface, address, version) {
        const device = this.requireDevice(iface, address);
        if (device.PARENT) {
            throw this.fault('notSupported', 'firmware is offered to a device, not a channel');
        }
        device.AVAILABLE_FIRMWARE = String(version);
        device.FIRMWARE_UPDATE_STATE = 'NEW_FIRMWARE_AVAILABLE';
        device.UPDATABLE = device.UPDATABLE === undefined ? 1 : device.UPDATABLE;
        const {channel, description} = this.maintenanceOf(iface, address);
        if (description.UPDATE_PENDING) {
            this.setValue(iface, channel, 'UPDATE_PENDING', true, {internal: true});
        }
        this.tellClientsParams(iface, 'updateDevice', [address, 0]);
    }

    performFirmwareUpdate(iface, address) {
        const device = this.index[iface].get(address);
        if (!device || device.PARENT || device.FIRMWARE_UPDATE_STATE !== 'NEW_FIRMWARE_AVAILABLE') {
            return;
        }
        const delay = this.interfaceOption(iface, 'firmwareUpdateDelay');
        const step = (index) => {
            // the device can be gone by now
            if (this.index[iface].get(address) !== device) {
                return;
            }
            device.FIRMWARE_UPDATE_STATE = FIRMWARE_UPDATE_STEPS[index];
            if (index === FIRMWARE_UPDATE_STEPS.length - 1) {
                device.FIRMWARE = device.AVAILABLE_FIRMWARE;
                const {channel, description} = this.maintenanceOf(iface, address);
                if (description.UPDATE_PENDING) {
                    this.setValue(iface, channel, 'UPDATE_PENDING', false, {internal: true});
                }
                this.log.info(iface, address, 'firmware', device.FIRMWARE);
            } else {
                this.timer(() => step(index + 1), delay);
            }
            this.tellClientsParams(iface, 'updateDevice', [address, 0]);
        };
        this.timer(() => step(0), delay);
    }

    /**
     * Runs scenario calls on the simulator's timer: `[{at: ms, call: 'setReachable', args: [...]}]`,
     * `at` counted from now. Resolves with the results once every step ran; `close()` cancels what
     * did not run yet (and the promise then never resolves).
     *
     * @param {Array<{at: number, call: string, args: Array}>} steps
     * @returns {Promise<Array>}
     */
    schedule(steps) {
        const list = steps || [];
        for (const step of list) {
            if (!SCENARIO_METHODS.has(step.call) || step.call === 'schedule' || typeof this[step.call] !== 'function') {
                throw new Error(`schedule: ${step.call} is no scenario call`);
            }
        }
        return Promise.all(
            list.map(
                (step) =>
                    new Promise((resolve) => {
                        this.timer(async () => {
                            try {
                                resolve(await this[step.call](...(step.args || [])));
                            } catch (error) {
                                this.log.error('schedule', step.call, error.message);
                                resolve(error);
                            }
                        }, step.at || 0);
                    }),
            ),
        );
    }

    /* ------------------------------------------------------------------ scenario api */

    /**
     * Adds one device with its channels.
     * @param {string} iface
     * @param {...object} descriptions the device description and its channel descriptions
     * @returns {Array} the descriptions that were not known yet
     */
    addDevice(iface, ...descriptions) {
        return this.addDevices(iface, descriptions.flat());
    }

    /**
     * Removes a device with its channels, values and links, like deleteDevice over RPC.
     * @param {string} iface
     * @param {string} address
     */
    removeDevice(iface, address) {
        return this.deleteDevice(iface, address);
    }

    /**
     * Sends one event, the way a device reports a change.
     *
     * Unlike setValue this does not check the description: a test has to be able to send exactly
     * the event it wants, including values a client would never be allowed to write.
     *
     * @param {string} iface
     * @param {string} address channel address
     * @param {string} datapoint
     * @param {*} value
     */
    fireEvent(iface, address, datapoint, value) {
        const state = this.values[iface] && this.values[iface][address];
        if (state) {
            state.VALUES[datapoint] = value;
        }
        this.event(iface, [address, datapoint, value]);
        return value;
    }

    /**
     * Drops everything that is connected to one interface: the registered logic layers are
     * forgotten and the server is restarted on the same port, so open sockets are reset. That is
     * what a client sees when an interface process restarts, and it has to re-init afterwards.
     *
     * @param {string} iface
     * @returns {Promise<void>} resolves once the server accepts connections again
     */
    async dropConnection(iface) {
        for (const key of Object.keys(this.clients[iface] || {})) {
            closeClient(this.clients[iface][key].client);
            delete this.clients[iface][key];
        }

        const server = this.servers[iface];
        const factory = this.serverFactories[iface];
        if (!server || !factory) {
            return;
        }

        const port = this.ports[iface];
        this.log.info(iface, 'dropping all connections');
        if (!this.stopped.has(iface)) {
            await server.close();
        }
        this.stopped.delete(iface);

        this.ready = [];
        this.servers[iface] = factory(port);
        this.exposeServer(iface);
        await this.whenReady();
    }

    /**
     * Stops an interface process: its port refuses connections, open connections are reset. The
     * registered clients stay known until startInterface() decides what the process remembers.
     *
     * @param {string} iface
     * @returns {Promise<void>} once the port is closed
     */
    async stopInterface(iface) {
        const server = this.servers[iface];
        if (!server || this.stopped.has(iface)) {
            return;
        }
        this.stopped.add(iface);
        this.log.info(iface, 'interface process stopped');
        await server.close();
    }

    /**
     * Starts a stopped interface process again on the same port.
     *
     * With `forgetClients` (the default) the registered clients are forgotten, as by a process
     * that keeps no list of them: no event reaches a client until it calls `init` again, and
     * nothing tells it. Without, the process remembers them and calls each back the way rfd does
     * when it starts with its handlers file: `system.listMethods`, then `listDevices`, and
     * `newDevices`/`deleteDevices` as at an init - a client sees calls it did not ask for, which is
     * how it can tell that the process restarted.
     *
     * @param {string} iface
     * @param {object} [options]
     * @param {boolean} [options.forgetClients=true]
     * @returns {Promise<void>} once the port accepts connections again
     */
    async startInterface(iface, {forgetClients = true} = {}) {
        const factory = this.serverFactories[iface];
        if (!factory || !this.stopped.has(iface)) {
            return;
        }
        if (forgetClients) {
            for (const key of Object.keys(this.clients[iface] || {})) {
                this.forgetClient(iface, key);
            }
        }

        const before = this.ready.length;
        this.servers[iface] = factory(this.ports[iface]);
        this.exposeServer(iface);
        const ready = this.ready.slice(before);
        this.ready.splice(before);
        await Promise.all(ready);
        this.stopped.delete(iface);
        this.log.info(iface, 'interface process started');

        for (const client of Object.values(this.clients[iface] || {})) {
            const listDevices = () => this.startInit(iface, client);
            if (BIDCOS_INTERFACES.has(iface)) {
                client.methodCall('system.listMethods', [client.id], listDevices);
            } else {
                listDevices();
            }
        }
    }

    /**
     * An interface process restarts: stopInterface(), `downMs` with the port closed,
     * startInterface(). See startInterface() for `forgetClients`.
     *
     * @param {string} iface
     * @param {object} [options]
     * @param {number} [options.downMs=0]
     * @param {boolean} [options.forgetClients=true]
     * @returns {Promise<void>} once the port accepts connections again
     */
    async restartInterface(iface, {downMs = 0, forgetClients = true} = {}) {
        await this.stopInterface(iface);
        if (downMs > 0) {
            await new Promise((resolve) => this.timer(resolve, downMs));
        }
        await this.startInterface(iface, {forgetClients});
    }

    /**
     * Sends a burst of events the way the interface processes do, as `system.multicall` batches.
     *
     * @param {string} iface
     * @param {Array<Array>} events `[[address, datapoint, value], ...]`, not validated
     * @param {object} [options]
     * @param {number} [options.batch] events per multicall, all in one when omitted
     */
    fireEvents(iface, events, {batch} = {}) {
        const list = events || [];
        for (const [address, datapoint, value] of list) {
            const state = this.values[iface] && this.values[iface][address];
            if (state) {
                state.VALUES[datapoint] = value;
            }
        }
        const size = batch > 0 ? batch : list.length;
        for (let index = 0; index < list.length; index += size) {
            this.eventMulticall(iface, list.slice(index, index + size));
        }
        return list.length;
    }

    /**
     * Raises or clears a service message. If the channel has the datapoint in its VALUES
     * description the value is written as well, so that the logic layer sees the event too.
     * @param {string} iface
     * @param {string} address channel address
     * @param {string} datapoint e.g. UNREACH, STICKY_UNREACH, LOWBAT, ERROR_OVERHEAT
     * @param {*} [value=true] a falsy value clears the message
     */
    setServiceMessage(iface, address, datapoint, value = true) {
        const messages = (this.serviceMessages[iface] = this.serviceMessages[iface] || []);
        const index = messages.findIndex((entry) => entry[0] === address && entry[1] === datapoint);
        if (value) {
            if (index === -1) {
                messages.push([address, datapoint, value]);
            } else {
                messages[index][2] = value;
            }
        } else if (index !== -1) {
            messages.splice(index, 1);
        }

        const description = this.getParamsetDescription(iface, address, 'VALUES');
        if (description && description[datapoint]) {
            this.setValue(iface, address, datapoint, value === true ? true : value || false, {internal: true});
        }
    }

    /**
     * Devices that appear the next time the install mode is switched on.
     * @param {string} iface
     * @param {Array} devices
     * @param {number} [delay=0] milliseconds between setInstallMode and the newDevices call
     */
    scriptNewDevices(iface, devices, delay = 0) {
        this.newDevicesScript[iface] = {devices, delay};
    }

    /** Calls one method on every connected logic layer. */
    tellClients(iface, method, payload) {
        this.tellClientsParams(iface, method, [payload]);
    }

    /** The same with several parameters after the interface id (`updateDevice(id, address, hint)`). */
    tellClientsParams(iface, method, params) {
        for (const key of Object.keys(this.clients[iface] || {})) {
            const client = this.clients[iface][key];
            this.deliver(iface, client, method, [client.id, ...params]);
        }
    }

    /**
     * One call to one registered client: held back while a registration of the interface hangs
     * (the 'measured' hmip model), and under the 'measured' BidCos model the client is dropped when
     * it does not answer within `deliveryTimeout`.
     */
    deliver(iface, client, method, params) {
        const held = this.held[iface];
        if (held && held.count > 0) {
            held.queue.push(() => this.deliver(iface, client, method, params));
            return;
        }
        const measuredBidcos =
            BIDCOS_INTERFACES.has(iface) && this.interfaceOption(iface, 'listenerModel') === 'measured';
        if (!measuredBidcos) {
            client.methodCall(method, params);
            return;
        }
        client.methodCall(
            method,
            params,
            (error) => {
                if (error && this.clients[iface][client.key] === client) {
                    this.log.warn(iface, 'client', client.url, 'did not take', method, '- dropped:', error.message);
                    this.forgetClient(iface, client.key);
                }
            },
            {timeout: this.interfaceOption(iface, 'deliveryTimeout')},
        );
    }

    forgetClient(iface, key) {
        const client = this.clients[iface] && this.clients[iface][key];
        if (client) {
            closeClient(client.client);
            delete this.clients[iface][key];
        }
    }

    /** Holds every delivery of an interface back until the returned function is called. */
    hold(iface) {
        const held = (this.held[iface] = this.held[iface] || {count: 0, queue: []});
        held.count++;
        let released = false;
        return () => {
            if (released) {
                return;
            }
            released = true;
            held.count--;
            if (held.count === 0) {
                const queue = held.queue.splice(0);
                for (const send of queue) {
                    send();
                }
            }
        };
    }

    /**
     * Makes every incoming call of an interface wait until the returned function is called - the
     * interface process is busy with something that does not return.
     */
    closeGate(iface) {
        let release;
        const gate = new Promise((resolve) => {
            release = resolve;
        });
        const previous = this.gates[iface];
        const combined = previous ? Promise.all([previous, gate]) : gate;
        this.gates[iface] = combined;
        return () => {
            release();
            if (this.gates[iface] === combined) {
                delete this.gates[iface];
            }
        };
    }

    /** A timer that never keeps the process alive and is cleared by close(). */
    timer(callback, ms) {
        const handle = setTimeout(() => {
            this.timers.delete(handle);
            callback();
        }, ms);
        if (typeof handle.unref === 'function') {
            handle.unref();
        }
        this.timers.add(handle);
        return handle;
    }

    clearTimer(handle) {
        if (handle) {
            clearTimeout(handle);
            this.timers.delete(handle);
        }
    }

    /**
     * Every putParamset the simulator accepted, oldest first.
     * @returns {Array<{iface: string, address: string, paramset: string, values: object, ts: number}>}
     */
    getWriteLog() {
        return this.writeLog.map((entry) => ({...entry, values: {...entry.values}}));
    }

    /* ------------------------------------------------------------------ rpc */

    buildRpcMethods() {
        const methods = {
            'system.listMethods': (iface) => this.methodNames(iface),
            'system.multicall': (iface, params) => this.multicall(iface, params),
            init: (iface, params) => this.init(iface, params),
            listDevices: (iface) => this.devices[iface].devices,
            getParamsetDescription: (iface, params) => this.describeParamset(iface, params[0], params[1]),
            getDeviceDescription: (iface, params) => this.getDeviceDescription(iface, params[0]),
            ping: (iface, params) => this.ping(iface, params),
            setValue: (iface, params) => {
                this.requireReachable(iface, params[0]);
                this.setValue(iface, params[0], params[1], params[2], {strict: true});
                return '';
            },
            getValue: (iface, params) => this.getValue(iface, params[0], params[1]),
            getParamset: (iface, params) => this.getParamset(iface, params[0], params[1]),
            putParamset: (iface, params) => {
                this.requireReachable(iface, params[0]);
                return this.putParamset(iface, params[0], params[1], params[2]);
            },
            'system.methodHelp': (iface, params) => this.methodHelp(params[0]),
            getLinks: (iface, params) => this.getLinks(iface, params),
            getLinkPeers: (iface, params) => this.getLinkPeers(iface, params),
            getLinkInfo: (iface, params) => this.getLinkInfo(iface, params),
            setLinkInfo: (iface, params) => this.setLinkInfo(iface, params),
            addLink: (iface, params) => this.addLink(iface, params),
            removeLink: (iface, params) => this.removeLink(iface, params),
            activateLinkParamset: (iface, params) => this.activateLinkParamset(iface, params),
            rssiInfo: (iface) => this.rssiInfo(iface),
            listBidcosInterfaces: (iface) => this.listBidcosInterfaces(iface),
            setBidcosInterface: (iface, params) => this.setBidcosInterface(iface, params),
            getServiceMessages: (iface) => this.getServiceMessages(iface),
            setInstallMode: (iface, params) => this.setInstallMode(iface, params),
            getInstallMode: (iface) => this.getInstallMode(iface),
            setTempKey: (iface, params) => this.setTempKey(iface, params),
            listTeams: (iface) => this.listTeams(iface),
            setTeam: (iface, params) => this.setTeam(iface, params),
            deleteDevice: (iface, params) => this.deleteDevice(iface, params[0], params[1]),
            replaceDevice: (iface, params) => this.replaceDevice(iface, params[0], params[1]),
            reportValueUsage: (iface, params) => this.reportValueUsage(iface, params),
            updateFirmware: (iface, params) => this.updateFirmware(iface, params),
            installFirmware: (iface, params) => this.installFirmware(iface, params),
            clearConfigCache: (iface, params) => this.clearConfigCache(iface, params[0]),
            restoreConfigToDevice: (iface, params) => this.restoreConfigToDevice(iface, params[0]),
            determineParameter: (iface, params) => this.determineParameter(iface, params),
            logLevel: (iface, params) => this.logLevel(iface, params),
            changeKey: (iface, params) => this.changeKey(iface, params),
            refreshDeployedDeviceFirmwareList: (iface) => this.refreshDeployedDeviceFirmwareList(iface),
            getKeyMismatchDevice: (iface, params) => this.getKeyMismatchDevice(iface, params),
            addDevice: (iface, params) => this.addDeviceBySerial(iface, params),
            suppressServiceMessages: (iface, params) => this.suppressServiceMessages(iface, params),
            getSuppressedServiceMessages: (iface, params) => this.getSuppressedServiceMessages(iface, params),
            getMetadata: (iface, params) => this.getMetadata(iface, params),
            setMetadata: (iface, params) => this.setMetadata(iface, params),
            getAllMetadata: (iface, params) => this.getAllMetadata(iface, params),
            listReplaceableDevices: (iface, params) => this.listReplaceableDevices(iface, params),
            getVersion: (iface) => this.getVersion(iface),
            getLGWStatus: (iface) => this.getLGWStatus(iface),
            setInterfaceClock: (iface, params) => this.setInterfaceClock(iface, params),
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
        const asFault = (error) => ({faultCode: error.faultCode, faultString: error.faultString});
        const results = [];
        for (const call of calls) {
            try {
                const result = this.callMethod(iface, call.methodName, call.params || []);
                results.push(isThenable(result) ? result.then((value) => [value], asFault) : [result]);
            } catch (error) {
                results.push(asFault(error));
            }
        }
        return results.some(isThenable) ? Promise.all(results) : results;
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
    dispatch(iface, method, params, callback, context = {}) {
        this.log.debug('rpc', iface, '<', method, shortenParams(params));
        const gate = this.gates[iface];
        if (gate) {
            gate.then(() => this.dispatchNow(iface, method, params, callback, context));
            return;
        }
        this.dispatchNow(iface, method, params, callback, context);
    }

    dispatchNow(iface, method, params, callback, context) {
        const injected = this.takeInjectedFault(iface, method);
        if (!injected) {
            this.execute(iface, method, params, callback);
            return;
        }

        const act = () => {
            if (injected.hang) {
                this.log.info('rpc', iface, method, 'injected: never answered');
                return;
            }
            if (injected.closeSocket) {
                this.log.info('rpc', iface, method, 'injected: connection closed');
                if (context.socket) {
                    context.socket.destroy();
                }
                return;
            }
            if (injected.fault !== undefined) {
                callback(this.injectedFaultOf(injected.fault, method));
                return;
            }
            this.execute(iface, method, params, callback);
        };
        if (injected.delayMs > 0) {
            this.timer(act, injected.delayMs);
        } else {
            act();
        }
    }

    execute(iface, method, params, callback) {
        const failed = (error) => {
            if (error.faultCode === undefined) {
                this.log.error('rpc', iface, method, error.stack || error.message);
                callback(this.fault('invalidArguments', error.message));
                return;
            }
            callback(error);
        };
        let result;
        try {
            result = this.callMethod(iface, method, params);
        } catch (error) {
            failed(error);
            return;
        }
        if (isThenable(result)) {
            result.then((value) => callback(null, value === undefined ? '' : value), failed);
            return;
        }
        callback(null, result);
    }

    /* ------------------------------------------------------------------ fault injection */

    /**
     * Makes the next calls of a method misbehave.
     *
     * @param {object} rule
     * @param {string} [rule.iface] the interface, every one when omitted
     * @param {string} [rule.method='*'] the method, `'*'` for any
     * @param {number} [rule.times=1] how many calls, `Infinity` or `-1` for all until clearFaults()
     * @param {number} [rule.delayMs] answer (or misbehave) only after this many milliseconds
     * @param {boolean} [rule.hang] never answer; the connection stays open
     * @param {boolean} [rule.closeSocket] close the connection instead of answering
     * @param {object|string} [rule.fault] answer this fault: `{faultCode, faultString}` or the name
     *        of an entry of the fault table (`'unknownInstance'`, `'notReachable'`, ...)
     */
    injectFault(rule = {}) {
        const entry = {method: '*', times: 1, ...rule};
        if (entry.fault !== undefined) {
            // check now, not when the call arrives
            this.injectedFaultOf(entry.fault, entry.method);
        }
        this.injectedFaults.push(entry);
        return entry;
    }

    /** Removes every injected fault that did not happen yet. */
    clearFaults() {
        this.injectedFaults = [];
    }

    takeInjectedFault(iface, method) {
        const index = this.injectedFaults.findIndex(
            (rule) =>
                (rule.iface === undefined || rule.iface === iface) && (rule.method === '*' || rule.method === method),
        );
        if (index === -1) {
            return undefined;
        }
        const rule = this.injectedFaults[index];
        // Infinity or a negative number: until clearFaults() (-1 is what JSON can carry)
        if (rule.times !== Infinity && rule.times >= 0) {
            rule.times--;
            if (rule.times <= 0) {
                this.injectedFaults.splice(index, 1);
            }
        }
        return rule;
    }

    injectedFaultOf(fault, method) {
        if (typeof fault === 'string') {
            if (!this.faults[fault]) {
                throw new Error(`no fault ${fault} in the fault table`);
            }
            return this.fault(fault, `injected into ${method}`);
        }
        if (!fault || typeof fault.faultCode !== 'number') {
            throw new Error('an injected fault is a name of the fault table or {faultCode, faultString}');
        }
        return {faultCode: fault.faultCode, faultString: fault.faultString || ''};
    }

    /**
     * Every call the simulator made to a registered client, oldest first (the last 10000):
     * `{iface, client, method, sentAt, answeredAt, error}`. `answeredAt` is null while the client
     * has not answered, `error` the transport error or timeout.
     */
    getCallbackLog() {
        return this.callbackLog.map((entry) => ({...entry}));
    }

    /**
     * `init(url, interfaceId)` - registers a logic layer, or with an empty id removes it.
     *
     * The url is `xmlrpc_bin://host:port` or `binrpc://…` for BIN-RPC callbacks, `http://` or
     * `https://host:port/path` for XML-RPC ones (the path is kept: a callback server may serve
     * several interfaces on one port). A registration is identified by the url exactly, scheme and
     * path included, as the interface processes do: `init('http://h:1', '')` does not remove a
     * `xmlrpc_bin://h:1` registration.
     */
    init(iface, params) {
        const [url, id] = params || [];
        const parsed = parseCallbackUrl(url);
        if (!parsed) {
            throw this.fault('invalidArguments', `init url ${url}`);
        }
        const clientId = String(url);

        if (id === '' || id === undefined) {
            const client = this.clients[iface][clientId];
            if (client) {
                this.log.debug('remove', iface, client.url);
                closeClient(client.client);
                delete this.clients[iface][clientId];
            }
        } else {
            const client = this.createClient(iface, parsed, url, id, clientId);
            if (this.interfaceOption(iface, 'listenerModel') === 'measured') {
                return BIDCOS_INTERFACES.has(iface)
                    ? this.initMeasuredBidcos(iface, client)
                    : this.initMeasuredHmip(iface, client);
            }
            this.clients[iface][clientId] = client;
            this.startInit(iface, client);
        }

        return '';
    }

    /** A registered logic layer: its RPC client, and a methodCall that logs and can time out. */
    createClient(iface, {protocol, host, port, path}, url, id, key) {
        let rpcClient;
        if (protocol === 'binrpc') {
            rpcClient = binrpc.createClient({host, port});
        } else if (protocol === 'https') {
            rpcClient = xmlrpc.createSecureClient({host, port, path, rejectUnauthorized: false});
        } else {
            rpcClient = xmlrpc.createClient({host, port, path});
        }
        const client = {
            id,
            url,
            key,
            client: rpcClient,
            methodCall: (methodName, methodParams, callback, {timeout} = {}) => {
                this.log.debug('rpc >', url, methodName, shortenParams(methodParams));
                const entry = {
                    iface,
                    client: url,
                    method: methodName,
                    sentAt: Date.now(),
                    answeredAt: null,
                    error: null,
                };
                this.logCallback(entry);
                let done = false;
                let timer;
                const finish = (error, result) => {
                    if (done) {
                        return;
                    }
                    done = true;
                    this.clearTimer(timer);
                    entry.answeredAt = Date.now();
                    entry.error = error ? String(error.message || error) : null;
                    this.log.debug('rpc <', url, error ? error.message : shortenParams(result));
                    if (typeof callback === 'function') {
                        callback(error, result);
                    }
                };
                if (timeout > 0) {
                    timer = this.timer(() => finish(new Error(`no answer within ${timeout} ms`)), timeout);
                }
                client.client.methodCall(methodName, methodParams, finish);
            },
        };
        return client;
    }

    logCallback(entry) {
        this.callbackLog.push(entry);
        if (this.callbackLog.length > CALLBACK_LOG_SIZE) {
            this.callbackLog.splice(0, this.callbackLog.length - CALLBACK_LOG_SIZE);
        }
    }

    /**
     * rfd's `init`, as measured with a callback server that never answers (firmware 3.89.8,
     * 2026-09-25): rfd calls `system.listMethods` back *before* it answers the `init`, and until
     * that callback returns, rfd answers nothing else at all - every other client's calls wait.
     * When the callback fails (the connection ended), rfd tries it three more times at once and
     * registers the client anyway. A registered client that does not take a callback within
     * `deliveryTimeout` (10 s measured) is dropped. That `listDevices` also comes before the
     * answer is the model of the simulator, as the rest of the init sequence.
     */
    initMeasuredBidcos(iface, client) {
        const release = this.closeGate(iface);
        return new Promise((resolve) => {
            const listMethods = (attempt) => {
                client.methodCall('system.listMethods', [client.id], (error) => {
                    if (error && attempt < 4) {
                        listMethods(attempt + 1);
                        return;
                    }
                    this.clients[iface][client.key] = client;
                    client.methodCall('listDevices', [client.id], (listError, clientDevices) => {
                        release();
                        resolve('');
                        if (!listError) {
                            this.checkDevices(iface, client, clientDevices);
                        }
                    });
                });
            };
            listMethods(1);
        });
    }

    /**
     * hmipserver's `init`, as measured (firmware 3.89.8, 2026-09-25): the call is answered at
     * once and `listDevices` is called back afterwards. While that callback hangs, hmipserver
     * delivers **no event to any client** of the interface - they are queued and follow when the
     * connection ends, and the client that hung is not called again. After a registration
     * finished, a client that stops answering holds up only itself.
     */
    initMeasuredHmip(iface, client) {
        this.clients[iface][client.key] = client;
        const release = this.hold(iface);
        client.methodCall('listDevices', [client.id], (error, clientDevices) => {
            if (error) {
                this.log.warn(iface, 'client', client.url, 'failed at listDevices - not registered:', error.message);
                if (this.clients[iface][client.key] === client) {
                    this.forgetClient(iface, client.key);
                }
            } else {
                this.checkDevices(iface, client, clientDevices);
            }
            release();
        });
        return '';
    }

    /**
     * `ping(callerId)` - the BidCos processes answer with a `CENTRAL`/`PONG` event to *every*
     * registered client, hmipserver sends none (`pong: false`). `pingDelay` delays the event.
     */
    ping(iface, params) {
        if (!this.interfaceOption(iface, 'pong')) {
            return '';
        }
        const pong = () => this.event(iface, ['CENTRAL', 'PONG', (params || [])[0]]);
        const delay = this.interfaceOption(iface, 'pingDelay');
        if (delay > 0) {
            this.timer(pong, delay);
        } else {
            pong();
        }
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
            this.deliver(iface, client, 'event', [client.id, ...params]);
        }
    }

    eventMulticall(iface, events) {
        for (const key of Object.keys(this.clients[iface] || {})) {
            const client = this.clients[iface][key];
            const multicall = events.map((singleEvent) => ({
                methodName: 'event',
                params: [client.id, singleEvent[0], singleEvent[1], singleEvent[2]],
            }));
            this.deliver(iface, client, 'system.multicall', [multicall]);
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

    /**
     * @param {string} iface
     * @param {string} address
     * @param {string} datapoint
     * @param {*} value
     * @param {object} [options]
     * @param {boolean} [options.strict=false] throw a fault instead of logging - used for incoming
     *                  RPC calls; the behaviour script API stays lenient
     */
    setValue(iface, address, datapoint, value, {strict = false, internal = false} = {}) {
        this.log.debug('setValue', iface, address, datapoint, value);

        let description;
        let casted;
        try {
            const device = this.requireDevice(iface, address);
            description = this.requireParamsetDescription(iface, device, 'VALUES');
            casted = castValue(description, datapoint, value, this.fault, {write: !internal});
        } catch (error) {
            if (strict) {
                throw error;
            }
            this.log.error('setValue', iface, address, datapoint, error.message);
            return;
        }

        const parameter = description[datapoint];
        const state = this.stateOf(iface, address);
        state.VALUES[datapoint] = casted;

        if (parameter.OPERATIONS & 4) {
            const events =
                parameter.TYPE === 'ACTION'
                    ? [[address, datapoint, casted]]
                    : Object.keys(state.VALUES).map((name) => [
                          address,
                          name,
                          this.reportedValue(iface, address, name, state.VALUES[name]),
                      ]);
            this.eventMulticall(iface, events);
        }
    }

    /* ------------------------------------------------------------------ servers */

    startServers() {
        const {
            listenAddress,
            binrpcListenPort,
            xmlrpcListenPort,
            virtualListenPort,
            cuxdListenPort,
            virtualPath = '/groups',
        } = this.config;

        // TLS and basic auth are off unless asked for, so that existing setups see no change
        this.tls = resolveTls(this.options.tls);
        this.auth = this.options.auth || null;
        const auth = this.auth;

        const binrpcServer = (iface, port, label) => {
            const {onListening, onError} = this.listeningCallbacks(iface, label, listenAddress);
            return createBinrpcServer({
                host: listenAddress,
                port,
                dispatch: (method, params, callback, context) =>
                    this.dispatch(iface, method, params, callback, context),
                onListening,
                onError,
            });
        };

        const xmlrpcServer = (iface, port, label, path) => {
            const {onListening, onError} = this.listeningCallbacks(iface, label, listenAddress);
            return createXmlrpcServer({
                host: listenAddress,
                port,
                path,
                tls: this.tls,
                auth,
                dispatch: (method, params, callback, context) =>
                    this.dispatch(iface, method, params, callback, context),
                onListening,
                onError,
            });
        };

        // rfd and hs485d answer BIN-RPC and XML-RPC on the same port; `protocols` narrows it
        const bidcosServer = (iface, port, label) => {
            const protocols = this.interfaceOption(iface, 'protocols') || ['binrpc', 'xmlrpc'];
            if (protocols.length === 1 && protocols[0] === 'binrpc') {
                return binrpcServer(iface, port, `${label} binrpc`);
            }
            const {onListening, onError} = this.listeningCallbacks(iface, label, listenAddress);
            return createDualServer({
                host: listenAddress,
                port,
                protocols,
                tls: this.tls,
                auth,
                dispatch: (method, params, callback, context) =>
                    this.dispatch(iface, method, params, callback, context),
                onListening,
                onError,
            });
        };

        // the factory of an interface is kept so that dropConnection() can restart its server
        const start = (iface, port, factory) => {
            if (this.interfaceOption(iface, 'startDelay') > 0) {
                this.delayedStarts[iface] = this.interfaceOption(iface, 'startDelay');
            }
            this.serverFactories[iface] = factory;
            this.servers[iface] = factory(port);
            this.exposeServer(iface);
        };

        if (this.devices.rfd) {
            start('rfd', binrpcListenPort, (port) => bidcosServer('rfd', port, 'rfd'));
        }

        if (this.devices.wired) {
            start('wired', this.config.wiredListenPort, (port) => bidcosServer('wired', port, 'wired'));
        }

        if (this.devices.hmip) {
            start('hmip', xmlrpcListenPort, (port) => xmlrpcServer('hmip', port, 'hmip xmlrpc'));
        }

        if (virtualListenPort !== undefined) {
            start('virtual', virtualListenPort, (port) =>
                xmlrpcServer('virtual', port, 'VirtualDevices xmlrpc', virtualPath),
            );
        }

        if (cuxdListenPort !== undefined) {
            start('cuxd', cuxdListenPort, (port) => binrpcServer('cuxd', port, 'CUxD binrpc'));
        }
    }

    /** Keeps the historical property names (sim.rfdServer, sim.hmipServer, ...) pointing at the server. */
    exposeServer(iface) {
        this[`${iface}Server`] = this.servers[iface];
    }

    /**
     * Registers a `whenReady()` promise for one server and returns its listening/error callbacks.
     * The port a server actually got - which matters when it was configured as 0 - lands in
     * `sim.ports[iface]`.
     */
    listeningCallbacks(iface, label, host) {
        let resolve;
        let reject;
        this.ready.push(
            new Promise((resolveReady, rejectReady) => {
                resolve = resolveReady;
                reject = rejectReady;
            }),
        );

        return {
            onListening: (server) => {
                const port = serverPort(server);
                this.ports[iface] = port;
                this.log.info(label, 'server listening on', host, port);
                const delay = this.delayedStarts[iface];
                if (delay !== undefined) {
                    // the port is known now; it refuses connections until the delay is over
                    delete this.delayedStarts[iface];
                    this.stopped.add(iface);
                    server.close();
                    this.log.info(label, 'starts in', delay, 'ms');
                    this.timer(() => this.startInterface(iface, {forgetClients: false}), delay);
                }
                resolve();
            },
            onError: (error) => {
                this.log.error(label, 'server error:', error.message);
                reject(error);
            },
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
        for (const handle of this.timers) {
            clearTimeout(handle);
        }
        this.timers.clear();
        for (const [iface, server] of Object.entries(this.servers)) {
            // a stopped server is closed already, and binrpc's close() rejects a second time
            if (typeof server.close === 'function' && !this.stopped.has(iface)) {
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

/** The port a binrpc or xmlrpc server is actually listening on. */
function serverPort(server) {
    const underlying = server.server || server.httpServer;
    const address = underlying && underlying.address();
    return address ? address.port : undefined;
}

/**
 * The parts of a callback url: `{protocol: 'binrpc'|'http'|'https', host, port, path}`, or
 * undefined when it is none.
 */
function parseCallbackUrl(url) {
    const match = /^([A-Za-z_]+):\/\/(\[[^\]]+\]|[^/:]+):(\d+)(\/.*)?$/.exec(String(url));
    if (!match) {
        return undefined;
    }
    const scheme = match[1].toLowerCase();
    const protocol = scheme === 'xmlrpc_bin' || scheme === 'binrpc' ? 'binrpc' : scheme;
    if (!['binrpc', 'http', 'https', 'xmlrpc'].includes(protocol)) {
        return undefined;
    }
    return {
        protocol: protocol === 'xmlrpc' ? 'http' : protocol,
        host: match[2].replace(/^\[|\]$/g, ''),
        port: Number(match[3]),
        path: match[4] || '/',
    };
}

function isThenable(value) {
    return value !== null && typeof value === 'object' && typeof value.then === 'function';
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
