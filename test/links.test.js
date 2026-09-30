'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall, xmlrpcCall, fixtures} = require('./helpers.js');

const KEY = 'ABC0000002:1';
const SWITCH = `${fixtures.SWITCH_ADDRESS}:1`;

describe('links', () => {
    let sim;
    let rfd;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    it('starts without links', async () => {
        assert.deepEqual(await rfd('getLinks', []), []);
        assert.deepEqual(await rfd('getLinkPeers', [SWITCH]), []);
    });

    it('adds a link', async () => {
        assert.equal(await rfd('addLink', [KEY, SWITCH, 'Flurlicht', 'Taster oben']), '');
        const links = await rfd('getLinks', []);
        assert.equal(links.length, 1);
        assert.deepEqual(links[0], {
            SENDER: KEY,
            RECEIVER: SWITCH,
            FLAGS: 0,
            NAME: 'Flurlicht',
            DESCRIPTION: 'Taster oben',
        });
    });

    it('filters getLinks by channel and by device', async () => {
        assert.equal((await rfd('getLinks', [SWITCH])).length, 1);
        assert.equal((await rfd('getLinks', [fixtures.SWITCH_ADDRESS])).length, 1);
        assert.equal((await rfd('getLinks', [`${fixtures.SWITCH_ADDRESS}:0`])).length, 0);
    });

    it('answers getLinkPeers from both sides', async () => {
        assert.deepEqual(await rfd('getLinkPeers', [SWITCH]), [KEY]);
        assert.deepEqual(await rfd('getLinkPeers', [KEY]), [SWITCH]);
    });

    it('reads and writes the link paramset through the peer address', async () => {
        const paramset = await rfd('getParamset', [SWITCH, KEY]);
        assert.equal(paramset.SHORT_ON_TIME, 0.5);
        assert.equal(paramset.SHORT_ACTION_TYPE, 1);

        assert.equal(await rfd('putParamset', [SWITCH, KEY, {SHORT_ON_TIME: 10}]), '');
        assert.equal((await rfd('getParamset', [SWITCH, KEY])).SHORT_ON_TIME, 10);
        // the sender side has its own link paramset
        assert.deepEqual(await rfd('getParamset', [KEY, SWITCH]), {});
    });

    it('validates link paramsets like every other paramset', async () => {
        assert.equal((await rfd('putParamset', [SWITCH, KEY, {SHORT_ON_TIME: 999999}])).faultCode, -5);
        assert.equal((await rfd('putParamset', [SWITCH, KEY, {NOPE: 1}])).faultCode, -5);
    });

    it('includes paramsets and descriptions when the flags ask for it', async () => {
        const [withParamsets] = await rfd('getLinks', ['', 2]);
        assert.equal(withParamsets.RECEIVER_PARAMSET.SHORT_ON_TIME, 10);
        const [withDescriptions] = await rfd('getLinks', ['', 4]);
        assert.equal(withDescriptions.SENDER_DESCRIPTION.TYPE, 'KEY');
        assert.equal(withDescriptions.RECEIVER_DESCRIPTION.TYPE, 'SWITCH');
    });

    it('reads and writes the link info', async () => {
        assert.deepEqual(await rfd('getLinkInfo', [KEY, SWITCH]), {
            NAME: 'Flurlicht',
            DESCRIPTION: 'Taster oben',
        });
        assert.equal(await rfd('setLinkInfo', [KEY, SWITCH, 'Neu', 'Text']), '');
        assert.deepEqual(await rfd('getLinkInfo', [KEY, SWITCH]), {NAME: 'Neu', DESCRIPTION: 'Text'});
    });

    it('applies a link paramset to the receiver', async () => {
        await rfd('putParamset', [SWITCH, 'VALUES', {STATE: false}]);
        await rfd('addLink', ['ABC0000002:1', SWITCH, 'x', '']);
        // STATE is not part of the LINK description, so nothing is written back, but the call is
        // recorded and answers without a fault
        assert.equal(await rfd('activateLinkParamset', [SWITCH, KEY, true]), '');
        const entry = sim.getWriteLog().pop();
        assert.equal(entry.method, 'activateLinkParamset');
        assert.equal(entry.longPress, true);
        assert.equal(entry.paramset, KEY);
    });

    it('faults on an unknown link', async () => {
        assert.equal((await rfd('getLinkInfo', [SWITCH, 'ABC0000002:0'])).faultCode, -2);
        assert.equal((await rfd('removeLink', [SWITCH, 'ABC0000002:0'])).faultCode, -2);
        assert.equal((await rfd('getParamset', [SWITCH, 'ABC0000002:0'])).faultCode, -2);
    });

    it('faults when a channel has no LINK paramset', async () => {
        const result = await rfd('addLink', [`${fixtures.SWITCH_ADDRESS}:0`, SWITCH, '', '']);
        assert.equal(result.faultCode, -1);
    });

    it('removes a link and its paramsets', async () => {
        assert.equal(await rfd('removeLink', [KEY, SWITCH]), '');
        assert.deepEqual(await rfd('getLinks', []), []);
        assert.equal((await rfd('getParamset', [SWITCH, KEY])).faultCode, -2);
    });
});

