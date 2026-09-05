'use strict';

/**
 * Type and range checking of parameter values against a paramset description.
 *
 * The real interface processes are stricter than the old simulator was: a value of the wrong type
 * or outside MIN..MAX is answered with a fault (hmipserver) or silently dropped and left in
 * CONFIG_PENDING (crRFD, see the CONFIG_PENDING modes in lib/sim.js). Both need the same check,
 * so it lives here.
 */

const WRITEABLE = 2;

/** ENUM values arrive as the index (BidCos) or as the name (HmIP); both are stored as the index. */
function castEnum(parameter, value, fault, name) {
    const list = Array.isArray(parameter.VALUE_LIST) ? parameter.VALUE_LIST : [];
    if (typeof value === 'string') {
        const index = list.indexOf(value);
        if (index === -1) {
            throw fault('outOfRange', `${name}=${value}`);
        }
        return index;
    }

    if (typeof value !== 'number' || !Number.isInteger(value)) {
        throw fault('typeError', `${name} is ENUM`);
    }
    if (value < 0 || (list.length > 0 && value >= list.length)) {
        throw fault('outOfRange', `${name}=${value}`);
    }
    return value;
}

function castNumber(parameter, value, fault, name) {
    if (value !== null && typeof value === 'object' && typeof value.explicitDouble === 'number') {
        value = value.explicitDouble;
    }
    if (typeof value !== 'number' || Number.isNaN(value)) {
        throw fault('typeError', `${name} is ${parameter.TYPE}`);
    }
    if (parameter.TYPE === 'INTEGER' && !Number.isInteger(value)) {
        throw fault('typeError', `${name} is INTEGER`);
    }
    if (typeof parameter.MIN === 'number' && value < parameter.MIN) {
        throw fault('outOfRange', `${name}=${value} < ${parameter.MIN}`);
    }
    if (typeof parameter.MAX === 'number' && value > parameter.MAX) {
        throw fault('outOfRange', `${name}=${value} > ${parameter.MAX}`);
    }
    return value;
}

/**
 * @param {object} description the paramset description
 * @param {string} name parameter name
 * @param {*} value
 * @param {function} fault fault factory, see lib/faults.js
 * @param {object} [options]
 * @param {boolean} [options.write=true] check OPERATIONS for the write bit
 * @returns {*} the value as it is stored
 */
function castValue(description, name, value, fault, {write = true} = {}) {
    const parameter = description && description[name];
    if (!parameter) {
        throw fault('unknownParameter', name);
    }

    if (write && typeof parameter.OPERATIONS === 'number' && !(parameter.OPERATIONS & WRITEABLE)) {
        throw fault('readOnly', name);
    }

    switch (parameter.TYPE) {
        case 'BOOL':
        case 'ACTION':
            if (typeof value === 'boolean') {
                return value;
            }
            // the interface processes accept 0/1 for BOOL as well
            if (value === 0 || value === 1) {
                return Boolean(value);
            }
            throw fault('typeError', `${name} is ${parameter.TYPE}`);
        case 'INTEGER':
        case 'FLOAT':
            return castNumber(parameter, value, fault, name);
        case 'ENUM':
            return castEnum(parameter, value, fault, name);
        case 'STRING':
            if (typeof value !== 'string') {
                throw fault('typeError', `${name} is STRING`);
            }
            return value;
        default:
            return value;
    }
}

/** The value a parameter has before anything was written, taken from its description. */
function defaultValue(parameter) {
    if (parameter.TYPE === 'ENUM' && Array.isArray(parameter.VALUE_LIST)) {
        const index = parameter.VALUE_LIST.indexOf(parameter.DEFAULT);
        return index === -1 ? 0 : index;
    }
    return parameter.DEFAULT;
}

/** Every parameter of a description with its default value. */
function defaultParamset(description) {
    const result = {};
    for (const [name, parameter] of Object.entries(description || {})) {
        result[name] = defaultValue(parameter);
    }
    return result;
}

module.exports = {WRITEABLE, castValue, defaultValue, defaultParamset};
