import { Suspense, StrictMode, lazy, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Container, MantineProvider, Text } from '@mantine/core';
import { HomePage } from './pages/HomePage.js';
import { ToastContainer } from './components/ToastContainer.js';
import { AppearanceProvider, useAppearance } from './lib/appearance.js';
import {
  APP_THEME_ROOT_CLASS,
  createAppMantineTheme,
  createAppThemeCssVars,
} from './theme/mantine.js';

// Mantine base + our markdown theme baseline. The theme helper defines
// the legacy token names that the app styles still consume.
import '@mantine/core/styles.css';
import '@marginalia/themes/default.css';
import './styles/theme.css';
import './styles/app.css';
import { installGlobalErrorLogging } from './lib/log.js';
import { APP_THEME } from './styles/theme.js';

installGlobalErrorLogging();

const mantineTheme = createAppMantineTheme(APP_THEME);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

const ViewPage = lazy(async () => {
  const mod = await import('./pages/ViewPage.js');
  return { default: mod.ViewPage };
});

const EditPage = lazy(async () => {
  const mod = await import('./pages/EditPage.js');
  return { default: mod.EditPage };
});

function RouteLoading() {
  return (
    <Container size={640} py="8">
      <Text c="dimmed">Loading…</Text>
    </Container>
  );
}

function App() {
  const { resolved } = useAppearance();
  const themeCssVars = createAppThemeCssVars(mantineTheme, {
    accentColor: APP_THEME.accentColor,
    grayColor: APP_THEME.grayColor,
    scaling: APP_THEME.scaling,
    appearance: resolved,
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('light', resolved === 'light');
    root.classList.toggle('dark', resolved === 'dark');

    for (const [name, value] of Object.entries(themeCssVars)) {
      root.style.setProperty(name, value);
    }
  }, [resolved, themeCssVars]);

  return (
    <MantineProvider theme={mantineTheme} forceColorScheme={resolved}>
      <div className={`${APP_THEME_ROOT_CLASS} ${resolved}`} style={themeCssVars}>
        <BrowserRouter>
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/d/:uid" element={<ViewPage />} />
              <Route path="/d/:uid/:token" element={<ViewPage />} />
              <Route path="/d/:uid/:token/edit" element={<EditPage />} />
              <Route path="/d/:uid/edit" element={<EditPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <ToastContainer />
        </BrowserRouter>
      </div>
    </MantineProvider>
  );
}

createRoot(rootEl).render(
  <StrictMode>
    <AppearanceProvider>
      <App />
    </AppearanceProvider>
  </StrictMode>,
);
