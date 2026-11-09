'use strict';

const {describe, it, before, after} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const {startSim, xmlrpcCall} = require('./helpers.js');

/** POSTs one XML-RPC call and answers the response body as it came. */
function rawCall(port, method, params = '') {
    const body = `<?xml version="1.0"?><methodCall><methodName>${method}</methodName><params>${params}</params></methodCall>`;
    return new Promise((resolve, reject) => {
        const request = http.request(
            {host: '127.0.0.1', port, path: '/', method: 'POST', headers: {'Content-Type': 'text/xml'}},
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            },
        );
        request.on('error', reject);
        request.end(body);
    });
}

const answer = (value) =>
    `<?xml version="1.0"?><methodResponse><params><param><value>${value}</value></param></params></methodResponse>`;
const param = (value) => `<param><value>${value}</value></param>`;

describe('XML-RPC answers carry their strings untyped, as rfd, hs485d and hmipserver send them', () => {
    let sim;
    let ports;

    before(async () => {
        ({sim, ports} = await startSim());
    });

    after(() => sim.close());

    it('getVersion is a bare <value> on rfd and hmipserver (the bytes a discovery matches)', async () => {
        assert.equal(await rawCall(ports.rfd, 'getVersion'), answer('2.6.0'));
        assert.equal(await rawCall(ports.hmip, 'getVersion'), answer('3.89.11.20260919'));
        assert.match(await rawCall(ports.hmip, 'getVersion'), /<value>[.\d]+<\/value>/);
        // a client decodes it as the string it was
        assert.equal(await xmlrpcCall(ports.rfd)('getVersion', []), '2.6.0');
    });

    it('strings in structs and arrays too; numbers and booleans keep their type', async () => {
        const xml = await rawCall(ports.rfd, 'getDeviceDescription', param('ABC0000001'));
        assert.match(xml, /<member><name>ADDRESS<\/name><value>ABC0000001<\/value><\/member>/);
        assert.match(
            xml,
            /<name>CHILDREN<\/name><value><array><data><value>ABC0000001:0<\/value><value>ABC0000001:1<\/value><\/data><\/array><\/value>/,
        );
        assert.match(xml, /<name>RF_ADDRESS<\/name><value><int>1234567<\/int><\/value>/);
        assert.doesNotMatch(xml, /<string>/);
    });

    it("an empty string is <value></value>, a fault's string is bare, a void answer is empty", async () => {
        assert.equal(await rawCall(ports.hmip, 'listReplaceableDevices', param('0001D3C99C1234')), answer(''));
        const fault = await rawCall(ports.rfd, 'nosuchMethod');
        assert.match(
            fault,
            /<fault><value><struct><member><name>faultCode<\/name><value><int>-1<\/int><\/value><\/member><member><name>faultString<\/name><value>[^<]+<\/value><\/member><\/struct><\/value><\/fault>/,
        );
        assert.doesNotMatch(fault, /<string>/);
    });

    it('escapes markup, and leaves doubles, binary, dates, null and other objects to the serializer', async () => {
        class Point {
            constructor() {
                this.x = 'kept typed';
            }
        }
        const bare = Object.create(null);
        bare.NAME = 'a <b> & c';
        const saved = sim.rpcMethods.getVersion;
        sim.rpcMethods.getVersion = () => [
            bare,
            {explicitDouble: 1},
            Buffer.from('hi'),
            new Date(2026, 10, 9, 12, 0, 0),
            null,
            true,
            2.5,
            new Point(),
        ];
        try {
            const xml = await rawCall(ports.hmip, 'getVersion');
            assert.equal(
                xml,
                answer(
                    '<array><data>' +
                        '<value><struct><member><name>NAME</name><value>a &lt;b&gt; &amp; c</value></member></struct></value>' +
                        '<value><double>1</double></value>' +
                        '<value><base64>aGk=</base64></value>' +
                        '<value><dateTime.iso8601>20261109T12:00:00</dateTime.iso8601></value>' +
                        '<value><nil></nil></value>' +
                        '<value><boolean>1</boolean></value>' +
                        '<value><double>2.5</double></value>' +
                        '<value><struct><member><name>x</name><value><string>kept typed</string></value></member></struct></value>' +
                        '</data></array>',
                ),
            );
        } finally {
            sim.rpcMethods.getVersion = saved;
        }
    });
});
