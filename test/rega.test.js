'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {startSim} = require('./helpers.js');

function post(port, body) {
    return new Promise((resolve, reject) => {
        const request = http.request({host: '127.0.0.1', port, path: '/rega.exe', method: 'POST'}, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () =>
                resolve({status: response.statusCode, body: Buffer.concat(chunks).toString('latin1')}),
            );
        });
        request.on('error', reject);
        request.end(Buffer.from(body, 'latin1'));
    });
}

/** the client splits the answer at the `<xml>` block, see homematic-rega */
const output = (body) => body.slice(0, body.indexOf('<xml>'));

describe('ReGa mock', () => {
    let sim;
    let port;

    before(async () => {
        const started = await startSim({
            rega: {
                port: 0,
                listenAddress: '127.0.0.1',
                channels: [
                    {id: 1000, address: 'ABC0000001', name: 'Steckdose'},
                    {id: 1001, address: 'ABC0000001:1', name: 'Steckdose:1'},
                ],
                variables: [{id: 950, name: 'Anwesenheit', val: true, ts: '2026-01-01 12:00:00'}],
                programs: [{id: 2000, name: 'Licht aus', active: true}],
                rooms: [{id: 20, name: 'Flur', channels: [1001]}],
                functions: [{id: 30, name: 'Licht', channels: [1001]}],
                values: [{name: 'BidCos-RF.ABC0000001:1.STATE', value: false, ts: '2026-01-01 12:00:00'}],
            },
        });
        sim = started.sim;
        port = sim.regaSim.port;
    });

    after(() => sim.close());

    it('answers the channel list (getChannels)', async () => {
        const {status, body} = await post(port, '!# devices.rega\nWrite("x");');
        assert.equal(status, 200);
        const channels = JSON.parse(output(body));
        assert.equal(channels.length, 2);
        assert.equal(channels[1].address, 'ABC0000001:1');
    });

    it('answers variables, programs, rooms, functions and values', async () => {
        for (const [marker, length] of [
            ['!# variables.rega', 1],
            ['!# programs.rega', 1],
            ['!# rooms.rega', 1],
            ['!# functions.rega', 1],
            ['!# values.rega', 1],
        ]) {
            const {body} = await post(port, marker + '\n');
            assert.equal(JSON.parse(output(body)).length, length, marker);
        }
    });

    it('appends the xml block the client parses', async () => {
        const {body} = await post(port, '!# rooms.rega\n');
        assert.ok(body.includes('<exec>rega.exe</exec>'));
        assert.ok(body.includes('<sessionId></sessionId>'));
    });

    it('sets a system variable', async () => {
        await post(port, 'dom.GetObject(950).State(false);');
        assert.equal(sim.regaSim.variables[0].val, false);
    });

    it('records rename scripts', async () => {
        await post(port, 'dom.GetObject(1001).Name("Neuer Name");');
        assert.deepEqual(
            sim.regaSim.renames.map((rename) => [rename.id, rename.name]),
            [[1001, 'Neuer Name']],
        );
        assert.equal(sim.regaSim.devices[1].name, 'Neuer Name');
    });

    it('records every script it was sent', () => {
        assert.ok(sim.regaSim.scripts.length > 5);
        assert.ok(sim.regaSim.scripts.some((script) => script.startsWith('dom.GetObject(1001).Name')));
    });

    it('activates and executes programs', async () => {
        await post(port, 'dom.GetObject(2000).Active(false);');
        assert.equal(sim.regaSim.programs[0].active, false);
        await post(port, 'dom.GetObject(2000).ProgramExecute();');
        assert.ok(sim.regaSim.programs[0].ts);
    });
});
