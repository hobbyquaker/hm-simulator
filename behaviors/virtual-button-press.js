module.exports = api => {
    setInterval(() => {
        api.emit('setValue', 'rfd', 'BidCoS-RF:1', 'PRESS_SHORT', true);
    }, 5000);
};