describe('device-internal links', () => {
    const OTHER = 'ABC0000002:1';
    const HMIP = `${fixtures.HMIP_ADDRESS}:1`;
    let sim;
    let rfd;
    let hmip;

    before(async () => {
        const started = await startSim({
            links: {
                rfd: [
                    {SENDER: OTHER, RECEIVER: SWITCH},
                    {SENDER: `${fixtures.SWITCH_ADDRESS}:0`, RECEIVER: SWITCH, FLAGS: 2},
                ],
                hmip: [{SENDER: HMIP, RECEIVER: HMIP}],
            },
        });
        sim = started.sim;
        rfd = binrpcCall(started.binrpcPort);
        hmip = xmlrpcCall(started.xmlrpcPort);
    });

    after(() => {
        rfd.close();
        sim.close();
    });

    const byPair = (links, sender, receiver) =>
        links.find((link) => link.SENDER === sender && link.RECEIVER === receiver);

    it('reports FLAGS 1 for a link within one device in the list of all links, as rfd does', async () => {
        // a relay's own button on the relay: the link works, rfd still says SENDER_BROKEN
        assert.equal(await rfd('addLink', [SWITCH, SWITCH, 'own button', '']), '');
        const all = await rfd('getLinks', []);
        assert.equal(byPair(all, SWITCH, SWITCH).FLAGS, 1);
        assert.equal(byPair(all, OTHER, SWITCH).FLAGS, 0);
        // whatever the flags argument asks for
        assert.equal(byPair(await rfd('getLinks', ['', 1]), SWITCH, SWITCH).FLAGS, 1);
        assert.equal(byPair(await rfd('getLinks', ['', 6]), SWITCH, SWITCH).FLAGS, 1);
    });

    it('reports the stored flags once an address filters the list, as rfd does', async () => {
        assert.equal(byPair(await rfd('getLinks', [SWITCH, 0]), SWITCH, SWITCH).FLAGS, 0);
        assert.equal(byPair(await rfd('getLinks', [fixtures.SWITCH_ADDRESS, 0]), SWITCH, SWITCH).FLAGS, 0);
    });

    it('keeps seeded flags and adds bit 1 to a seeded internal link', async () => {
        const all = await rfd('getLinks', []);
        // the :0 -> :1 link was seeded with RECEIVER_BROKEN; it is internal too
        assert.equal(byPair(all, `${fixtures.SWITCH_ADDRESS}:0`, SWITCH).FLAGS, 3);
        assert.equal(byPair(await rfd('getLinks', [SWITCH]), `${fixtures.SWITCH_ADDRESS}:0`, SWITCH).FLAGS, 2);
    });

    it('lists the own channel once as a peer, and knows the link info', async () => {
        const peers = await rfd('getLinkPeers', [SWITCH]);
        assert.deepEqual(peers.sort(), [OTHER, `${fixtures.SWITCH_ADDRESS}:0`, SWITCH].sort());
        assert.deepEqual(await rfd('getLinkInfo', [SWITCH, SWITCH]), {NAME: 'own button', DESCRIPTION: ''});
    });

    it('leaves hmipserver links alone', async () => {
        const all = await hmip('getLinks', []);
        assert.equal(byPair(all, HMIP, HMIP).FLAGS, 0);
    });
});
