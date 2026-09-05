'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');

const {startSim, binrpcCall} = require('./helpers.js');

/**
 * The simulator encodes binrpc responses itself (lib/binrpc-codec.js) so that it can send faults
 * with message type 0xff. These tests decode the result with a real binrpc client, which is the
 * only meaningful check that the encoding matches the protocol.
 */
describe('binrpc response encoding', () => {
    let sim;
    let call;

    before(async () => {
        const started = await startSim();
        sim = started.sim;
        call = binrpcCall(started.binrpcPort);
    });

    after(() => {
        call.close();
        sim.close();
    });

    const roundtrip = async (value) => {
        sim.rpcMethods.echo = () => value;
        try {
            return await call('echo', []);
        } finally {
            delete sim.rpcMethods.echo;
        }
    };

    it('encodes strings, integers and booleans', async () => {
        assert.equal(await roundtrip('hello'), 'hello');
        assert.equal(await roundtrip(42), 42);
        assert.equal(await roundtrip(-7), -7);
        assert.equal(await roundtrip(true), true);
        assert.equal(await roundtrip(false), false);
    });

    it('encodes doubles close enough for the binrpc mantissa/exponent format', async () => {
        const result = await roundtrip(23.5);
        assert.ok(Math.abs(result - 23.5) < 0.0001, `got ${result}`);
    });

    it('encodes arrays and structs', async () => {
        assert.deepEqual(await roundtrip(['a', 1, true]), ['a', 1, true]);
        assert.deepEqual(await roundtrip({A: 1, B: 'x'}), {A: 1, B: 'x'});
        assert.deepEqual(await roundtrip([{A: [1, 2]}]), [{A: [1, 2]}]);
    });

    it('encodes an empty array and an empty struct', async () => {
        assert.deepEqual(await roundtrip([]), []);
        assert.deepEqual(await roundtrip({}), {});
    });

    it('sends faults as a struct with faultCode and faultString', async () => {
        const result = await call('noSuchMethod', []);
        assert.deepEqual(result, {faultCode: -1, faultString: 'Invalid XML-RPC message'});
    });
});
