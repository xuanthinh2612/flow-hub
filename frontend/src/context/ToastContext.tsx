import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export interface ToastItem {
  id: number;
  message: string;
  kind: 'ok' | 'err' | '';
}

interface ToastContextType {
  toast: (message: string, kind?: 'ok' | 'err' | '') => void;
  copy: (text: string, label?: string) => Promise<void>;
}

const ToastContext = createContext<ToastContextType | null>(null);

let nextId = 1;

export const ToastProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const toast = useCallback((message: string, kind: 'ok' | 'err' | '' = '') => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, message, kind }]);
    const timeout = kind === 'err' ? 8000 : 3500;
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, timeout);
  }, []);

  const copy = useCallback(
    async (text: string, label = 'Đã copy') => {
      try {
        await navigator.clipboard.writeText(text);
        toast(label, 'ok');
      } catch (e: any) {
        toast(`Không copy được: ${e.message}`, 'err');
      }
    },
    [toast]
  );

  return (
    <ToastContext.Provider value={{ toast, copy }}>
      {children}
      <div className="toasts" id="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

