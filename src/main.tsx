import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import DesktopLyrics from './components/DesktopLyrics';
import TrayMenu from './components/TrayMenu';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode>{window.location.hash === '#desktop-lyrics' ? <DesktopLyrics /> : window.location.hash === '#tray-menu' ? <TrayMenu /> : <App />}</React.StrictMode>);
