# hm-simulator

[![NPM version](https://badge.fury.io/js/hm-simulator.svg)](http://badge.fury.io/js/hm-simulator)
[![CI](https://github.com/hobbyquaker/hm-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-simulator/actions/workflows/ci.yml)
[![License][mit-badge]][mit-url]

> Simulates a Homematic CCU for automated tests

hm-simulator answers the RPC calls a CCU's interface processes answer (rfd, hmipserver,
BidCos-Wired, VirtualDevices, CUxD), keeps the devices and paramsets behind them, calls back into
the logic layers that registered, and imitates what the real processes were measured to do -
faults, `CONFIG_PENDING`, service messages, restarts, a callback server that hangs. An application
that talks to a CCU can be tested against it without one, in-process or as a separate process. It
is used by the tests of [node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu),
[hm2mqtt.js](https://github.com/hobbyquaker/hm2mqtt.js),
[Homematic Manager](https://github.com/hobbyquaker/homematic-manager) and
[matterbridge-homematic](https://github.com/hobbyquaker/matterbridge-homematic).

- [Quick start](#quick-start)
- [What is simulated](#what-is-simulated)
- [Connecting a client](#connecting-a-client)
- [Options](#options)
- [Scenario API](#scenario-api)
- [Recipes](#recipes)
- [Device data and fixtures](#device-data-and-fixtures)
- [Interface behaviour, measured](#interface-behaviour-measured)
- [ReGa mock](#rega-mock)
- [TLS and basic auth](#tls-and-basic-auth)
- [Behaviour scripts](#behaviour-scripts)
- [Command line](#command-line)
- [Upgrading from 0.x](#upgrading-from-0x)

## Quick start

Prerequisites: [Node.js](https://nodejs.org) >= 20.19.

```
npm install --save-dev hm-simulator
```

TypeScript declarations ship with the package (`sim.d.ts`, `sim.d.mts`, `lib/faults.d.ts`): the
options, the scenario API, the introspection calls and the description types are under the `HmSim`
namespace (`HmSim.Options`, `HmSim.DeviceDescription`, `HmSim.ParamsetDescription`, ...).

A test file with `node:test` - the same shape works with mocha (`before`/`after`) and vitest
(`beforeAll`/`afterAll`):

```js
const {before, after, test} = require('node:test');
const assert = require('node:assert/strict');
const HmSim = require('hm-simulator/sim.js'); // ESM: import HmSim from 'hm-simulator/sim.mjs'
const lab = require('hm-simulator/data/fixtures/lab-2026-09.json');

let sim;

before(async () => {
  sim = new HmSim({
    devices: structuredClone(lab.devices), // the simulator changes the lists it is given
    paramsetDescriptions: lab.paramsetDescriptions,
    links: structuredClone(lab.links),
    bidcosInterfaces: lab.bidcosInterfaces,
    behaviorPath: false, // no example behaviour scripts firing events of their own
    config: {listenAddress: '127.0.0.1', binrpcListenPort: 0, xmlrpcListenPort: 0, wiredListenPort: 0},
  });
  await sim.whenReady(); // every server listens; rejects when a port is taken
});

after(() => sim.close());

test('the code under test sees the blind actuator', async () => {
  // point the code under test at xmlrpc_bin://127.0.0.1:${sim.ports.rfd} (BidCos-RF)
  // and http://127.0.0.1:${sim.ports.hmip} (HmIP-RF)
  assert.equal(sim.getDevice('hmip', '00000000000004').TYPE, 'HmIP-BBL');
});
```

Port `0` lets the operating system pick a free port, so test files can run in parallel;
`sim.ports` (`rfd`, `hmip`, `wired`, `virtual`, `cuxd`) holds what it picked once `whenReady()`
resolved.

With Playwright, start it in a `globalSetup` and hand the ports to the application under test,
for example through the environment:

```js
// playwright.global-setup.js
const HmSim = require('hm-simulator/sim.js');
const lab = require('hm-simulator/data/fixtures/lab-2026-09.json');

module.exports = async () => {
  const sim = new HmSim({
    devices: structuredClone(lab.devices),
    paramsetDescriptions: lab.paramsetDescriptions,
    behaviorPath: false,
    config: {listenAddress: '127.0.0.1', binrpcListenPort: 0, xmlrpcListenPort: 0},
  });
  await sim.whenReady();
  process.env.CCU_RFD_PORT = String(sim.ports.rfd);
  process.env.CCU_HMIP_PORT = String(sim.ports.hmip);
  return () => sim.close(); // Playwright runs the returned function as the teardown
};
```

For code that cannot `require()` it - a daemon in another language, a spawned service - run the
[command line](#command-line) with `--ports-json -` and drive it through the control port.

## What is simulated

**Interfaces.** Each has its own devices, values, paramsets, links and service messages.

| Interface      | Protocol                        | Port on a CCU | Option (the CLI flag)                                                      |
| -------------- | ------------------------------- | ------------- | -------------------------------------------------------------------------- |
| rfd            | BIN-RPC and XML-RPC on one port | 2001          | `config.binrpcListenPort` (`--binrpc-port`), on when `devices.rfd` exists  |
| hmipserver     | XML-RPC                         | 2010          | `config.xmlrpcListenPort` (`--xmlrpc-port`), on when `devices.hmip` exists |
| BidCos-Wired   | BIN-RPC and XML-RPC on one port | 2000          | `config.wiredListenPort` (`--wired-port`), on when `devices.wired` exists  |
| VirtualDevices | XML-RPC, path `/groups`         | 9292          | `config.virtualListenPort` (`--virtual-port`)                              |
| CUxD           | BIN-RPC                         | 8701          | `config.cuxdListenPort` (`--cuxd-port`)                                    |
| ReGa           | HTTP, `rega.exe`                | 8181          | `rega` (`--rega-port`), see [ReGa mock](#rega-mock)                        |

rfd and BidCos-Wired answer **BIN-RPC and XML-RPC on the same port**, as on a CCU: a connection
that starts with the bytes `Bin` is BIN-RPC, anything else XML-RPC over HTTP.
`interfaces: {rfd: {protocols: ['binrpc']}}` narrows a port to one of them.

**Incoming RPC methods.**

|                  |                                                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| session          | `init` (register and de-register a logic layer), `ping`, `system.listMethods`, `system.methodHelp`, `system.multicall`                                                                                                                            |
| devices          | `listDevices`, `getDeviceDescription`, `deleteDevice`, `replaceDevice`, `listReplaceableDevices`, `setInstallMode`, `getInstallMode`, `addDevice` (BidCos only), `getKeyMismatchDevice` (rfd, hmipserver)                                         |
| paramsets        | `getParamsetDescription`, `getParamset`, `putParamset`, `getValue`, `setValue`, `determineParameter`, `reportValueUsage`                                                                                                                          |
| links            | `getLinks`, `getLinkPeers`, `getLinkInfo`, `setLinkInfo`, `addLink`, `removeLink`, `activateLinkParamset`                                                                                                                                         |
| interface        | `rssiInfo`, `listBidcosInterfaces`, `setBidcosInterface`, `getServiceMessages`, `setTempKey` (BidCos only), `changeKey` (rfd, hmipserver), `logLevel`, `getVersion`, `setInterfaceClock` (rfd, hmipserver), `getLGWStatus` (only when configured) |
| metadata         | `getMetadata`, `setMetadata` (rfd, hs485d, hmipserver), `getAllMetadata` (BidCos only)                                                                                                                                                            |
| service messages | `suppressServiceMessages`, `getSuppressedServiceMessages` (hmipserver only)                                                                                                                                                                       |
| teams            | `listTeams`, `setTeam` (BidCos only): the smoke detector teams as rfd keeps them, pseudo devices `*<serial>`                                                                                                                                      |
| maintenance      | `clearConfigCache`, `restoreConfigToDevice`, `updateFirmware`, `installFirmware`, `refreshDeployedDeviceFirmwareList` (rfd, hmipserver)                                                                                                           |

Every write is checked against the paramset description (type, range, `VALUE_LIST`,
`OPERATIONS`) and answered the way the interface process answers it - see
[Interface behaviour, measured](#interface-behaviour-measured). `sim.methodNames()` lists the
methods.

**Outgoing RPC calls** to every registered logic layer: `listDevices`, `newDevices`,
`deleteDevices`, `updateDevice`, `event` and `system.multicall`; after a restart with remembered
clients also `system.listMethods`.

**What is not simulated:** the radio protocol and anything a device does on its own beyond what a
behaviour script or the scenario API makes it do; firmware behaviour beyond the update states of
[Device and radio health](#device-and-radio-health); duty cycle and carrier sense beyond the
levels a test sets; HmIP groups and heating groups as hmipserver forms them (VirtualDevices serves
whatever devices it is given); the CCU's web UI and JSON-API (`/api/homematic.cgi`); openccu-lite's
own APIs; ReGa beyond the scripts listed under [ReGa mock](#rega-mock).

## Connecting a client

A logic layer registers with `init(url, interfaceId)` and removes itself with `init(url, '')`. The
url is `xmlrpc_bin://host:port` (or `binrpc://`) for BIN-RPC callbacks and `http://host:port/path`
or `https://…` for XML-RPC ones, whichever protocol the `init` itself came over. The path is kept,
so one callback server can serve several interfaces (`http://127.0.0.1:8184/cb/BidCos-RF`). As on
a CCU a registration is identified by its url exactly, scheme and path included:
`init('http://h:1', '')` does not remove `xmlrpc_bin://h:1`. A url that is none is a fault.

After the `init` the simulator calls the client back as the interface processes do:

1. `listDevices(interfaceId)` - what the client already knows;
2. `deleteDevices` for devices the client knows and the interface does not (or whose `VERSION`
   differs), then `newDevices` with the ones the client does not know. hmipserver sends **every**
   device again on every `init`, and so does the simulator on `hmip`;
3. from then on `event(interfaceId, address, datapoint, value)` for every change - several at once
   as `system.multicall` (`fireEvents`).

`ping(callerId)` answers with a `CENTRAL`/`PONG` event to every registered client on the BidCos
interfaces, and with nothing on hmipserver, as the real one (`interfaces.<iface>.pong` changes
that). A client that watches for events to arrive therefore has to treat HmIP differently.

`sim.dropConnection(iface)` is an interface process that restarts in an instant: every registered
client is forgotten and every open connection reset; nothing tells the client, which receives no
more events until it calls `init` again. `restartInterface()` and its siblings model slower and
more talkative restarts, see [Interface processes misbehaving](#interface-processes-misbehaving).

Strings: an XML-RPC request declared ISO-8859-1 (in the XML declaration or the Content-Type
header), as the interface processes speak it, is read as such, anything else as UTF-8; answers are
UTF-8. BIN-RPC strings go out as ISO-8859-1, as rfd sends them.

## Options

`new HmSim(options)`; everything is optional.

| option                     | default                                              |                                                                                               |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `devices`                  | `{rfd: {devices: []}, hmip: {devices: []}}`          | device descriptions per interface, `{<iface>: {devices: [...]}}`                              |
| `paramsetDescriptions`     | the bundled 8.4 MB `data/paramset-descriptions.json` | replaces the bundled descriptions, see [Device data and fixtures](#device-data-and-fixtures)  |
| `paramsetFallback`         | `true`                                               | a firmware without a description uses the nearest one; `false` for exact keys only            |
| `links`                    | `{}`                                                 | links per interface, `[{SENDER, RECEIVER, FLAGS, NAME, DESCRIPTION}]`                         |
| `bidcosInterfaces`         | one per interface                                    | what `listBidcosInterfaces` answers, per interface                                            |
| `serviceMessages`          | `{}`                                                 | extra service messages per interface, `[[address, datapoint, value]]`                         |
| `newDevices`               | `{}`                                                 | devices that appear when the install mode is switched on, `{<iface>: {devices, delay}}`       |
| `defaultRssi`              | `-65`                                                | what `rssiInfo` answers where a device has no RSSI datapoint                                  |
| `metadata`                 | `{}`                                                 | what `getMetadata` answers before any `setMetadata`, `{<iface>: {<address>: {<key>: value}}}` |
| `config.listenAddress`     | all interfaces                                       | `'127.0.0.1'` in tests                                                                        |
| `config.binrpcListenPort`  | –                                                    | rfd                                                                                           |
| `config.xmlrpcListenPort`  | –                                                    | hmipserver                                                                                    |
| `config.wiredListenPort`   | –                                                    | BidCos-Wired, started when `devices.wired` exists                                             |
| `config.virtualListenPort` | off                                                  | VirtualDevices                                                                                |
| `config.virtualPath`       | `/groups`                                            | the path VirtualDevices answers on                                                            |
| `config.cuxdListenPort`    | off                                                  | CUxD                                                                                          |
| `interfaces`               | see below                                            | behaviour per interface, `{<iface>: {...}}`                                                   |
| `faults`                   | hmipserver's table                                   | overrides for the fault table, see [Fault codes](#fault-codes)                                |
| `behaviorPath`             | `behaviors/` of the package                          | directory with [behaviour scripts](#behaviour-scripts), `false` for none                      |
| `rega`                     | off                                                  | the [ReGa mock](#rega-mock)                                                                   |
| `tls`                      | off                                                  | `true` or `{key, cert}`, see [TLS and basic auth](#tls-and-basic-auth)                        |
| `auth`                     | off                                                  | `{username, password}`, HTTP basic auth                                                       |
| `log`                      | silent                                               | an object with `debug`, `info`, `warn`, `error` (`console` will do)                           |

**Per interface** (`interfaces: {hmip: {...}, rfd: {...}}`):

| option                         | default                                                                        |                                                                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configPendingMode`            | `'hmip'` for `hmip`, `'bidcos'` for `rfd` and `wired`, `'strict'` for the rest | what a MASTER write does, see [CONFIG_PENDING](#config_pending)                                                                                                                                               |
| `configPendingOnWrite`         | `false`                                                                        | raise `CONFIG_PENDING` for _every_ accepted MASTER write (implied by `'bidcos'` for every write that changes something)                                                                                       |
| `configPendingDelay`           | `0`                                                                            | milliseconds after which a non-sticky `CONFIG_PENDING` clears itself: the device taking the configuration (measured: 160-180 s on a thermostat that transmits regularly, "until the door opens" on a contact) |
| `serviceMessagesEmptyAsString` | `false`                                                                        | answer `getServiceMessages` with `''` instead of `[]` when nothing is pending, which is what rfd really does                                                                                                  |
| `protocols`                    | `['binrpc', 'xmlrpc']` for `rfd` and `wired`                                   | what the port of a BidCos interface answers                                                                                                                                                                   |
| `listenerModel`                | `'isolated'`                                                                   | `'measured'`: what the interface processes do with a callback server that hangs, see [below](#a-callback-server-that-hangs)                                                                                   |
| `deliveryTimeout`              | `10000`                                                                        | `'measured'` BidCos only: a client that does not take a callback within this time is dropped                                                                                                                  |
| `pong`                         | `false` for `hmip`, `true` for the rest                                        | whether `ping` sends the `CENTRAL`/`PONG` event                                                                                                                                                               |
| `pingDelay`                    | `0`                                                                            | milliseconds between `ping` and its `PONG`                                                                                                                                                                    |
| `startDelay`                   | `0`                                                                            | milliseconds after `whenReady()` until the port accepts connections: a process that starts late (`sim.ports` knows the port from the start)                                                                   |
| `unreachWrites`                | `'accept'`                                                                     | what `setValue`/`putParamset` to an unreachable device answer: `'accept'`, or `'fault'` (`notReachable`). The simulator's model, not a measurement                                                            |
| `firmwareUpdateDelay`          | `0`                                                                            | milliseconds per step of a firmware update                                                                                                                                                                    |
| `getServiceMessagesFault`      | `false`                                                                        | answer `getServiceMessages` with the unknown-method fault (`Invalid XML-RPC message`), as VirtualDevices, CUxD and hmipserver were seen to on 3.89.x                                                          |
| `version`                      | `'2.6.0'` for `rfd` and `wired`, `'3.89.11.20260919'` for `hmip`               | what `getVersion` answers; the rest has no `getVersion`                                                                                                                                                       |
| `lgwStatus`                    | –                                                                              | BidCos only: what `getLGWStatus` answers; without it the method is unknown, as on rfd 3.89.11                                                                                                                 |

## Scenario API

What a test calls on the simulator to make things happen and to look at what happened. The same
calls are available over HTTP on the [control port](#the-control-port).

**Devices**

```js
sim.addDevice('rfd', device, channel0, channel1); // pairs a device: newDevices to the clients
sim.removeDevice('rfd', 'LAB0000002'); // deleteDevices, with its values and links
sim.scriptNewDevices('rfd', [device, channel0, channel1], 500); // appear 500 ms after setInstallMode
sim.getDevice('rfd', 'LAB0000002:1'); // the description, false when unknown
// a device that holds another system's key: the next install mode hears it (getKeyMismatchDevice
// names it) until setTempKey('their-key') lets it pair; addDevice('LAB0000009') does the same
sim.scriptKeyMismatch('rfd', 'LAB0000009', {key: 'their-key', devices: [device, channel0, channel1]});
```

**Values and events**

```js
sim.fireEvent('rfd', 'LAB0000002:1', 'STATE', true); // one event, not checked against the description
sim.fireEvents('hmip', [[address, 'LEVEL', 0.5], ...], {batch: 10}); // a burst as system.multicall
sim.setValue('rfd', 'LAB0000002:1', 'STATE', true, {internal: true}); // the device reports a value
sim.values.rfd['LAB0000002:1'].VALUES.STATE; // the stored state: VALUES, MASTER, LINKS per channel
sim.api.emit('setValue', 'rfd', 'LAB0000002:1', 'STATE', true); // as a behaviour script does
```

**Service messages, device and radio health**

```js
sim.setServiceMessage('rfd', 'LAB0000002:0', 'STICKY_UNREACH', true);
sim.setReachable('hmip', '00000000000004', false); // UNREACH (+ STICKY_UNREACH on BidCos)
sim.setLowBattery('rfd', 'LAB0000003', true); // LOWBAT or LOW_BAT, whichever :0 has
sim.setDutyCycle('rfd', 42); // listBidcosInterfaces' DUTY_CYCLE
sim.setCarrierSense('hmip', 8); // and CARRIER_SENSE_LEVEL on the radio module's :0
sim.offerFirmware('hmip', '00000000000004', '1.2.0'); // a firmware update becomes available
```

**Interface processes**

```js
await sim.dropConnection('rfd'); // restart in an instant, clients forgotten
await sim.stopInterface('hmip'); // the port refuses connections
await sim.startInterface('hmip', {forgetClients: true});
await sim.restartInterface('rfd', {downMs: 2000, forgetClients: false});
sim.injectFault({iface: 'rfd', method: 'setValue', fault: 'notReachable', times: 1});
sim.clearFaults();
```

**Time**

```js
await sim.schedule([{at: 1000, call: 'setReachable', args: ['rfd', 'LAB0000002', false]}]);
```

**Introspection**

```js
sim.getWriteLog(); // every accepted putParamset: [{iface, address, paramset, values, rejected, ts}]
sim.getConfigPending('rfd'); // [{address, sticky}]
sim.getPoisonedChannels('hmip'); // channels whose stored MASTER has a parameter they do not have
sim.getMissingParamsetDescriptions(); // [{iface, key, usedKey}]; empty: the fixture is complete
sim.getCallbackLog(); // every call to a client: [{iface, client, method, sentAt, answeredAt, error}]
sim.getTempKey('rfd'); // what setTempKey set
sim.getInstallMode('rfd'); // seconds of install mode left
sim.keyChanges; // every changeKey: [{iface, key, ts}]
sim.firmwareListRefreshes; // every refreshDeployedDeviceFirmwareList: [{iface, ts}]
sim.interfaceClocks; // every setInterfaceClock: [{iface, utc, offset, ts}]
sim.metadata; // what setMetadata stored: {<iface>: {<address>: {<key>: value}}}
sim.ports; // {rfd, hmip, wired, virtual, cuxd, ...}: the ports once whenReady() resolved
sim.regaSim.scripts; // every script the ReGa mock received
```

### Device and radio health

- A datapoint the `:0` channel's description has is stored and sent as the description says, and
  counts as a service message by its `FLAGS`; one it does not have is sent as an event and raised
  with `setServiceMessage`. `STICKY_UNREACH` stays after the device is back until a client writes
  it `false`, as rfd does. A write to an unreachable device is accepted unless `unreachWrites` is
  `'fault'`.
- The radio module is the HmIP device whose address is the last 14 characters of the interface's
  address in `listBidcosInterfaces` (its SGTIN), or a device of a radio module's type
  (`RPI-RF-MOD`, `HmIP-RFUSB`); without one only `listBidcosInterfaces` changes.
- `offerFirmware` sets `AVAILABLE_FIRMWARE`, `FIRMWARE_UPDATE_STATE: 'NEW_FIRMWARE_AVAILABLE'` and
  `UPDATABLE` in the device description and `UPDATE_PENDING` on `:0`, and sends `updateDevice`.
  `updateFirmware`/`installFirmware` then walk `FIRMWARE_UPDATE_STATE` through
  `DO_UPDATE_PENDING`, `PERFORMING_UPDATE` and `UP_TO_DATE` (an `updateDevice` each, one step per
  `firmwareUpdateDelay`) and set `FIRMWARE` at the end. Without an offer they only record the call.
  The state names are the RPC specification's; the timing is the simulator's model.
- `schedule` runs any scenario call on the simulator's timer (`at` in milliseconds from now) and
  resolves with the results; `close()` cancels what did not run yet.

### Interface processes misbehaving

For the code that has to survive an interface process that restarts, starts late, answers slowly or
not at all - reconnects, re-inits, watchdogs, init retries:

```js
sim.injectFault({iface: 'rfd', method: 'init', times: 3, fault: 'unknownInstance'});
sim.injectFault({iface: 'hmip', method: '*', delayMs: 1500}); // answer late
sim.injectFault({method: 'getValue', hang: true}); // never answer
sim.injectFault({method: 'listDevices', closeSocket: true}); // close the connection instead
```

- **Restarts.** With `forgetClients: true` (the default) a restarted process has forgotten every
  registered client: no events until the client calls `init` again. With `forgetClients: false`
  it remembers them and calls each back as rfd does when it starts with its handlers file:
  `system.listMethods` (BidCos), `listDevices`, `newDevices`/`deleteDevices` - calls the client did
  not ask for, which is how it can tell that the process restarted.
- **Late start.** `interfaces: {hmip: {startDelay: 5000}}` binds the port and refuses connections
  until the delay is over.
- **Injected faults** apply to the next `times` calls (default 1; `Infinity` or `-1` until
  `clearFaults()`) of `method` (`'*'` for any) on `iface` (every interface when omitted), over both
  transports. `fault` is a key of the fault table or `{faultCode, faultString}`; `delayMs` can be
  combined with the others.
- **The callback log** lists every call the simulator made to a client with when it was sent and
  answered, so a test can assert that its callback server answers fast.

## Recipes

Each assumes the quick start's `sim` with the lab fixture (`LAB0000002` is its HM-LC-Sw1-Pl-2,
`LAB0000003` the HM-Sec-SC, `00000000000004` the HmIP-BBL) and a client of the code under test
registered on the interface.

**A device goes unreachable and comes back.**

```js
sim.setReachable('rfd', 'LAB0000002', false); // events UNREACH true, STICKY_UNREACH true on :0
sim.setReachable('rfd', 'LAB0000002', true); // UNREACH false; STICKY_UNREACH stays
// the client acknowledges: setValue('LAB0000002:0', 'STICKY_UNREACH', false) over RPC
```

**A sticky service message.** `sim.setServiceMessage('hmip', '00000000000004:0', 'CONFIG_PENDING',
true)` sends the event, and `getServiceMessages` lists it until it is set `false` the same way.

**A device is paired.**

```js
sim.scriptNewDevices('rfd', [device, channel0, channel1], 500);
// the code under test calls setInstallMode(true, 60) - 500 ms later the clients get newDevices
```

or without the install mode, `sim.addDevice('rfd', device, channel0, channel1)`.

**The interface process restarts.** `await sim.dropConnection('hmip')`, then assert that the code
under test calls `init` again; `await sim.restartInterface('rfd', {downMs: 3000, forgetClients:
false})` for a restart it has to notice from the callbacks.

**CONFIG_PENDING after a MASTER write.** With `interfaces: {rfd: {configPendingDelay: 2000}}`, a
`putParamset('LAB0000003', 'MASTER', {CYCLIC_INFO_MSG: true})` of the code under test raises
`CONFIG_PENDING` on `LAB0000003:0` (an event, and `sim.getConfigPending('rfd')`), and 2 s later it
clears, as when the device took the configuration.

**What was written.**

```js
const writes = sim.getWriteLog().filter((entry) => entry.address === 'LAB0000003');
assert.deepEqual(writes.at(-1).values, {CYCLIC_INFO_MSG: true});
```

**A smoke detector team.** Give the smoke channels of HM-Sec-SD-2 devices a `TEAM`
(`'*<serial of the team>:1'`) and `TEAM_TAG: 'smoke_detector'`, and the team as a device of its own
(`ADDRESS: '*<serial>'`, `TYPE: 'HM-Sec-SD-2-Team'`) whose team channel lists the members in
`TEAM_CHANNELS`. `listTeams` answers the team devices, `setTeam(channel, team)` moves a detector
and deletes a team nobody is left in, `setTeam(channel, '')` gives it a team of its own - with
`newDevices`, `deleteDevices` and `updateDevice` to the clients. The shape is rfd's as read from a
CCU3; when rfd deletes and creates the team devices is the simulator's model.

## Device data and fixtures

**What ships.** Without `devices` the library starts with no devices; the [command line](#command-line)
loads the historical lists `data/devices-rfd.json` (only the CCU's own `HM-RCV-50`, firmware
2.27.8, `BidCoS-RF:0..50`) and `data/devices-hmip.json` (six HmIP devices of 2017: HMIP-eTRV,
HMIP-PS, HMIP-SWDO, HMIP-WTH, HmIP-SMI and a radio module). Without `paramsetDescriptions` both use
`data/paramset-descriptions.json` (1855 descriptions). These stay as they are for compatibility;
**tests should use a fixture**:

| File                             | What                                                                                                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `data/fixtures/lab-2026-09.json` | real devices of four test systems with the descriptions of their exact firmware, links and radio modules - the recommended one                                                    |
| `data/fixtures/devices.json`     | generated from node-red-contrib-ccu's `paramsets.json`: real descriptions, synthesised channel indexes - HmIP-PDT, HmIPW-DRS8, HmIPW-DRI16, HmIPW-DRAP, HM-LC-Sw1-Pl, HM-CC-RT-DN |
| `data/fixtures/lab-devices.json` | a real `listDevices` of two CCUs on firmware 3.89.8 (2026-09-05), no descriptions of its own - pass the ones of `devices.json` or the bundled set alongside                       |

**`data/fixtures/lab-2026-09.json`**: four test systems (openccu-lite, the interface processes of
OpenCCU 3.89.11) dumped with `tools/dump-ccu.js` on 2026-09-29 and merged - `listDevices`, the
paramset descriptions of exactly the firmware every device runs (MASTER, VALUES, SERVICE, LINK;
`getMissingParamsetDescriptions()` is empty without the fallback), the direct links and
`listBidcosInterfaces`:

| Interface    | Device types                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BidCos-RF    | HM-RCV-50 (the central, `BidCoS-RF:0..50`), HM-CC-TC, HM-Sec-SC, HM-LC-Sw1-Pl-2; five radio interfaces (types `CCU2`, `USB Interface`, `HMLGW2`)                               |
| BidCos-Wired | HMW-RCV-50 (the central only)                                                                                                                                                  |
| HmIP-RF      | HmIP-RCV-50 (the central), the radio modules RPI-RF-MOD and HmIP-RFUSB (twice), HmIP-HAP, HmIP-BBL, HMIP-WRC2 (three firmwares), HmIP-PDT, HmIPW-DRAP, HmIPW-DRI16, HmIPW-DRS8 |

Links: WRC2s on the PDT, the BBL and a DRS8 channel, the PDT's and the BBL's internal links, and
the Sw1's one on BidCos-RF. A real hmipserver lists one radio module; the merged set lists three,
and `listBidcosInterfaces` names the first as the HmIP radio (its `ADDRESS` is `3014F711A0` + that
module's device address, as on a CCU). Serials are anonymised consistently in their own shape -
BidCos `LAB0000001`, HmIP `00000000000004` - link names are empty, and nothing else is changed.
Real hardware's oddities stay: the CCU's own `HmIP-RCV-50` sends a trailing **empty string** in
`CHILDREN`, for instance. The file is also a device file for the command line (`--devices`; add
`--wired-port 0` or a port for BidCos-Wired).

**How descriptions are found.** A description is looked up by
`<interface>/<type>/<firmware>/<version>/<channel type>/<paramset>`, and a device reports the
firmware it runs - which a description set often does not have. Such a device uses the description
of the **nearest firmware** of the same type and `VERSION`: the highest one at or below its own,
else the lowest one above it; firmware compared numerically part by part, a trailing build date
(`3.41.11.20181222`) last. Each substitution is logged once at `warn`. A type with no description
at all answers `-2` for its paramsets. `paramsetFallback: false` keeps the exact keys only, and
`sim.getMissingParamsetDescriptions()` lists every paramset a device announces in `PARAMSETS`
without an exact description, with the key used instead (`usedKey`, `null` when there is none):

```js
assert.deepEqual(sim.getMissingParamsetDescriptions(), []); // the fixture is complete
```

**Making a fixture from a CCU.** `tools/dump-ccu.js` (in the repository, not in the package):

```
node tools/dump-ccu.js --rfd xmlrpc_bin://127.0.0.1:2001 --hmip xmlrpc://127.0.0.1:2010 \
    --virtual xmlrpc://127.0.0.1:9292/groups --out my-ccu.json
```

Every interface may be given more than once to merge several systems; `--types` keeps only the
device types listed, `--keep-serials` switches the anonymisation off, `--help` lists the rest. It
only reads (`listDevices`, `getParamsetDescription`, `getLinks`, `listBidcosInterfaces`), and it
refuses to write a file in which anything shaped like a serial, an HmIP address or an SGTIN is left
that it did not put there itself. The rest of a CCU's identity - host names, addresses, keys - is
never read.

**Making a fixture from descriptions.** `tools/fixtures-from-paramsets.js` builds devices from a
paramset description dump: node-red-contrib-ccu writes every description it ever read into
`paramsets.json` in its Node-RED user directory (and its repository carries one), keyed the same
way.

```
node tools/fixtures-from-paramsets.js --source ../node-red-contrib-ccu/paramsets.json \
    --types HmIP-PDT,HM-LC-Sw1-Pl --out data/fixtures/devices.json
node tools/fixtures-from-paramsets.js --source ../node-red-contrib-ccu/paramsets.json --list
```

Such a dump knows the channel _types_ of a device but never their _indexes_, so the channel layout
comes from `tools/device-layouts.json`. An entry with a `channels` list is the real layout of the
hardware, read from a `listDevices` dump (HmIP-PDT, HmIP-WRC2, HmIPW-DRS8, HmIPW-DRI16, HmIPW-DRAP,
HM-CC-TC, HM-Sec-SC); everything else is synthesised from `order` and `counts` - consistent within
a fixture, not guaranteed to match the hardware. **A device type** is added with an entry there and
a run of the generator, or, better, by dumping a CCU that has one.

## Interface behaviour, measured

Where the simulator imitates an interface process, this says whether the shape was measured on a
CCU or is the simulator's model. The measurements were made for Homematic Manager (tasks 6 and 58)
on CCUs with firmware 3.89.8 and 3.89.x.

### Direct links

rfd (firmware 3.89.11, 2026-09-30) answers `getLinks("", flags)` - the list of all links - with
`FLAGS: 1` (`SENDER_BROKEN`) on every **device-internal** link: a relay's own button on the relay
(`:1` → `:1`), a dimmer's channel on its virtual channels. The link works; the bit carries no
information there. Asked for one address, `getLinks("ABC0000001:1", 0)` and `getLinks("ABC0000001",
0)` answer the same link with `FLAGS: 0`, and `getLinkPeers` names the own channel once. The simulator
does the same on `rfd`: `addLink` stores `FLAGS: 0`, the unfiltered list adds bit 1 to internal links
(seeded flags are kept and or-ed), the filtered one reports what is stored. hmipserver is not
measured and reports the stored flags. rfd also refuses `getLinkPeers` of a device address (`-1
Failure`); the simulator answers the peers of all its channels.

### CONFIG_PENDING

What a `putParamset MASTER` does, per interface (`interfaces.<iface>.configPendingMode`):

| `configPendingMode` | what a `putParamset MASTER` does                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'hmip'`            | measured hmipserver: stores everything, faults when the result is not transferable, poisons the channel on an unknown parameter, sticky `CONFIG_PENDING` on a wrong type, no range check |
| `'bidcos'`          | measured rfd: no fault, unknown parameters dropped, values clamped or ignored, `CONFIG_PENDING` while the change is queued                                                               |
| `'strict'`          | a model: an invalid write is answered with a fault and nothing is written                                                                                                                |
| `'pending'`         | a model: the write is accepted, the valid parameters are stored, the rejected ones are recorded, and a sticky `CONFIG_PENDING` is raised                                                 |

- **hmipserver stores what it rejects.** Everything in the struct is written into its own
  configuration for the channel first; the fault comes afterwards, when the result cannot be
  transferred to the device. A parameter the channel does not have is stored **for ever** - it
  survives a restart, no RPC method removes it, and from then on every `putParamset` on that
  channel faults, including one with an empty struct (`sim.getPoisonedChannels(iface)`; deleting
  the device is the only cure, on the hardware too). A value of the wrong type raises a sticky
  `CONFIG_PENDING`, which a valid full MASTER write clears. A number outside `MIN`..`MAX` is
  accepted without a word.
- **rfd never faults on a value.** It drops a parameter the device does not have, ignores what it
  cannot use, clamps numbers into `MIN`..`MAX` and coerces strings - and answers `ok` to all of
  it. `CONFIG_PENDING` there means "a configuration is queued for the device" and clears when the
  device takes it (`configPendingDelay`), which on a battery device is when it next wakes up.
- In `'strict'` and `'pending'` a sticky `CONFIG_PENDING` clears on a valid full MASTER write, on
  `clearConfigCache(deviceAddress)` or on `restoreConfigToDevice(deviceAddress)`. In `'hmip'` only
  the valid full MASTER write does: `clearConfigCache`, `restoreConfigToDevice` and
  `determineParameter` answer `-1 Generic error` there, exactly as hmipserver does.

The two models are the explanations that competed before the measurement (Homematic Manager issue
#98); they stay for applications that want to test against them.

### Fault codes

The default table is **hmipserver's**, because that is the one an application has to survive
(measured):

| key                | code | string                          | when                                                                               |
| ------------------ | ---- | ------------------------------- | ---------------------------------------------------------------------------------- |
| `unknownMethod`    | -1   | Invalid XML-RPC message         | no handler for the method name (hmipserver answers this without a faultCode)       |
| `unknownInstance`  | -2   | Invalid device                  | address not known to this interface                                                |
| `unknownParamset`  | -2   | Invalid device                  | the device has no such paramset                                                    |
| `unknownLink`      | -2   | Invalid device                  | the two channels are not linked                                                    |
| `unknownParameter` | -5   | Unknown Parameter for value key | the paramset has no such parameter                                                 |
| `readOnly`         | -5   | Invalid parameter or value      | `OPERATIONS & 2` is not set                                                        |
| `typeError`        | -5   | Invalid parameter or value      | value does not fit the parameter's `TYPE`                                          |
| `outOfRange`       | -5   | Invalid parameter or value      | ENUM value not in `VALUE_LIST`                                                     |
| `invalidValue`     | -5   | Invalid parameter or value      | the stored channel configuration cannot be transferred                             |
| `notSupported`     | -1   | Generic error                   | a method this interface does not implement                                         |
| `notReachable`     | -1   | Generic error (UNREACH)         | a sleeping battery device                                                          |
| `invalidArguments` | -321 | Invalid arguments               | wrong number of arguments; hmipserver really answers a Java exception message here |

Over XML-RPC a fault is an XML-RPC fault, over BIN-RPC a message of type `0xff` with a
`faultCode`/`faultString` struct. rfd's table is exported as `BIDCOS_FAULTS` and differs in more
than wording - it answers **no fault at all** for an unknown paramset name (it takes the name as a
peer address), for a missing argument, and for a `setValue` on a read-only datapoint:

```js
const {FAULT_TABLES} = require('hm-simulator/lib/faults.js');
new HmSim({faults: FAULT_TABLES.bidcos});
new HmSim({faults: {unknownParameter: {faultCode: -4, faultString: 'Unknown parameter'}}}); // one entry
```

### Service messages

`getServiceMessages` answers `[[address, datapoint, value]]`: every datapoint whose description
flags it as a service message and whose value is set, plus what `setServiceMessage` and the
`serviceMessages` option add. rfd answers an empty **string** rather than an empty array when
nothing is pending (measured); `serviceMessagesEmptyAsString: true` does the same - off by default,
because it breaks every client that assumes an array, which is why a client should be tested with it
once. Teams (`listTeams`) have the shape rfd was read to have on a CCU3.

**Suppression** (hmipserver only, eQ-3's HmIP addendum): `suppressServiceMessages(channelAddress,
parameter, suppress)` takes one of the channel's service parameters or `''` for all of them, and
ignores a parameter without the service flag; `getSuppressedServiceMessages(channelAddress)`
answers the suppressed ones (`[]` for an address it does not know). Measured on 3.89.11. A
suppressed message is left out of `getServiceMessages` and its datapoint reports the value that
raises no message (`false`), in `getValue`, `getParamset` and events, while the stored value stays;
a new occurrence stays suppressed until the suppression is lifted. That a change of the suppression
sends that value as an event is the simulator's model.

VirtualDevices, CUxD and hmipserver were seen to answer `getServiceMessages` with the fault
`Invalid XML-RPC message` on 3.89.x (hmipserver answered it on 3.89.11);
`interfaces.<iface>.getServiceMessagesFault: true` does the same, for a client that has to survive
it.

### A callback server that hangs

`interfaces.<iface>.listenerModel: 'measured'`. Measured on firmware 3.89.8 (2026-09-25) with a
callback server that accepts the connection and never answers:

| interface      | what happens                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hmip`         | `init` is answered at once, `listDevices` is called back afterwards. While that callback hangs, **no event reaches any client** of the interface; they are queued and follow when the connection ends, and the client that hung is not called again. A client that hangs _after_ its registration holds up only itself.                     |
| `rfd`, `wired` | `system.listMethods` is called back **before** `init` answers, and until it returns **the interface answers nothing at all**, to anybody. When the connection ends, it is tried three more times at once and the client is registered anyway. A registered client that does not take a callback within `deliveryTimeout` (10 s) is dropped. |

That `listDevices` also comes before rfd answers the `init` is the simulator's model, not a
measurement; so is everything with the default `'isolated'`, where every client is on its own.

### The calls of openccu-lite's daemon

`logLevel` (rfd and hs485d answer the level, 5 until one is set; hmipserver an empty string),
`changeKey` (rfd, hmipserver; recorded in `sim.keyChanges`) and `refreshDeployedDeviceFirmwareList`
(rfd, hmipserver; recorded in `sim.firmwareListRefreshes`) answer as the interfaces were measured to
on firmware 3.89.x; the simulator does no cryptography and loads no firmware.

### The calls of Homematic Manager

Measured on rfd and hmipserver of firmware 3.89.11 (read-only calls, and one suppression set and
lifted again):

| call                                     | rfd                                                                    | hmipserver                                |
| ---------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------- |
| `getKeyMismatchDevice(reset)`            | `''` when no device holds another key                                  | the same                                  |
| `getMetadata(address, key)`, key not set | fault `-1 Failure`, for an unknown address too                         | an empty value                            |
| `getAllMetadata(address)`, nothing set   | fault `-1 Failure`                                                     | not in `system.listMethods`               |
| `listReplaceableDevices(address)`        | `[]` for its own `BidCoS-RF`, `-2 Unknown instance` for an unknown one | an empty HTTP body, always                |
| `getVersion()`                           | `2.6.0`                                                                | the firmware, `3.89.11.…`                 |
| `getLGWStatus()`                         | `unknown method name`, with and without a LAN gateway in the system    | not in `system.listMethods`               |
| `suppressServiceMessages(…)`             | not in `system.listMethods`                                            | see [Service messages](#service-messages) |

The simulator answers so, with the fault table in force (`-1 Generic error` under hmipserver's
default table where rfd says `-1 Failure`) and `''` for hmipserver's empty body. Its models:
`listReplaceableDevices` on rfd lists the other devices of the same `TYPE`; `setMetadata` on rfd
knows only its own addresses; `setInterfaceClock` is recorded, not measured (it sets the clock the
devices get). `addDevice(serial)` pairs only the device of `scriptKeyMismatch`, with the right
temporary key; any other serial is `unknownInstance`, the mismatch a `notSupported` fault.

## ReGa mock

`rega: {port: 8181, ...}` starts an HTTP server that answers `POST /<name>.exe` as the CCU's
`rega.exe` does - the script output followed by an `<xml>` block - for the scripts of the
[homematic-rega](https://github.com/hobbyquaker/homematic-rega) client, recognised by their first
line. Each answers the option of the same name:

| first line          | client call      | option      | one element                                                                       |
| ------------------- | ---------------- | ----------- | --------------------------------------------------------------------------------- |
| `!# devices.rega`   | `getChannels()`  | `channels`  | `{id: 1001, address: 'LAB0000002:1', name: 'Plug'}`                               |
| `!# variables.rega` | `getVariables()` | `variables` | `{id: 950, name: 'Presence', val: true, ts: '2026-01-01 12:00:00'}`               |
| `!# programs.rega`  | `getPrograms()`  | `programs`  | `{id: 2000, name: 'Lights off', active: true}`                                    |
| `!# rooms.rega`     | `getRooms()`     | `rooms`     | `{id: 20, name: 'Hall', channels: [1001]}`                                        |
| `!# functions.rega` | `getFunctions()` | `functions` | `{id: 30, name: 'Light', channels: [1001]}`                                       |
| `!# values.rega`    | `getValues()`    | `values`    | `{name: 'BidCos-RF.LAB0000002:1.STATE', value: false, ts: '2026-01-01 12:00:00'}` |

Of the other scripts, these are applied to the mock's state: `dom.GetObject(id).State(value)` (a
variable), `.Name("...")` (any object; also recorded in `sim.regaSim.renames` as `{id, name,
script}`), `.Active(true|false)` and `.ProgramExecute()` (a program). Every script, applied or not,
is recorded in `sim.regaSim.scripts` and anything else is answered with an empty output. `rega`
also takes `listenAddress`, `tls` and `auth` (inherited from the simulator's when not given);
`sim.regaSim.port` is the port once `whenReady()` resolved.

## TLS and basic auth

`tls: true` serves every XML-RPC server - hmipserver, VirtualDevices, the XML-RPC half of rfd's and
BidCos-Wired's ports - and the ReGa mock over HTTPS; BIN-RPC has no TLS and stays plain, as on a
CCU. The certificate is self-signed, for `localhost`/`127.0.0.1`, generated per run and available
as `sim.tls.cert` (PEM; `--tls-cert-out <file>` on the command line), so a client either trusts
that or connects with `rejectUnauthorized: false`. `tls: {key, cert}` uses your own pair instead.

`auth: {username, password}` requires HTTP basic auth on the same servers (the XML-RPC ones and
ReGa); BIN-RPC has none. Callbacks to `https://` urls are made with `rejectUnauthorized: false`.

## Behaviour scripts

A behaviour script is a module in `behaviorPath` that exports `api => {...}` and makes devices act
on their own with `api.emit('setValue', iface, address, datapoint, value)` - a device report, so it
may set datapoints a client could not write (`PRESS_SHORT`, `UNREACH`). **They are on by default:**
without `behaviorPath` the two examples in the package's `behaviors/` load and press `BidCoS-RF:1`
every 5 s and toggle `0000D3C98C9233:1` every 60 s - events a test did not ask for, and timers that
keep the process alive. Pass `behaviorPath: false` (or `--no-behaviors`) in tests.

## Command line

```
Usage: hm-simulator [options]

  --listen-address <ip>     default 127.0.0.1
  --binrpc-port <port>      rfd (BIN-RPC and XML-RPC), default 2001
  --xmlrpc-port <port>      hmipserver, default 2010
  --wired-port <port>       BidCos-Wired, off unless given or configured
  --virtual-port <port>     VirtualDevices, off unless given
  --cuxd-port <port>        CUxD, off unless given
  --rega-port <port>        ReGa mock, default 8181
  --no-rega                 do not start the ReGa mock
                            every port may be 0: the system picks a free one
  --ports-json <file|->     once every server listens, write the ports as JSON to the file, or
                            as one line to stdout with "-" (the log then goes to stderr)
  --config <file>           constructor options as a .json or .js file; the flags override it
  --devices <file>          a device file: {devices: {rfd, hmip, ...}, paramsetDescriptions, links,
                            bidcosInterfaces}, such as data/fixtures/lab-2026-09.json; default:
                            the bundled rfd and hmip lists
  --tls                     serve the XML-RPC servers over TLS with a generated certificate
  --tls-cert-out <file>     write that certificate (PEM) to the file
  --auth <user:password>    HTTP basic auth for the XML-RPC servers and ReGa
  --behavior-path <dir>     behaviour scripts, default the bundled examples
  --no-behaviors            no behaviour scripts
  --control-port <port>     the scenario API over HTTP on 127.0.0.1, off unless given
  -v, --verbosity <level>   error|warn|info|debug, default info
  --version
  -h, --help
```

Unlike the library, the CLI listens on `127.0.0.1`, starts the ReGa mock on 8181 and loads the
bundled device lists unless `--devices` or `--config` says otherwise.

**Out of process** - start it with every port `0` and `--ports-json -`, wait for the first line on
stdout, and read the ports from it:

```
$ hm-simulator --binrpc-port 0 --xmlrpc-port 0 --no-rega --no-behaviors \
    --devices node_modules/hm-simulator/data/fixtures/lab-2026-09.json --wired-port 0 \
    --control-port 0 --ports-json -
{"rfd":40123,"wired":40124,"hmip":40125,"control":40126}
```

`--ports-json <file>` writes the same object to a file instead (atomically: a reader never sees
half of it). A port that is taken ends the process with exit code 1 and the address in the
message. `SIGTERM` and `SIGINT` close every server and exit 0.

`--config` takes the constructor options as a file; `devices` and `paramsetDescriptions` in it may
be paths (relative to the file), `devices` a device file as for `--devices`. Everything without a
flag of its own - `interfaces`, `faults`, `serviceMessages`, `newDevices`, `rega`'s data - goes
there. The flags win over the file:

```json
{
  "devices": "node_modules/hm-simulator/data/fixtures/lab-2026-09.json",
  "interfaces": {"rfd": {"serviceMessagesEmptyAsString": true}},
  "rega": {"variables": [{"id": 950, "name": "Presence", "val": true}]}
}
```

### The control port

`--control-port` (loopback only) is the [scenario API](#scenario-api) over HTTP:
`POST /scenario/<call>` with a JSON array of the arguments, `GET /scenario/<call>` for one without
arguments. The answer is `{"result": ...}`; a fault is `400` with `faultCode` and `faultString`, an
unknown call `404`. `GET /ports` answers the ports. The calls: `addDevice`, `removeDevice`,
`fireEvent`, `fireEvents`, `setValue` (the device reporting a value, as a behaviour script does),
`setServiceMessage`, `scriptNewDevices`, `scriptKeyMismatch`, `dropConnection`, `stopInterface`, `startInterface`,
`restartInterface`, `injectFault`, `clearFaults`, `setReachable`, `setLowBattery`, `setDutyCycle`,
`setCarrierSense`, `offerFirmware`, `schedule`, `getDevice`, `getWriteLog`, `getConfigPending`,
`getPoisonedChannels`, `getMissingParamsetDescriptions`, `getCallbackLog`, `getTempKey`,
`getInstallMode`.

```
curl -s -X POST localhost:40126/scenario/setReachable -d '["rfd", "LAB0000002", false]'
```

## Upgrading from 0.x

- `require('hm-simulator/sim')` and `require('hm-simulator/sim.js')` keep returning the `HmSim`
  class; `sim.mjs` is the ESM entry point.
- The constructor options `config.listenAddress`, `config.binrpcListenPort`,
  `config.xmlrpcListenPort`, `devices`, `log`, `behaviorPath` and `rega` are unchanged, and so are
  `sim.api`, `sim.regaSim`, `sim.values`, `sim.rfdServer`, `sim.hmipServer` and `sim.close()`.
- Everything new is off by default: no additional server starts, no TLS, no basic auth.
- `configPendingMode` **is** on by default, though: since the lab measurement of 2026-09-05 the
  `hmip` interface defaults to `'hmip'` and `rfd`/`wired` to `'bidcos'`, so an application is
  tested against what the interface processes really do rather than against a guess. Pass
  `interfaces: {rfd: {configPendingMode: 'strict'}}` for the old behaviour.
- The fault codes changed with the same measurement (`-3` -> `-2`, `-4`/`-6`/`-7` -> `-5`, and the
  strings with them). A test that asserts a code has to be updated; `FAULT_TABLES` and the
  `faults` option restore any other table.
- Calls that used to be answered with an empty string because they had no handler now do something:
  `getParamset`, `putParamset`, `getLinks`, `getServiceMessages`, `listBidcosInterfaces`, `rssiInfo`
  and the rest of the table above. An unknown method now answers a fault instead of an empty string.
- Node >= 20.19. `binrpc` 4 and `homematic-xmlrpc` 2 are the only runtime dependencies.

## Contributing

Pull requests welcome. `npm run lint` and `npm test` have to pass; a new RPC method or scenario call
comes with a test over both transports where it applies.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

MIT
Copyright (c) 2017 Sebastian Raff

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
