'use strict';

/**
 * Fault responses.
 *
 * The real interface processes (rfd/crRFD, hmipserver, CUxD) answer invalid calls with an XML-RPC
 * fault (binrpc message type 0xff with a struct body). The exact codes and strings are **not**
 * publicly specified; the table below follows the negative-code convention of the eq3 XML-RPC API
 * and is deliberately kept in one place so it can be recalibrated from real hardware
 * (Homematic Manager roadmap task 6 does that). Every entry can be overridden through the
 * `faults` constructor option, and `sim.faults` exposes the effective table.
 */

const DEFAULT_FAULTS = {
    // no handler for the requested method name
    unknownMethod: {faultCode: -1, faultString: 'Unknown method'},
    // device or channel address not known to this interface process
    unknownInstance: {faultCode: -2, faultString: 'Unknown instance'},
    // the device/channel exists but does not have the requested paramset
    unknownParamset: {faultCode: -3, faultString: 'Unknown paramset'},
    // the paramset exists but does not contain the requested parameter
    unknownParameter: {faultCode: -4, faultString: 'Unknown parameter'},
    // parameter exists but OPERATIONS does not include write (2)
    readOnly: {faultCode: -5, faultString: 'Parameter is not writeable'},
    // value has a type the parameter's TYPE does not accept
    typeError: {faultCode: -6, faultString: 'Type error'},
    // numeric value outside MIN..MAX, or ENUM index/name not in VALUE_LIST
    outOfRange: {faultCode: -7, faultString: 'Value out of range'},
    // method understood but not implemented for this interface/device
    notSupported: {faultCode: -8, faultString: 'Operation not supported'},
    // device is known but currently not reachable (UNREACH)
    notReachable: {faultCode: -9, faultString: 'Device not reachable'},
    // malformed parameters (wrong count, wrong type of an address/paramset argument)
    invalidArguments: {faultCode: -10, faultString: 'Invalid arguments'},
};

/** Error carrying an XML-RPC fault. */
class RpcFault extends Error {
    constructor(faultCode, faultString, detail) {
        super(detail ? `${faultString}: ${detail}` : faultString);
        this.name = 'RpcFault';
        this.faultCode = faultCode;
        this.faultString = faultString;
        this.detail = detail;
    }

    /** The struct a binrpc fault carries as its body. */
    toStruct() {
        return {faultCode: this.faultCode, faultString: this.faultString};
    }
}

/**
 * Builds a fault factory bound to a (possibly overridden) fault table.
 * @param {object} [overrides] partial table, same shape as DEFAULT_FAULTS
 * @returns {{table: object, fault: function(string, string=): RpcFault}}
 */
function createFaults(overrides = {}) {
    const table = {};
    for (const [key, value] of Object.entries(DEFAULT_FAULTS)) {
        table[key] = {...value, ...overrides[key]};
    }
    for (const [key, value] of Object.entries(overrides)) {
        if (!table[key]) {
            table[key] = {...value};
        }
    }

    const fault = (key, detail) => {
        const entry = table[key] || table.unknownMethod;
        return new RpcFault(entry.faultCode, entry.faultString, detail);
    };

    return {table, fault};
}

module.exports = {DEFAULT_FAULTS, RpcFault, createFaults};
