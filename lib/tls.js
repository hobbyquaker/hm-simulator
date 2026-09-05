'use strict';

const crypto = require('node:crypto');

/**
 * Self signed certificate, generated at start.
 *
 * The CCU serves its XML-RPC interfaces over TLS with a certificate nobody can validate either, so
 * a client that talks to the simulator has to be able to deal with exactly that. Node can generate
 * key pairs but not certificates, and a test simulator should not need a dependency (or a private
 * key checked into the repository) for it, so the certificate is DER encoded here by hand. It is a
 * plain v3 certificate for localhost/127.0.0.1, valid for one year, and it is only ever meant for
 * `rejectUnauthorized: false` clients.
 */

function length(size) {
    if (size < 0x80) {
        return Buffer.from([size]);
    }
    const bytes = [];
    let rest = size;
    while (rest > 0) {
        bytes.unshift(rest & 0xff);
        rest >>= 8;
    }
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tagged = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const sequence = (...parts) => tagged(0x30, Buffer.concat(parts));
const set = (content) => tagged(0x31, content);
const octetString = (content) => tagged(0x04, content);
const bitString = (content) => tagged(0x03, Buffer.concat([Buffer.from([0x00]), content]));
const utf8String = (value) => tagged(0x0c, Buffer.from(value, 'utf8'));
const boolean = (value) => tagged(0x01, Buffer.from([value ? 0xff : 0x00]));
const nullValue = () => Buffer.from([0x05, 0x00]);

function integer(value) {
    let bytes = [];
    let rest = BigInt(value);
    if (rest === 0n) {
        bytes = [0];
    }
    while (rest > 0n) {
        bytes.unshift(Number(rest & 0xffn));
        rest >>= 8n;
    }
    if (bytes[0] & 0x80) {
        bytes.unshift(0);
    }
    return tagged(0x02, Buffer.from(bytes));
}

function oid(dotted) {
    const parts = dotted.split('.').map(Number);
    const bytes = [parts[0] * 40 + parts[1]];
    for (const part of parts.slice(2)) {
        const chunk = [part & 0x7f];
        let rest = part >> 7;
        while (rest > 0) {
            chunk.unshift((rest & 0x7f) | 0x80);
            rest >>= 7;
        }
        bytes.push(...chunk);
    }
    return tagged(0x06, Buffer.from(bytes));
}

function utcTime(date) {
    const pad = (value) => String(value).padStart(2, '0');
    const text =
        pad(date.getUTCFullYear() % 100) +
        pad(date.getUTCMonth() + 1) +
        pad(date.getUTCDate()) +
        pad(date.getUTCHours()) +
        pad(date.getUTCMinutes()) +
        pad(date.getUTCSeconds()) +
        'Z';
    return tagged(0x17, Buffer.from(text, 'ascii'));
}

/** Name with a single CN attribute. */
const name = (commonName) => sequence(set(sequence(oid('2.5.4.3'), utf8String(commonName))));

const extension = (id, critical, value) =>
    critical ? sequence(oid(id), boolean(true), octetString(value)) : sequence(oid(id), octetString(value));

function subjectAltName(hostnames, ips) {
    const parts = [
        ...hostnames.map((host) => tagged(0x82, Buffer.from(host, 'ascii'))),
        ...ips.map((ip) => tagged(0x87, Buffer.from(ip.split('.').map(Number)))),
    ];
    return sequence(...parts);
}

/**
 * @param {object} [options]
 * @param {string} [options.commonName='localhost']
 * @param {Array<string>} [options.hostnames=['localhost']]
 * @param {Array<string>} [options.ips=['127.0.0.1']]
 * @param {number} [options.days=365]
 * @returns {{key: string, cert: string}} both PEM encoded
 */
function selfSignedCertificate({
    commonName = 'localhost',
    hostnames = ['localhost'],
    ips = ['127.0.0.1'],
    days = 365,
} = {}) {
    const {privateKey, publicKey} = crypto.generateKeyPairSync('rsa', {modulusLength: 2048});
    const spki = publicKey.export({type: 'spki', format: 'der'});

    const sha256WithRsa = sequence(oid('1.2.840.113549.1.1.11'), nullValue());
    const notBefore = new Date(Date.now() - 60 * 60 * 1000);
    const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const tbs = sequence(
        tagged(0xa0, integer(2)), // version v3
        integer(Date.now()),
        sha256WithRsa,
        name(commonName),
        sequence(utcTime(notBefore), utcTime(notAfter)),
        name(commonName),
        spki,
        tagged(
            0xa3,
            sequence(
                extension('2.5.29.19', true, sequence(boolean(true))), // basicConstraints CA:TRUE
                extension('2.5.29.17', false, subjectAltName(hostnames, ips)),
            ),
        ),
    );

    const signature = crypto.sign('sha256', tbs, privateKey);
    const der = sequence(tbs, sha256WithRsa, bitString(signature));

    const base64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
    const cert = `-----BEGIN CERTIFICATE-----\n${base64}${base64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE-----\n`;

    return {key: privateKey.export({type: 'pkcs8', format: 'pem'}), cert};
}

/**
 * Turns the `tls` option into {key, cert}: `true` generates a certificate, an object with key and
 * cert is used as it is.
 */
function resolveTls(option) {
    if (!option) {
        return null;
    }
    if (option === true) {
        return selfSignedCertificate();
    }
    if (option.key && option.cert) {
        return option;
    }
    return selfSignedCertificate(option);
}

module.exports = {selfSignedCertificate, resolveTls};
