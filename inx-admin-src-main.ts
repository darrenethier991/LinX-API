import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AdminDashboard from './pages/AdminDashboard';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/admin" element={<AdminDashboard />} />
    </Routes>
  </BrowserRouter>
);
