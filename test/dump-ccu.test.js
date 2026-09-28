'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

const lab = require('../data/fixtures/lab-2026-09.json');
const {dumpCcu, anonymise} = require('../tools/dump-ccu.js');
const {startSim, fixtures} = require('./helpers.js');

const copy = (value) => JSON.parse(JSON.stringify(value));

/** The interfaces of a running simulator as dump-ccu urls, as InterfacesList.xml writes them. */
function urls(ports) {
    const result = {};
    if (ports.rfd) {
        result.rfd = [`xmlrpc_bin://127.0.0.1:${ports.rfd}`];
    }
    if (ports.wired) {
        result.wired = [`xmlrpc_bin://127.0.0.1:${ports.wired}`];
    }
    if (ports.hmip) {
        result.hmip = [`xmlrpc://127.0.0.1:${ports.hmip}`];
    }
    return result;
}

function startLab(fixture) {
    return startSim({
        devices: copy(fixture.devices),
        paramsetDescriptions: fixture.paramsetDescriptions,
        links: copy(fixture.links || {}),
        bidcosInterfaces: fixture.bidcosInterfaces,
        config: fixture.devices.wired ? {wiredListenPort: 0} : {},
    });
}

describe('tools/dump-ccu.js', () => {
    it('dumps the simulator: load -> dump -> the same devices, descriptions, links and radios', async () => {
        const {sim, ports} = await startLab(lab);
        try {
            const {fixture, warnings} = await dumpCcu({interfaces: urls(ports), keepSerials: true});
            assert.deepEqual(warnings, []);
            assert.deepEqual(fixture.devices, lab.devices);
            assert.deepEqual(fixture.paramsetDescriptions, lab.paramsetDescriptions);
            assert.deepEqual(fixture.links, lab.links);
            // hs485d knows no listBidcosInterfaces; the simulator answers it for every interface
            assert.deepEqual(fixture.bidcosInterfaces.rfd, lab.bidcosInterfaces.rfd);
            assert.deepEqual(fixture.bidcosInterfaces.hmip, lab.bidcosInterfaces.hmip);
        } finally {
            sim.close();
        }
    });

    it('anonymises consistently: the dump of the dump loads and has the same shape', async () => {
        const {sim, ports} = await startSim({paramsetFallback: false});
        let fixture;
        let missing;
        try {
            ({fixture} = await dumpCcu({interfaces: urls(ports)}));
            missing = sim.getMissingParamsetDescriptions().length;
        } finally {
            sim.close();
        }

        const text = JSON.stringify(fixture);
        const original = fixtures.devices();
        for (const {devices} of Object.values(original)) {
            for (const device of devices) {
                assert.equal(text.includes(device.ADDRESS.split(':')[0]), false, `${device.ADDRESS} left`);
            }
        }
        // BidCos serials keep their shape, HmIP addresses theirs
        for (const device of fixture.devices.rfd.devices) {
            assert.match(device.ADDRESS, /^(LAB[0-9]{7}|BidCoS-RF)(:[0-9]+)?$/);
        }
        for (const device of fixture.devices.hmip.devices) {
            assert.match(device.ADDRESS, /^([0-9]{14}|HmIP-RCV-1)(:[0-9]+)?$/);
        }
        // the same types and channel layouts, in the same order
        for (const iface of Object.keys(original)) {
            assert.deepEqual(
                fixture.devices[iface].devices.map((device) => [device.TYPE, device.INDEX]),
                original[iface].devices.map((device) => [device.TYPE, device.INDEX]),
            );
        }

        // and the result is a fixture the simulator serves, with the descriptions it had (the
        // small test fixture lacks a few on purpose)
        const second = await startSim({
            devices: copy(fixture.devices),
            paramsetDescriptions: fixture.paramsetDescriptions,
            paramsetFallback: false,
        });
        try {
            assert.equal(second.sim.getMissingParamsetDescriptions().length, missing);
        } finally {
            second.sim.close();
        }
    });

    it('keeps the relation of an SGTIN to its module device and maps link ends', () => {
        const raw = {
            devices: {
                hmip: {
                    devices: [
                        {ADDRESS: '0001A2B3C4D5E6', PARENT: '', TYPE: 'HmIP-RFUSB', CHILDREN: ['0001A2B3C4D5E6:0']},
                        {ADDRESS: '0001A2B3C4D5E6:0', PARENT: '0001A2B3C4D5E6', TYPE: 'MAINTENANCE', INDEX: 0},
                        {ADDRESS: '000F00000000AB', PARENT: '', TYPE: 'HmIP-BBL', CHILDREN: ['000F00000000AB:4']},
                        {ADDRESS: '000F00000000AB:4', PARENT: '000F00000000AB', TYPE: 'BLIND', INDEX: 4},
                    ],
                },
                rfd: {
                    devices: [{ADDRESS: 'XYZ0000042', PARENT: '', TYPE: 'HM-LC-Sw1-Pl-2', INTERFACE: 'QRS1234567'}],
                },
            },
            paramsetDescriptions: {},
            links: {
                hmip: [
                    {
                        SENDER: '0001A2B3C4D5E6:0',
                        RECEIVER: '000F00000000AB:4',
                        FLAGS: 0,
                        NAME: 'mine',
                        DESCRIPTION: 'x',
                    },
                ],
            },
            bidcosInterfaces: {
                hmip: [{ADDRESS: '3014F711A00001A2B3C4D5E6', DESCRIPTION: 'HMIP_CCU2 3014F711A00001A2B3C4D5E6'}],
                rfd: [{ADDRESS: 'QRS1234567'}],
            },
        };
        const done = anonymise(raw);
        const module = done.devices.hmip.devices[0].ADDRESS;
        assert.equal(done.bidcosInterfaces.hmip[0].ADDRESS, `3014F711A0${module}`);
        assert.equal(done.bidcosInterfaces.hmip[0].DESCRIPTION, `HMIP_CCU2 3014F711A0${module}`);
        assert.equal(done.devices.rfd.devices[0].INTERFACE, done.bidcosInterfaces.rfd[0].ADDRESS);
        assert.match(done.devices.rfd.devices[0].INTERFACE, /^LAB[0-9]{7}$/);
        assert.deepEqual(done.links.hmip[0], {
            SENDER: `${module}:0`,
            RECEIVER: `${done.devices.hmip.devices[2].ADDRESS}:4`,
            FLAGS: 0,
            NAME: '',
            DESCRIPTION: '',
        });
        const {devices, links, bidcosInterfaces} = done;
        assert.equal(JSON.stringify({devices, links, bidcosInterfaces}).includes('A2B3C4D5E6'), false);
    });

    it('merges several systems: a device and a description once, the second radio not default', async () => {
        const first = await startLab(lab);
        const other = {...lab.bidcosInterfaces.rfd[0], ADDRESS: 'LAB9999999', DEFAULT: true};
        const second = await startLab({...lab, bidcosInterfaces: {rfd: [other]}});
        try {
            const interfaces = {rfd: [...urls(first.ports).rfd, ...urls(second.ports).rfd]};
            const {fixture} = await dumpCcu({interfaces, keepSerials: true});
            assert.deepEqual(fixture.devices.rfd, lab.devices.rfd);
            assert.deepEqual(fixture.bidcosInterfaces.rfd, [...lab.bidcosInterfaces.rfd, {...other, DEFAULT: false}]);
        } finally {
            first.sim.close();
            second.sim.close();
        }
    });

    it('takes only the device types asked for', async () => {
        const {sim, ports} = await startLab(lab);
        try {
            const {fixture} = await dumpCcu({
                interfaces: urls(ports),
                types: ['HmIP-BBL', 'HMIP-WRC2'],
                keepSerials: true,
            });
            assert.deepEqual(Object.keys(fixture.devices), ['hmip']);
            const types = new Set(fixture.devices.hmip.devices.filter((d) => !d.PARENT).map((d) => d.TYPE));
            assert.deepEqual([...types].sort(), ['HMIP-WRC2', 'HmIP-BBL']);
            assert.ok(Object.keys(fixture.paramsetDescriptions).every((key) => /\/(HmIP-BBL|HMIP-WRC2)\//.test(key)));
            // the link from the remote to the blind is kept, links to devices left out are not
            assert.ok(fixture.links.hmip.length > 0);
        } finally {
            sim.close();
        }
    });
});
