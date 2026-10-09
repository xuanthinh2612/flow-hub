import React, { createContext, useContext, useState, useCallback, useRef, ReactNode } from 'react';

interface ModalContextType {
  openModal: (title: string, content: ReactNode) => void;
  closeModal: () => void;
  isOpen: boolean;
}

const ModalContext = createContext<ModalContextType | null>(null);

export const ModalProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [modalState, setModalState] = useState<{ isOpen: boolean; title: string; content: ReactNode | null }>({
    isOpen: false,
    title: '',
    content: null,
  });

  const dialogRef = useRef<HTMLDialogElement>(null);

  const openModal = useCallback((title: string, content: ReactNode) => {
    setModalState({ isOpen: true, title, content });
    if (dialogRef.current && !dialogRef.current.open) {
      dialogRef.current.showModal();
    }
  }, []);

  const closeModal = useCallback(() => {
    setModalState((prev) => ({ ...prev, isOpen: false }));
    if (dialogRef.current && dialogRef.current.open) {
      dialogRef.current.close();
    }
  }, []);

  return (
    <ModalContext.Provider value={{ openModal, closeModal, isOpen: modalState.isOpen }}>
      {children}
      <dialog ref={dialogRef} className="modal" id="modal" onClose={() => setModalState((prev) => ({ ...prev, isOpen: false }))}>
        <div className="modal-inner">
          <header className="modal-head">
            <span id="modal-title">{modalState.title}</span>
            <button className="btn btn-ghost btn-sm" id="modal-close" onClick={closeModal}>
              ✕
            </button>
          </header>
          <div id="modal-body">{modalState.content}</div>
        </div>
      </dialog>
    </ModalContext.Provider>
  );
};

export function useModal() {
  const ctx = useContext(ModalContext);
  if (!ctx) throw new Error('useModal must be used within ModalProvider');
  return ctx;
}

