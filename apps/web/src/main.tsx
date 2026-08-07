import { Container, Text, Theme } from '@radix-ui/themes';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { RouteErrorBoundary } from './components/RouteErrorBoundary.js';
import { ToastContainer } from './components/ToastContainer.js';
import { AppearanceProvider, useAppearance } from './lib/appearance.js';

// Radix UI base + our markdown theme baseline. Radix styles come first so
// document theme CSS wins when selectors collide.
import '@radix-ui/themes/styles.css';
import '@marginalia/themes/default.css';
import './styles/theme.css';
import './styles/app.css';
import { installGlobalErrorLogging } from './lib/log.js';
import { registerServiceWorker } from './lib/pwa.js';
import { APP_THEME } from './styles/theme.js';

installGlobalErrorLogging();
registerServiceWorker();

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const HomePage = lazy(async () => {
  const mod = await import('./pages/HomePage.js');
  return { default: mod.HomePage };
});

const ViewPage = lazy(async () => {
  const mod = await import('./pages/ViewPage.js');
  return { default: mod.ViewPage };
});

const EditPage = lazy(async () => {
  const mod = await import('./pages/EditPage.js');
  return { default: mod.EditPage };
});

const PairPage = lazy(async () => {
  const mod = await import('./pages/PairPage.js');
  return { default: mod.PairPage };
});

function RouteLoading() {
  return (
    <Container size="2" py="8">
      <Text color="gray">Loading…</Text>
    </Container>
  );
}

function App() {
  const { resolved } = useAppearance();
  return (
    <Theme
      accentColor={APP_THEME.accentColor}
      grayColor={APP_THEME.grayColor}
      radius={APP_THEME.radius}
      scaling={APP_THEME.scaling}
      appearance={resolved}
    >
      <BrowserRouter>
        <RouteErrorBoundary>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/d/:uid" element={<ViewPage />} />
              <Route path="/d/:uid/:token" element={<ViewPage />} />
              <Route path="/d/:uid/:token/edit" element={<EditPage />} />
              <Route path="/d/:uid/edit" element={<EditPage />} />
              <Route path="/k" element={<PairPage />} />
              <Route path="/k/:code" element={<PairPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
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
