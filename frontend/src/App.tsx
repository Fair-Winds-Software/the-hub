// Authorized by HUB-1569 — App root; BrowserRouter + Suspense + lazy /console/login stub
import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

const Login = lazy(() => import('./routes/Login'));

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<div>Loading…</div>}>
        <Routes>
          <Route path="/console/login" element={<Login />} />
          <Route path="*" element={<Navigate to="/console/login" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
