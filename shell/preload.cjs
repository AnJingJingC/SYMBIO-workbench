// ② Preload —— 安全桥：只暴露白名单契约，不暴露 require / fs / ipcRenderer 原件。
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('app', {
  file: {
    list: (dir = '.') => invoke('app:file:list', dir),
    read: (p) => invoke('app:file:read', p), // 主进程侧硬截 8KB
  },
  session: {
    current: () => invoke('app:session:current'),
    rotate: () => invoke('app:session:rotate'),
  },
  tabs: {
    getOrder: () => invoke('app:tabs:getOrder'),
    setOrder: (ids) => invoke('app:tabs:setOrder', ids),
  },
  scenario: {
    list: () => invoke('app:scenario:list'),
    get: (id) => invoke('app:scenario:get', id),
  },
  config: {
    stage: () => invoke('app:config:stage'),
  },
  bridge: {
    sites: () => invoke('app:bridge:sites'),
    health: () => invoke('app:bridge:health'),
    ask: ({ site, question }) => invoke('app:bridge:ask', { site, question }),
    login: ({ site }) => invoke('app:bridge:login', { site }),
    hide: ({ site }) => invoke('app:bridge:hide', { site }),
    probe: ({ site }) => invoke('app:bridge:probe', { site }),
  },
  window: {
    minimize: () => invoke('app:window:minimize'),
    close: () => invoke('app:window:close'),
  },
});
