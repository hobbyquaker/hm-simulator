#!/usr/bin/env node

const log = require('yalm');
const HmSim = require('./sim.js');

log.setLevel('debug');

const hmSim = new HmSim({
    log,
    devices: {
        rfd: require('./data/devices-rfd.json'),
        hmip: require('./data/devices-hmip.json')
    },
    config: {
        listenAddress: '127.0.0.1',
        binrpcListenPort: 2001,
        xmlrpcListenPort: 2010
    }
});
