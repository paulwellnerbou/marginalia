import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Theme } from '@radix-ui/themes';
import { HomePage } from './pages/HomePage.js';
import { ViewPage } from './pages/ViewPage.js';
import { EditPage } from './pages/EditPage.js';
import { ToastContainer } from './components/ToastContainer.js';
import { AppearanceProvider, useAppearance } from './lib/appearance.js';

// Radix UI base + our markdown theme baseline. Radix styles come first so
// document theme CSS wins when selectors collide.
import '@radix-ui/themes/styles.css';
import '@marginalia/themes/default.css';
import './styles/app.css';
import { installGlobalErrorLogging } from './lib/log.js';

installGlobalErrorLogging();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

function App() {
  const { resolved } = useAppearance();
  return (
    <Theme accentColor="indigo" grayColor="slate" radius="medium" scaling="100%" appearance={resolved}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/d/:uid" element={<ViewPage />} />
          <Route path="/d/:uid/:token" element={<ViewPage />} />
          <Route path="/d/:uid/:token/edit" element={<EditPage />} />
          <Route path="/d/:uid/edit" element={<EditPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        <ToastContainer />
      </BrowserRouter>
    </Theme>
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </StrictMode>,
);
