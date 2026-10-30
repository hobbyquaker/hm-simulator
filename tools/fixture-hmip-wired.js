#!/usr/bin/env node

'use strict';

/**
 * Builds `data/fixtures/hmip-wired.json`: an HmIP-Wired distribution board - an HmIPW-DRBL4 blind
 * actuator, HmIPW-DRI32 and HmIPW-DRI16 input modules and an HmIPW-WRC6 wall button - with links
 * from the inputs and buttons to the actuator whose LINK paramsets carry what the CCU's WebUI
 * writes for the profile chosen.
 *
 * - HmIPW-DRBL4 (1.6.0), HmIPW-DRI32 (1.2.2), HmIPW-WRC6 (1.0.8): device and paramset descriptions
 *   (MASTER, VALUES, LINK, SERVICE) of pydevccu (https://github.com/danielperna84/pydevccu, MIT),
 *   which are `listDevices`/`getParamsetDescription` answers of a CCU's hmipserver.
 * - HmIPW-DRI16 (1.4.6): as `data/fixtures/lab-2026-09.json` has it (a test system, 3.89.11).
 * - The link paramsets: the description's defaults with the profile's presets of the WebUI's
 *   easymode file (`<RECEIVER>/<SENDER>.tcl`) on top - eQ-3's current WebUI source in OpenCCU-Base
 *   (`src/webui/www/config/easymodes`), or for the link marked `webui: '3.87'` the WebUI tree of
 *   firmware 3.87 (`www/config/easymodes`), whose shutter profiles still wrote
 *   `LONG_PROFILE_ACTION_TYPE` 5 (eQ-3 changed it to 1 in June 2026) - the first
 *   value where the file lists several and the default value of a `{default range min - max}`, as
 *   the WebUI's profile form starts out and writes them unchanged.
 *
 * Addresses are replaced by `00000000000101`-style ones (the DRI16 keeps the lab fixture's), the
 * RF addresses by made-up numbers; types, firmware, versions, flags and channel layouts stay.
 *
 * Usage:
 *   node tools/fixture-hmip-wired.js --pydevccu <pydevccu package dir> --base ../OpenCCU-Base [--out <file>]
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/** The pydevccu devices and the addresses they get. */
const DEVICES = [
    {type: 'HmIPW-DRBL4', address: '00000000000101', rfAddress: 1048833},
    {type: 'HmIPW-DRI32', address: '00000000000102', rfAddress: 1048834},
    {type: 'HmIPW-WRC6', address: '00000000000103', rfAddress: 1048835},
];

/**
 * The links and the WebUI profile each was made with. The DRBL4 runs its channels as shutters
 * (`CHANNEL_OPERATION_MODE` SHUTTER, the default), so the WebUI takes the SHUTTER_VIRTUAL_RECEIVER
 * profiles; an input in key mode (`CHANNEL_OPERATION_MODE` KEY_BEHAVIOR) is
 * MULTI_MODE_INPUT_TRANSMITTER_1.
 */
const LINKS = [
    {
        sender: 'DRI32:2',
        receiver: 'DRBL4:3',
        folder: 'SHUTTER_VIRTUAL_RECEIVER',
        file: 'MULTI_MODE_INPUT_TRANSMITTER_1',
        profile: 3,
        webui: '3.87',
    },
    {
        sender: 'DRI32:1',
        receiver: 'DRBL4:2',
        folder: 'SHUTTER_VIRTUAL_RECEIVER',
        file: 'MULTI_MODE_INPUT_TRANSMITTER_1',
        profile: 3,
    },
    {
        sender: 'DRI16:1',
        receiver: 'DRBL4:6',
        folder: 'SHUTTER_VIRTUAL_RECEIVER',
        file: 'MULTI_MODE_INPUT_TRANSMITTER_1',
        profile: 1,
    },
    {sender: 'WRC6:1', receiver: 'DRBL4:10', folder: 'SHUTTER_VIRTUAL_RECEIVER', file: 'KEY_TRANSCEIVER', profile: 3},
    {sender: 'WRC6:2', receiver: 'DRBL4:14', folder: 'SHUTTER_VIRTUAL_RECEIVER', file: 'KEY_TRANSCEIVER', profile: 4},
];

function parseArgs(argv) {
    const args = {out: path.join(ROOT, 'data', 'fixtures', 'hmip-wired.json')};
    for (let i = 0; i < argv.length; i++) {
        const name = argv[i].replace(/^--/, '');
        if (['pydevccu', 'base', 'out'].includes(name)) {
            args[name] = argv[++i];
        } else {
            throw new Error(`unknown argument ${argv[i]}`);
        }
    }
    if (!args.pydevccu || !args.base) {
        throw new Error('usage: fixture-hmip-wired.js --pydevccu <dir> --base <OpenCCU-Base> [--out <file>]');
    }
    return args;
}

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The first word of a Tcl preset: `{1 2 5}` -> `1`, `{0.4 range 0.0 - 25.5}` -> `0.4`, `$OFF` -> its value. */
function presetValue(raw, variables) {
    let text = raw.trim();
    const subst = /^\[subst \{(.*)\}\]$/.exec(text);
    if (subst) {
        text = subst[1];
    } else if (text.startsWith('{') && text.endsWith('}')) {
        text = text.slice(1, -1);
    }
    let first = text.trim().split(/\s+/)[0];
    if (first.startsWith('$')) {
        first = variables[first.slice(1)];
    }
    const number = Number(first);
    return first === undefined || first === '' || Number.isNaN(number) ? undefined : number;
}

