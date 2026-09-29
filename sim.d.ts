// Type declarations for hm-simulator. The package is plain CommonJS; these are written by hand and
// checked by `npm run test:types` (test/types/). Every option, scenario call or RPC method that is
// added to lib/sim.js is added here in the same change.

import type {EventEmitter} from 'node:events';

import type {FaultEntry, FaultName, FaultTable} from './lib/faults.js';

declare namespace HmSim {
    /** The interfaces the simulator serves; `devices` may name others, which get no port. */
    type InterfaceName = 'rfd' | 'hmip' | 'wired' | 'virtual' | 'cuxd' | (string & {});

    /** A device or channel, as `listDevices` and `getDeviceDescription` answer it. */
    interface DeviceDescription {
        ADDRESS: string;
        TYPE: string;
        VERSION?: number;
        PARENT?: string;
        PARENT_TYPE?: string;
        CHILDREN?: string[];
        PARAMSETS?: string[];
        FIRMWARE?: string;
        AVAILABLE_FIRMWARE?: string;
        FIRMWARE_UPDATE_STATE?: string;
        UPDATABLE?: number | boolean;
        FLAGS?: number;
        INTERFACE?: string;
        INDEX?: number;
        DIRECTION?: number;
        LINK_SOURCE_ROLES?: string;
        LINK_TARGET_ROLES?: string;
        RF_ADDRESS?: number;
        ROAMING?: number;
        RX_MODE?: number;
        AES_ACTIVE?: number;
        TEAM?: string;
        TEAM_TAG?: string;
        TEAM_CHANNELS?: string[];
        [key: string]: unknown;
    }

    /** One entry of `SPECIAL`: a value with a meaning of its own. */
    interface SpecialValue {
        ID: string;
        VALUE: number;
    }

    /** One parameter of a paramset description. */
    interface ParameterDescription {
        TYPE: 'BOOL' | 'ACTION' | 'INTEGER' | 'FLOAT' | 'ENUM' | 'STRING' | (string & {});
        /** 1 read, 2 write, 4 event */
        OPERATIONS: number;
        /** 1 visible, 2 internal, 4 transform, 8 service, 16 sticky */
        FLAGS?: number;
        DEFAULT?: unknown;
        MIN?: unknown;
        MAX?: unknown;
        VALUE_LIST?: string[];
        UNIT?: string;
        SPECIAL?: SpecialValue[];
        ID?: string;
        TAB_ORDER?: number;
        CONTROL?: string;
        [key: string]: unknown;
    }

    /** A paramset description: parameter name -> description. */
    type ParamsetDescription = Record<string, ParameterDescription>;

    /** A direct link. */
    interface Link {
        SENDER: string;
        RECEIVER: string;
        FLAGS?: number;
        NAME?: string;
        DESCRIPTION?: string;
    }

    /** What `listBidcosInterfaces` answers for one radio interface. */
    interface BidcosInterface {
        ADDRESS: string;
        DESCRIPTION?: string;
        CONNECTED?: boolean;
        DEFAULT?: boolean;
        FIRMWARE_VERSION?: string;
        TYPE?: string;
        DUTY_CYCLE?: number;
        CARRIER_SENSE_LEVEL?: number;
        [key: string]: unknown;
    }

    /** `[address, datapoint, value]`, as `getServiceMessages` answers and events carry. */
    type ServiceMessage = [address: string, datapoint: string, value: unknown];
    type EventTuple = [address: string, datapoint: string, value: unknown];

    interface Logger {
        debug(...args: unknown[]): void;
        info(...args: unknown[]): void;
        warn(...args: unknown[]): void;
        error(...args: unknown[]): void;
    }

    interface BasicAuth {
        username: string;
        password: string;
    }

    /** `true`: a generated self-signed certificate; `{key, cert}`: PEM; otherwise how to generate one. */
    type TlsOption =
        | boolean
        | {key: string; cert: string}
        | {commonName?: string; hostnames?: string[]; ips?: string[]; days?: number};

    interface Config {
        /** all interfaces unless set; `'127.0.0.1'` in tests */
        listenAddress?: string;
        /** rfd; 0 picks a free port */
        binrpcListenPort?: number;
        /** hmipserver */
        xmlrpcListenPort?: number;
        /** BidCos-Wired, started when `devices.wired` exists */
        wiredListenPort?: number;
        /** VirtualDevices, off unless set */
        virtualListenPort?: number;
        /** the path VirtualDevices answers on, `/groups` */
        virtualPath?: string;
        /** CUxD, off unless set */
        cuxdListenPort?: number;
    }

