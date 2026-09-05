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

/** Unwraps the `{explicitDouble}` wrapper both RPC encoders understand. */
function plain(value) {
    return value !== null && typeof value === 'object' && typeof value.explicitDouble === 'number'
        ? value.explicitDouble
        : value;
}

function clamp(parameter, value) {
    let result = value;
    if (typeof parameter.MIN === 'number' && result < parameter.MIN) {
        result = parameter.MIN;
    }
    if (typeof parameter.MAX === 'number' && result > parameter.MAX) {
        result = parameter.MAX;
    }
    return result;
}

/**
 * hmipserver's MASTER write, measured on firmware 3.89.8 (Homematic Manager task 6).
 *
 * It stores what it is given **before** it validates, and it validates the *type* only: a string
 * in an INTEGER and an ENUM value that is not in the VALUE_LIST are stored as they came and make
 * the channel's configuration invalid, while a number outside MIN..MAX is simply accepted - there
 * is no range check anywhere in hmipserver.
 *
 * @param {object} parameter the parameter's description
 * @param {*} value
 * @returns {{value: *, valid: boolean}} the value as it is stored, and whether it is acceptable
 */
function hmipStoredValue(parameter, value) {
    const raw = plain(value);
    switch (parameter.TYPE) {
        case 'BOOL':
        case 'ACTION':
            if (typeof raw === 'boolean') {
                return {value: raw, valid: true};
            }
            if (raw === 0 || raw === 1) {
                return {value: Boolean(raw), valid: true};
            }
            return {value: raw, valid: false};
        case 'INTEGER':
            return {value: raw, valid: typeof raw === 'number' && Number.isInteger(raw)};
        case 'FLOAT':
            // an <int> is accepted where a <double> belongs and stored as the integer it is
            return {value: raw, valid: typeof raw === 'number' && !Number.isNaN(raw)};
        case 'ENUM': {
            const list = Array.isArray(parameter.VALUE_LIST) ? parameter.VALUE_LIST : [];
            if (typeof raw === 'string') {
                const index = list.indexOf(raw);
                return index === -1 ? {value: raw, valid: false} : {value: index, valid: true};
            }
            const inRange = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw < list.length;
            return {value: raw, valid: inRange};
        }
        case 'STRING':
            return {value: raw, valid: typeof raw === 'string'};
        default:
            return {value: raw, valid: true};
    }
}

/**
 * rfd's MASTER write, measured on firmware 3.89.8 (Homematic Manager task 6).
 *
 * rfd never faults on a bad value. It silently clamps a number to MIN..MAX, coerces a string to a
 * number, and ignores what it cannot use at all - an integer where a BOOL belongs, an ENUM name
 * that is not in the VALUE_LIST. `undefined` means "ignored, nothing was stored".
 *
 * Not modelled: rfd also ignores a FLOAT that arrives as an XML-RPC `<int>`, which is why every
 * FLOAT has to go out as an explicit double. Both decode to a JavaScript number, so the
 * distinction is gone by the time the simulator sees the value.
 *
 * @param {object} parameter the parameter's description
 * @param {*} value
 * @returns {*} the value as it is stored, or `undefined` when rfd ignores it
 */
function bidcosStoredValue(parameter, value) {
    const raw = plain(value);
    switch (parameter.TYPE) {
        case 'BOOL':
        case 'ACTION':
            return typeof raw === 'boolean' ? raw : undefined;
        case 'INTEGER': {
            const number = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10);
            return clamp(parameter, Number.isNaN(number) ? 0 : Math.round(number));
        }
        case 'FLOAT': {
            const number = typeof raw === 'number' ? raw : Number.parseFloat(String(raw));
            return clamp(parameter, Number.isNaN(number) ? 0 : number);
        }
        case 'ENUM': {
            const list = Array.isArray(parameter.VALUE_LIST) ? parameter.VALUE_LIST : [];
            if (typeof raw === 'string') {
                const index = list.indexOf(raw);
                return index === -1 ? undefined : index;
            }
            if (typeof raw !== 'number' || !Number.isInteger(raw)) {
                return undefined;
            }
            return list.length > 0 ? Math.min(Math.max(raw, 0), list.length - 1) : raw;
        }
        case 'STRING':
            return typeof raw === 'string' ? raw : undefined;
        default:
            return raw;
    }
}

module.exports = {
    WRITEABLE,
    castValue,
    defaultValue,
    defaultParamset,
    hmipStoredValue,
    bidcosStoredValue,
};
