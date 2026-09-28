# hm-simulator

[![NPM version](https://badge.fury.io/js/hm-simulator.svg)](http://badge.fury.io/js/hm-simulator)
[![CI](https://github.com/hobbyquaker/hm-simulator/actions/workflows/ci.yml/badge.svg)](https://github.com/hobbyquaker/hm-simulator/actions/workflows/ci.yml)
[![License][mit-badge]][mit-url]

> Simulates a Homematic CCU for automated tests

hm-simulator answers the RPC calls a CCU's interface processes answer, keeps the state behind them
and calls back into the logic layer that registered itself, so that an application that talks to a
CCU can be tested without one. It is used by
[node-red-contrib-ccu](https://github.com/rdmtc/node-red-contrib-ccu),
[hm2mqtt.js](https://github.com/hobbyquaker/hm2mqtt.js) and
[Homematic Manager](https://github.com/hobbyquaker/homematic-manager).

## Installation

Prerequisites: [Node.js](https://nodejs.org) >= 20.19

```
npm install --save-dev hm-simulator
```

Or, as a standalone process, `npm install -g hm-simulator` and then `hm-simulator --help`.

## What is simulated

**Interfaces.** rfd (binrpc and xmlrpc), hmipserver (xmlrpc), BidCos-Wired (binrpc and xmlrpc),
VirtualDevices (xmlrpc, path `/groups`) and CUxD (binrpc). Each has its own devices, values,
paramsets, links and service messages. rfd and hmipserver start by default, the others when their
port is configured.

rfd and BidCos-Wired answer **BIN-RPC and XML-RPC on the same port**, as on a CCU: a connection
that starts with the bytes `Bin` is BIN-RPC, anything else XML-RPC over HTTP. A client may register
over one and ask for callbacks in the other (`init('xmlrpc_bin://…')` gets BIN-RPC callbacks,
`init('http://…')` XML-RPC ones). With `tls` the XML-RPC half is HTTPS only and BIN-RPC stays plain;
basic auth applies to the XML-RPC half. `interfaces: {rfd: {protocols: ['binrpc']}}` gives the
BIN-RPC-only server of 1.1 back, `['xmlrpc']` the other half.

**Incoming RPC methods.**

|             |                                                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| session     | `init` (register and de-register a logic layer), `ping`, `system.listMethods`, `system.methodHelp`, `system.multicall`                                |
| devices     | `listDevices`, `getDeviceDescription`, `deleteDevice`, `replaceDevice`, `setInstallMode`, `getInstallMode`                                            |
| paramsets   | `getParamsetDescription`, `getParamset`, `putParamset`, `getValue`, `setValue`, `determineParameter`, `reportValueUsage`                              |
| links       | `getLinks`, `getLinkPeers`, `getLinkInfo`, `setLinkInfo`, `addLink`, `removeLink`, `activateLinkParamset`                                             |
| interface   | `rssiInfo`, `listBidcosInterfaces`, `setBidcosInterface`, `getServiceMessages`, `setTempKey` (BidCos only), `changeKey` (rfd, hmipserver), `logLevel` |
| teams       | `listTeams`, `setTeam` (BidCos only): the smoke detector teams as rfd keeps them, pseudo devices `*<serial>`                                          |
| maintenance | `clearConfigCache`, `restoreConfigToDevice`, `updateFirmware`, `installFirmware`, `refreshDeployedDeviceFirmwareList` (rfd, hmipserver)               |

**Registering a client.** `init(url, interfaceId)` registers a logic layer and `init(url, '')`
removes it. The url is `xmlrpc_bin://host:port` (or `binrpc://`) for BIN-RPC callbacks and
`http://host:port/path` or `https://…` for XML-RPC ones; the path is kept, so one callback server
can serve several interfaces (`http://127.0.0.1:8184/cb/BidCos-RF`). As on a CCU a registration is
identified by its url exactly, scheme and path included: `init('http://h:1', '')` does not remove
`xmlrpc_bin://h:1`.

**Character set.** An XML-RPC request declared ISO-8859-1 (in the XML declaration or the
Content-Type header), as the interface processes speak it, is read as such; anything else as
UTF-8. Answers are UTF-8. BIN-RPC strings go out as ISO-8859-1, as rfd sends them.

**Outgoing RPC calls** to every registered logic layer: `listDevices`, `newDevices`,
`deleteDevices`, `updateDevice` (after `setTeam`), `event`, `system.multicall`.

**ReGa** (`rega.exe` on port 8181): the scripts of the
[homematic-rega](https://github.com/hobbyquaker/homematic-rega) client - `getChannels`,
`getVariables`, `getPrograms`, `getRooms`, `getFunctions`, `getValues` - plus setting a variable,
renaming an object, activating and executing a program. Every script the mock receives is recorded
(`sim.regaSim.scripts`), renames additionally in `sim.regaSim.renames`.

**Faults.** Unknown method, unknown address, unknown paramset, unknown parameter, read-only
parameter, wrong type, out of range, unknown link. Over xmlrpc as an XML-RPC fault, over binrpc as
a message of type `0xff` with a `faultCode`/`faultString` struct - see
[Fault codes](#fault-codes-measured) below.

What is **not** simulated: the actual radio protocol, firmware behaviour beyond the update states
of [Device and radio health](#device-and-radio-health), the CCU's web UI and JSON-API, and anything a device does on its own beyond what a behaviour script or the
scenario API makes it do.

## Usage

```js
const HmSim = require('hm-simulator/sim.js'); // ESM: import HmSim from 'hm-simulator/sim.mjs'

const sim = new HmSim({
  devices: {
    rfd: require('hm-simulator/data/devices-rfd.json'),
    hmip: require('hm-simulator/data/devices-hmip.json'),
  },
  config: {listenAddress: '127.0.0.1', binrpcListenPort: 2001, xmlrpcListenPort: 2010},
});

await sim.whenReady(); // every server is accepting connections
// ... run the code under test ...
sim.close();
```

With a port of `0` the operating system picks one and `sim.ports` holds what it picked
(`sim.ports.rfd`, `sim.ports.hmip`, ...) once `whenReady()` resolved. That is the reliable way to
run tests in parallel.

### Options

| option                     | default                                              |                                                                                         |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `log`                      | silent                                               | object with `debug`, `info`, `warn`, `error`                                            |
| `devices`                  | `{rfd: {devices: []}, hmip: {devices: []}}`          | device descriptions per interface                                                       |
| `paramsetDescriptions`     | the bundled 8.4 MB `data/paramset-descriptions.json` | replaces the bundled descriptions                                                       |
| `paramsetFallback`         | `true`                                               | a firmware without a description uses the nearest one, see [Fixtures](#fixtures)        |
| `config.listenAddress`     | all interfaces                                       |                                                                                         |
| `config.binrpcListenPort`  | –                                                    | rfd                                                                                     |
| `config.xmlrpcListenPort`  | –                                                    | hmipserver                                                                              |
| `config.wiredListenPort`   | –                                                    | BidCos-Wired, started when `devices.wired` exists                                       |
| `config.virtualListenPort` | off                                                  | VirtualDevices                                                                          |
| `config.cuxdListenPort`    | off                                                  | CUxD                                                                                    |
| `config.virtualPath`       | `/groups`                                            | path the VirtualDevices server answers on                                               |
| `behaviorPath`             | `behaviors/` of the package                          | directory with behaviour scripts, `false` for none                                      |
| `rega`                     | off                                                  | ReGa mock, see below                                                                    |
| `links`                    | `{}`                                                 | links per interface, `[{SENDER, RECEIVER, NAME, DESCRIPTION}]`                          |
| `serviceMessages`          | `{}`                                                 | service messages per interface, `[[address, datapoint, value]]`                         |
| `newDevices`               | `{}`                                                 | devices that appear when the install mode is switched on, `{<iface>: {devices, delay}}` |
| `bidcosInterfaces`         | one per interface                                    | what `listBidcosInterfaces` answers                                                     |
| `defaultRssi`              | `-65`                                                | what `rssiInfo` answers where a device has no RSSI datapoint                            |
| `interfaces`               | see [CONFIG_PENDING](#config_pending)                | per interface behaviour                                                                 |
| `faults`                   | see [Fault codes](#fault-codes-measured)             | overrides for the fault table                                                           |
| `tls`                      | off                                                  | `true` generates a self signed certificate, or pass `{key, cert}`                       |
| `auth`                     | off                                                  | `{username, password}`, HTTP basic auth for the xmlrpc servers and ReGa                 |

`rega` takes `{port, listenAddress, channels, variables, programs, rooms, functions, values, tls,
auth}`. `channels` is what `getChannels()` answers: `[{id, address, name}]`.

### Scenario API

```js
sim.addDevice('rfd', deviceDescription, channel0, channel1); // sends newDevices
sim.removeDevice('rfd', 'ABC0000001'); // sends deleteDevices
sim.fireEvent('rfd', 'ABC0000001:1', 'STATE', true); // one event, no validation
sim.setServiceMessage('rfd', 'ABC0000001:0', 'STICKY_UNREACH', true);
sim.scriptNewDevices('rfd', [devices], 500); // appear after setInstallMode
await sim.dropConnection('rfd'); // interface process restart
sim.getWriteLog(); // every accepted putParamset: {iface, address, paramset, values, rejected, ts}
sim.getConfigPending('rfd'); // [{address, sticky}]
sim.getPoisonedChannels('hmip'); // channels whose stored MASTER has a parameter they do not have
sim.getMissingParamsetDescriptions(); // [{iface, key, usedKey}]: paramsets without an exact description
sim.fireEvents('rfd', [[address, 'WORKING', true], ...], {batch: 10}); // a burst as system.multicall batches
await sim.restartInterface('hmip', {downMs: 2000, forgetClients: true}); // see below
sim.injectFault({iface: 'rfd', method: 'setValue', fault: 'notReachable'}); // see below
sim.getCallbackLog(); // [{iface, client, method, sentAt, answeredAt, error}]
sim.setReachable('rfd', 'ABC0000001', false); // see Device and radio health
sim.schedule([{at: 1000, call: 'setReachable', args: ['rfd', 'ABC0000001', true]}]); // a timeline
sim.api.emit('setValue', 'rfd', 'ABC0000001:1', 'STATE', true); // as a behaviour script would
```

Behaviour scripts are plain modules in `behaviorPath` that export `api => { ... }` and use
`api.emit('setValue', iface, address, datapoint, value)`; the two examples in `behaviors/` press a
virtual button and open a window periodically. Point `behaviorPath` at an empty directory to have
none.

## CONFIG_PENDING

Devices that end up stuck in `CONFIG_PENDING` after a paramset write are the reason this part
exists (Homematic Manager issue #98). Until 2026-09-05 there were two competing explanations and
nobody had measured which one the interface processes actually implement. Homematic Manager's
roadmap task 6 measured it, on two lab CCUs on firmware 3.89.8; the write-up with the raw answers
is `docs/config-pending.md` in that repository, and the answer is that neither hypothesis was
right:

- **hmipserver stores what it rejects.** Everything in the struct is written into its own
  configuration for the channel first; the fault comes afterwards, when the result cannot be
  transferred to the device. A parameter the channel does not have is stored **for ever** - it
  survives a restart, no RPC method removes it, and from then on every `putParamset` on that
  channel faults, including one with an empty struct. A value of the wrong type raises a sticky
  `CONFIG_PENDING`, which a valid full MASTER write clears. A number outside `MIN`..`MAX` is
  accepted without a word: hmipserver does not range-check.
- **rfd never faults on a value.** It drops a parameter the device does not have, ignores what it
  cannot use, clamps numbers into `MIN`..`MAX` and coerces strings - and answers `ok` to all of
  it. `CONFIG_PENDING` there means "a configuration is queued for the device" and clears when the
  device takes it, which on a battery device is when it next wakes up.

The simulator implements both, plus the two original hypotheses, per interface:

```js
new HmSim({
  interfaces: {
    hmip: {configPendingMode: 'hmip'}, // the default for hmip
    rfd: {configPendingMode: 'bidcos', configPendingDelay: 3000}, // the default for rfd and wired
  },
});
```

| option                         | default                                                                        |                                                                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configPendingMode`            | `'hmip'` for `hmip`, `'bidcos'` for `rfd` and `wired`, `'strict'` for the rest | see the table below                                                                                                                                                                                                                               |
| `configPendingOnWrite`         | `false`                                                                        | raise `CONFIG_PENDING` for _every_ accepted MASTER write. Implied by `'bidcos'`, which raises it for every write that changes something                                                                                                           |
| `configPendingDelay`           | `0`                                                                            | milliseconds after which a non-sticky `CONFIG_PENDING` clears itself - the stand-in for the device taking the configuration. The lab measured 160-180 s on a thermostat that transmits regularly, and "until someone opens the door" on a contact |
| `serviceMessagesEmptyAsString` | `false`                                                                        | answer `getServiceMessages` with `''` instead of `[]` when nothing is pending, which is what rfd really does                                                                                                                                      |
| `protocols`                    | `['binrpc', 'xmlrpc']` for `rfd` and `wired`                                   | what the port of a BidCos interface answers, see [What is simulated](#what-is-simulated)                                                                                                                                                          |
| `listenerModel`                | `'isolated'`                                                                   | `'measured'`: what the interface processes do with a callback server that hangs, see [Interface processes misbehaving](#interface-processes-misbehaving)                                                                                          |
| `pong`                         | `false` for `hmip`, `true` for the rest                                        | whether `ping` sends the `CENTRAL`/`PONG` event (to every registered client)                                                                                                                                                                      |
| `pingDelay`                    | `0`                                                                            | milliseconds between `ping` and its `PONG` event                                                                                                                                                                                                  |
| `startDelay`                   | `0`                                                                            | milliseconds after `whenReady()` until the port accepts connections: a process that starts late (`sim.ports` knows the port from the start)                                                                                                       |
| `deliveryTimeout`              | `10000`                                                                        | `'measured'` BidCos only: a client that does not answer a callback within this time is dropped                                                                                                                                                    |
| `unreachWrites`                | `'accept'`                                                                     | what `setValue`/`putParamset` to an unreachable device answer: `'accept'`, or `'fault'` (`notReachable`). The simulator's model, not a measurement                                                                                                |
| `firmwareUpdateDelay`          | `0`                                                                            | milliseconds per step of a firmware update, see [Device and radio health](#device-and-radio-health)                                                                                                                                               |

| `configPendingMode` | what a `putParamset MASTER` does                                                                                                                                                         |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `'hmip'`            | measured hmipserver: stores everything, faults when the result is not transferable, poisons the channel on an unknown parameter, sticky `CONFIG_PENDING` on a wrong type, no range check |
| `'bidcos'`          | measured rfd: no fault, unknown parameters dropped, values clamped or ignored, `CONFIG_PENDING` while the change is queued                                                               |
| `'strict'`          | the first hypothesis: an invalid write is answered with a fault and nothing is written                                                                                                   |
| `'pending'`         | the second hypothesis: the write is accepted, the valid parameters are stored, the rejected ones are recorded, and a sticky `CONFIG_PENDING` is raised                                   |

In `'strict'` and `'pending'` a sticky `CONFIG_PENDING` clears on a valid full MASTER write, on
`clearConfigCache(deviceAddress)` or on `restoreConfigToDevice(deviceAddress)`. In `'hmip'` only
the valid full MASTER write does: `clearConfigCache`, `restoreConfigToDevice` and
`determineParameter` answer `-1 Generic error` there, exactly as hmipserver does - they are BidCos
methods that hmipserver lists but does not implement.

`sim.getPoisonedChannels(iface)` lists the channels whose stored MASTER carries a parameter their
description does not have. Deleting the device (`sim.removeDevice`) is the only thing that clears
one, which is also true of the hardware: there, it means pairing the device again.

## Fault codes, measured

The interface processes' fault codes are not publicly specified, and the table in `lib/faults.js`
used to be an educated guess. It is a measurement now (Homematic Manager task 6, firmware 3.89.8).
The default table is **hmipserver's**, because that is the one an application has to survive:

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

rfd's table is exported as `BIDCOS_FAULTS` and differs in more than wording - it answers **no
fault at all** for an unknown paramset name (it takes the name as a peer address), for a missing
argument, and for a `setValue` on a read-only datapoint:

```js
const {FAULT_TABLES} = require('hm-simulator/lib/faults.js');
new HmSim({faults: FAULT_TABLES.bidcos});
```

Every entry can still be replaced individually:

```js
new HmSim({faults: {unknownParameter: {faultCode: -4, faultString: 'Unknown parameter'}}});
```

## Device and radio health

What the devices and the radio report over time - the service messages, levels and update states a
client renders and reacts to:

```js
sim.setReachable('rfd', 'ABC0000001', false); // UNREACH (+ STICKY_UNREACH on BidCos) on :0
sim.setReachable('rfd', 'ABC0000001', true); // UNREACH clears, STICKY_UNREACH stays for the client
sim.setLowBattery('hmip', '0001D3C99C1234', true); // LOW_BAT or LOWBAT, whichever :0 has
sim.setDutyCycle('rfd', 42); // listBidcosInterfaces' DUTY_CYCLE
sim.setDutyCycle('hmip', 17); // ... and DUTY_CYCLE_LEVEL on the radio module's :0
sim.setCarrierSense('hmip', 8); // CARRIER_SENSE_LEVEL, the same way
sim.offerFirmware('hmip', '0001D3C99C1234', '1.6.0'); // a firmware update becomes available
await sim.schedule([
  {at: 1000, call: 'setReachable', args: ['rfd', 'ABC0000001', false]},
  {at: 3000, call: 'setReachable', args: ['rfd', 'ABC0000001', true]},
]);
```

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

## Interface processes misbehaving

For the code that has to survive an interface process that restarts, starts late, answers slowly or
not at all - reconnects, re-inits, watchdogs, init retries:

```js
await sim.stopInterface('hmip'); // the port refuses connections, open ones are reset
await sim.startInterface('hmip', {forgetClients: true}); // up again on the same port
await sim.restartInterface('rfd', {downMs: 2000, forgetClients: false}); // both, with a pause
sim.injectFault({iface: 'rfd', method: 'init', times: 3, fault: 'unknownInstance'});
sim.injectFault({iface: 'hmip', method: '*', delayMs: 1500}); // answer late
sim.injectFault({method: 'getValue', hang: true}); // never answer
sim.injectFault({method: 'listDevices', closeSocket: true}); // close the connection instead
sim.clearFaults();
```

- **Restarts.** With `forgetClients: true` (the default) a restarted process has forgotten every
  registered client: no events until the client calls `init` again, and nothing tells it - which
  is what a watchdog is for. With `forgetClients: false` it remembers them and calls each back as rfd
  does when it starts with its handlers file: `system.listMethods` (BidCos), `listDevices`,
  `newDevices`/`deleteDevices` - calls the client did not ask for, which is how it can tell that the
  process restarted. `dropConnection()` stays what it was: forget the clients, reset the
  connections, no pause.
- **Late start.** `interfaces: {hmip: {startDelay: 5000}}` binds the port (so `sim.ports.hmip` is
  known when `whenReady()` resolves) and refuses connections until the delay is over.
- **Injected faults** apply to the next `times` calls (default 1; `Infinity` or `-1` until
  `clearFaults()`) of `method` (`'*'` for any) on `iface` (every interface when omitted), over both
  transports. `fault` is a name of the fault table or `{faultCode, faultString}`; `delayMs` can be
  combined with the others.
- **PONG.** `ping` answers with a `CENTRAL`/`PONG` event to every registered client on the BidCos
  interfaces and with nothing on hmipserver; `pong` and `pingDelay` change that per interface.
- **The callback log.** `sim.getCallbackLog()` lists every call the simulator made to a client with
  when it was sent and answered, so a test can assert that its callback server answers fast.

**A callback server that hangs** (`listenerModel: 'measured'`). Measured on firmware 3.89.8
(2026-09-25) with a callback server that accepts the connection and never answers:

| interface      | what happens                                                                                                                                                                                                                                                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hmip`         | `init` is answered at once, `listDevices` is called back afterwards. While that callback hangs, **no event reaches any client** of the interface; they are queued and follow when the connection ends, and the client that hung is not called again. A client that hangs _after_ its registration holds up only itself.                     |
| `rfd`, `wired` | `system.listMethods` is called back **before** `init` answers, and until it returns **the interface answers nothing at all**, to anybody. When the connection ends, it is tried three more times at once and the client is registered anyway. A registered client that does not take a callback within `deliveryTimeout` (10 s) is dropped. |

That `listDevices` also comes before rfd answers the `init` is the simulator's model, not a
measurement; so is everything with the default `'isolated'`, where every client is on its own.

## Fixtures

`data/devices-rfd.json` and `data/devices-hmip.json` (the historical device lists) and
`data/paramset-descriptions.json` (1855 descriptions) ship with the package and are unchanged.

A description is looked up by `<interface>/<type>/<firmware>/<version>/<channel type>/<paramset>`,
and a device reports the firmware it runs - which a description set often does not have (the
bundled `HM-RCV-50` has firmware 2.27.8, the bundled descriptions start at 2.31.25). Such a device
uses the description of the **nearest firmware** of the same type and `VERSION`: the highest one at
or below its own, else the lowest one above it; firmware compared numerically part by part, a
trailing build date (`3.41.11.20181222`) last. Each substitution is logged once at `warn`. A type
with no description at all still answers `-2` for its paramsets. `paramsetFallback: false` keeps
the exact keys only, and `sim.getMissingParamsetDescriptions()` lists every paramset a device
announces in `PARAMSETS` that has no exact description, with the key used instead (`usedKey`,
`null` when there is none) - an empty list means a fixture is complete:

```js
assert.deepEqual(sim.getMissingParamsetDescriptions(), []);
```

`data/fixtures/devices.json` is generated from node-red-contrib-ccu's `paramsets.json` and contains
real descriptions for HmIP-PDT, HmIPW-DRS8, HmIPW-DRI16, HmIPW-DRAP, HM-LC-Sw1-Pl and HM-CC-RT-DN:

```js
const fixture = require('hm-simulator/data/fixtures/devices.json');
const sim = new HmSim({devices: fixture.devices, paramsetDescriptions: fixture.paramsetDescriptions});
```

Regenerate or extend it with

```
node tools/fixtures-from-paramsets.js --source ../node-red-contrib-ccu/paramsets.json \
    --types HmIP-PDT,HM-LC-Sw1-Pl --out data/fixtures/devices.json
node tools/fixtures-from-paramsets.js --source ../node-red-contrib-ccu/paramsets.json --list
```

A paramset description dump knows the channel _types_ of a device but never their _indexes_, so
the channel layout comes from `tools/device-layouts.json`. An entry with a `channels` list is the
real layout of the hardware, read from a `listDevices` dump; the seven device types of the
Homematic Manager lab (HmIP-PDT, HmIP-WRC2, HmIPW-DRS8, HmIPW-DRI16, HmIPW-DRAP, HM-CC-TC,
HM-Sec-SC) have one since 2026-09-05. Everything else is synthesised from `order` and `counts`:
consistent within a fixture (`CHILDREN`, `PARENT` and `INDEX` always agree), not guaranteed to
match the hardware. Correcting an entry from a `listDevices` dump is a one line change there.

`data/fixtures/lab-devices.json` is such a dump: `listDevices` as two CCUs on firmware 3.89.8
answered it, with the serials anonymised and nothing else touched. It has no paramset
descriptions - pass the ones from `devices.json` or the bundled set alongside:

```js
const lab = require('hm-simulator/data/fixtures/lab-devices.json');
const fixture = require('hm-simulator/data/fixtures/devices.json');
const sim = new HmSim({devices: lab.devices, paramsetDescriptions: fixture.paramsetDescriptions});
```

It is also where the oddities live that only real hardware produces - the CCU's own `HmIP-RCV-50`
sends a trailing **empty string** in `CHILDREN`, for instance.

`data/fixtures/lab-2026-09.json` is the complete one: four test systems (openccu-lite, the
interface processes of OpenCCU 3.89.11) dumped with `tools/dump-ccu.js` on 2026-09-29 and merged -
`listDevices`, the paramset descriptions of exactly the firmware every device runs (MASTER, VALUES,
SERVICE, LINK; `getMissingParamsetDescriptions()` is empty without the fallback), the direct links
and `listBidcosInterfaces`. Its devices:

| Interface    | Device types                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BidCos-RF    | HM-RCV-50 (the central, `BidCoS-RF:0..50`), HM-CC-TC, HM-Sec-SC, HM-LC-Sw1-Pl-2; five radio interfaces (types `CCU2`, `USB Interface`, `HMLGW2`)                               |
| BidCos-Wired | HMW-RCV-50 (the central only)                                                                                                                                                  |
| HmIP-RF      | HmIP-RCV-50 (the central), the radio modules RPI-RF-MOD and HmIP-RFUSB (twice), HmIP-HAP, HmIP-BBL, HMIP-WRC2 (three firmwares), HmIP-PDT, HmIPW-DRAP, HmIPW-DRI16, HmIPW-DRS8 |

Links: WRC2s on the PDT, the BBL and a DRS8 channel, the PDT's and the BBL's internal links, and
the Sw1's one on BidCos-RF. A real
hmipserver lists one radio module; the merged set lists three, and `listBidcosInterfaces` names
the first as the HmIP radio (its `ADDRESS` is `3014F711A0` + that module's device address, as on a
CCU). Serials are anonymised consistently in their own shape - BidCos `LAB0000001`, HmIP
`00000000000004` - link names are empty, and nothing else is changed. The file is a device file
for the command line (`--devices`, add `--wired-port 0` or a port for BidCos-Wired) and carries
the constructor options of the same names:

```js
const lab = require('hm-simulator/data/fixtures/lab-2026-09.json');
const sim = new HmSim({
  devices: structuredClone(lab.devices), // the simulator changes the lists it is given
  paramsetDescriptions: lab.paramsetDescriptions,
  links: structuredClone(lab.links),
  bidcosInterfaces: lab.bidcosInterfaces,
  config: {binrpcListenPort: 0, xmlrpcListenPort: 0, wiredListenPort: 0},
});
```

`tools/dump-ccu.js` (in the repository, not in the package) makes such a file from any CCU:

```
node tools/dump-ccu.js --rfd xmlrpc_bin://127.0.0.1:2001 --hmip xmlrpc://127.0.0.1:2010 \
    --virtual xmlrpc://127.0.0.1:9292/groups --out my-ccu.json
```

Every interface may be given more than once to merge several systems; `--types` keeps only the
device types listed, `--keep-serials` switches the anonymisation off, and `--help` lists the rest.
It only reads (`listDevices`, `getParamsetDescription`, `getLinks`, `listBidcosInterfaces`), and it
refuses to write a file in which anything shaped like a serial, an HmIP address or an SGTIN is left
that it did not put there itself. The rest of a CCU's identity - host names, addresses, keys - is
never read.

## Command line

```
hm-simulator [options]

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

**Out of process** - for a test whose code under test cannot `require()` the simulator (a daemon
in another language, a spawned service): start it with every port `0` and `--ports-json -`, wait
for the first line on stdout, and read the ports from it:

```
$ hm-simulator --binrpc-port 0 --xmlrpc-port 0 --rega-port 0 --no-behaviors \
    --devices node_modules/hm-simulator/data/fixtures/devices.json --control-port 0 --ports-json -
{"rfd":40123,"hmip":40124,"rega":40125,"control":40126}
```

`--ports-json <file>` writes the same object to a file instead (atomically: a reader never sees
half of it). A port that is taken ends the process with exit code 1 and the address in the
message. `SIGTERM` and `SIGINT` close every server and exit 0.

`--config` takes the constructor options as a file; `devices` and `paramsetDescriptions` in it may
be paths (relative to the file), `devices` a device file as for `--devices`. The flags win over the
file:

```json
{
  "devices": "node_modules/hm-simulator/data/fixtures/devices.json",
  "interfaces": {"rfd": {"serviceMessagesEmptyAsString": true}},
  "links": {"rfd": []}
}
```

**The control port** (`--control-port`, loopback only) is the [scenario API](#scenario-api) over
HTTP: `POST /scenario/<call>` with a JSON array of the arguments, `GET /scenario/<call>` for one
without arguments. The answer is `{"result": ...}`; a fault is `400` with `faultCode` and
`faultString`, an unknown call `404`. `GET /ports` answers the ports. The calls:
`addDevice`, `removeDevice`, `fireEvent`, `setValue` (the device reporting a value, as a behaviour
script does), `setServiceMessage`, `scriptNewDevices`, `dropConnection`, `getDevice`,
`getWriteLog`, `getConfigPending`, `getPoisonedChannels`, `getMissingParamsetDescriptions`,
`getTempKey`, `getInstallMode`.

```
curl -s -X POST localhost:40126/scenario/fireEvent -d '["rfd", "BidCoS-RF:1", "PRESS_SHORT", true]'
```

## Compatibility

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

## Changelog

### Unreleased

- `data/fixtures/lab-2026-09.json`: the devices of four test systems with the paramset
  descriptions of their exact firmware, their direct links and radio modules - the CCU centrals,
  RPI-RF-MOD, HmIP-RFUSB, HmIP-HAP, HmIP-BBL, HMIP-WRC2, HmIP-PDT, HmIPW-DRAP/-DRI16/-DRS8,
  HM-CC-TC, HM-Sec-SC, HM-LC-Sw1-Pl-2 - anonymised. `tools/dump-ccu.js` makes such a fixture from
  any CCU (read only, anonymised unless told otherwise). A device file given to `--devices` brings
  its `links` and `bidcosInterfaces` along.
- The calls openccu-lite's daemon makes: `logLevel` (rfd and hs485d answer the level, 5 until set;
  hmipserver an empty string), `changeKey` (rfd, hmipserver; recorded in `sim.keyChanges`) and
  `refreshDeployedDeviceFirmwareList` (rfd, hmipserver; recorded in
  `sim.firmwareListRefreshes`), with the interfaces measured on a CCU with firmware 3.89.x.
- `init` keeps the path of an XML-RPC callback url (`http://host:port/cb/BidCos-RF`; the path used
  to end up in the port), takes `https://`, and identifies a registration by its url exactly, scheme
  included, as the interface processes do - an `init(url, '')` with another scheme no longer removes
  it. A url that is none is a fault.
- An XML-RPC request declared ISO-8859-1 is read as ISO-8859-1 instead of UTF-8.
- Device and radio health: `setReachable` (UNREACH, and STICKY_UNREACH on BidCos until a client
  clears it; `unreachWrites: 'fault'` answers writes with notReachable), `setLowBattery`,
  `setDutyCycle` and `setCarrierSense` (in `listBidcosInterfaces` and, on hmip, as the radio
  module's `DUTY_CYCLE_LEVEL`/`CARRIER_SENSE_LEVEL`), `offerFirmware` with the update states
  `updateFirmware`/`installFirmware` then walk through, and `schedule` for a timeline of scenario
  calls.
- Interface processes that misbehave: `stopInterface`, `startInterface` and `restartInterface`
  (forgetting the registered clients, or calling them back as rfd does after a restart),
  `interfaces.<iface>.startDelay`, `pong` and `pingDelay`, `injectFault` (delay, hang, fault,
  closed connection, for the next calls of a method) and `clearFaults`, and
  `listenerModel: 'measured'`: what hmipserver and rfd do with a callback server that hangs
  (hmipserver holds every client's events back, rfd stops answering). `getCallbackLog()` records
  every call to a client with its timing, `fireEvents()` sends bursts as `system.multicall` batches.
- The command line is usable out of process: every port may be `0`, `--ports-json <file|->`
  reports the ports once every server listens, `--config` and `--devices` load options and device
  files, `--wired-port`, `--tls` with `--tls-cert-out`, `--auth`, `--behavior-path`,
  `--no-behaviors`, and `--control-port` serves the scenario API over HTTP on the loopback. A taken
  port exits 1 with the address in the message. `behaviorPath: false` starts no behaviour scripts.
- An ENUM whose description gives `DEFAULT` as the index (1088 of the 5624 ENUMs in the bundled
  descriptions) started at `-1` instead of that index, so a thermostat's `FAULT_REPORTING` was a
  service message from the start.
- rfd and BidCos-Wired answer BIN-RPC and XML-RPC on the same port, as on a CCU, so a client
  that talks XML-RPC to rfd can be tested too; the callbacks follow the URL a client registered
  with, whichever protocol it registered over. With `tls` the XML-RPC half is HTTPS, BIN-RPC stays
  plain. `interfaces.<iface>.protocols` narrows a port to one of them.
- A device whose firmware has no paramset description uses the description of the nearest
  firmware of the same type and `VERSION` instead of answering `-2 Invalid device` for every
  channel `listDevices` reports; the bundled CCU virtual remote (`HM-RCV-50` 2.27.8,
  `BidCoS-RF:1..50`) works again. `paramsetFallback: false` switches it off,
  `sim.getMissingParamsetDescriptions()` lists what is not matched exactly (reported in #1 by
  @Hypnos3, cause found by @foxriver76).

### 1.1.0

- `setTempKey` on the BidCos interfaces: the passphrase a device is taught in with, applied to
  the pairings that follow; `sim.getTempKey(iface)` reads back what was set, an empty string
  clears it. No cryptography. hmipserver has no such method, so it faults with unknown-method
  there (Homematic Manager issue #20).
- Smoke detector teams on the BidCos interfaces: `listTeams` and `setTeam`. A channel with a
  `TEAM_TAG` is in the team its `TEAM` names, a pseudo device `*<serial>` whose team channel lists
  the members in `TEAM_CHANNELS`; `setTeam(channel, team)` moves it and deletes a team nobody is
  left in, `setTeam(channel, '')` puts it back into a team of its own, created like the one it
  left (`newDevices`, `deleteDevices`, `updateDevice` to the logic layers). The shape is rfd's
  as Homematic Manager task 58 read it from a CCU3; when rfd deletes and creates the team devices
  is the simulator's model, not a measurement.

### 1.0.0

- Node >= 20.19, `binrpc` ^4.2, `homematic-xmlrpc` ^2.0; `express`, `body-parser`, `request`,
  `async` and `yalm` removed. The ReGa mock runs on `node:http`, the CLI logs through `console`.
- Paramset state per device and channel for MASTER, VALUES, SERVICE and the link paramsets, with
  type, range, `VALUE_LIST` and `OPERATIONS` checks on every write.
- `CONFIG_PENDING` semantics, configurable per interface: `'hmip'` and `'bidcos'` are what the
  two interface processes of a CCU on firmware 3.89.8 were measured to do (Homematic Manager task
  6, 2026-09-05), `'strict'` and `'pending'` are the two hypotheses that measurement replaced.
  `getPoisonedChannels()` for the channel an unknown parameter destroyed.
- Fault codes and strings measured on the same firmware, hmipserver's as the default table and
  rfd's as `BIDCOS_FAULTS`.
- `data/fixtures/lab-devices.json`: an anonymised real `listDevices` of two CCUs, and the channel
  layouts in `tools/device-layouts.json` corrected from it.
- Links: `getLinks`, `getLinkPeers`, `getLinkInfo`, `setLinkInfo`, `addLink`, `removeLink`,
  `activateLinkParamset`, and link paramsets addressed by the peer's address.
- Interface and service methods: `rssiInfo`, `listBidcosInterfaces`, `setBidcosInterface`,
  `getServiceMessages`, `setInstallMode`/`getInstallMode` with scripted `newDevices`,
  `deleteDevice`, `replaceDevice`, `reportValueUsage`, `updateFirmware`, `installFirmware`,
  `clearConfigCache`, `restoreConfigToDevice`, `determineParameter`, `getDeviceDescription`,
  `getValue`, `system.methodHelp`, `system.multicall`.
- Fault responses on both transports, with an overridable fault table.
- VirtualDevices and CUxD servers, BidCos-Wired, optional TLS with a generated certificate and
  optional HTTP basic auth.
- ReGa mock with `getChannels`, `getValues`, rename/program scripts and a script log.
- Scenario API: `addDevice`, `removeDevice`, `fireEvent`, `setServiceMessage`, `scriptNewDevices`,
  `dropConnection`, `getWriteLog`, `getConfigPending`.
- `whenReady()`, port `0` support and `sim.ports`.
- Fixture generator `tools/fixtures-from-paramsets.js` and generated real device fixtures.
- ESLint 9 + Prettier, `node --test`, GitHub Actions on Node 20/22/24.

### 0.1.1 and earlier

`init`, `ping`, `system.listMethods`, `getParamsetDescription`, `listDevices`, `setValue`, events
through behaviour scripts, ReGa mock.

## Contributing

Pull requests welcome. `npm run lint` and `npm test` have to pass.

## License

MIT
Copyright (c) 2017 Sebastian Raff

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
