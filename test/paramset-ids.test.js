'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const lab = require('../data/fixtures/lab-2026-09.json');
const {parseDeviceFile} = require('../tools/paramset-ids.js');
const {startSim, binrpcCall, xmlrpcCall} = require('./helpers.js');

const copy = (value) => JSON.parse(JSON.stringify(value));

/**
 * `getParamsetId`, measured on firmware 3.89.11: hmipserver builds the id from type, channel
 * index and key; rfd and hs485d answer the id their device file gives the paramset.
 */
describe('getParamsetId', () => {
    let context;
    let rfd;
    let hmip;
    let wired;

    before(async () => {
        const devices = copy(lab.devices);
        devices.hmip.devices.push(
            {
                ADDRESS: '00000000000101',
                TYPE: 'HmIPW-DRBL4',
                FIRMWARE: '1.6.0',
                VERSION: 2,
                CHILDREN: ['00000000000101:2'],
            },
            {
                ADDRESS: '00000000000101:2',
                TYPE: 'BLIND_VIRTUAL_RECEIVER',
                PARENT: '00000000000101',
                PARENT_TYPE: 'HmIPW-DRBL4',
                INDEX: 2,
                VERSION: 2,
                PARAMSETS: ['MASTER', 'VALUES', 'LINK', 'SERVICE'],
            },
        );
        context = await startSim({
            devices,
            paramsetDescriptions: lab.paramsetDescriptions,
            config: {wiredListenPort: 0},
            paramsetIds: {rfd: {'LAB0000002:1': {LINK: 'switch_ch_link_custom'}}},
        });
        rfd = binrpcCall(context.binrpcPort);
        hmip = xmlrpcCall(context.xmlrpcPort);
        wired = binrpcCall(context.ports.wired);
    });

    after(async () => {
        rfd.close();
        wired.close();
        await context.sim.close();
    });

    it('builds the HmIP id from the device type, the channel index and the key (hmipserver)', async () => {
        assert.equal(await hmip('getParamsetId', ['00000000000101:2', 'LINK']), 'hmipw-drbl4_2_link');
        assert.equal(await hmip('getParamsetId', ['00000000000101:2', 'MASTER']), 'hmipw-drbl4_2_master');
        assert.equal(await hmip('getParamsetId', ['00000000000101', 'MASTER']), 'hmipw-drbl4_master');
        // any key, as hmipserver answers it: a peer address, a paramset the channel lacks, none
        assert.equal(
            await hmip('getParamsetId', ['00000000000101:2', '00000000000013:1']),
            'hmipw-drbl4_2_00000000000013:1',
        );
        assert.equal(await hmip('getParamsetId', ['00000000000101', 'LINK']), 'hmipw-drbl4_link');
        assert.equal(await hmip('getParamsetId', ['00000000000101:2']), 'hmipw-drbl4_2_null');
    });

    it('answers the device file ids on rfd (binrpc)', async () => {
        assert.equal(await rfd('getParamsetId', ['LAB0000001', 'MASTER']), 'cc_tc_dev_master');
        assert.equal(await rfd('getParamsetId', ['LAB0000001:3', 'LINK']), 'cc_tc_ch_wsr_link');
        assert.equal(await rfd('getParamsetId', ['LAB0000001:0', 'VALUES']), 'maint_ch_values');
        assert.equal(await rfd('getParamsetId', ['BidCoS-RF', 'MASTER']), 'rf_central_dev_master');
        assert.equal(await rfd('getParamsetId', ['BidCoS-RF:0', 'MASTER']), 'rf_central_maint_ch_master');
        assert.equal(await rfd('getParamsetId', ['BidCoS-RF:1', 'MASTER']), 'rf_central_ch_virtkey_master');
        // another key on a channel with LINK is a peer address: the LINK id
        assert.equal(await rfd('getParamsetId', ['BidCoS-RF:1', 'BidCoS-RF:2']), 'rf_central_ch_virtkey_link');
        assert.equal(await rfd('getParamsetId', ['BidCoS-RF:1', 'NOSUCH']), 'rf_central_ch_virtkey_link');
    });

    it('answers -3 on rfd for a paramset the address does not have', async () => {
        for (const params of [
            ['BidCoS-RF', 'LINK'],
            ['BidCoS-RF', 'VALUES'],
            ['BidCoS-RF', 'NOSUCH'],
            ['BidCoS-RF:0', 'LINK'],
            ['BidCoS-RF:0', 'NOSUCH'],
        ]) {
            const answer = await rfd('getParamsetId', params);
            assert.equal(answer.faultCode, -3, `${params.join(' ')}: ${JSON.stringify(answer)}`);
        }
    });

    it('answers the device file ids on BidCos-Wired', async () => {
        assert.equal(await wired('getParamsetId', ['BidCoS-Wir', 'MASTER']), 'hmw_central_dev_master');
        assert.equal(await wired('getParamsetId', ['BidCoS-Wir:1', 'LINK']), 'hmw_central_ch_virtkey_link');
    });

    it('faults for an unknown address everywhere', async () => {
        const answer = await rfd('getParamsetId', ['XEQ0000001:1', 'LINK']);
        assert.equal(answer.faultCode, -2);
        await assert.rejects(hmip('getParamsetId', ['00000000009999:1', 'LINK']), (error) => error.faultCode === -2);
    });

    it('answers what options.paramsetIds says first', async () => {
        assert.equal(await rfd('getParamsetId', ['LAB0000002:1', 'LINK']), 'switch_ch_link_custom');
        assert.equal(await rfd('getParamsetId', ['LAB0000002:1', 'MASTER']), 'switch_ch_master');
    });

    it("answers '' for a BidCos type the device files do not describe", () => {
        const {sim} = context;
        sim.addDevices('rfd', [
            {ADDRESS: 'ABC0000001', TYPE: 'XX-NOT-A-TYPE', VERSION: 1, PARAMSETS: ['MASTER'], CHILDREN: []},
        ]);
        assert.equal(sim.callMethod('rfd', 'getParamsetId', ['ABC0000001', 'MASTER']), '');
    });
});

describe('tools/paramset-ids.js', () => {
    it('reads the device, channel and count of a device file', () => {
        const parsed = parseDeviceFile(
            '<?xml version="1.0"?><device version="7"><supported_types><type name="x" id="XX-1"><parameter index="9.0" const_value="1"/></type>' +
                '<type name="y" id="XX-2"/></supported_types><paramset type="MASTER" id="xx_dev_master"><parameter id="A"/></paramset>' +
                '<channels><channel index="0" type="MAINTENANCE"><paramset type="MASTER" id="maint_ch_master"/><paramset type="VALUES" id="maint_ch_values"/></channel>' +
                '<channel index="1" type="KEY" count="4"><paramset type="MASTER" id="xx_key_master"/><paramset type="LINK" id="xx_key_link"/>' +
                '<subconfig><paramset type="MASTER" id="xx_other_master"/></subconfig></channel></channels></device>',
        );
        assert.deepEqual(parsed, {
            version: '7',
            types: ['XX-1', 'XX-2'],
            device: {MASTER: 'xx_dev_master'},
            channels: [
                {index: 0, count: 1, MASTER: 'maint_ch_master', VALUES: 'maint_ch_values'},
                {index: 1, count: 4, MASTER: 'xx_key_master', LINK: 'xx_key_link'},
            ],
        });
    });
});
