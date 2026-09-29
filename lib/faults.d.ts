// Type declarations for lib/faults.js (`require('hm-simulator/lib/faults.js')`).

/** An XML-RPC fault: what the interface process answers. */
export interface FaultEntry {
    faultCode: number;
    faultString: string;
}

/** The names of the fault table's entries. */
export type FaultName =
    | 'unknownMethod'
    | 'unknownInstance'
    | 'unknownParamset'
    | 'unknownParameter'
    | 'unknownLink'
    | 'readOnly'
    | 'typeError'
    | 'outOfRange'
    | 'invalidValue'
    | 'notSupported'
    | 'notReachable'
    | 'invalidArguments';

/** A fault table: every name above, plus whatever an override added. */
export type FaultTable = Record<FaultName, FaultEntry> & Record<string, FaultEntry>;

/** hmipserver 3.89.8, measured 2026-09-05 - the default. */
export declare const DEFAULT_FAULTS: FaultTable;
/** rfd 3.89.8, measured 2026-09-05. */
export declare const BIDCOS_FAULTS: FaultTable;
/** The measured tables by name, for `new HmSim({faults: FAULT_TABLES.bidcos})`. */
export declare const FAULT_TABLES: {hmip: FaultTable; bidcos: FaultTable};

/** Error carrying an XML-RPC fault. */
export declare class RpcFault extends Error {
    constructor(faultCode: number, faultString: string, detail?: string);
    faultCode: number;
    faultString: string;
    detail?: string;
    /** The struct a BIN-RPC fault carries as its body. */
    toStruct(): FaultEntry;
}

/** A fault factory bound to a (possibly overridden) table. */
export declare function createFaults(overrides?: Partial<Record<FaultName | (string & {}), Partial<FaultEntry>>>): {
    table: FaultTable;
    fault: (name: FaultName | (string & {}), detail?: string) => RpcFault;
};
