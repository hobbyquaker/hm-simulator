'use strict';

/**
 * Fault responses.
 *
 * The real interface processes (rfd/crRFD, hmipserver, CUxD) answer invalid calls with an XML-RPC
 * fault (binrpc message type 0xff with a struct body). The exact codes and strings are not
 * publicly specified, so until 2026-09-05 the table below was an educated guess following the
 * negative-code convention of the eq3 XML-RPC API.
 *
 * It is a measurement now. Homematic Manager's roadmap task 6 probed both interface processes of
 * two CCUs on firmware 3.89.8 with calls that cannot change anything - an address that does not
 * exist, a paramset that does not exist, a read-only parameter, a method that does not exist - and
 * recorded what came back; `docs/config-pending.md` in that repository has the full tables and the
 * script that produced them.
 *
 * The two processes disagree, and not only in wording:
 *
 * - hmipserver answers a fault for nearly everything and uses **-5 `Invalid parameter or value`**
 *   for every kind of bad `putParamset`, whatever went wrong.
 * - rfd answers **no fault at all** for a whole class of mistakes: an unknown paramset name is
 *   taken as a peer address, a missing argument defaults, a write to a read-only datapoint is
 *   accepted. What it does fault on, it names differently.
 *
 * {@link DEFAULT_FAULTS} is hmipserver's table, because that is the one an application has to
 * survive; {@link BIDCOS_FAULTS} is rfd's, for a simulator that models a BidCos interface. Every
 * entry can still be overridden through the `faults` constructor option, and `sim.faults` exposes
 * the effective table.
 */

/** hmipserver 3.89.8, measured 2026-09-05. */
const DEFAULT_FAULTS = {
    // no handler for the requested method name. hmipserver answers this at the HTTP level and
    // sends no faultCode at all, so -1 is the simulator's stand-in
    unknownMethod: {faultCode: -1, faultString: 'Invalid XML-RPC message'},
    // device or channel address not known to this interface process
    unknownInstance: {faultCode: -2, faultString: 'Invalid device'},
    // the device/channel exists but does not have the requested paramset (getParamset, putParamset)
    unknownParamset: {faultCode: -2, faultString: 'Invalid device'},
    // getParamsetDescription of a paramset the channel does not have. hmipserver 3.89.11 appends the
    // name it was asked for (`Unknown Paramset: NOSUCH`); measured 2026-10-02
    unknownParamsetDescription: {faultCode: -3, faultString: 'Unknown Paramset'},
    // the paramset exists but does not contain the requested parameter (getValue/setValue)
    unknownParameter: {faultCode: -5, faultString: 'Unknown Parameter for value key'},
    // the two channels are not linked with each other
    unknownLink: {faultCode: -2, faultString: 'Invalid device'},
    // parameter exists but OPERATIONS does not include write (2)
    readOnly: {faultCode: -5, faultString: 'Invalid parameter or value'},
    // value has a type the parameter's TYPE does not accept
    typeError: {faultCode: -5, faultString: 'Invalid parameter or value'},
    // ENUM index/name not in VALUE_LIST. hmipserver does *not* check MIN..MAX at all - see the
    // 'hmip' configPendingMode in lib/sim.js
    outOfRange: {faultCode: -5, faultString: 'Invalid parameter or value'},
    // the stored configuration of a channel cannot be transferred to the device: the fault a
    // poisoned channel answers to every putParamset, including one with an empty struct
    invalidValue: {faultCode: -5, faultString: 'Invalid parameter or value'},
    // method understood but not implemented for this interface: clearConfigCache,
    // restoreConfigToDevice and determineParameter all answer this on hmipserver
    notSupported: {faultCode: -1, faultString: 'Generic error'},
    // device is known but currently not reachable (a sleeping battery device)
    notReachable: {faultCode: -1, faultString: 'Generic error (UNREACH)'},
    // malformed parameters. hmipserver lets a Java NullPointerException through here and answers
    // -321 with the exception message, which is not something an application can rely on
    invalidArguments: {faultCode: -321, faultString: 'Invalid arguments'},
};

/** rfd (BidCos-RF) 3.89.8, measured 2026-09-05. */
const BIDCOS_FAULTS = {
    unknownMethod: {faultCode: -1, faultString: 'unknown method name'},
    unknownInstance: {faultCode: -2, faultString: 'Unknown instance'},
    // rfd does not fault here at all: an unknown paramset name is taken as a peer channel address
    // and the link defaults come back. The entry covers what the simulator cannot model.
    unknownParamset: {faultCode: -2, faultString: 'Unknown instance'},
    // getParamsetDescription of a paramset the channel does not have, on a channel without a LINK
    // paramset; a channel that has one answers the LINK description for any unknown name (rfd
    // 3.89.11, measured 2026-10-02)
    unknownParamsetDescription: {faultCode: -3, faultString: 'Unknown paramset'},
    unknownParameter: {faultCode: -5, faultString: 'Unknown parameter'},
    unknownLink: {faultCode: -1, faultString: 'Failure'},
    // rfd accepts a setValue on a read-only datapoint, so this is never raised against it
    readOnly: {faultCode: -5, faultString: 'Unknown parameter'},
    typeError: {faultCode: -5, faultString: 'Unknown parameter'},
    outOfRange: {faultCode: -5, faultString: 'Unknown parameter'},
    invalidValue: {faultCode: -5, faultString: 'Unknown parameter'},
    notSupported: {faultCode: -1, faultString: 'Failure'},
    notReachable: {faultCode: -1, faultString: 'Failure'},
    invalidArguments: {faultCode: -1, faultString: 'Failure'},
};

/** The measured tables by name, for `new HmSim({faults: FAULT_TABLES.bidcos})`. */
const FAULT_TABLES = {hmip: DEFAULT_FAULTS, bidcos: BIDCOS_FAULTS};

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

module.exports = {DEFAULT_FAULTS, BIDCOS_FAULTS, FAULT_TABLES, RpcFault, createFaults};
