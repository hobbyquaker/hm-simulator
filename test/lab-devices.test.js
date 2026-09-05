'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');

const lab = require('../data/fixtures/lab-devices.json');
const layouts = require('../tools/device-layouts.json');

/**
 * `data/fixtures/lab-devices.json` is a real `listDevices` answer of two CCUs on firmware 3.89.8,
 * with the serials anonymised. It is the only fixture in this package whose channel indexes are
 * measured rather than synthesised, so the tests here check that it stayed that way and that
 * `tools/device-layouts.json` still agrees with it.
 */
describe('the lab listDevices fixture', () => {
    const all = [...lab.devices.rfd.devices, ...lab.devices.hmip.devices];

    it('carries no serial of the lab hardware', () => {
        for (const entry of all) {
            const serial = String(entry.ADDRESS).split(':')[0];
            const anonymised = /^LAB[0-9]{7}$/.test(serial);
            const central = serial === 'BidCoS-RF' || serial === 'HmIP-RCV-1';
            assert.ok(anonymised || central, `${entry.ADDRESS} is neither anonymised nor a central channel`);
        }
    });

    it('has unique addresses and consistent PARENT/CHILDREN/INDEX', () => {
        const byAddress = new Map();
        for (const entry of all) {
            assert.equal(byAddress.has(entry.ADDRESS), false, `duplicate address ${entry.ADDRESS}`);
            byAddress.set(entry.ADDRESS, entry);
        }
        for (const entry of all) {
            if (!entry.PARENT) {
                for (const [index, child] of (entry.CHILDREN || []).entries()) {
                    // the CCU's own HmIP-RCV-50 really does send a trailing empty CHILDREN entry -
                    // kept in the fixture on purpose, because an application has to survive it
                    if (child === '') {
                        continue;
                    }
                    assert.equal(byAddress.get(child).PARENT, entry.ADDRESS);
                    assert.equal(byAddress.get(child).INDEX, index);
                }
                continue;
            }
            const parent = byAddress.get(entry.PARENT);
            assert.ok(parent, `${entry.ADDRESS} has no parent`);
            assert.equal(entry.PARENT_TYPE, parent.TYPE);
            assert.equal(entry.ADDRESS, `${entry.PARENT}:${entry.INDEX}`);
        }
    });

    it('is what tools/device-layouts.json says for the measured device types', () => {
        const measured = Object.entries(layouts).filter(([, layout]) => Array.isArray(layout.channels));
        assert.ok(measured.length >= 7, 'the lab layouts are gone from device-layouts.json');

        for (const [type, layout] of measured) {
            const device = all.find((entry) => !entry.PARENT && entry.TYPE === type);
            if (!device) {
                continue; // a layout for a device type the lab does not have
            }
            const channels = (device.CHILDREN || [])
                .filter((address) => address !== '')
                .map((address) => all.find((entry) => entry.ADDRESS === address).TYPE);
            assert.deepEqual(channels, layout.channels, `${type} layout differs from the dump`);
        }
    });

    it('has the channel layout of the devices the write study used', () => {
        const layoutOf = (type) => layouts[type].channels;
        // the two virtual receiver channels of the HmIPW-DRS8 are interleaved with its
        // transmitters, which is what a synthesised layout got wrong
        assert.equal(layoutOf('HmIPW-DRS8')[1], 'SWITCH_TRANSMITTER');
        assert.equal(layoutOf('HmIPW-DRS8')[2], 'SWITCH_VIRTUAL_RECEIVER');
        assert.equal(layoutOf('HmIPW-DRS8')[5], 'SWITCH_TRANSMITTER');
        assert.equal(layoutOf('HmIPW-DRS8').length, 34);
        // the HmIP-PDT's KEY_TRANSCEIVER is channel 1, before the dimmer channels
        assert.deepEqual(layoutOf('HmIP-PDT').slice(0, 4), [
            'MAINTENANCE',
            'KEY_TRANSCEIVER',
            'DIMMER_TRANSMITTER',
            'DIMMER_VIRTUAL_RECEIVER',
        ]);
        assert.deepEqual(layoutOf('HM-CC-TC'), [
            'MAINTENANCE',
            'WEATHER',
            'CLIMATECONTROL_REGULATOR',
            'WINDOW_SWITCH_RECEIVER',
        ]);
        assert.deepEqual(layoutOf('HM-Sec-SC'), ['MAINTENANCE', 'SHUTTER_CONTACT']);
    });
});
