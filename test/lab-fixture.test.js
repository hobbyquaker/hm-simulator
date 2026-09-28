'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const lab = require('../data/fixtures/lab-2026-09.json');
const layouts = require('../tools/device-layouts.json');
const {startSim, binrpcCall, xmlrpcCall} = require('./helpers.js');

/** what may stand where a serial was: the replacements of tools/dump-ccu.js and the centrals */
const ANONYMISED = /^(LAB[0-9]{7}|[0-9]{14}|3014F711A0[0-9]{14}|BidCoS-RF|BidCoS-Wir|HmIP-RCV-1)$/;

const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * `data/fixtures/lab-2026-09.json` is what tools/dump-ccu.js read from four test systems: real
 * listDevices answers, the paramset descriptions of exactly the firmware each device runs, the
 * links and the radio modules, anonymised. The tests keep it that way and check that the
 * simulator serves it without falling back to another firmware's description.
 */
describe('the lab-2026-09 fixture', () => {
    const all = Object.entries(lab.devices).flatMap(([iface, {devices}]) => devices.map((device) => ({iface, device})));

    it('has the device types occulited and the clients meet', () => {
        const types = new Set(all.filter(({device}) => !device.PARENT).map(({device}) => device.TYPE));
        for (const type of [
            'HM-RCV-50',
            'HMW-RCV-50',
            'HmIP-RCV-50',
            'RPI-RF-MOD',
            'HmIP-RFUSB',
            'HmIP-HAP',
            'HM-CC-TC',
            'HM-Sec-SC',
            'HM-LC-Sw1-Pl-2',
            'HmIP-BBL',
            'HMIP-WRC2',
            'HmIP-PDT',
            'HmIPW-DRAP',
            'HmIPW-DRI16',
            'HmIPW-DRS8',
        ]) {
            assert.ok(types.has(type), `${type} is missing`);
        }
    });

    it('carries no serial, address or SGTIN of real hardware', () => {
        for (const {device} of all) {
            assert.match(device.ADDRESS.split(':')[0], ANONYMISED);
            if (device.INTERFACE) {
                assert.match(device.INTERFACE, ANONYMISED);
            }
        }
        for (const list of Object.values(lab.bidcosInterfaces)) {
            for (const entry of list) {
                assert.match(entry.ADDRESS, ANONYMISED);
            }
        }
        for (const list of Object.values(lab.links)) {
            for (const link of list) {
                assert.match(link.SENDER.split(':')[0], ANONYMISED);
                assert.match(link.RECEIVER.split(':')[0], ANONYMISED);
                assert.equal(link.NAME, '');
                assert.equal(link.DESCRIPTION, '');
            }
        }
        // anywhere in the file, descriptions included: nothing shaped like a serial, an HmIP
        // address or an SGTIN but the replacements
        const text = JSON.stringify(lab);
        for (const match of text.matchAll(/\b([A-Z]{3}[0-9]{7}|[0-9A-F]{14}|[0-9A-F]{24})\b/g)) {
            assert.match(match[1], ANONYMISED);
        }
    });

    it('has unique addresses and consistent PARENT/CHILDREN/INDEX', () => {
        for (const [iface, {devices}] of Object.entries(lab.devices)) {
            const byAddress = new Map();
            for (const device of devices) {
                assert.equal(byAddress.has(device.ADDRESS), false, `duplicate ${iface} ${device.ADDRESS}`);
                byAddress.set(device.ADDRESS, device);
            }
            for (const device of devices) {
                if (!device.PARENT) {
                    for (const [index, child] of (device.CHILDREN || []).entries()) {
                        if (child === '') {
                            continue; // the HmIP-RCV-50's trailing empty entry is real
                        }
                        assert.equal(byAddress.get(child).PARENT, device.ADDRESS);
                        assert.equal(byAddress.get(child).INDEX, index);
                    }
                    continue;
                }
                const parent = byAddress.get(device.PARENT);
                assert.ok(parent, `${device.ADDRESS} has no parent`);
                assert.equal(device.ADDRESS, `${device.PARENT}:${device.INDEX}`);
                assert.ok(parent.CHILDREN.includes(device.ADDRESS));
            }
        }
    });

    it('agrees with the measured channel layouts of tools/device-layouts.json', () => {
        const byAddress = new Map(all.map(({device}) => [device.ADDRESS, device]));
        let compared = 0;
        for (const [type, layout] of Object.entries(layouts)) {
            if (!Array.isArray(layout.channels)) {
                continue;
            }
            for (const {device} of all.filter(({device}) => !device.PARENT && device.TYPE === type)) {
                const channels = device.CHILDREN.filter((address) => address !== '').map(
                    (address) => byAddress.get(address).TYPE,
                );
                assert.deepEqual(channels, layout.channels, `${type} layout differs from the dump`);
                compared += 1;
            }
        }
        assert.ok(compared >= 5, `only ${compared} device(s) compared`);
    });

    describe('served by the simulator', () => {
        let sim;
        let ports;
        let rfd;
        let rfdXml;
        let wired;
        let hmip;

        before(async () => {
            ({sim, ports} = await startSim({
                devices: copy(lab.devices),
                paramsetDescriptions: lab.paramsetDescriptions,
                links: copy(lab.links),
                bidcosInterfaces: lab.bidcosInterfaces,
                paramsetFallback: false,
                config: {wiredListenPort: 0},
            }));
            rfd = binrpcCall(ports.rfd);
            rfdXml = xmlrpcCall(ports.rfd);
            wired = binrpcCall(ports.wired);
            hmip = xmlrpcCall(ports.hmip);
        });

        after(() => {
            rfd.close();
            wired.close();
            sim.close();
        });

        it('needs no fallback: every paramset has the description of its exact firmware', () => {
            assert.deepEqual(sim.getMissingParamsetDescriptions(), []);
        });

        it('answers listDevices with the fixture over both transports', async () => {
            const addresses = (list) => list.map((device) => device.ADDRESS).sort();
            const expected = (iface) => addresses(lab.devices[iface].devices);
            assert.deepEqual(addresses(await rfd('listDevices', [])), expected('rfd'));
            assert.deepEqual(addresses(await rfdXml('listDevices', [])), expected('rfd'));
            assert.deepEqual(addresses(await wired('listDevices', [])), expected('wired'));
            assert.deepEqual(addresses(await hmip('listDevices', [])), expected('hmip'));
        });

        it('answers getParamset VALUES for every channel that has one', async () => {
            const call = {rfd, wired, hmip};
            let read = 0;
            for (const {iface, device} of all) {
                if (!device.PARENT || !device.PARAMSETS.includes('VALUES')) {
                    continue;
                }
                const values = await call[iface]('getParamset', [device.ADDRESS, 'VALUES']);
                assert.equal(typeof values, 'object', `${iface} ${device.ADDRESS}`);
                assert.equal(values.faultCode, undefined, `${iface} ${device.ADDRESS}: ${values.faultString}`);
                read += 1;
            }
            assert.ok(read > 100, `only ${read} channels read`);
        });

        it('answers getParamsetDescription MASTER of a device over XML-RPC and BIN-RPC', async () => {
            const bbl = lab.devices.hmip.devices.find((device) => device.TYPE === 'HmIP-BBL');
            const key = `HmIP-RF/HmIP-BBL/${bbl.FIRMWARE}/${bbl.VERSION}//MASTER`;
            assert.deepEqual(
                await hmip('getParamsetDescription', [bbl.ADDRESS, 'MASTER']),
                lab.paramsetDescriptions[key],
            );
            const sw1 = lab.devices.rfd.devices.find(
                (device) => device.PARENT_TYPE === 'HM-LC-Sw1-Pl-2' && device.INDEX === 1,
            );
            const description = await rfd('getParamsetDescription', [sw1.ADDRESS, 'VALUES']);
            assert.equal(description.STATE.TYPE, 'BOOL');
        });

        it('has the direct links the systems had, among them the WRC2 on the BBL', async () => {
            const links = await hmip('getLinks', []);
            assert.equal(links.length, lab.links.hmip.length);
            const bbl = lab.devices.hmip.devices.find((device) => device.TYPE === 'HmIP-BBL');
            const wrc2 = new Set(
                lab.devices.hmip.devices
                    .filter((device) => device.TYPE === 'HMIP-WRC2')
                    .map((device) => device.ADDRESS),
            );
            assert.ok(
                links.some(
                    (link) => wrc2.has(link.SENDER.split(':')[0]) && link.RECEIVER.startsWith(`${bbl.ADDRESS}:`),
                ),
            );
        });

        it('lists the radio modules; the HmIP one is the SGTIN of a device it lists', async () => {
            assert.deepEqual(await rfd('listBidcosInterfaces', []), lab.bidcosInterfaces.rfd);
            const [module] = await hmip('listBidcosInterfaces', []);
            const device = lab.devices.hmip.devices.find((entry) => entry.ADDRESS === module.ADDRESS.slice(10));
            assert.ok(device, 'the HmIP radio module is not in listDevices');
            assert.match(device.TYPE, /^(HmIP-RFUSB|RPI-RF-MOD)$/);
        });
    });
});
