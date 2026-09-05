#!/usr/bin/env node

'use strict';

/**
 * Builds simulator fixtures from a paramset description dump.
 *
 * node-red-contrib-ccu caches every paramset description it ever read in `paramsets.json`, keyed
 * `<interface>/<deviceType>/<firmware>/<version>/<channelType>/<paramset>` - the same key the
 * simulator uses. That cache is the only large collection of *real* descriptions from real
 * firmware that exists outside a CCU, so it is what the simulator's device types come from.
 *
 * What the cache does not contain is the channel layout: it knows that an HmIP-PDT has a
 * DIMMER_VIRTUAL_RECEIVER channel type, not that it sits on channel 4. The indexes are therefore
 * synthesised from tools/device-layouts.json - consistent within a fixture, not guaranteed to
 * match the hardware. See the comment at the top of that file.
 *
 * Usage:
 *   node tools/fixtures-from-paramsets.js --source <paramsets.json> [options]
 *
 *   --source <file>    the paramset description dump (required)
 *   --out <file>       output file, default data/fixtures/devices.json
 *   --types <list>     comma separated device types, default the list in DEFAULT_TYPES
 *   --layouts <file>   channel layouts, default tools/device-layouts.json
 *   --list             print the device types the source knows and exit
 */

const fs = require('node:fs');
const path = require('node:path');
const {parseArgs} = require('node:util');

/** the device types roadmap task 5 asks for */
const DEFAULT_TYPES = [
    'HmIP-PDT',
    'HmIP-WRC2',
    'HmIPW-DRS8',
    'HmIPW-DRI16',
    'HmIPW-DRAP',
    'HM-LC-Sw1-Pl',
    'HM-PB-2-WM55',
    'HM-CC-RT-DN',
    'HM-SEC-SC-2',
];

/** paramset description key -> interface key of the simulator */
const IFACE_OF_PREFIX = {
    'BidCos-RF': 'rfd',
    'BidCos-Wired': 'wired',
    'HmIP-RF': 'hmip',
    VirtualDevices: 'virtual',
    CUxD: 'cuxd',
};

const {values: args} = parseArgs({
    options: {
        source: {type: 'string'},
        out: {type: 'string'},
        types: {type: 'string'},
        layouts: {type: 'string'},
        list: {type: 'boolean', default: false},
        help: {type: 'boolean', short: 'h', default: false},
    },
});

const USAGE = `Usage: node tools/fixtures-from-paramsets.js --source <paramsets.json> [options]

  --source <file>    the paramset description dump (required)
  --out <file>       output file, default data/fixtures/devices.json
  --types <list>     comma separated device types, default:
                     ${DEFAULT_TYPES.join(', ')}
  --layouts <file>   channel layouts, default tools/device-layouts.json
  --list             print the device types the source knows and exit
  -h, --help`;

if (args.help || !args.source) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
}

const source = JSON.parse(fs.readFileSync(args.source, 'utf8'));
const layouts = JSON.parse(fs.readFileSync(args.layouts || path.join(__dirname, 'device-layouts.json'), 'utf8'));

/** {prefix, type, firmware, version, channelType, paramset} of every key of the dump */
function parseKey(key) {
    const [prefix, type, firmware, version, channelType, paramset] = key.split('/');
    return {prefix, type, firmware, version, channelType, paramset};
}

if (args.list) {
    const types = new Map();
    for (const key of Object.keys(source)) {
        const {prefix, type, firmware, version} = parseKey(key);
        types.set(
            `${prefix}/${type}/${firmware}/${version}`,
            (types.get(`${prefix}/${type}/${firmware}/${version}`) || 0) + 1,
        );
    }
    for (const [name, count] of [...types].sort()) {
        console.log(`${count}\t${name}`);
    }
    process.exit(0);
}

const wanted = (args.types ? args.types.split(',') : DEFAULT_TYPES).map((type) => type.trim());

/** Groups the dump by device: one entry per interface/type/firmware/version. */
function groupByDevice() {
    const devices = new Map();
    for (const key of Object.keys(source)) {
        const parsed = parseKey(key);
        if (!wanted.includes(parsed.type)) {
            continue;
        }
        const id = [parsed.prefix, parsed.type, parsed.firmware, parsed.version].join('/');
        if (!devices.has(id)) {
            devices.set(id, {...parsed, channelTypes: new Map(), keys: []});
        }
        const entry = devices.get(id);
        entry.keys.push(key);
        if (!entry.channelTypes.has(parsed.channelType)) {
            entry.channelTypes.set(parsed.channelType, new Set());
        }
        entry.channelTypes.get(parsed.channelType).add(parsed.paramset);
    }
    return devices;
}

