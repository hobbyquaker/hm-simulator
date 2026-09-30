// Compile-time test of the declarations: `npm run test:types`. Never run, only type-checked; every
// export is used once, and the @ts-expect-error lines prove that wrong shapes are refused.
import HmSim = require('../../sim.js');
import faults = require('../../lib/faults.js');

const device: HmSim.DeviceDescription = {ADDRESS: 'ABC0000001', TYPE: 'HM-LC-Sw1-Pl', VERSION: 1, CHILDREN: []};
const channel: HmSim.DeviceDescription = {ADDRESS: 'ABC0000001:1', TYPE: 'SWITCH', PARENT: 'ABC0000001'};
const description: HmSim.ParamsetDescription = {
    STATE: {TYPE: 'BOOL', OPERATIONS: 7, FLAGS: 1, DEFAULT: false},
    LEVEL: {TYPE: 'FLOAT', OPERATIONS: 7, MIN: 0, MAX: 1, UNIT: '100%', SPECIAL: [{ID: 'NOT_USED', VALUE: 1.01}]},
    MODE: {TYPE: 'ENUM', OPERATIONS: 3, VALUE_LIST: ['A', 'B'], DEFAULT: 0},
};

const sim = new HmSim({
    log: console,
    devices: {rfd: {devices: [device, channel]}, hmip: {devices: []}},
    config: {listenAddress: '127.0.0.1', binrpcListenPort: 0, xmlrpcListenPort: 0, virtualListenPort: 0},
    behaviorPath: false,
    paramsetDescriptions: {'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/SWITCH/VALUES': description},
    paramsetFallback: false,
    faults: {...faults.FAULT_TABLES.bidcos, unknownMethod: {faultString: 'x'}},
    interfaces: {
        hmip: {configPendingMode: 'hmip', listenerModel: 'measured', getServiceMessagesFault: true},
        rfd: {protocols: ['binrpc'], version: '2.6.0', lgwStatus: {}, unreachWrites: 'fault'},
    },
    links: {rfd: [{SENDER: 'A:1', RECEIVER: 'B:1'}]},
    bidcosInterfaces: {rfd: [{ADDRESS: 'OEQ0123456', CONNECTED: true, DUTY_CYCLE: 3}]},
    serviceMessages: {rfd: [['A:0', 'LOWBAT', true]]},
    newDevices: {rfd: {devices: [device], delay: 10}},
    defaultRssi: -70,
    metadata: {hmip: {'X:1': {channelMode: 'shutter'}}},
    rega: {port: 0, listenAddress: '127.0.0.1', channels: []},
    tls: true,
    auth: {username: 'u', password: 'p'},
});

// @ts-expect-error a configPendingMode that does not exist
new HmSim({interfaces: {rfd: {configPendingMode: 'lenient'}}});
// @ts-expect-error behaviorPath is a string or false
new HmSim({behaviorPath: true});
// @ts-expect-error ports are numbers
new HmSim({config: {binrpcListenPort: '2001'}});
// @ts-expect-error a device needs an ADDRESS
const incomplete: HmSim.DeviceDescription = {TYPE: 'X'};