    /** Behaviour per interface, `interfaces: {<iface>: {...}}`. */
    interface InterfaceOptions {
        configPendingMode?: 'hmip' | 'bidcos' | 'strict' | 'pending';
        configPendingOnWrite?: boolean;
        configPendingDelay?: number;
        serviceMessagesEmptyAsString?: boolean;
        getServiceMessagesFault?: boolean;
        protocols?: Array<'binrpc' | 'xmlrpc'>;
        listenerModel?: 'isolated' | 'measured';
        deliveryTimeout?: number;
        pong?: boolean;
        pingDelay?: number;
        startDelay?: number;
        unreachWrites?: 'accept' | 'fault';
        firmwareUpdateDelay?: number;
        /** what `getVersion` answers */
        version?: string;
        /** BidCos only: what `getLGWStatus` answers; unknown method without it */
        lgwStatus?: unknown;
    }

    /** The ReGa mock (`rega` option). */
    interface RegaOptions {
        port?: number;
        listenAddress?: string;
        variables?: unknown[];
        /** devices and channels, the answer to `getChannels()` */
        channels?: unknown[];
        programs?: unknown[];
        rooms?: unknown[];
        functions?: unknown[];
        /** the answer to `getValues()` */
        values?: unknown[];
        auth?: BasicAuth;
        tls?: {key: string; cert: string};
    }

    interface Options {
        log?: Logger;
        devices?: Record<string, {devices: DeviceDescription[]}>;
        config?: Config;
        /** directory with behaviour scripts, `false` for none */
        behaviorPath?: string | false;
        rega?: RegaOptions;
        paramsetDescriptions?: Record<string, ParamsetDescription>;
        paramsetFallback?: boolean;
        faults?: Partial<Record<FaultName | (string & {}), Partial<FaultEntry>>>;
        interfaces?: Partial<Record<InterfaceName, InterfaceOptions>>;
        links?: Record<string, Link[]>;
        bidcosInterfaces?: Record<string, BidcosInterface[]>;
        serviceMessages?: Record<string, ServiceMessage[]>;
        newDevices?: Record<string, {devices: DeviceDescription[]; delay?: number}>;
        defaultRssi?: number;
        /** `{<iface>: {<address>: {<key>: value}}}`, what `getMetadata` answers before any `setMetadata` */
        metadata?: Record<string, Record<string, Record<string, unknown>>>;
        tls?: TlsOption;
        auth?: BasicAuth;
    }

    interface WriteLogEntry {
        iface: string;
        address: string;
        /** MASTER, VALUES, SERVICE or a peer address */
        paramset: string;
        values: Record<string, unknown>;
        rejected?: Array<{name: string; value: unknown; reason: string; faultCode?: number}>;
        method?: 'activateLinkParamset';
        longPress?: boolean;
        ts: number;
    }

    interface CallbackLogEntry {
        iface: string;
        /** the url the client registered with */
        client: string;
        method: string;
        sentAt: number;
        answeredAt: number | null;
        error: string | null;
    }

    interface ConfigPendingEntry {
        address: string;
        sticky: boolean;
    }

    interface MissingParamsetDescription {
        iface: string;
        key: string;
        usedKey: string | null;
    }

    interface InjectedFault {
        iface?: string;
        /** `'*'` for any */
        method?: string;
        /** `Infinity` or `-1` for all until `clearFaults()` */
        times?: number;
        delayMs?: number;
        hang?: boolean;
        closeSocket?: boolean;
        fault?: FaultName | (string & {}) | {faultCode: number; faultString?: string};
    }

    interface ScheduleStep {
        at?: number;
        call: string;
        args?: unknown[];
    }

    interface KeyMismatchScript {
        /** the passphrase the device was taught in with */
        key?: string;
        /** its description and channel descriptions, paired once the temporary key is `key` */
        devices?: DeviceDescription[];
        /** milliseconds between the install mode and the device being heard */
        delay?: number;
    }

    /** An RPC fault as the simulator throws and answers it. */
    interface RpcFault extends Error {
        faultCode: number;
        faultString: string;
        detail?: string;
    }

    /** `method -> handler(iface, params)`, as the servers dispatch it. */
    type RpcMethodTable = Record<string, (iface: string, params: unknown[]) => unknown>;

    /** The ports once `whenReady()` resolved. */
    type Ports = Partial<Record<InterfaceName, number>>;

