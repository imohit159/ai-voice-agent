import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError } from './shared/api/client.js';
import { ToastProvider } from './shared/ui/Toast.js';
import { App } from './app/App.js';
import './style.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Retrying a 4xx never helps; transient network or server errors get one retry.
      retry: (failures, error) =>
        failures < 1 &&
        !(
          error instanceof ApiError &&
          error.status >= 400 &&
          error.status < 500
        ),
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <App />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
