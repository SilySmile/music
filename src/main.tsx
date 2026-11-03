import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopLyrics from './components/DesktopLyrics';
import TrayMenu from './components/TrayMenu';
import './styles.css';
import { Capacitor } from '@capacitor/core';

// Keep ordinary browser zoom available; only the installed Android app fixes its viewport.
if (Capacitor.getPlatform() === 'android') {
  document.querySelector('meta[name="viewport"]')?.setAttribute('content', 'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover');
  document.documentElement.classList.add('android-app');
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash === '#desktop-lyrics' ? <DesktopLyrics /> : window.location.hash === '#tray-menu' ? <TrayMenu /> : <App />}</React.StrictMode>);
