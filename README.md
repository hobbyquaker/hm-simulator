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

**Interfaces.** rfd (binrpc), hmipserver (xmlrpc), BidCos-Wired (binrpc), VirtualDevices (xmlrpc,
path `/groups`) and CUxD (binrpc). Each has its own devices, values, paramsets, links and service
messages. rfd and hmipserver start by default, the others when their port is configured.

**Incoming RPC methods.**

|             |                                                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| session     | `init` (register and de-register a logic layer), `ping`, `system.listMethods`, `system.methodHelp`, `system.multicall`         |
| devices     | `listDevices`, `getDeviceDescription`, `deleteDevice`, `replaceDevice`, `setInstallMode`, `getInstallMode`                     |
| paramsets   | `getParamsetDescription`, `getParamset`, `putParamset`, `getValue`, `setValue`, `determineParameter`, `reportValueUsage`       |
| links       | `getLinks`, `getLinkPeers`, `getLinkInfo`, `setLinkInfo`, `addLink`, `removeLink`, `activateLinkParamset`                      |
| interface   | `rssiInfo`, `listBidcosInterfaces`, `setBidcosInterface`, `getServiceMessages`                                                 |
| maintenance | `clearConfigCache`, `restoreConfigToDevice`, `updateFirmware`, `installFirmware` (the last two are stubs that record the call) |

**Outgoing RPC calls** to every registered logic layer: `listDevices`, `newDevices`,
`deleteDevices`, `event`, `system.multicall`.

