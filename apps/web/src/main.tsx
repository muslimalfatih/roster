import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';

// Seat counts change under us constantly (that is the whole point of the exercise),
// so nothing is cached across mounts and failed mutations are never auto-retried.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: false }, mutations: { retry: false } },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
