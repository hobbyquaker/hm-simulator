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
[Fault codes](#fault-codes-measured) below.

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