    /** The ReGa mock. */
    interface RegaSim {
        port: number;
        ready: Promise<void>;
        /** every script it received */
        scripts: string[];
        /** every `dom.GetObject(id).Name("…")` among them */
        renames: Array<{id: number; name: string; script: string}>;
        variables: unknown[];
        devices: unknown[];
        programs: unknown[];
        rooms: unknown[];
        functions: unknown[];
        values: unknown[];
        close(): void;
    }

    /** The emitter behaviour scripts get: `emit('setValue', iface, address, datapoint, value)`. */
    interface BehaviorApi extends EventEmitter {
        emit(event: 'setValue', iface: string, address: string, datapoint: string, value: unknown): boolean;
        emit(event: string | symbol, ...args: unknown[]): boolean;
    }
}

/**
 * Simulates the RPC interface processes and the ReGa of a Homematic CCU.
 */
declare class HmSim {
    constructor(options?: HmSim.Options);

    readonly options: HmSim.Options;
    log: HmSim.Logger;
    config: HmSim.Config;
    devices: Record<string, {devices: HmSim.DeviceDescription[]}>;
    paramsetDescriptions: Record<string, HmSim.ParamsetDescription>;
    paramsetFallback: boolean;
    /** the effective fault table */
    faults: FaultTable;
    /** builds an {@link HmSim.RpcFault} from an entry of the fault table */
    fault(name: FaultName | (string & {}), detail?: string): HmSim.RpcFault;
    /** the port each server listens on, filled in once it listens */
    ports: HmSim.Ports;
    /** stored state per interface and address: `{VALUES, MASTER, LINKS, ...}` */
    values: Record<string, Record<string, Record<string, Record<string, unknown>>>>;
    links: Record<string, HmSim.Link[]>;
    serviceMessages: Record<string, HmSim.ServiceMessage[]>;
    /** every reportValueUsage */
    valueUsage: Array<{iface: string; address: string; valueId: string; refCounter: number; ts: number}>;
    /** every updateFirmware/installFirmware */
    firmwareUpdates: Array<{iface: string; addresses: string[]; method: string; ts: number}>;
    /** every refreshDeployedDeviceFirmwareList */
    firmwareListRefreshes: Array<{iface: string; ts: number}>;
    /** every changeKey */
    keyChanges: Array<{iface: string; key: string; ts: number}>;
    /** every setInterfaceClock */
    interfaceClocks: Array<{iface: string; utc: number; offset: number; ts: number}>;
    /** what setMetadata stored and the `metadata` option seeded */
    metadata: Record<string, Record<string, Record<string, unknown>>>;
    /** the serial getKeyMismatchDevice answers, per interface */
    keyMismatch: Record<string, string>;
    /** what scriptKeyMismatch() set up and did not pair yet */
    keyMismatchScript: Record<string, Required<HmSim.KeyMismatchScript> & {serial: string}>;
    /** the temporary key per interface, as setTempKey left it */
    tempKey: Record<string, string>;
    /** the log level per interface, as logLevel set it */
    logLevels: Record<string, number>;
    /** the RPC method table; a test may replace a handler */
    rpcMethods: HmSim.RpcMethodTable;
    /** the emitter behaviour scripts get */
    api: HmSim.BehaviorApi;
    /** the ReGa mock, when the `rega` option started it */
    regaSim?: HmSim.RegaSim;

    /** Resolves once every server accepts connections. */
    whenReady(): Promise<void>;
    /** Stops every server, timer and client connection. */
    close(): void;

    /* ---------------------------------------------------------------- scenario api: devices */

    /** Pairs a device with its channels: `newDevices` to every client. Answers the ones that were new. */
    addDevice(
        iface: string,
        ...descriptions: Array<HmSim.DeviceDescription | HmSim.DeviceDescription[]>
    ): HmSim.DeviceDescription[];
    addDevices(iface: string, list: HmSim.DeviceDescription[]): HmSim.DeviceDescription[];
    /** Removes a device with its channels, values and links: `deleteDevices` to every client. */
    removeDevice(iface: string, address: string): '';
    /** The description, `false` when the interface does not know the address. */
    getDevice(iface: string, address: string): HmSim.DeviceDescription | false;
    /** Devices that appear the next time the install mode is switched on. */
    scriptNewDevices(iface: string, devices: HmSim.DeviceDescription[], delay?: number): void;
    /** A device that holds another system's key: heard at the next install mode, paired with its key. */
    scriptKeyMismatch(iface: string, serial: string, script?: HmSim.KeyMismatchScript): void;

