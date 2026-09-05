'use strict';

/**
 * A small, self contained device set with matching paramset descriptions. The bundled
 * data/paramset-descriptions.json is 8.4 MB; the tests use this instead so that they stay fast and
 * so that every value in an assertion is visible right here.
 */

const SWITCH_ADDRESS = 'ABC0000001';
const HMIP_ADDRESS = '0001D3C99C1234';

const bidcosDevices = [
    {
        ADDRESS: SWITCH_ADDRESS,
        CHILDREN: [`${SWITCH_ADDRESS}:0`, `${SWITCH_ADDRESS}:1`],
        FIRMWARE: '1.9',
        FLAGS: 1,
        INTERFACE: 'BidCoS-RF',
        PARAMSETS: ['MASTER'],
        RF_ADDRESS: 1234567,
        ROAMING: 0,
        RX_MODE: 1,
        TYPE: 'HM-LC-Sw1-Pl',
        VERSION: 1,
    },
    {
        ADDRESS: `${SWITCH_ADDRESS}:0`,
        AES_ACTIVE: 0,
        DIRECTION: 0,
        FLAGS: 3,
        INDEX: 0,
        LINK_SOURCE_ROLES: '',
        LINK_TARGET_ROLES: '',
        PARAMSETS: ['MASTER', 'VALUES'],
        PARENT: SWITCH_ADDRESS,
        PARENT_TYPE: 'HM-LC-Sw1-Pl',
        TYPE: 'MAINTENANCE',
        VERSION: 1,
    },
    {
        ADDRESS: `${SWITCH_ADDRESS}:1`,
        AES_ACTIVE: 0,
        DIRECTION: 2,
        FLAGS: 1,
        INDEX: 1,
        LINK_SOURCE_ROLES: '',
        LINK_TARGET_ROLES: 'SWITCH',
        PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
        PARENT: SWITCH_ADDRESS,
        PARENT_TYPE: 'HM-LC-Sw1-Pl',
        TYPE: 'SWITCH',
        VERSION: 1,
    },
    {
        ADDRESS: 'ABC0000002',
        CHILDREN: ['ABC0000002:0', 'ABC0000002:1'],
        FIRMWARE: '2.4',
        FLAGS: 1,
        INTERFACE: 'BidCoS-RF',
        PARAMSETS: ['MASTER'],
        RF_ADDRESS: 7654321,
        TYPE: 'HM-PB-2-WM55',
        VERSION: 1,
    },
    {
        ADDRESS: 'ABC0000002:0',
        DIRECTION: 0,
        INDEX: 0,
        PARAMSETS: ['MASTER', 'VALUES'],
        PARENT: 'ABC0000002',
        PARENT_TYPE: 'HM-PB-2-WM55',
        TYPE: 'MAINTENANCE',
        VERSION: 1,
    },
    {
        ADDRESS: 'ABC0000002:1',
        DIRECTION: 1,
        INDEX: 1,
        LINK_SOURCE_ROLES: 'SWITCH',
        LINK_TARGET_ROLES: '',
        PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
        PARENT: 'ABC0000002',
        PARENT_TYPE: 'HM-PB-2-WM55',
        TYPE: 'KEY',
        VERSION: 1,
    },
];

const hmipDevices = [
    {
        ADDRESS: HMIP_ADDRESS,
        CHILDREN: [`${HMIP_ADDRESS}:0`, `${HMIP_ADDRESS}:1`],
        FIRMWARE: '1.4.8',
        FLAGS: 1,
        INTERFACE: 'HmIP-RF',
        PARAMSETS: ['MASTER'],
        TYPE: 'HmIP-PDT',
        VERSION: 2,
    },
    {
        ADDRESS: `${HMIP_ADDRESS}:0`,
        DIRECTION: 0,
        INDEX: 0,
        PARAMSETS: ['MASTER', 'VALUES', 'SERVICE'],
        PARENT: HMIP_ADDRESS,
        PARENT_TYPE: 'HmIP-PDT',
        TYPE: 'MAINTENANCE',
        VERSION: 2,
    },
    {
        ADDRESS: `${HMIP_ADDRESS}:1`,
        DIRECTION: 2,
        INDEX: 1,
        LINK_SOURCE_ROLES: '',
        LINK_TARGET_ROLES: 'SWITCH',
        PARAMSETS: ['MASTER', 'VALUES', 'LINK'],
        PARENT: HMIP_ADDRESS,
        PARENT_TYPE: 'HmIP-PDT',
        TYPE: 'SWITCH_VIRTUAL_RECEIVER',
        VERSION: 2,
    },
];

