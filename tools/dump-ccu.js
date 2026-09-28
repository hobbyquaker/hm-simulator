#!/usr/bin/env node

'use strict';

/**
 * Dumps the devices of a CCU's interface processes into a simulator fixture.
 *
 * Reads `listDevices`, `getParamsetDescription` for every paramset each device and channel
 * announces (MASTER, VALUES, SERVICE, LINK), `getLinks` and `listBidcosInterfaces` from each
 * interface given, and writes `{devices, paramsetDescriptions, links, bidcosInterfaces}` keyed the
 * way the simulator keys them - a file the simulator loads as it is (`--devices <file>` on the
 * command line, or the four properties as constructor options).
 *
 * Only reading calls are made. Every interface may be given more than once (several CCUs into one
 * fixture): a device that two of them report is kept once, and so is each paramset description.
 *
 * Unless `--keep-serials` is given the output is anonymised: every serial - device addresses, the
 * serial part of channel addresses, `PARENT`, `CHILDREN`, `INTERFACE`, the radio modules' own
 * entries (an HmIP module's address is its SGTIN), link ends, team and group members - is replaced
 * by `LAB0000001`-style serials, the same serial always by the same replacement; `RF_ADDRESS` gets
 * a made-up number; link names and descriptions are emptied. Types, firmware, versions, flags and
 * channel layouts stay as the CCU reported them.
 *
 * Usage:
 *   node tools/dump-ccu.js --rfd xmlrpc_bin://127.0.0.1:2001 --hmip xmlrpc://127.0.0.1:2010 --out lab.json
 *
 *   --rfd <url>        BidCos-RF, repeatable
 *   --hmip <url>       HmIP-RF, repeatable
 *   --wired <url>      BidCos-Wired, repeatable
 *   --virtual <url>    VirtualDevices, e.g. xmlrpc://127.0.0.1:9292/groups, repeatable
 *   --cuxd <url>       CUxD, repeatable
 *   --out <file>       the fixture file, default stdout
 *   --types <list>     only these device types (comma separated)
 *   --prefix <text>    the replacement serials' prefix, default LAB
 *   --keep-serials     do not anonymise
 *   --timeout <ms>     per call, default 30000
 *   --comment <text>   a line for the file's `_comment` (repeatable)
 *
 * A url is `xmlrpc_bin://host:port` (BIN-RPC) or `xmlrpc://host:port[/path]` / `http://...` (XML-RPC),
 * as in the CCU's InterfacesList.xml.
 */

const fs = require('node:fs');
const {parseArgs} = require('node:util');

const binrpc = require('binrpc');
const xmlrpc = require('homematic-xmlrpc');

/** simulator interface key -> paramset description key prefix, as lib/sim.js has it */
const PARAMSET_PREFIX = {
    rfd: 'BidCos-RF',
    wired: 'BidCos-Wired',
    hmip: 'HmIP-RF',
    virtual: 'VirtualDevices',
    cuxd: 'CUxD',
};

/** addresses that are the same on every CCU and identify nothing: the centrals, VirtualDevices' groups */
const isCentral = (serial) =>
    serial === 'BidCoS-RF' || serial === 'BidCoS-Wir' || serial === 'HmIP-RCV-1' || /^INT[0-9]{7}$/.test(serial);

/** the eQ-3 company prefix and filter of an HmIP SGTIN, kept in front of an anonymised device address */
const SGTIN_PREFIX = '3014F711A0';

/** what a serial or radio identity of real hardware looks like, for the check after anonymising */
const HARDWARE_ID = [
    /\b(?!INT)[A-Z]{3}[0-9]{7}\b/g, // BidCos serial
    /\b[0-9A-F]{24}\b/g, // SGTIN
    /\b[0-9A-F]{14}\b/g, // HmIP device address
];

/** A BidCos serial, an SGTIN or an HmIP address - not a name such as `HmIP-RF`. */
function looksLikeHardwareId(value) {
    return (
        typeof value === 'string' && /^([A-Z]{3}[0-9]{7}|[0-9A-F]{14}|[0-9A-F]{24})$/.test(value) && !isCentral(value)
    );
}

/**
 * An RPC client for a url of InterfacesList.xml's form.
 * @param {string} url
 * @param {number} timeout
 * @returns {{call: function(string, Array): Promise, close: function()}}
 */
