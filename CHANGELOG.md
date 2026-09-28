# Changelog

All notable changes of hm-simulator. The release workflow takes each version's section from here for the
GitHub release notes.

## Unreleased

- The README is rewritten for the test author (quick start, connecting a client, the scenario API
  grouped, recipes, the fixtures, what is measured and what is the simulator's model), and the
  changelog moved into this file.
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

## 1.1.0

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

## 1.0.0

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

## 0.1.1 and earlier

`init`, `ping`, `system.listMethods`, `getParamsetDescription`, `listDevices`, `setValue`, events
through behaviour scripts, ReGa mock.
