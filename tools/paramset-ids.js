#!/usr/bin/env node

'use strict';

/**
 * Builds `data/paramset-ids.json`, what rfd and hs485d answer to `getParamsetId`, from the BidCos
 * device files of a CCU firmware tree (OpenCCU-Base's `firmware/rftypes` and
 * `firmware/hs485types`).
 *
 * Both interface processes answer `getParamsetId(address, MASTER|VALUES|LINK)` with the `id` of the
 * `<paramset>` the device file gives that channel (`cc_tc_ch_weather_master`), or the device's own
 * `<paramset type="MASTER">` for a device address (`cc_tc_dev_master`). The ids are collected per
 * device type and device file `version` (the `VERSION` of the device description), and per channel
 * index:
 *
 *   {"BidCos-RF": {"HM-CC-TC": {"15": {"device": {"MASTER": "cc_tc_dev_master"},
 *                                      "channels": [{"index": 0, "count": 1, "MASTER": "maint_ch_master", ...}]}}}}
 *
 * A type that several files of the same version describe (firmware variants) keeps the first file's
 * ids in name order and every other file's channels that the first lacks.
 *
 * Usage:
 *   node tools/paramset-ids.js --base ../OpenCCU-Base [--out data/paramset-ids.json]
 */

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
    const args = {out: path.join(__dirname, '..', 'data', 'paramset-ids.json')};
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--base') {
            args.base = argv[++i];
        } else if (argv[i] === '--out') {
            args.out = argv[++i];
        } else if (argv[i] === '--help' || argv[i] === '-h') {
            args.help = true;
        } else {
            throw new Error(`unknown argument ${argv[i]}`);
        }
    }
    return args;
}

function attributes(tag) {
    const result = {};
    for (const match of tag.matchAll(/([A-Za-z_]+)="([^"]*)"/g)) {
        result[match[1]] = match[2];
    }
    return result;
}

/** The `<paramset type=... id=...>` tags directly in a piece of the file, by type, the first of each. */
function paramsetIds(xml) {
    const ids = {};
    for (const match of xml.matchAll(/<paramset\s[^>]*>/g)) {
        const {type, id} = attributes(match[0]);
        if (type && id && ids[type] === undefined) {
            ids[type] = id;
        }
    }
    return ids;
}

/**
 * One device file: its version, the type ids it supports, the device's own paramset ids (outside
 * `<channels>`) and every channel's.
 */
function parseDeviceFile(xml) {
    const device = /<device\s[^>]*>/.exec(xml);
    if (!device) {
        return undefined;
    }
    const version = attributes(device[0]).version;
    const types = [];
    const supported = /<supported_types>([\s\S]*?)<\/supported_types>/.exec(xml);
    for (const match of (supported ? supported[1] : '').matchAll(/<type\s[^>]*>/g)) {
        const {id} = attributes(match[0]);
        if (id && !types.includes(id)) {
            types.push(id);
        }
    }

    const channelsStart = xml.indexOf('<channels>');
    const head = channelsStart === -1 ? xml : xml.slice(0, channelsStart);
    // the device's own paramsets, without the ones of <frames> or <supported_types>
    const ownIds = paramsetIds(head.replace(/<supported_types>[\s\S]*?<\/supported_types>/, ''));

    const channels = [];
    if (channelsStart !== -1) {
        const body = xml.slice(channelsStart, xml.indexOf('</channels>', channelsStart));
        const parts = body.split(/(?=<channel\s)/).filter((part) => part.startsWith('<channel '));
        for (const part of parts) {
            const tag = /<channel\s[^>]*>/.exec(part)[0];
            const {index, count, count_from_sysinfo: fromSysinfo} = attributes(tag);
            if (index === undefined) {
                continue;
            }
            const entry = {index: Number(index), count: Number(count || 1)};
            if (count === undefined && fromSysinfo !== undefined) {
                // the number of channels is read from the device; cover what any device has
                entry.count = 255 - entry.index;
            }
            // a channel's alternative layouts (<subconfig>) keep the ids of the main paramsets
            Object.assign(entry, paramsetIds(part.replace(/<subconfig[\s\S]*?<\/subconfig>/g, '')));
            channels.push(entry);
        }
    }

    return {version, types, device: ownIds.MASTER ? {MASTER: ownIds.MASTER} : {}, channels};
}

function collect(dir, iface, out) {
    if (!fs.existsSync(dir)) {
        throw new Error(`${dir} does not exist`);
    }
    const files = fs
        .readdirSync(dir)
        .filter((file) => file.endsWith('.xml'))
        .sort();
    for (const file of files) {
        const parsed = parseDeviceFile(fs.readFileSync(path.join(dir, file), 'latin1'));
        if (!parsed || parsed.version === undefined) {
            continue;
        }
        for (const type of parsed.types) {
            out[iface] = out[iface] || {};
            out[iface][type] = out[iface][type] || {};
            const existing = out[iface][type][parsed.version];
            if (!existing) {
                out[iface][type][parsed.version] = {device: parsed.device, channels: parsed.channels};
                continue;
            }
            for (const channel of parsed.channels) {
                if (!existing.channels.some((known) => known.index === channel.index)) {
                    existing.channels.push(channel);
                }
            }
            existing.channels.sort((a, b) => a.index - b.index);
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || !args.base) {
        console.log('usage: node tools/paramset-ids.js --base <OpenCCU-Base checkout> [--out <file>]');
        process.exit(args.help ? 0 : 1);
    }
    const out = {};
    collect(path.join(args.base, 'firmware', 'rftypes'), 'BidCos-RF', out);
    collect(path.join(args.base, 'firmware', 'hs485types'), 'BidCos-Wired', out);
    const sorted = {};
    for (const iface of Object.keys(out).sort()) {
        sorted[iface] = {};
        for (const type of Object.keys(out[iface]).sort()) {
            sorted[iface][type] = out[iface][type];
        }
    }
    fs.writeFileSync(args.out, JSON.stringify(sorted) + '\n');
    const types = Object.values(sorted).reduce((sum, types) => sum + Object.keys(types).length, 0);
    console.log(`${args.out}: ${types} device types`);
}

if (require.main === module) {
    main();
}

module.exports = {parseDeviceFile};