function connect(url, timeout) {
    const parsed = new URL(url.replace(/^xmlrpc_bin:/, 'binrpc:').replace(/^xmlrpc:/, 'http:'));
    const host = parsed.hostname;
    const port = Number(parsed.port);
    let client;
    if (parsed.protocol === 'binrpc:') {
        client = binrpc.createClient({host, port, reconnectTimeout: 0});
    } else if (parsed.protocol === 'http:') {
        client = xmlrpc.createClient({host, port, path: parsed.pathname || '/'});
    } else {
        throw new Error(`unsupported url ${url}`);
    }

    const call = (method, params = []) =>
        new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`${url} ${method}: no answer in ${timeout} ms`)), timeout);
            client.methodCall(method, params, (error, result) => {
                clearTimeout(timer);
                if (error) {
                    reject(error);
                } else if (result && typeof result === 'object' && result.faultCode !== undefined) {
                    // binrpc hands a fault over as a result
                    reject(Object.assign(new Error(String(result.faultString)), {code: result.faultCode}));
                } else {
                    resolve(result);
                }
            });
        });
    const close = () => {
        if (client.socket) {
            client.reconnectTimeout = 0;
            client.socket.destroy();
        }
    };
    return {call, close};
}

/** The serial of an address: `ABC0001234:3` -> `ABC0001234`. */
function serialOf(address) {
    return String(address).split(':')[0];
}

/**
 * Reads one interface process.
 * @param {string} iface simulator interface key
 * @param {{call: Function}} rpc
 * @param {object} fixture filled in place
 * @param {object} options {types}
 */
async function dumpInterface(iface, rpc, fixture, options) {
    const listed = (await rpc.call('listDevices', [])) || [];
    const known = fixture.devices[iface] ? fixture.devices[iface].devices : [];
    const seen = new Set(known.map((device) => device.ADDRESS));
    const byAddress = new Map(listed.map((device) => [device.ADDRESS, device]));

    const rootOf = (device) => (device.PARENT ? byAddress.get(device.PARENT) : device);
    const wanted = (device) => {
        const root = rootOf(device);
        return root !== undefined && (!options.types || options.types.includes(root.TYPE));
    };

    const devices = listed.filter((device) => wanted(device) && !seen.has(device.ADDRESS));
    fixture.devices[iface] = {devices: [...known, ...devices]};

    const prefix = PARAMSET_PREFIX[iface];
    for (const device of devices) {
        const root = rootOf(device);
        const channelType = device.PARENT ? device.TYPE : '';
        for (const paramset of device.PARAMSETS || []) {
            const key = [prefix, root.TYPE, root.FIRMWARE, root.VERSION, channelType, paramset].join('/');
            if (fixture.paramsetDescriptions[key]) {
                continue;
            }
            try {
                fixture.paramsetDescriptions[key] = await rpc.call('getParamsetDescription', [
                    device.ADDRESS,
                    paramset,
                ]);
            } catch (error) {
                fixture.warnings.push(`${iface} ${device.ADDRESS} ${paramset}: ${error.message}`);
            }
        }
    }

    const addresses = new Set(fixture.devices[iface].devices.map((device) => device.ADDRESS));
    try {
        const links = (await rpc.call('getLinks', [])) || [];
        const kept = links
            .filter((link) => addresses.has(link.SENDER) && addresses.has(link.RECEIVER))
            .map((link) => ({
                SENDER: link.SENDER,
                RECEIVER: link.RECEIVER,
                FLAGS: link.FLAGS || 0,
                NAME: link.NAME || '',
                DESCRIPTION: link.DESCRIPTION || '',
            }));
        const existing = fixture.links[iface] || [];
        const key = (link) => `${link.SENDER} ${link.RECEIVER}`;
        const have = new Set(existing.map(key));
        fixture.links[iface] = [...existing, ...kept.filter((link) => !have.has(key(link)))];
    } catch (error) {
        fixture.warnings.push(`${iface} getLinks: ${error.message}`);
    }

    if (iface === 'rfd' || iface === 'wired' || iface === 'hmip') {
        try {
            const interfaces = (await rpc.call('listBidcosInterfaces', [])) || [];
            const existing = fixture.bidcosInterfaces[iface];
            if (!existing) {
                fixture.bidcosInterfaces[iface] = interfaces.map((entry) => ({...entry}));
            } else if (iface !== 'hmip') {
                // a second system's radios join the first one's as further, non-default interfaces;
                // hmipserver has one radio, so HmIP-RF keeps the first system's
                const have = new Set(existing.map((entry) => entry.ADDRESS));
                for (const entry of interfaces) {
                    if (!have.has(entry.ADDRESS)) {
                        existing.push({...entry, DEFAULT: false});
                    }
                }
            }
        } catch (error) {
            fixture.warnings.push(`${iface} listBidcosInterfaces: ${error.message}`);
        }
    }
}

/**
 * Replaces every serial of the fixture, see the comment at the top. Returns a new fixture.
 * @param {object} fixture
 * @param {string} [prefix]
 * @returns {object}
 */
