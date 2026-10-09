import React from 'react';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ToastProvider } from './context/ToastContext';
import { ModalProvider } from './context/ModalContext';
import { AuthProvider } from './context/AuthContext';
import { Layout } from './components/Layout';
import { OverviewPage } from './pages/Overview';
import { ImageCreatePage } from './pages/ImageCreate';
import { CharacterCreatePage } from './pages/CharacterCreate';
import { VideoCreatePage } from './pages/VideoCreate';
import { LibraryPage } from './pages/Library';
import { JobsPage } from './pages/Jobs';
import { ObservationPage } from './pages/Observation';
import { ModelsPage } from './pages/Models';
import { TemplatesPage } from './pages/Templates';
import { SettingsPage } from './pages/Settings';

export const App: React.FC = () => {
  return (
    <HashRouter>
      <ToastProvider>
        <ModalProvider>
          <AuthProvider>
            <Routes>
              <Route path="/" element={<Layout />}>
                <Route index element={<Navigate to="/overview" replace />} />
                <Route path="overview" element={<OverviewPage />} />
                <Route path="image" element={<ImageCreatePage />} />
                <Route path="character" element={<CharacterCreatePage />} />
                <Route path="video" element={<VideoCreatePage />} />
                <Route path="library" element={<LibraryPage />} />
                <Route path="jobs" element={<JobsPage />} />
                <Route path="observe" element={<ObservationPage />} />
                <Route path="models" element={<ModelsPage />} />
                <Route path="templates" element={<TemplatesPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>
            </Routes>
          </AuthProvider>
        </ModalProvider>
      </ToastProvider>
    </HashRouter>
  );
};
