import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { getApiKey, setApiKey, setOnAuthRequired } from '../api/client';
import { useModal } from './ModalContext';

interface AuthContextType {
  apiKey: string;
  saveKey: (key: string) => void;
  promptKey: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [apiKey, setApiKeyState] = useState(getApiKey());
  const { openModal, closeModal } = useModal();

  const promptKey = () => {
    let currentInput = apiKey;
    openModal(
      'Nhập API key',
      <div>
        <p className="hint">
          Server đang bật xác thực. Key được in ra khi khởi động server (hoặc đặt FLOWHUB_API_KEY trong .env).
        </p>
        <div className="inline" style={{ marginTop: '10px' }}>
          <input
            className="input mono"
            placeholder="API key"
            type="password"
            defaultValue={apiKey}
            onChange={(e) => {
              currentInput = e.target.value.trim();
            }}
          />
          <button
            className="btn btn-primary"
            onClick={() => {
              setApiKey(currentInput);
              setApiKeyState(currentInput);
              closeModal();
              window.location.reload();
            }}
          >
            Lưu
          </button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    setOnAuthRequired(() => {
      promptKey();
    });
  }, [apiKey]);

  const saveKey = (key: string) => {
    setApiKey(key);
    setApiKeyState(key);
  };

  return <AuthContext.Provider value={{ apiKey, saveKey, promptKey }}>{children}</AuthContext.Provider>;
};

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}