/** The presets of one profile of a WebUI easymode file. */
function profilePresets(file, profile) {
    const tcl = fs.readFileSync(file, 'latin1');
    const variables = {};
    for (const match of tcl.matchAll(/^set ([A-Z_][A-Z0-9_]*) (\S+)\s*$/gm)) {
        variables[match[1]] = match[2];
    }
    const presets = {};
    const pattern = new RegExp(`^set PROFILE_${profile}\\(([A-Z0-9_]+)\\)\\s+(.+)$`, 'gm');
    for (const match of tcl.matchAll(pattern)) {
        if (match[1].startsWith('UI_')) {
            continue;
        }
        const value = presetValue(match[2], variables);
        if (value !== undefined) {
            presets[match[1]] = value;
        }
    }
    if (Object.keys(presets).length === 0) {
        throw new Error(`${file} has no profile ${profile}`);
    }
    return presets;
}

function defaultOf(parameter) {
    if (parameter.TYPE === 'ENUM') {
        const index = parameter.VALUE_LIST.indexOf(parameter.DEFAULT);
        return Number.isInteger(parameter.DEFAULT) ? parameter.DEFAULT : Math.max(index, 0);
    }
    return parameter.DEFAULT;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const lab = readJson(path.join(ROOT, 'data', 'fixtures', 'lab-2026-09.json'));

    const devices = [];
    const paramsetDescriptions = {};
    const addresses = {};

    for (const {type, address, rfAddress} of DEVICES) {
        const list = readJson(path.join(args.pydevccu, 'device_descriptions', `${type}.json`));
        const descriptions = readJson(path.join(args.pydevccu, 'paramset_descriptions', `${type}.json`));
        const original = list.find((entry) => !entry.PARENT).ADDRESS;
        const rename = (text) => String(text).replace(original, address);
        addresses[type.replace('HmIPW-', '')] = address;

        for (const entry of list) {
            const copy = {
                ...entry,
                ADDRESS: rename(entry.ADDRESS),
                PARENT: entry.PARENT ? rename(entry.PARENT) : '',
                CHILDREN: (entry.CHILDREN || []).map(rename),
                RF_ADDRESS: entry.PARENT ? 0 : rfAddress,
            };
            devices.push(copy);
            const parent = list.find((item) => item.ADDRESS === (entry.PARENT || entry.ADDRESS));
            for (const [paramset, description] of Object.entries(descriptions[entry.ADDRESS] || {})) {
                const key = [
                    'HmIP-RF',
                    parent.TYPE,
                    parent.FIRMWARE,
                    parent.VERSION,
                    entry.PARENT ? entry.TYPE : '',
                    paramset,
                ].join('/');
                paramsetDescriptions[key] = description;
            }
        }
    }

    const dri16 = lab.devices.hmip.devices.filter(
        (entry) => entry.TYPE === 'HmIPW-DRI16' || entry.PARENT_TYPE === 'HmIPW-DRI16',
    );
    addresses.DRI16 = dri16.find((entry) => !entry.PARENT).ADDRESS;
    devices.push(...dri16);
    for (const [key, description] of Object.entries(lab.paramsetDescriptions)) {
        if (key.startsWith('HmIP-RF/HmIPW-DRI16/')) {
            paramsetDescriptions[key] = description;
        }
    }

    const resolve = (name) => {
        const [device, channel] = name.split(':');
        return `${addresses[device]}:${channel}`;
    };
    const byAddress = new Map(devices.map((entry) => [entry.ADDRESS, entry]));
    const linkDescription = (address) => {
        const channel = byAddress.get(address);
        const parent = byAddress.get(channel.PARENT);
        return paramsetDescriptions[
            ['HmIP-RF', parent.TYPE, parent.FIRMWARE, parent.VERSION, channel.TYPE, 'LINK'].join('/')
        ];
    };

    const links = [];
    const paramsets = {};
    for (const link of LINKS) {
        const sender = resolve(link.sender);
        const receiver = resolve(link.receiver);
        links.push({SENDER: sender, RECEIVER: receiver, FLAGS: 0, NAME: '', DESCRIPTION: ''});

        const description = linkDescription(receiver);
        const presets = profilePresets(
            path.join(
                args.base,
                ...(link.webui === '3.87' ? ['www'] : ['src', 'webui', 'www']),
                'config',
                'easymodes',
                link.folder,
                `${link.file}.tcl`,
            ),
            link.profile,
        );
        const values = {};
        for (const [name, parameter] of Object.entries(description)) {
            values[name] = presets[name] === undefined ? defaultOf(parameter) : presets[name];
        }
        paramsets[receiver] = {...paramsets[receiver], [sender]: values};
    }

    const fixture = {
        _comment: [
            'An HmIP-Wired distribution board: HmIPW-DRBL4 1.6.0, HmIPW-DRI32 1.2.2 and HmIPW-WRC6 1.0.8 with the',
            "descriptions of pydevccu (MIT, a CCU's hmipserver answers), HmIPW-DRI16 1.4.6 from lab-2026-09.json, and five",
            "links to the DRBL4 (run as shutters) whose LINK paramsets hold what the CCU's WebUI writes for the profile:",
            LINKS.map(
                (link) =>
                    `${link.sender} -> ${link.receiver} ${link.folder}/${link.file} profile ${link.profile}` +
                    (link.webui ? ` (the WebUI of ${link.webui})` : ''),
            ).join('; '),
            'Generated by tools/fixture-hmip-wired.js; addresses replaced.',
        ],
        devices: {hmip: {devices}},
        paramsetDescriptions,
        links: {hmip: links},
        paramsets: {hmip: paramsets},
    };
    fs.writeFileSync(args.out, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`${args.out}: ${devices.length} devices and channels, ${links.length} links`);
}

if (require.main === module) {
    main();
}

module.exports = {presetValue, profilePresets};
