import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthGate } from './components/AuthGate';
import './styles.css';

/*
 * 注册 Service Worker（只为接收 Web Push，不做离线缓存）。
 *
 * Service Worker 需要安全上下文：https 或 localhost。
 * 失败不必惊动用户 —— 界面会根据 pushSupported() 把通知那一块置灰。
 */
if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js').catch(() => {
    /* 注册不上就只是没有通知，不影响其他功能 */
  });
}

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
);