async function scenario(): Promise<void> {
    await sim.whenReady();
    const port: number | undefined = sim.ports.rfd;
    const added: HmSim.DeviceDescription[] = sim.addDevice('rfd', device, channel);
    sim.addDevice('rfd', [device, channel]);
    sim.removeDevice('rfd', 'ABC0000001');
    const found: HmSim.DeviceDescription | false = sim.getDevice('rfd', 'ABC0000001:1');
    sim.scriptNewDevices('rfd', [device], 500);
    sim.scriptKeyMismatch('rfd', 'KEY0000001', {key: 'k', devices: [device, channel], delay: 10});
    sim.fireEvent('rfd', 'ABC0000001:1', 'STATE', true);
    const count: number = sim.fireEvents('hmip', [['X:1', 'LEVEL', 0.5]], {batch: 10});
    sim.setValue('rfd', 'ABC0000001:1', 'STATE', true, {internal: true});
    const value: unknown = sim.getValue('rfd', 'ABC0000001:1', 'STATE');
    const paramset: Record<string, unknown> = sim.getParamset('rfd', 'ABC0000001:1', 'MASTER');
    sim.putParamset('rfd', 'ABC0000001:1', 'MASTER', {LOGGING: true});
    const read: HmSim.ParamsetDescription | undefined = sim.getParamsetDescription('rfd', 'ABC0000001:1', 'VALUES');
    sim.setServiceMessage('rfd', 'ABC0000001:0', 'STICKY_UNREACH', true);
    const messages: HmSim.ServiceMessage[] | '' = sim.getServiceMessages('rfd');
    sim.setConfigPending('rfd', 'ABC0000001', {sticky: true});
    sim.setReachable('hmip', 'X', false);
    sim.setLowBattery('rfd', 'ABC0000001', true);
    sim.setDutyCycle('rfd', 42);
    sim.setCarrierSense('hmip', 8);
    sim.offerFirmware('hmip', 'X', '1.2.0');
    await sim.dropConnection('rfd');
    await sim.stopInterface('hmip');
    await sim.startInterface('hmip', {forgetClients: false});
    await sim.restartInterface('rfd', {downMs: 100});
    sim.injectFault({iface: 'rfd', method: 'setValue', fault: 'notReachable', times: 1});
    sim.injectFault({method: '*', fault: {faultCode: -1}, hang: true, delayMs: 5});
    sim.clearFaults();
    const results: unknown[] = await sim.schedule([{at: 10, call: 'setReachable', args: ['rfd', 'A', false]}]);
    const log: HmSim.WriteLogEntry[] = sim.getWriteLog();
    const pending: HmSim.ConfigPendingEntry[] = sim.getConfigPending('rfd');
    const poisoned: string[] = sim.getPoisonedChannels('hmip');
    const missing: HmSim.MissingParamsetDescription[] = sim.getMissingParamsetDescriptions();
    const callbacks: HmSim.CallbackLogEntry[] = sim.getCallbackLog();
    const answered: number | null = callbacks[0].answeredAt;
    const tempKey: string = sim.getTempKey('rfd');
    const seconds: number = sim.getInstallMode('rfd');
    const names: string[] = sim.methodNames();
    const keyChange: string = sim.keyChanges[0].key;
    const clock: number = sim.interfaceClocks[0].utc;
    const refreshed: number = sim.firmwareListRefreshes[0].ts;
    const mode: unknown = sim.metadata.hmip['X:1'].channelMode;
    const mismatch: string = sim.getKeyMismatchDevice('rfd', [true]);
    const suppressed: string[] = sim.getSuppressedServiceMessages('hmip', ['X:0']);
    sim.suppressServiceMessages('hmip', ['X:0', '', true]);
    const links = sim.getLinks('rfd', ['ABC0000001:1', 0]);
    const sender: string = links[0].SENDER;
    const replaced: true = sim.replaceDevice('rfd', 'ABC0000001', 'ABC0000002');
    const subscribers: number = Object.keys(sim.clients.rfd ?? {}).length;
    const client: HmSim.Client | undefined = sim.clients.rfd?.['http://127.0.0.1:2010'];
    client?.methodCall('system.listMethods', [client.id], (error, result) => void [error, result], {timeout: 100});
    const inner = sim.dispatch.bind(sim);
    sim.dispatch = (iface, method, params, callback, context) => inner(iface, method, params, callback, context);
    sim.dispatch('rfd', 'getVersion', [], (fault, result) => void [fault?.faultCode, result]);
    const interfaces: HmSim.BidcosInterface[] = sim.listBidcosInterfaces('rfd');
    const rpc: unknown = sim.callMethod('rfd', 'getVersion', []);
    sim.rpcMethods.getVersion = () => '9.9.9';
    sim.api.emit('setValue', 'rfd', 'ABC0000001:1', 'STATE', true);
    sim.api.on('setValue', () => {});
    const renames: Array<{id: number; name: string}> = sim.regaSim ? sim.regaSim.renames : [];
    const scripts: string[] = sim.regaSim?.scripts ?? [];
    const fault: HmSim.RpcFault = sim.fault('unknownInstance', 'X');
    const code: number = sim.faults.unknownMethod.faultCode;
    sim.close();

    // @ts-expect-error fireEvents wants tuples
    sim.fireEvents('rfd', [{address: 'A'}]);
    // @ts-expect-error schedule steps name the call
    await sim.schedule([{at: 1}]);
    // @ts-expect-error getWriteLog entries have no such field
    sim.getWriteLog()[0].nope;
    // @ts-expect-error clients is read-only
    sim.clients = {};

    void [port, added, found, count, value, paramset, read, messages, results, log, pending, poisoned, missing];
    void [answered, tempKey, seconds, names, keyChange, clock, refreshed, mode, mismatch, suppressed, sender];
    void [interfaces, rpc, renames, scripts, fault, code, incomplete, replaced, subscribers];
}

const table: faults.FaultTable = faults.DEFAULT_FAULTS;
const entry: faults.FaultEntry = faults.BIDCOS_FAULTS.notReachable;
const made = faults.createFaults({notReachable: {faultCode: -9}});
const thrown: faults.RpcFault = made.fault('notReachable', 'A');
const struct: faults.FaultEntry = new faults.RpcFault(-1, 'x').toStruct();
// @ts-expect-error a fault code is a number
faults.createFaults({notReachable: {faultCode: '-9'}});

void [scenario, table, entry, thrown, struct];
