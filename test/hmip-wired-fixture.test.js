'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const wired = require('../data/fixtures/hmip-wired.json');
const {presetValue} = require('../tools/fixture-hmip-wired.js');
const {startSim, xmlrpcCall} = require('./helpers.js');

const copy = (value) => JSON.parse(JSON.stringify(value));

const DRBL4 = '00000000000101';
const DRI32 = '00000000000102';
const WRC6 = '00000000000103';
const DRI16 = '00000000000013';

/**
 * `data/fixtures/hmip-wired.json`: an HmIPW-DRBL4 with HmIPW-DRI32, -DRI16 and -WRC6 senders, and
 * the links to it as the CCU's WebUI writes them (the shutter profiles, one of them as firmware 3.87 wrote it).
 */
describe('the hmip-wired fixture', () => {
    let context;
    let call;

    before(async () => {
        context = await startSim({
            devices: copy(wired.devices),
            paramsetDescriptions: wired.paramsetDescriptions,
            links: copy(wired.links),
            paramsets: wired.paramsets,
            paramsetFallback: false,
        });
        call = xmlrpcCall(context.xmlrpcPort);
    });

    after(async () => {
        await context.sim.close();
    });

    it('has the devices with their real channel layouts', () => {
        const types = Object.fromEntries(
            wired.devices.hmip.devices.filter((device) => !device.PARENT).map((device) => [device.TYPE, device]),
        );
        assert.deepEqual(Object.keys(types).sort(), ['HmIPW-DRBL4', 'HmIPW-DRI16', 'HmIPW-DRI32', 'HmIPW-WRC6']);
        assert.equal(types['HmIPW-DRBL4'].CHILDREN.length, 18);
        assert.equal(types['HmIPW-DRI32'].CHILDREN.length, 34);
        assert.equal(types['HmIPW-DRI16'].CHILDREN.length, 18);
        assert.equal(types['HmIPW-WRC6'].CHILDREN.length, 15);
        const channel = (address) => wired.devices.hmip.devices.find((device) => device.ADDRESS === address);
        assert.equal(channel(`${DRBL4}:1`).TYPE, 'BLIND_TRANSMITTER');
        assert.equal(channel(`${DRBL4}:2`).TYPE, 'BLIND_VIRTUAL_RECEIVER');
        assert.equal(channel(`${DRBL4}:17`).TYPE, 'BLIND_WEEK_PROFILE');
        assert.equal(channel(`${DRI32}:1`).TYPE, 'MULTI_MODE_INPUT_TRANSMITTER');
        assert.equal(channel(`${WRC6}:1`).TYPE, 'KEY_TRANSCEIVER');
    });

    it('describes every paramset of every device exactly', () => {
        assert.deepEqual(context.sim.getMissingParamsetDescriptions(), []);
    });

    it('lists the links and serves the LINK paramsets the WebUI wrote', async () => {
        const links = await call('getLinks', [DRBL4, 0]);
        assert.deepEqual(links.map((link) => `${link.SENDER}->${link.RECEIVER}`).sort(), [
            `${DRI16}:1->${DRBL4}:6`,
            `${DRI32}:1->${DRBL4}:2`,
            `${DRI32}:2->${DRBL4}:3`,
            `${WRC6}:1->${DRBL4}:10`,
            `${WRC6}:2->${DRBL4}:14`,
        ]);
        // SHUTTER_VIRTUAL_RECEIVER/MULTI_MODE_INPUT_TRANSMITTER_1.tcl profile 3, "open / closed & up / down"
        const values = await call('getParamset', [`${DRBL4}:2`, `${DRI32}:1`]);
        assert.equal(values.SHORT_PROFILE_ACTION_TYPE, 1);
        assert.equal(values.LONG_PROFILE_ACTION_TYPE, 1);
        assert.equal(values.SHORT_JT_OFF, 1);
        assert.equal(values.SHORT_JT_ON, 4);
        assert.equal(values.LONG_MAX_TIME_FIRST_DIR, 0.4);
        assert.equal(values.SHORT_MAX_TIME_FIRST_DIR, 25.5);
        assert.equal(Object.keys(values).length, 72);
        // the same profile as the WebUI of firmware 3.87 wrote it: the long press toggles the direction
        const older = await call('getParamset', [`${DRBL4}:3`, `${DRI32}:2`]);
        assert.equal(older.LONG_PROFILE_ACTION_TYPE, 5);
        assert.deepEqual({...older, LONG_PROFILE_ACTION_TYPE: 1}, values);
        // the sender side has an empty LINK paramset
        assert.deepEqual(await call('getParamset', [`${DRI32}:1`, `${DRBL4}:2`]), {});
    });

    it('starts the inputs in key mode and the actuator as shutters', async () => {
        const input = await call('getParamset', [`${DRI32}:1`, 'MASTER']);
        assert.equal(input.CHANNEL_OPERATION_MODE, 1); // KEY_BEHAVIOR
        const blind = await call('getParamset', [`${DRBL4}:1`, 'MASTER']);
        assert.equal(blind.CHANNEL_OPERATION_MODE, 0); // SHUTTER
    });

    it('answers the paramset ids hmipserver builds', async () => {
        assert.equal(await call('getParamsetId', [`${DRBL4}:2`, 'LINK']), 'hmipw-drbl4_2_link');
        assert.equal(await call('getParamsetId', [`${DRI32}:1`, 'LINK']), 'hmipw-dri32_1_link');
        assert.equal(await call('getParamsetId', [`${WRC6}:1`, 'MASTER']), 'hmipw-wrc6_1_master');
    });
});

describe('options.paramsets', () => {
    it('starts MASTER, VALUES and link paramsets with the given values on top of the defaults', async () => {
        const context = await startSim({
            devices: copy(wired.devices),
            paramsetDescriptions: wired.paramsetDescriptions,
            links: copy(wired.links),
            paramsets: {
                hmip: {
                    [`${DRI32}:1`]: {MASTER: {CHANNEL_OPERATION_MODE: 2}},
                    [`${DRBL4}:2`]: {VALUES: {LEVEL: 0.5}, [`${DRI32}:1`]: {SHORT_JT_OFF: 6}},
                },
            },
        });
        try {
            const {sim} = context;
            const master = sim.callMethod('hmip', 'getParamset', [`${DRI32}:1`, 'MASTER']);
            assert.equal(master.CHANNEL_OPERATION_MODE, 2);
            assert.ok(Object.keys(master).length > 1, 'the rest keeps its defaults');
            assert.equal(sim.callMethod('hmip', 'getValue', [`${DRBL4}:2`, 'LEVEL']), 0.5);
            const link = sim.callMethod('hmip', 'getParamset', [`${DRBL4}:2`, `${DRI32}:1`]);
            assert.equal(link.SHORT_JT_OFF, 6);
            assert.equal(link.LONG_PROFILE_ACTION_TYPE, 5, 'the default of the description');
        } finally {
            await context.sim.close();
        }
    });
});

describe('tools/fixture-hmip-wired.js', () => {
    it('takes the first value of a WebUI preset', () => {
        const variables = {ON_DELAY: '1', OFF_DELAY: '4'};
        assert.equal(presetValue('5', variables), 5);
        assert.equal(presetValue('1.000000', variables), 1);
        assert.equal(presetValue('{100 150}', variables), 100);
        assert.equal(presetValue('{0.4 range 0.0 - 25.5}', variables), 0.4);
        assert.equal(presetValue('$ON_DELAY', variables), 1);
        assert.equal(presetValue('[subst {$OFF_DELAY $ON_DELAY}]', variables), 4);
        assert.equal(presetValue('""', variables), undefined);
    });
});
