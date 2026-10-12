import React, { useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import '../canvas-styles.css';
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { Board } from '../canvas/Board';
import { GenerationDialog } from '../components/GenerationDialog';
import { AddNodePalette } from '../canvas/AddNodePalette';
import { ResultViewer } from '../components/ResultViewer';
import { useBoardStore } from '../store/board';
import { getBoardByPublicId } from '../store/boardApi';

export const CanvasVideoCreatePage: React.FC = () => {
  const { projectId: routeProjectId } = useParams();
  const navigate = useNavigate();
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const boardPublicId = useBoardStore((s) => s.boardPublicId);
  const boardName = useBoardStore((s) => s.boardName);

  // Initialize the board store on first mount — identical to flowboard's
  // App.tsx pattern.  Without this, boardId stays null and every
  // addNodeOfType call silently returns null.
  useEffect(() => {
    let active = true;
    if (!routeProjectId) {
      navigate('/canvas', { replace: true });
      return () => { active = false; };
    }
    getBoardByPublicId(routeProjectId).then((project) => {
      if (!active) return;
      if (project) void loadInitialBoard(project.id);
      else navigate('/canvas', { replace: true });
    }).catch(() => {
      if (active) navigate('/canvas', { replace: true });
    });
    return () => { active = false; };
  }, [loadInitialBoard, navigate, routeProjectId]);

  return (
    <ReactFlowProvider>
      <div className="canvas-container" style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <header className="page-header" style={{ flexShrink: 0, padding: '5px' }}>
          <Link className="btn btn-sm" to="/canvas">← Dự án</Link>
          <h2 style={{ margin: 0 }}>{boardName || 'Canvas video'}</h2>
          {boardPublicId && <Link className="btn btn-sm" to={`/library?workspace_id=${boardPublicId}`}>Thư viện project</Link>}
        </header>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#888' }}>
              Loading board…
            </div>
          ) : boardId === null ? (
            <div className="empty">Không tìm thấy project canvas.</div>
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