function anonymise(fixture, prefix = 'LAB') {
    const serials = new Map();
    let counter = 0;
    // each kind keeps its shape, because clients tell the interfaces apart by it: a BidCos serial
    // becomes `LAB0000001`, an HmIP address `00000000000002`, an SGTIN `3014F711A0` + the
    // replacement of its device's address (the module's device address is the SGTIN's tail)
    const replacementOf = (serial) => {
        if (!serials.has(serial)) {
            if (/^[0-9A-F]{24}$/.test(serial)) {
                const tail = serial.slice(10);
                serials.set(serial, `${SGTIN_PREFIX}${serials.has(tail) ? serials.get(tail) : replacementOf(tail)}`);
            } else {
                counter += 1;
                serials.set(
                    serial,
                    /^[0-9A-F]{14}$/.test(serial)
                        ? String(counter).padStart(14, '0')
                        : `${prefix}${String(counter).padStart(7, '0')}`,
                );
            }
        }
        return serials.get(serial);
    };

    // the numbering follows the device types, so a second dump of the same systems comes out alike
    const roots = [];
    for (const [iface, {devices}] of Object.entries(fixture.devices)) {
        for (const device of devices) {
            if (!device.PARENT && !isCentral(serialOf(device.ADDRESS))) {
                roots.push({iface, type: device.TYPE, address: device.ADDRESS});
            }
        }
    }
    const ifaceOrder = Object.keys(PARAMSET_PREFIX);
    roots.sort(
        (a, b) =>
            ifaceOrder.indexOf(a.iface) - ifaceOrder.indexOf(b.iface) ||
            a.type.localeCompare(b.type) ||
            a.address.localeCompare(b.address),
    );
    for (const root of roots) {
        replacementOf(serialOf(root.address));
    }
    // the radio modules' serials that appear only as INTERFACE or in listBidcosInterfaces
    for (const devices of Object.values(fixture.devices)) {
        for (const device of devices.devices) {
            if (looksLikeHardwareId(device.INTERFACE)) {
                replacementOf(device.INTERFACE);
            }
        }
    }
    for (const entries of Object.values(fixture.bidcosInterfaces || {})) {
        for (const entry of entries) {
            if (entry.ADDRESS && !isCentral(entry.ADDRESS)) {
                replacementOf(entry.ADDRESS);
            }
        }
    }

    // the longest serial first, so that no serial is replaced inside a longer one
    const ordered = [...serials.keys()].sort((a, b) => b.length - a.length);
    const replaceString = (value) => {
        let result = value;
        for (const serial of ordered) {
            if (result.includes(serial)) {
                result = result.split(serial).join(serials.get(serial));
            }
        }
        return result;
    };
    const walk = (value) => {
        if (typeof value === 'string') {
            return replaceString(value);
        }
        if (Array.isArray(value)) {
            return value.map(walk);
        }
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
        }
        return value;
    };

    const devices = walk(fixture.devices);
    let rfAddress = 0;
    const rfAddresses = new Map();
    for (const {devices: list} of Object.values(devices)) {
        for (const device of list) {
            if (typeof device.RF_ADDRESS === 'number' && device.RF_ADDRESS !== 0) {
                if (!rfAddresses.has(device.RF_ADDRESS)) {
                    rfAddress += 1;
                    rfAddresses.set(device.RF_ADDRESS, 0x100000 + rfAddress);
                }
                device.RF_ADDRESS = rfAddresses.get(device.RF_ADDRESS);
            }
        }
    }

    const links = walk(fixture.links || {});
    for (const list of Object.values(links)) {
        for (const link of list) {
            link.NAME = '';
            link.DESCRIPTION = '';
        }
    }

    return {
        ...fixture,
        devices,
        paramsetDescriptions: walk(fixture.paramsetDescriptions),
        links,
        bidcosInterfaces: walk(fixture.bidcosInterfaces || {}),
        replaced: [...serials.keys()],
        replacements: [...serials.values()],
    };
}

/**
 * @param {object} options
 * @param {object} options.interfaces {<iface>: [url, ...]}
 * @param {string[]} [options.types]
 * @param {boolean} [options.keepSerials]
 * @param {string} [options.prefix]
 * @param {number} [options.timeout]
 * @returns {Promise<{fixture: object, warnings: string[]}>} `fixture` is what goes into the file
 */
