'use strict';

/**
 * Finds a paramset description for a device whose firmware has none.
 *
 * The descriptions are keyed `<interface>/<type>/<firmware>/<version>/<channelType>/<paramset>`,
 * so a device whose firmware is older or newer than every dump in the set has no description at
 * all, although the channel layout of the same type and VERSION is the same. The index groups the
 * keys by everything but the firmware and picks the nearest firmware: the highest one at or below
 * the device's, else the lowest one above it.
 */

/**
 * Firmware as numbers, part by part; `2.31.25.20180526` is `[2, 31, 25, 20180526]`, so a dated
 * build sorts after its undated version. A part that is no number counts as -1.
 * @param {string} firmware
 * @returns {number[]}
 */
function firmwareParts(firmware) {
    return String(firmware)
        .split('.')
        .map((part) => {
            const number = Number.parseInt(part, 10);
            return Number.isNaN(number) ? -1 : number;
        });
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} < 0, 0 or > 0
 */
function compareFirmware(a, b) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index++) {
        const left = a[index] === undefined ? -1 : a[index];
        const right = b[index] === undefined ? -1 : b[index];
        if (left !== right) {
            return left - right;
        }
    }
    return 0;
}

class ParamsetIndex {
    /**
     * @param {object} descriptions key -> paramset description
     */
    constructor(descriptions) {
        this.descriptions = descriptions;
        /** `<interface>/<type>/<version>/<channelType>/<paramset>` -> [{parts, key}] sorted by firmware */
        this.groups = undefined;
    }

    build() {
        const groups = new Map();
        for (const key of Object.keys(this.descriptions)) {
            const fields = key.split('/');
            if (fields.length !== 6) {
                continue;
            }
            const [prefix, type, firmware, version, channelType, paramset] = fields;
            const group = [prefix, type, version, channelType, paramset].join('/');
            if (!groups.has(group)) {
                groups.set(group, []);
            }
            groups.get(group).push({parts: firmwareParts(firmware), key});
        }
        for (const entries of groups.values()) {
            entries.sort((a, b) => compareFirmware(a.parts, b.parts));
        }
        this.groups = groups;
    }

    /**
     * The key of the nearest firmware for a key that has no description.
     * @param {string} key `<interface>/<type>/<firmware>/<version>/<channelType>/<paramset>`
     * @returns {string|null}
     */
    nearest(key) {
        const fields = key.split('/');
        if (fields.length !== 6) {
            return null;
        }
        if (!this.groups) {
            this.build();
        }
        const [prefix, type, firmware, version, channelType, paramset] = fields;
        const entries = this.groups.get([prefix, type, version, channelType, paramset].join('/'));
        if (!entries || entries.length === 0) {
            return null;
        }

        const wanted = firmwareParts(firmware);
        let below = null;
        for (const entry of entries) {
            if (compareFirmware(entry.parts, wanted) <= 0) {
                below = entry;
            } else {
                return (below || entry).key;
            }
        }
        return below.key;
    }
}

module.exports = {ParamsetIndex, firmwareParts, compareFirmware};
