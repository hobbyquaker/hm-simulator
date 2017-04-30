module.exports = api => {
    setInterval(() => {
        api.emit('setValue', 'hmip', '0000D3C98C9233:1', 'STATE', true);
        setTimeout(() => {
            api.emit('setValue', 'hmip', '0000D3C98C9233:1', 'STATE', false);
        }, 30000);
    }, 60000);
};
