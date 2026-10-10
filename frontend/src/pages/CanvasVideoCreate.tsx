import React, { useEffect, useRef } from 'react';
import '../canvas-styles.css';
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { Board } from '../canvas/Board';
import { GenerationDialog } from '../components/GenerationDialog';
import { AddNodePalette } from '../canvas/AddNodePalette';
import { ResultViewer } from '../components/ResultViewer';
import { useBoardStore } from '../store/board';

export const CanvasVideoCreatePage: React.FC = () => {
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const ran = useRef(false);

  // Initialize the board store on first mount — identical to flowboard's
  // App.tsx pattern.  Without this, boardId stays null and every
  // addNodeOfType call silently returns null.
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    loadInitialBoard();
  }, [loadInitialBoard]);

  return (
    <ReactFlowProvider>
      <div className="canvas-container" style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <header className="page-header" style={{ flexShrink: 0, padding: '5px' }}>
          <h2>Tạo video canvas</h2>
        </header>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {loading && boardId === null ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>
              Loading board…
            </div>
          ) : (
            <>
              <AddNodePalette />
              <Board />
            </>
          )}
        </div>
        <GenerationDialog />
        <ResultViewer />
      </div>
    </ReactFlowProvider>
  );
};
