# hm-simulator

[![License][mit-badge]][mit-url]
[![NPM version](https://badge.fury.io/js/hm-simulator.svg)](http://badge.fury.io/js/hm-simulator)
[![Dependency Status](https://img.shields.io/gemnasium/hobbyquaker/hm-simulator.svg?maxAge=2592000)](https://gemnasium.com/github.com/hobbyquaker/hm-simulator)
[![Build Status](https://travis-ci.org/hobbyquaker/hm-simulator.svg?branch=master)](https://travis-ci.org/hobbyquaker/hm-simulator)

> Simulates (partly) a Homematic CCU


## Installation

Prerequisites: [Node.js](https://nodejs.org) >= 6.0

`npm install -g hm-simulator`


## What for?

This can be used for automated tests of software connecting to a Homematic CCU


## What does it do?

**Warning: This is far away from a complete simulation** Until now I only implemented what was needed for basic tests of
[hm2mqtt.js](https://github.com/hobbyquaker/hm2mqtt.js).

* Simulated rfd, [binrpc](https://github.com/hobbyquaker/binrpc) only, interface on port 2001
* Simulated hmipserver, xmlrpc only, interface on port 2010


### Until now implemented Devices

#### rfd

* HM-RCV-50 (SHORT_PRESS event on BidCoS-RF:1 is triggered every 5 seconds)


#### hmipserver

* HMIP-PS (Toggles its power state every 30 seconds)


#### Until now implemented RPC methods

**incoming:**

* init 
* ping
* system.listMethods


**outgoing:**

* listDevices
* newDevices 
* deleteDevices 
* event


## Todo

* incoming setValue
* incoming getParamsetDescription
* outgoing system.multicall 
* script api
* rega listener on port 8181, rega script mocking 


## Contributing

Pull Request welcome! :-)


## License

MIT 
Copyright (c) 2017 Sebastian Raff
