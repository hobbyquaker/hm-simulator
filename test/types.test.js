'use strict';

const {describe, it} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {SCENARIO_METHODS} = require('../lib/control.js');
const HmSim = require('../sim.js');

const ROOT = path.join(__dirname, '..');
const DECLARATIONS = fs.readFileSync(path.join(ROOT, 'sim.d.ts'), 'utf8');
const SOURCE = fs.readFileSync(path.join(ROOT, 'lib', 'sim.js'), 'utf8');

/**
 * The declarations are written by hand; `npm run test:types` proves they compile and fit together,
 * this proves they keep up with the code: every option and every scenario call is declared.
 */
describe('sim.d.ts', () => {
    it('declares every constructor option and every per-interface option', () => {
        const methodOptions = new Set(['batch', 'downMs', 'forgetClients', 'strict', 'config']);
        const options = new Set([...SOURCE.matchAll(/\boptions\.([a-zA-Z]+)/g)].map((match) => match[1]));
        const perInterface = [...SOURCE.matchAll(/interfaceOption\(\w+, '(\w+)'\)/g)].map((match) => match[1]);
        const config = [...SOURCE.matchAll(/\bconfig\.([a-zA-Z]+)/g)].map((match) => match[1]);
        for (const option of [...options].filter((name) => !methodOptions.has(name)).concat(perInterface, config)) {
            assert.match(DECLARATIONS, new RegExp(`\\b${option}\\?:`), `option ${option} is not declared`);
        }
    });

    it('declares every scenario call', () => {
        for (const method of SCENARIO_METHODS) {
            assert.equal(typeof HmSim.prototype[method], 'function', method);
            assert.match(DECLARATIONS, new RegExp(`\\n    ${method}\\(`), `scenario call ${method} is not declared`);
        }
    });

    it('is what package.json points at, and is published', () => {
        const pkg = require('../package.json');
        assert.equal(pkg.types, './sim.d.ts');
        for (const file of ['sim.d.ts', 'sim.d.mts']) {
            assert.ok(pkg.files.includes(file), file);
        }
        assert.ok(fs.existsSync(path.join(ROOT, 'lib', 'faults.d.ts')));
    });
});