async function dumpCcu(options) {
    const timeout = options.timeout || 30000;
    const raw = {devices: {}, paramsetDescriptions: {}, links: {}, bidcosInterfaces: {}, warnings: []};

    for (const [iface, urls] of Object.entries(options.interfaces)) {
        if (!PARAMSET_PREFIX[iface]) {
            throw new Error(`unknown interface ${iface}`);
        }
        for (const url of [].concat(urls)) {
            const rpc = connect(url, timeout);
            try {
                await dumpInterface(iface, rpc, raw, options);
            } finally {
                rpc.close();
            }
        }
    }

    const done = options.keepSerials ? {...raw, replaced: [], replacements: []} : anonymise(raw, options.prefix);
    // an interface without devices, links or radios is left out: the simulator would start it
    const nonEmpty = (object, has) => Object.fromEntries(Object.entries(object).filter(([, value]) => has(value)));
    const fixture = {
        devices: nonEmpty(done.devices, (value) => value.devices.length > 0),
        paramsetDescriptions: sortKeys(done.paramsetDescriptions),
    };
    const links = nonEmpty(done.links, (list) => list.length > 0);
    if (Object.keys(links).length > 0) {
        fixture.links = links;
    }
    const interfaces = nonEmpty(done.bidcosInterfaces, (list) => list.length > 0);
    if (Object.keys(interfaces).length > 0) {
        fixture.bidcosInterfaces = interfaces;
    }

    // the last line of defence: not one replaced serial may be left anywhere in the output
    if (!options.keepSerials) {
        const text = JSON.stringify(fixture);
        const left = done.replaced.filter((serial) => text.includes(serial));
        if (left.length > 0) {
            throw new Error(`${left.length} serial(s) survived the anonymisation: ${left.join(', ')}`);
        }
        const replacements = new Set(done.replacements);
        const suspicious = new Set();
        for (const pattern of HARDWARE_ID) {
            for (const match of text.matchAll(pattern)) {
                if (!replacements.has(match[0])) {
                    suspicious.add(match[0]);
                }
            }
        }
        if (suspicious.size > 0) {
            throw new Error(`${suspicious.size} string(s) that look like hardware ids are left: check the dump`);
        }
    }

    return {fixture, warnings: raw.warnings};
}

function sortKeys(object) {
    return Object.fromEntries(
        Object.keys(object)
            .sort()
            .map((key) => [key, object[key]]),
    );
}

const USAGE = `Usage: node tools/dump-ccu.js --<interface> <url> [...] [options]

  --rfd <url>        BidCos-RF, e.g. xmlrpc_bin://127.0.0.1:2001 (repeatable)
  --hmip <url>       HmIP-RF, e.g. xmlrpc://127.0.0.1:2010 (repeatable)
  --wired <url>      BidCos-Wired, e.g. xmlrpc_bin://127.0.0.1:2000 (repeatable)
  --virtual <url>    VirtualDevices, e.g. xmlrpc://127.0.0.1:9292/groups (repeatable)
  --cuxd <url>       CUxD (repeatable)
  --out <file>       the fixture file, default stdout
  --types <list>     only these device types (comma separated)
  --prefix <text>    the replacement serials' prefix, default LAB
  --keep-serials     do not anonymise
  --timeout <ms>     per call, default 30000
  --comment <text>   a line for the file's _comment (repeatable)
  -h, --help`;

async function main() {
    const {values: args} = parseArgs({
        options: {
            rfd: {type: 'string', multiple: true},
            hmip: {type: 'string', multiple: true},
            wired: {type: 'string', multiple: true},
            virtual: {type: 'string', multiple: true},
            cuxd: {type: 'string', multiple: true},
            out: {type: 'string'},
            types: {type: 'string'},
            prefix: {type: 'string', default: 'LAB'},
            'keep-serials': {type: 'boolean', default: false},
            timeout: {type: 'string', default: '30000'},
            comment: {type: 'string', multiple: true},
            help: {type: 'boolean', short: 'h', default: false},
        },
    });
    const interfaces = {};
    for (const iface of Object.keys(PARAMSET_PREFIX)) {
        if (args[iface]) {
            interfaces[iface] = args[iface];
        }
    }
    if (args.help || Object.keys(interfaces).length === 0) {
        console.log(USAGE);
        process.exit(args.help ? 0 : 1);
    }

    const {fixture, warnings} = await dumpCcu({
        interfaces,
        types: args.types ? args.types.split(',').map((type) => type.trim()) : undefined,
        keepSerials: args['keep-serials'],
        prefix: args.prefix,
        timeout: Number(args.timeout),
    });
    const text = JSON.stringify(args.comment ? {_comment: args.comment, ...fixture} : fixture, null, 2) + '\n';
    if (args.out) {
        fs.writeFileSync(args.out, text);
    } else {
        process.stdout.write(text);
    }

    for (const warning of warnings) {
        console.error('warning:', warning);
    }
    for (const [iface, {devices}] of Object.entries(fixture.devices)) {
        const roots = devices.filter((device) => !device.PARENT);
        console.error(`${iface}: ${roots.length} devices (${roots.map((device) => device.TYPE).join(', ')})`);
    }
    console.error(`${Object.keys(fixture.paramsetDescriptions).length} paramset descriptions`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = {dumpCcu, anonymise, connect};