    /* ---------------------------------------------------------------- scenario api: values and events */

    /** One event, not checked against the description. Answers the value. */
    fireEvent(iface: string, address: string, datapoint: string, value: unknown): unknown;
    /** A burst of events as `system.multicall` batches. Answers how many. */
    fireEvents(iface: string, events: HmSim.EventTuple[], options?: {batch?: number}): number;
    /** A value, checked against the description; `internal` is the device reporting it. */
    setValue(
        iface: string,
        address: string,
        datapoint: string,
        value: unknown,
        options?: {strict?: boolean; internal?: boolean},
    ): void;
    getValue(iface: string, address: string, datapoint: string): unknown;
    getParamset(iface: string, address: string, key: string): Record<string, unknown>;
    putParamset(iface: string, address: string, key: string, set: Record<string, unknown>): '';
    getParamsetDescription(
        iface: string,
        device: string | HmSim.DeviceDescription,
        paramset: string,
    ): HmSim.ParamsetDescription | undefined;
    getDeviceDescription(iface: string, address: string): HmSim.DeviceDescription;

    /* ---------------------------------------------------------------- scenario api: service messages and health */

    /** Raises (or with a falsy value clears) a service message. */
    setServiceMessage(iface: string, address: string, datapoint: string, value?: unknown): void;
    getServiceMessages(iface: string): HmSim.ServiceMessage[] | '';
    setConfigPending(iface: string, address: string, options?: {sticky?: boolean}): void;
    clearConfigPending(iface: string, address: string): void;
    setReachable(iface: string, address: string, reachable: boolean): void;
    setLowBattery(iface: string, address: string, low: boolean): void;
    setDutyCycle(iface: string, percent: number): void;
    setCarrierSense(iface: string, percent: number): void;
    offerFirmware(iface: string, address: string, version: string): void;
    listBidcosInterfaces(iface: string): HmSim.BidcosInterface[];

    /* ---------------------------------------------------------------- scenario api: interface processes */

    dropConnection(iface: string): Promise<void>;
    stopInterface(iface: string): Promise<void>;
    startInterface(iface: string, options?: {forgetClients?: boolean}): Promise<void>;
    restartInterface(iface: string, options?: {downMs?: number; forgetClients?: boolean}): Promise<void>;
    injectFault(rule?: HmSim.InjectedFault): HmSim.InjectedFault;
    clearFaults(): void;
    /** Scenario calls on the simulator's timer; resolves with their results. */
    schedule(steps: HmSim.ScheduleStep[]): Promise<unknown[]>;

    /* ---------------------------------------------------------------- introspection */

    getWriteLog(): HmSim.WriteLogEntry[];
    getConfigPending(iface: string): HmSim.ConfigPendingEntry[];
    getPoisonedChannels(iface: string): string[];
    getMissingParamsetDescriptions(): HmSim.MissingParamsetDescription[];
    getCallbackLog(): HmSim.CallbackLogEntry[];
    getTempKey(iface: string): string;
    getInstallMode(iface: string): number;
    /** The names of every RPC method. */
    methodNames(): string[];
    methodHelp(name: string): string;

    /* ---------------------------------------------------------------- rpc, as the servers call it */

    /** One RPC method as a client call would run it; throws the fault. */
    callMethod(iface: string, method: string, params?: unknown[]): unknown;
    getLinks(iface: string, params?: unknown[]): Array<HmSim.Link & Record<string, unknown>>;
    getLinkPeers(iface: string, params: unknown[]): string[];
    deleteDevice(iface: string, address: string, flags?: number): '';
    replaceDevice(iface: string, oldAddress: string, newAddress: string): '';
    getKeyMismatchDevice(iface: string, params?: [reset?: boolean]): string;
    suppressServiceMessages(
        iface: string,
        params: [channelAddress: string, parameter?: string, suppress?: boolean],
    ): '';
    getSuppressedServiceMessages(iface: string, params: [channelAddress: string]): string[];
    getMetadata(iface: string, params: [address: string, key: string]): unknown;
    setMetadata(iface: string, params: [address: string, key: string, value: unknown]): '';
    getAllMetadata(iface: string, params: [address: string]): Record<string, unknown>;
    listReplaceableDevices(iface: string, params: [address: string]): HmSim.DeviceDescription[] | '';
    getVersion(iface: string): string;
    /** Sends one `event` to every client of the interface. */
    event(iface: string, params: HmSim.EventTuple): void;
}

export = HmSim;
