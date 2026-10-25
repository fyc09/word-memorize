import React from 'react';
import ReactDOM from 'react-dom/client';
import { AuthGate } from './components/AuthGate';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('找不到 #root 挂载点');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>,
);
