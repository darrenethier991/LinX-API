import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import LandingPage from './pages/LandingPage';
import ContractorDashboard from './pages/ContractorDashboard';
import HomeownerDashboard from './pages/HomeownerDashboard';
import EchoForgePage from './pages/EchoForgePage';
import LeadGenPage from './pages/LeadGenPage';
import ShortenerPage from './pages/ShortenerPage';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/contractor/:id" element={<ContractorDashboard />} />
      <Route path="/homeowner/:id" element={<HomeownerDashboard />} />
      <Route path="/echoforge" element={<EchoForgePage />} />
      <Route path="/leads" element={<LeadGenPage />} />
      <Route path="/shortener" element={<ShortenerPage />} />
    </Routes>
  </BrowserRouter>
);
