'use strict';

const http = require('node:http');

/**
 * ReGa (HomeMatic logic layer) mock.
 *
 * Answers the `rega.exe` endpoint the way the CCU does: the script output followed by an `<xml>`
 * block. The scripts of the `homematic-rega` client are recognised by their first line
 * (`!# devices.rega`, `!# variables.rega`, `!# programs.rega`, `!# rooms.rega`,
 * `!# functions.rega`, `!# values.rega`); `getChannels()` uses `channels.rega`, whose first line is
 * the historical `!# devices.rega`.
 *
 * Every script that is not one of those is echoed into `regaSim.scripts` (and, for the ones the
 * mock understands, applied to the mock's state), so tests can assert on what was executed -
 * renames (`dom.GetObject(id).Name("...")`) in particular.
 */
class RegaSim {
    /**
     * @param {object} options
     * @param {number} [options.port=8181]
     * @param {string} [options.listenAddress]
     * @param {Array} [options.variables]
     * @param {Array} [options.channels] devices and channels, the answer to `getChannels()`
     * @param {Array} [options.programs]
     * @param {Array} [options.rooms]
     * @param {Array} [options.functions]
     * @param {Array} [options.values] the answer to `getValues()`
     * @param {object} [options.auth] {username, password} - enables HTTP basic auth
     * @param {object} [options.tls] {key, cert} - serve https instead of http
     * @param {object} [log]
     */
    constructor(options, log) {
        this.log = log || {debug() {}, info() {}, warn() {}, error() {}};
        this.variables = options.variables || [];
        this.devices = options.channels || [];
        this.programs = options.programs || [];
        this.rooms = options.rooms || [];
        this.functions = options.functions || [];
        this.values = options.values || [];
        /** every script the mock received, newest last */
        this.scripts = [];
        /** every rename script, as {id, name, script} */
        this.renames = [];
        this.auth = options.auth || null;

        const handler = (request, response) => this.handleRequest(request, response);
        this.server = options.tls
            ? require('node:https').createServer(options.tls, handler)
            : http.createServer(handler);
        this.server.on('error', () => {});
        /** resolves once the mock accepts connections */
        this.ready = new Promise((resolve) => {
            this.server.listen(options.port === undefined ? 8181 : options.port, options.listenAddress, resolve);
        });
    }

    handleRequest(request, response) {
        if (this.auth) {
            const expected =
                'Basic ' + Buffer.from(`${this.auth.username}:${this.auth.password || ''}`, 'utf8').toString('base64');
            if (request.headers.authorization !== expected) {
                response.writeHead(401, {
                    'WWW-Authenticate': 'Basic realm="hm-simulator"',
                    'Content-Type': 'text/plain',
                });
                response.end('Unauthorized');
                return;
            }
        }

        const path = (request.url || '/').split('?')[0];
        if (!/^\/[\w-]+\.exe$/.test(path)) {
            response.writeHead(404, {'Content-Type': 'text/plain'});
            response.end('Not Found');
            return;
        }

        if (request.method !== 'POST') {
            this.send(response, this.response(''));
            return;
        }

        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const script = Buffer.concat(chunks).toString('latin1');
            this.send(response, this.response(this.exec(script)));
        });
    }

    /**
     * Runs a script against the mock's state.
     * @param {string} script
     * @returns {string|Array|object} the script's output
     */
    exec(script) {
        this.scripts.push(script);
        const line = script.split('\n')[0].trim();

        switch (line) {
            case '!# devices.rega':
                return this.devices;
            case '!# variables.rega':
                return this.variables;
            case '!# programs.rega':
                return this.programs;
            case '!# rooms.rega':
                return this.rooms;
            case '!# functions.rega':
                return this.functions;
            case '!# values.rega':
                return this.values;
            default:
                return this.execStatement(script, line);
        }
    }

    execStatement(script, line) {
        let match = line.match(/dom\.GetObject\((\d+)\)\.State\(([^)]*)\)/);
        if (match) {
            const id = Number.parseInt(match[1], 10);
            let value;
            try {
                value = JSON.parse(match[2]);
            } catch {
                value = match[2];
            }
            for (const [index, variable] of this.variables.entries()) {
                if (variable.id === id) {
                    this.variables[index].val = value;
                    this.variables[index].ts = this.ts();
                }
            }
            return '';
        }

        match = line.match(/dom\.GetObject\((\d+)\)\.Name\("([^"]*)"\)/);
        if (match) {
            const id = Number.parseInt(match[1], 10);
            const name = match[2];
            this.renames.push({id, name, script});
            for (const list of [this.devices, this.variables, this.programs, this.rooms, this.functions]) {
                for (const item of list) {
                    if (item.id === id) {
                        item.name = name;
                    }
                }
            }
            return '';
        }

        match = line.match(/dom\.GetObject\((\d+)\)\.Active\((true|false)\)/);
        if (match) {
            const id = Number.parseInt(match[1], 10);
            for (const program of this.programs) {
                if (program.id === id) {
                    program.active = match[2] === 'true';
                    program.ts = this.ts();
                }
            }
            return '';
        }

        match = line.match(/dom\.GetObject\((\d+)\)\.ProgramExecute\(\)/);
        if (match) {
            const id = Number.parseInt(match[1], 10);
            for (const program of this.programs) {
                if (program.id === id) {
                    program.ts = this.ts();
                }
            }
            return '';
        }

        this.log.warn('unknown script', line);
        return '';
    }

    send(response, body) {
        const buffer = Buffer.from(body, 'latin1');
        response.writeHead(200, {
            server: 'ise GmbH HTTP-Server v2.0',
            'accept-ranges': 'bytes',
            'cache-control': 'no-store, no-cache',
            'content-type': 'text/xml; charset=iso-8859-1',
            'content-length': buffer.length,
        });
        response.end(buffer);
    }

    close() {
        this.server.close();
        if (typeof this.server.closeAllConnections === 'function') {
            this.server.closeAllConnections();
        }
    }

    response(stdout, vars = []) {
        if (typeof stdout !== 'string') {
            stdout = JSON.stringify(stdout);
        }

        const xml = [
            ['exec', 'rega.exe'],
            ['sessionId', ''],
            ['httpUserAgent', ''],
        ].concat(vars);

        stdout += '<xml>';
        for (const [key, value] of xml) {
            stdout += `<${key}>${value}</${key}>`;
        }
        stdout += '</xml>';

        return stdout;
    }

    ts() {
        const d = new Date();
        return (
            d.getFullYear() +
            '-' +
            ('0' + (d.getMonth() + 1)).slice(-2) +
            '-' +
            ('0' + d.getDate()).slice(-2) +
            ' ' +
            ('0' + d.getHours()).slice(-2) +
            ':' +
            ('0' + d.getMinutes()).slice(-2) +
            ':' +
            ('0' + d.getSeconds()).slice(-2)
        );
    }
}

module.exports = RegaSim;
