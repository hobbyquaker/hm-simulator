'use strict';

/**
 * Minimal binrpc response encoder.
 *
 * binrpc's own server only ever writes message type 0x01 (response); the real rfd/crRFD answers an
 * invalid call with message type 0xff and a struct body holding faultCode and faultString. To be
 * able to send both, the simulator encodes responses itself instead of reaching into binrpc's
 * internals. The encoding mirrors binrpc's protocol module byte for byte (every 32 bit word
 * big-endian, strings ascii, doubles as mantissa/exponent pair); `test/binrpc-codec.test.js`
 * verifies that against a real binrpc client.
 */

function word32(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value >>> 0, 0);
    return buf;
}

function encodeInteger(value) {
    return Buffer.concat([word32(0x01), word32(value)]);
}

function encodeDouble(value) {
    const exponent = Math.floor(Math.log(Math.abs(value)) / Math.LN2) + 1;
    const mantissa = Math.floor(value * Math.pow(2, -exponent) * (1 << 30));
    return Buffer.concat([word32(0x04), word32(mantissa), word32(exponent)]);
}

function encodeString(value) {
    const str = String(value);
    return Buffer.concat([word32(0x03), word32(str.length), Buffer.from(str, 'ascii')]);
}

function encodeBool(value) {
    return Buffer.concat([word32(0x02), Buffer.from([value ? 1 : 0])]);
}

function encodeKey(key) {
    return Buffer.concat([word32(key.length), Buffer.from(key, 'ascii')]);
}

function encodeData(data) {
    if (data === undefined || data === null) {
        return encodeString('');
    }
    switch (typeof data) {
        case 'number':
            return data % 1 === 0 ? encodeInteger(data) : encodeDouble(data);
        case 'boolean':
            return encodeBool(data);
        case 'string':
            return encodeString(data);
        case 'object':
            break;
        default:
            return encodeString(String(data));
    }

    if (Array.isArray(data)) {
        return Buffer.concat([word32(0x100), word32(data.length), ...data.map((item) => encodeData(item))]);
    }

    if (typeof data.explicitDouble === 'number') {
        return encodeDouble(data.explicitDouble);
    }

    const keys = Object.keys(data).filter((key) => data[key] !== undefined);
    const members = [];
    for (const key of keys) {
        members.push(encodeKey(key), encodeData(data[key]));
    }
    return Buffer.concat([word32(0x101), word32(keys.length), ...members]);
}

function message(type, body) {
    return Buffer.concat([Buffer.from('Bin', 'ascii'), Buffer.from([type]), word32(body.length), body]);
}

/**
 * @param {*} data
 * @returns {Buffer} message type 0x01
 */
function encodeResponse(data) {
    return message(0x01, encodeData(data === undefined ? '' : data));
}

/**
 * @param {{faultCode: number, faultString: string}} fault
 * @returns {Buffer} message type 0xff
 */
function encodeFault(fault) {
    const body = encodeData({
        faultCode: Number(fault.faultCode) || 0,
        faultString: fault.faultString === undefined ? '' : String(fault.faultString),
    });
    return message(0xff, body);
}

module.exports = {encodeData, encodeResponse, encodeFault};