/** MAINTENANCE first, then the layout of the device type, then whatever is left over. */
function channelOrder(type, channelTypes) {
    const available = [...channelTypes.keys()].filter((name) => name !== '' && name !== 'MAINTENANCE');
    const layout = layouts[type];
    const order = [];

    if (channelTypes.has('MAINTENANCE')) {
        order.push('MAINTENANCE');
    }

    const push = (name, count) => {
        for (let index = 0; index < count; index++) {
            order.push(name);
        }
    };

    if (layout) {
        for (const name of layout.order) {
            if (channelTypes.has(name)) {
                push(name, (layout.counts && layout.counts[name]) || 1);
            }
        }
        for (const name of available) {
            if (!layout.order.includes(name)) {
                push(name, 1);
            }
        }
    } else {
        for (const name of available) {
            push(name, 1);
        }
    }

    return order;
}

/**
 * DIRECTION as the CCU reports it: 0 none, 1 sender, 2 receiver. Derived from the channel type's
 * name, which is how the naming convention of the firmware works.
 */
function directionOf(channelType) {
    if (channelType === 'MAINTENANCE' || channelType === '') {
        return 0;
    }
    if (/RECEIVER$/.test(channelType)) {
        return 2;
    }
    if (/(TRANSMITTER|TRANSCEIVER|KEY|SWITCH|SENSOR|CONTACT)/.test(channelType)) {
        return 1;
    }
    return 0;
}

/** A deterministic serial per device, so that a regenerated fixture keeps its addresses. */
function serialOf(prefix, type, index) {
    const letters = type
        .replace(/[^A-Za-z]/g, '')
        .toUpperCase()
        .slice(0, 3)
        .padEnd(3, 'X');
    return prefix === 'HmIP-RF'
        ? `0001${letters}${String(index).padStart(7, '0')}`
        : `${letters}${String(index).padStart(7, '0')}`;
}

function build() {
    const devicesByIface = {};
    const descriptions = {};
    const report = [];
    let counter = 0;

    for (const [id, entry] of [...groupByDevice()].sort()) {
        const iface = IFACE_OF_PREFIX[entry.prefix] || entry.prefix;
        devicesByIface[iface] = devicesByIface[iface] || {devices: []};

        counter += 1;
        const address = serialOf(entry.prefix, entry.type, counter);
        const order = channelOrder(entry.type, entry.channelTypes);
        const children = order.map((_, index) => `${address}:${index}`);

        const deviceParamsets = [...(entry.channelTypes.get('') || ['MASTER'])];
        devicesByIface[iface].devices.push({
            ADDRESS: address,
            CHILDREN: children,
            FIRMWARE: entry.firmware,
            FLAGS: 1,
            INTERFACE: entry.prefix === 'HmIP-RF' ? 'HmIP-RF' : 'BidCoS-RF',
            PARAMSETS: deviceParamsets,
            PARENT: '',
            RF_ADDRESS: 1_000_000 + counter,
            ROAMING: 0,
            RX_MODE: entry.prefix === 'HmIP-RF' ? 12 : 1,
            TYPE: entry.type,
            VERSION: Number(entry.version),
        });

        for (const [index, channelType] of order.entries()) {
            devicesByIface[iface].devices.push({
                ADDRESS: `${address}:${index}`,
                AES_ACTIVE: 0,
                DIRECTION: directionOf(channelType),
                FLAGS: 1,
                INDEX: index,
                LINK_SOURCE_ROLES: '',
                LINK_TARGET_ROLES: '',
                PARAMSETS: [...entry.channelTypes.get(channelType)].sort(),
                PARENT: address,
                PARENT_TYPE: entry.type,
                TYPE: channelType,
                VERSION: Number(entry.version),
            });
        }

        for (const key of entry.keys) {
            descriptions[key] = source[key];
        }

        report.push(`${id}: ${order.length} channels (${new Set(order).size} channel types)`);
    }

    return {devices: devicesByIface, paramsetDescriptions: descriptions, report};
}

const {devices, paramsetDescriptions, report} = build();
const outFile = args.out || path.join(__dirname, '..', 'data', 'fixtures', 'devices.json');
fs.mkdirSync(path.dirname(outFile), {recursive: true});
fs.writeFileSync(outFile, JSON.stringify({devices, paramsetDescriptions}, null, 2) + '\n');

for (const line of report) {
    console.log(line);
}
console.log(
    `\n${report.length} devices, ${Object.keys(paramsetDescriptions).length} paramset descriptions -> ${outFile}`,
);

const missing = wanted.filter(
    (type) => !Object.values(devices).some((entry) => entry.devices.some((device) => device.TYPE === type)),
);
if (missing.length > 0) {
    console.log('not in the source:', missing.join(', '));
}
