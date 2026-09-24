'use strict';

/**
 * Answers to `system.methodHelp`. The real interface processes answer with a one line signature;
 * the wording here follows the eq3 XML-RPC API documentation.
 */
module.exports = {
    'system.listMethods': 'array system.listMethods() - names of all methods this interface knows',
    'system.methodHelp': 'string system.methodHelp(string method) - the documentation of a method',
    'system.multicall': 'array system.multicall(array calls) - execute several method calls at once',
    init: 'string init(string url, string interfaceId) - register or (with an empty id) remove a logic layer',
    listDevices: 'array listDevices() - descriptions of all devices and channels',
    getDeviceDescription: 'struct getDeviceDescription(string address) - description of one device or channel',
    getParamsetDescription:
        'struct getParamsetDescription(string address, string paramsetType) - description of a paramset',
    getParamsetId: 'string getParamsetId(string address, string paramsetType) - identifier of a paramset',
    getParamset: 'struct getParamset(string address, string paramsetKey) - values of a paramset',
    putParamset: 'void putParamset(string address, string paramsetKey, struct set) - write values of a paramset',
    getValue: 'ValueType getValue(string address, string valueKey) - read one value',
    setValue: 'void setValue(string address, string valueKey, ValueType value) - write one value',
    ping: 'boolean ping(string callerId) - triggers a PONG event',
    getLinks: 'array getLinks(string address, int flags) - links of a channel or of the whole interface',
    getLinkInfo: 'struct getLinkInfo(string senderAddress, string receiverAddress) - name and description of a link',
    setLinkInfo:
        'void setLinkInfo(string senderAddress, string receiverAddress, string name, string description) - rename a link',
    getLinkPeers: 'array getLinkPeers(string address) - the peers a channel is linked with',
    addLink:
        'void addLink(string senderAddress, string receiverAddress, string name, string description) - link two channels',
    removeLink: 'void removeLink(string senderAddress, string receiverAddress) - remove a link',
    activateLinkParamset:
        'void activateLinkParamset(string address, string peerAddress, boolean longPress) - apply a link paramset',
    rssiInfo: 'struct rssiInfo() - receive levels of all devices',
    listBidcosInterfaces: 'array listBidcosInterfaces() - the BidCos interfaces (antennas) of this process',
    setBidcosInterface:
        'void setBidcosInterface(string deviceId, string interfaceId, boolean roaming) - assign a device to an interface',
    getServiceMessages: 'array getServiceMessages() - the pending service messages',
    setInstallMode: 'void setInstallMode(boolean on, int time, int mode) - switch the install mode',
    getInstallMode: 'int getInstallMode() - remaining seconds of the install mode',
    setTempKey: 'void setTempKey(string passphrase) - the temporary key the next BidCos pairings use; BidCos only',
    listTeams: 'array listTeams() - the team pseudo devices (smoke detector teams) with their channels; BidCos only',
    setTeam:
        'void setTeam(string channelAddress, string teamAddress) - put a channel into a team, an empty team into its own; BidCos only',
    deleteDevice: 'void deleteDevice(string address, int flags) - remove a device',
    replaceDevice:
        'void replaceDevice(string oldDeviceAddress, string newDeviceAddress) - take over the configuration of a device',
    reportValueUsage:
        'void reportValueUsage(string address, string valueId, int refCounter) - announce datapoint usage',
    updateFirmware: 'boolean updateFirmware(array deviceAddresses) - start a firmware update',
    installFirmware: 'boolean installFirmware(string deviceAddress) - install a pending firmware',
    clearConfigCache: 'void clearConfigCache(string address) - drop the cached configuration of a device',
    restoreConfigToDevice: 'void restoreConfigToDevice(string address) - write the cached configuration to the device',
    determineParameter:
        'void determineParameter(string address, string paramsetKey, string parameterId) - read a parameter from the device',
};
