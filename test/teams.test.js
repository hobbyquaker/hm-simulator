'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall} = require('./helpers.js');

const SD_1 = 'NEQ0448334';
const SD_2 = 'NEQ0448077';
const TEAM = `*${SD_1}`;

/** An HM-Sec-SD-2 as rfd lists it: the smoke channel carries TEAM and TEAM_TAG. */
function detector(serial, team) {
    return [
        {
            ADDRESS: serial,
            TYPE: 'HM-Sec-SD-2',
            VERSION: 1,
            FIRMWARE: '1.0',
            CHILDREN: [`${serial}:0`, `${serial}:1`],
            PARAMSETS: ['MASTER'],
        },
        {
            ADDRESS: `${serial}:0`,
            TYPE: 'MAINTENANCE',
            VERSION: 1,
            PARENT: serial,
            PARENT_TYPE: 'HM-Sec-SD-2',
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 0,
        },
        {
            ADDRESS: `${serial}:1`,
            TYPE: 'SMOKE_DETECTOR',
            VERSION: 1,
            PARENT: serial,
            PARENT_TYPE: 'HM-Sec-SD-2',
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 1,
            TEAM: `${team}:1`,
            TEAM_TAG: 'smoke_detector',
        },
    ];
}

/** The team both detectors are in, as rfd lists it. */
function team() {
    return [
        {
            ADDRESS: TEAM,
            TYPE: 'HM-Sec-SD-2-Team',
            VERSION: 1,
            FIRMWARE: '1.0',
            CHILDREN: [`${TEAM}:0`, `${TEAM}:1`],
            PARAMSETS: ['MASTER'],
            FLAGS: 9,
        },
        {
            ADDRESS: `${TEAM}:0`,
            TYPE: 'MAINTENANCE',
            VERSION: 1,
            PARENT: TEAM,
            PARENT_TYPE: 'HM-Sec-SD-2-Team',
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 0,
        },
        {
            ADDRESS: `${TEAM}:1`,
            TYPE: 'SMOKE_DETECTOR_TEAM_V2',
            VERSION: 1,
            PARENT: TEAM,
            PARENT_TYPE: 'HM-Sec-SD-2-Team',
            PARAMSETS: ['MASTER', 'VALUES'],
            INDEX: 1,
            TEAM_TAG: 'smoke_detector',
            TEAM_CHANNELS: [`${SD_2}:1`, `${SD_1}:1`],
        },
    ];
}

describe('smoke detector teams (listTeams, setTeam)', () => {
    let sim;
    let rfd;
    let hmip;
    /** what the simulator told its clients, as [method, ...params] */
    const told = [];

    before(async () => {
        const started = await startSim({
            devices: {
                rfd: {devices: [...detector(SD_1, TEAM), ...detector(SD_2, TEAM), ...team()]},
                hmip: {devices: []},
            },
            paramsetDescriptions: {},
        });
        sim = started.sim;
        const original = sim.tellClientsParams.bind(sim);
        sim.tellClientsParams = (iface, method, params) => {
            told.push([method, ...params]);
            original(iface, method, params);
        };
        rfd = binrpcCall(started.binrpcPort);
        hmip = xmlrpcCall(started.xmlrpcPort);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    const members = async (address) => (await rfd('getDeviceDescription', [address])).TEAM_CHANNELS;

    it('lists the team devices and their channels', async () => {
        const teams = await rfd('listTeams', []);
        assert.deepEqual(
            teams.map((entry) => entry.ADDRESS),
            [TEAM, `${TEAM}:0`, `${TEAM}:1`],
        );
    });

    it('puts a detector back into a team of its own, created like the one it left', async () => {
        told.length = 0;
        assert.equal(await rfd('setTeam', [`${SD_2}:1`, '']), '');
        assert.deepEqual(await members(`${TEAM}:1`), [`${SD_1}:1`]);
        const own = await rfd('getDeviceDescription', [`*${SD_2}:1`]);
        assert.equal(own.TYPE, 'SMOKE_DETECTOR_TEAM_V2');
        assert.equal(own.PARENT_TYPE, 'HM-Sec-SD-2-Team');
        assert.deepEqual(own.TEAM_CHANNELS, [`${SD_2}:1`]);
        assert.equal((await rfd('getDeviceDescription', [`${SD_2}:1`])).TEAM, `*${SD_2}:1`);
        assert.ok(
            told.some(([method, devices]) => method === 'newDevices' && devices.some((d) => d.ADDRESS === `*${SD_2}`)),
        );
        assert.ok(told.some(([method, address]) => method === 'updateDevice' && address === `${SD_2}:1`));
        assert.equal((await rfd('listTeams', [])).filter((entry) => !entry.PARENT).length, 2);
    });

    it('moves a detector into another team, and deletes the team nobody is left in', async () => {
        told.length = 0;
        assert.equal(await rfd('setTeam', [`${SD_2}:1`, `${TEAM}:1`]), '');
        assert.deepEqual(await members(`${TEAM}:1`), [`${SD_1}:1`, `${SD_2}:1`]);
        assert.equal((await rfd('getDeviceDescription', [`${SD_2}:1`])).TEAM, `${TEAM}:1`);
        assert.ok(told.some(([method, addresses]) => method === 'deleteDevices' && addresses.includes(`*${SD_2}`)));
        assert.equal((await rfd('getDeviceDescription', [`*${SD_2}`])).faultCode, -2);
        // a second time is nothing to do
        told.length = 0;
        assert.equal(await rfd('setTeam', [`${SD_2}:1`, `${TEAM}:1`]), '');
        assert.deepEqual(told, []);
    });

    it('refuses what is no team, a channel without a team tag, and a team channel as a member', async () => {
        assert.equal((await rfd('setTeam', [`${SD_2}:1`, `${SD_1}:0`])).faultCode, -321);
        assert.equal((await rfd('setTeam', [`${SD_2}:0`, `${TEAM}:1`])).faultCode, -321);
        assert.equal((await rfd('setTeam', [`${TEAM}:1`, ''])).faultCode, -321);
        assert.equal((await rfd('setTeam', [`${SD_2}:1`, '*NOPE:1'])).faultCode, -2);
    });

    it('has no teams on HmIP', async () => {
        await assert.rejects(hmip('listTeams', []));
        await assert.rejects(hmip('setTeam', [`${SD_1}:1`, '']));
    });
});