const paramsetDescriptions = {
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1//MASTER': {
        BURST_RX: {TYPE: 'BOOL', OPERATIONS: 3, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'BURST_RX'},
    },
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/MAINTENANCE/VALUES': {
        UNREACH: {TYPE: 'BOOL', OPERATIONS: 5, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'UNREACH'},
        STICKY_UNREACH: {
            TYPE: 'BOOL',
            OPERATIONS: 7,
            FLAGS: 1,
            DEFAULT: false,
            MIN: false,
            MAX: true,
            ID: 'STICKY_UNREACH',
        },
        CONFIG_PENDING: {
            TYPE: 'BOOL',
            OPERATIONS: 5,
            FLAGS: 1,
            DEFAULT: false,
            MIN: false,
            MAX: true,
            ID: 'CONFIG_PENDING',
        },
        RSSI_DEVICE: {TYPE: 'INTEGER', OPERATIONS: 5, FLAGS: 1, DEFAULT: 0, MIN: -128, MAX: 127, ID: 'RSSI_DEVICE'},
    },
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/MAINTENANCE/MASTER': {},
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/SWITCH/VALUES': {
        STATE: {TYPE: 'BOOL', OPERATIONS: 7, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'STATE'},
        WORKING: {TYPE: 'BOOL', OPERATIONS: 5, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'WORKING'},
        INHIBIT: {TYPE: 'BOOL', OPERATIONS: 7, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'INHIBIT'},
    },
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/SWITCH/MASTER': {
        LOGGING: {TYPE: 'BOOL', OPERATIONS: 3, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'LOGGING'},
        ON_TIME: {
            TYPE: 'FLOAT',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 0,
            MIN: 0,
            MAX: 85825945.6,
            UNIT: 's',
            ID: 'ON_TIME',
        },
        POWERUP_ACTION: {
            TYPE: 'INTEGER',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 0,
            MIN: 0,
            MAX: 1,
            ID: 'POWERUP_ACTION',
        },
        STATUSINFO_MINDELAY: {
            TYPE: 'INTEGER',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 2,
            MIN: 1,
            MAX: 15,
            ID: 'STATUSINFO_MINDELAY',
        },
        SEQUENCE: {
            TYPE: 'ENUM',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 'OFF',
            MIN: 'OFF',
            MAX: 'ON',
            VALUE_LIST: ['OFF', 'ON'],
            ID: 'SEQUENCE',
        },
        SERIAL: {TYPE: 'STRING', OPERATIONS: 5, FLAGS: 1, DEFAULT: '', ID: 'SERIAL'},
    },
    'BidCos-RF/HM-LC-Sw1-Pl/1.9/1/SWITCH/LINK': {
        SHORT_ON_TIME: {TYPE: 'FLOAT', OPERATIONS: 3, FLAGS: 1, DEFAULT: 0.5, MIN: 0, MAX: 8583, ID: 'SHORT_ON_TIME'},
        SHORT_ACTION_TYPE: {
            TYPE: 'ENUM',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 'JUMP_TO_TARGET',
            MIN: 'INACTIVE',
            MAX: 'JUMP_TO_TARGET',
            VALUE_LIST: ['INACTIVE', 'JUMP_TO_TARGET'],
            ID: 'SHORT_ACTION_TYPE',
        },
    },
    'BidCos-RF/HM-PB-2-WM55/2.4/1//MASTER': {},
    'BidCos-RF/HM-PB-2-WM55/2.4/1/MAINTENANCE/VALUES': {
        UNREACH: {TYPE: 'BOOL', OPERATIONS: 5, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'UNREACH'},
        CONFIG_PENDING: {
            TYPE: 'BOOL',
            OPERATIONS: 5,
            FLAGS: 1,
            DEFAULT: false,
            MIN: false,
            MAX: true,
            ID: 'CONFIG_PENDING',
        },
        LOWBAT: {TYPE: 'BOOL', OPERATIONS: 5, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'LOWBAT'},
    },
    'BidCos-RF/HM-PB-2-WM55/2.4/1/KEY/VALUES': {
        PRESS_SHORT: {
            TYPE: 'ACTION',
            OPERATIONS: 6,
            FLAGS: 1,
            DEFAULT: false,
            MIN: false,
            MAX: true,
            ID: 'PRESS_SHORT',
        },
        PRESS_LONG: {TYPE: 'ACTION', OPERATIONS: 6, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'PRESS_LONG'},
    },
    'BidCos-RF/HM-PB-2-WM55/2.4/1/KEY/MASTER': {
        LONG_PRESS_TIME: {
            TYPE: 'FLOAT',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 0.4,
            MIN: 0.3,
            MAX: 1.8,
            UNIT: 's',
            ID: 'LONG_PRESS_TIME',
        },
    },
    'BidCos-RF/HM-PB-2-WM55/2.4/1/KEY/LINK': {},
    'HmIP-RF/HmIP-PDT/1.4.8/2//MASTER': {},
    'HmIP-RF/HmIP-PDT/1.4.8/2/MAINTENANCE/VALUES': {
        UNREACH: {TYPE: 'BOOL', OPERATIONS: 5, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'UNREACH'},
        CONFIG_PENDING: {
            TYPE: 'BOOL',
            OPERATIONS: 5,
            FLAGS: 1,
            DEFAULT: false,
            MIN: false,
            MAX: true,
            ID: 'CONFIG_PENDING',
        },
        RSSI_DEVICE: {TYPE: 'INTEGER', OPERATIONS: 5, FLAGS: 1, DEFAULT: 0, MIN: -128, MAX: 127, ID: 'RSSI_DEVICE'},
        RSSI_PEER: {TYPE: 'INTEGER', OPERATIONS: 5, FLAGS: 1, DEFAULT: 0, MIN: -128, MAX: 127, ID: 'RSSI_PEER'},
    },
    'HmIP-RF/HmIP-PDT/1.4.8/2/MAINTENANCE/MASTER': {},
    'HmIP-RF/HmIP-PDT/1.4.8/2/SWITCH_VIRTUAL_RECEIVER/VALUES': {
        STATE: {TYPE: 'BOOL', OPERATIONS: 7, FLAGS: 1, DEFAULT: false, MIN: false, MAX: true, ID: 'STATE'},
        PROCESS: {TYPE: 'INTEGER', OPERATIONS: 5, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 1, ID: 'PROCESS'},
    },
    'HmIP-RF/HmIP-PDT/1.4.8/2/SWITCH_VIRTUAL_RECEIVER/MASTER': {
        CHANNEL_OPERATION_MODE: {
            TYPE: 'ENUM',
            OPERATIONS: 3,
            FLAGS: 1,
            DEFAULT: 'SWITCH',
            MIN: 'SWITCH',
            MAX: 'DIMMER',
            VALUE_LIST: ['SWITCH', 'DIMMER'],
            ID: 'CHANNEL_OPERATION_MODE',
        },
        ON_TIME: {TYPE: 'FLOAT', OPERATIONS: 3, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 16383, UNIT: 's', ID: 'ON_TIME'},
    },
    'HmIP-RF/HmIP-PDT/1.4.8/2/SWITCH_VIRTUAL_RECEIVER/LINK': {
        ON_TIME: {TYPE: 'FLOAT', OPERATIONS: 3, FLAGS: 1, DEFAULT: 0, MIN: 0, MAX: 16383, UNIT: 's', ID: 'ON_TIME'},
    },
};

function devices() {
    return {
        rfd: {devices: structuredClone(bidcosDevices)},
        hmip: {devices: structuredClone(hmipDevices)},
    };
}

module.exports = {
    SWITCH_ADDRESS,
    HMIP_ADDRESS,
    devices,
    paramsetDescriptions,
};