**ReGa** (`rega.exe` on port 8181): the scripts of the
[homematic-rega](https://github.com/hobbyquaker/homematic-rega) client - `getChannels`,
`getVariables`, `getPrograms`, `getRooms`, `getFunctions`, `getValues` - plus setting a variable,
renaming an object, activating and executing a program. Every script the mock receives is recorded
(`sim.regaSim.scripts`), renames additionally in `sim.regaSim.renames`.

**Faults.** Unknown method, unknown address, unknown paramset, unknown parameter, read-only
parameter, wrong type, out of range, unknown link. Over xmlrpc as an XML-RPC fault, over binrpc as
a message of type `0xff` with a `faultCode`/`faultString` struct - see
[Fault codes](#fault-codes-an-assumption) below.

What is **not** simulated: the actual radio protocol, firmware behaviour, duty cycle, the CCU's web
UI and JSON-API, and anything a device does on its own beyond what a behaviour script or the
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
| `config.listenAddress`     | all interfaces                                       |                                                                                         |
| `config.binrpcListenPort`  | –                                                    | rfd                                                                                     |
| `config.xmlrpcListenPort`  | –                                                    | hmipserver                                                                              |
| `config.wiredListenPort`   | –                                                    | BidCos-Wired, started when `devices.wired` exists                                       |
| `config.virtualListenPort` | off                                                  | VirtualDevices                                                                          |
| `config.cuxdListenPort`    | off                                                  | CUxD                                                                                    |
| `config.virtualPath`       | `/groups`                                            | path the VirtualDevices server answers on                                               |
| `behaviorPath`             | `behaviors/` of the package                          | directory with behaviour scripts                                                        |
| `rega`                     | off                                                  | ReGa mock, see below                                                                    |
| `links`                    | `{}`                                                 | links per interface, `[{SENDER, RECEIVER, NAME, DESCRIPTION}]`                          |
| `serviceMessages`          | `{}`                                                 | service messages per interface, `[[address, datapoint, value]]`                         |
| `newDevices`               | `{}`                                                 | devices that appear when the install mode is switched on, `{<iface>: {devices, delay}}` |
| `bidcosInterfaces`         | one per interface                                    | what `listBidcosInterfaces` answers                                                     |
| `defaultRssi`              | `-65`                                                | what `rssiInfo` answers where a device has no RSSI datapoint                            |
| `interfaces`               | see [CONFIG_PENDING](#config_pending)                | per interface behaviour                                                                 |
| `faults`                   | see [Fault codes](#fault-codes-an-assumption)        | overrides for the fault table                                                           |
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
sim.api.emit('setValue', 'rfd', 'ABC0000001:1', 'STATE', true); // as a behaviour script would
```

Behaviour scripts are plain modules in `behaviorPath` that export `api => { ... }` and use
`api.emit('setValue', iface, address, datapoint, value)`; the two examples in `behaviors/` press a
virtual button and open a window periodically. Point `behaviorPath` at an empty directory to have
none.

## CONFIG_PENDING

Devices that end up stuck in `CONFIG_PENDING` after a paramset write are the reason this part
exists (Homematic Manager issue #98). There are two competing explanations, and **nobody has
measured which one hmipserver and crRFD actually do**:

- the interface process validates against the device's paramset description and **rejects** the
  call - then the application sees a fault and the device is untouched;
- it **accepts** the call, keeps a configuration the device never acknowledges, and the flag
  sticks until the configuration is corrected.

The simulator implements both, per interface, so that an application can be tested against either:

```js
new HmSim({
  interfaces: {
    hmip: {configPendingMode: 'strict'},
    rfd: {configPendingMode: 'pending', configPendingOnWrite: true, configPendingDelay: 3000},
  },
});
```

| option                 | default    |                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `configPendingMode`    | `'strict'` | `'strict'`: an invalid `putParamset MASTER` is answered with a fault and nothing is written. `'pending'`: the call is accepted, the valid parameters are stored, the rejected ones are recorded in the write log and `CONFIG_PENDING` is raised on the device's `:0` channel and stays |
| `configPendingOnWrite` | `false`    | raise `CONFIG_PENDING` for _every_ accepted MASTER write - the ordinary BidCos case, where the configuration is queued until the battery device wakes up                                                                                                                               |
| `configPendingDelay`   | `0`        | milliseconds after which a non-sticky `CONFIG_PENDING` clears itself                                                                                                                                                                                                                   |

A sticky `CONFIG_PENDING` clears on

- a `putParamset MASTER` that covers **every** writeable parameter of the paramset and is valid,
- `clearConfigCache(deviceAddress)`,
- `restoreConfigToDevice(deviceAddress)`.

Which of the two modes is right, and which of the three recoveries actually works on real
hardware, is what **Homematic Manager roadmap task 6** measures on the lab CCUs. Until then both
exist so that both hypotheses can be tested, and the defaults were chosen to be the conservative
ones (strict, no pending on write).

## Fault codes: an assumption

The interface processes' fault codes are not publicly specified. The table in `lib/faults.js`
follows the negative-code convention of the eq3 XML-RPC API and is **not measured**:

| key                | code | string                     | when                                           |
| ------------------ | ---- | -------------------------- | ---------------------------------------------- |
| `unknownMethod`    | -1   | Unknown method             | no handler for the method name                 |
| `unknownInstance`  | -2   | Unknown instance           | address not known to this interface            |
| `unknownLink`      | -2   | Unknown link               | the two channels are not linked                |
| `unknownParamset`  | -3   | Unknown paramset           | the device has no such paramset                |
| `unknownParameter` | -4   | Unknown parameter          | the paramset has no such parameter             |
| `readOnly`         | -5   | Parameter is not writeable | `OPERATIONS & 2` is not set                    |
| `typeError`        | -6   | Type error                 | value does not fit the parameter's `TYPE`      |
| `outOfRange`       | -7   | Value out of range         | outside `MIN`..`MAX`, or not in `VALUE_LIST`   |
| `notSupported`     | -8   | Operation not supported    | e.g. linking a channel without a LINK paramset |
| `notReachable`     | -9   | Device not reachable       | device known but not answering                 |
| `invalidArguments` | -10  | Invalid arguments          | wrong number or type of arguments              |

Every entry can be replaced, so a calibration against real hardware does not need a new release:

```js
new HmSim({faults: {unknownParameter: {faultCode: -5, faultString: 'Unknown parameter'}}});
```

Homematic Manager roadmap task 6 records what the lab CCUs really answer; the table is updated
from that measurement.

## Fixtures

`data/devices-rfd.json` and `data/devices-hmip.json` (the historical device lists) and
`data/paramset-descriptions.json` (1855 descriptions) ship with the package and are unchanged.

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
the channel layout comes from `tools/device-layouts.json` and is an assumption: consistent within a
fixture (`CHILDREN`, `PARENT` and `INDEX` always agree), not guaranteed to match the hardware.
Correcting an entry against a `listDevices` dump of a real device is a one line change there.

## Command line

```
hm-simulator [options]

  --listen-address <ip>   default 127.0.0.1
  --binrpc-port <port>    rfd, default 2001
  --xmlrpc-port <port>    hmipserver, default 2010
  --virtual-port <port>   VirtualDevices, off unless given
  --cuxd-port <port>      CUxD, off unless given
  --rega-port <port>      ReGa mock, default 8181
  --no-rega               do not start the ReGa mock
  -v, --verbosity <level> error|warn|info|debug, default info
```

## Compatibility

- `require('hm-simulator/sim')` and `require('hm-simulator/sim.js')` keep returning the `HmSim`
  class; `sim.mjs` is the ESM entry point.
- The constructor options `config.listenAddress`, `config.binrpcListenPort`,
  `config.xmlrpcListenPort`, `devices`, `log`, `behaviorPath` and `rega` are unchanged, and so are
  `sim.api`, `sim.regaSim`, `sim.values`, `sim.rfdServer`, `sim.hmipServer` and `sim.close()`.
- Everything new is off by default: no additional server starts, no TLS, no basic auth, and
  `configPendingMode` defaults to the behaviour that answers a fault rather than inventing a
  pending state.
- Calls that used to be answered with an empty string because they had no handler now do something:
  `getParamset`, `putParamset`, `getLinks`, `getServiceMessages`, `listBidcosInterfaces`, `rssiInfo`
  and the rest of the table above. An unknown method now answers a fault instead of an empty string.
- Node >= 20.19. `binrpc` 4 and `homematic-xmlrpc` 2 are the only runtime dependencies.

## Changelog

### 1.0.0

- Node >= 20.19, `binrpc` ^4.2, `homematic-xmlrpc` ^2.0; `express`, `body-parser`, `request`,
  `async` and `yalm` removed. The ReGa mock runs on `node:http`, the CLI logs through `console`.
- Paramset state per device and channel for MASTER, VALUES, SERVICE and the link paramsets, with
  type, range, `VALUE_LIST` and `OPERATIONS` checks on every write.
- `CONFIG_PENDING` semantics, configurable per interface (`strict`/`pending`, plus the ordinary
  BidCos queue).
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
