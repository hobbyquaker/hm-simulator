'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {SCENARIO_METHODS} = require('../lib/control.js');

const ROOT = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'sim.js'), 'utf8');

/** The first ```js block after a heading. */
function codeAfter(heading) {
    const start = README.indexOf(`\n${heading}\n`);
    assert.notEqual(start, -1, `no heading ${heading}`);
    const match = README.slice(start).match(/```js\n([\s\S]*?)```/);
    return match[1];
}

/**
 * The README is the reference: the quick start has to run as printed, and every option, flag and
 * control-port call the code has has to be in it.
 */
describe('README', () => {
    it('has a quick start that runs as printed', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-simulator-readme-'));
        const file = path.join(directory, 'quick-start.test.js');
        // the package is not installed into itself: its require paths point at the checkout
        const code = codeAfter('## Quick start').replaceAll("require('hm-simulator/", `require('${ROOT}/`);
        fs.writeFileSync(file, code);
        // a clean environment: the test runner marks its children, and this child is a runner itself
        const env = {...process.env};
        delete env.NODE_TEST_CONTEXT;
        const result = spawnSync(process.execPath, ['--test', file], {encoding: 'utf8', timeout: 30000, env});
        fs.rmSync(directory, {recursive: true, force: true});
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /pass 1/);
    });

    it('prints the command line help as --help does', () => {
        const help = spawnSync(process.execPath, [path.join(ROOT, 'index.js'), '--help'], {encoding: 'utf8'});
        const usage = help.stdout.slice(help.stdout.indexOf('Usage:')).trimEnd();
        assert.ok(README.includes(usage), "the README's command line block differs from --help");
    });

    it('documents every constructor option and every per-interface option', () => {
        // options of methods (`restartInterface(iface, {downMs})`), not of the constructor; config.* below
        const methodOptions = new Set(['batch', 'downMs', 'forgetClients', 'strict', 'config']);
        const options = new Set([...SOURCE.matchAll(/\boptions\.([a-zA-Z]+)/g)].map((match) => match[1]));
        for (const option of options) {
            if (!methodOptions.has(option)) {
                assert.ok(README.includes(`\`${option}\``), `option ${option} is not in the README`);
            }
        }
        const perInterface = new Set([...SOURCE.matchAll(/interfaceOption\(\w+, '(\w+)'\)/g)].map((match) => match[1]));
        assert.ok(perInterface.size >= 10);
        for (const option of perInterface) {
            assert.ok(README.includes(`| \`${option}\``), `interfaces.<iface>.${option} is not in the table`);
        }
        const config = new Set([...SOURCE.matchAll(/\bconfig\.([a-zA-Z]+)/g)].map((match) => match[1]));
        for (const option of config) {
            assert.ok(README.includes(`\`config.${option}\``), `config.${option} is not in the README`);
        }
    });

    it('lists every call of the control port and shows every scenario call', () => {
        const section = README.slice(README.indexOf('### The control port'));
        for (const method of SCENARIO_METHODS) {
            assert.ok(section.includes(`\`${method}\``), `control port call ${method} is not listed`);
            assert.ok(README.includes(`sim.${method}(`), `scenario call ${method} is not shown`);
        }
    });
});
