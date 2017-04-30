# hm-simulator

[![NPM version](https://badge.fury.io/js/hm-simulator.svg)](http://badge.fury.io/js/hm-simulator)
[![Dependency Status](https://img.shields.io/gemnasium/hobbyquaker/hm-simulator.svg?maxAge=2592000)](https://gemnasium.com/github.com/hobbyquaker/hm-simulator)
[![Build Status](https://travis-ci.org/hobbyquaker/hm-simulator.svg?branch=master)](https://travis-ci.org/hobbyquaker/hm-simulator)
[![XO code style](https://img.shields.io/badge/code_style-XO-5ed9c7.svg)](https://github.com/sindresorhus/xo)
[![License][mit-badge]][mit-url]

> Simulates (partly) a Homematic CCU


## Installation

Prerequisites: [Node.js](https://nodejs.org) >= 6.0

`npm install -g hm-simulator`


## What for?

This can be used for automated tests of software connecting to a Homematic CCU


## What does it do?

**Warning: This is far away from a complete simulation and still work in progress** Until now I'm only implementing what 
I needed for basic tests of [hm2mqtt.js](https://github.com/hobbyquaker/hm2mqtt.js).

* Simulated rfd, [binrpc](https://github.com/hobbyquaker/binrpc) only, interface on port 2001
* Simulated hmipserver, xmlrpc only, interface on port 2010


### RPC methods implemented until now

**incoming:**

* init 
* ping
* system.listMethods
* getParamsetDescription


**outgoing:**

* listDevices
* newDevices 
* deleteDevices 
* event
* system.multicall 


### Scripting

In the behaviors directory are two example scripts:

 * `virtual-button-press.js` triggers a `PRESS_SHORT` on `BidCoS-RF:1` every 5 seconds.
 * `window-open-close.js` opens and closes `0000D3C98C9233:1` every 30 seconds.


## Todo

* bugfixes...
* extend script api
* more behavior examples
* more rfd devices
* correct error responses to invalid methodCalls
* incoming getParamset
* MASTER, MAINTENANCE and LINK paramsets
* service messages, incoming getServiceMessages
* incoming putParamset
* rega listener on port 8181, rega script mocking 
* ... many more... ;)


## Contributing

Pull Request welcome! :-)


## License

MIT 
Copyright (c) 2017 Sebastian Raff

[mit-badge]: https://img.shields.io/badge/License-MIT-blue.svg?style=flat
[mit-url]: LICENSE
