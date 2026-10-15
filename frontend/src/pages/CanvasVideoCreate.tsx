import React, { useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import '../canvas-styles.css';
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { Board } from '../canvas/Board';
import { GenerationDialog } from '../components/GenerationDialog';
import { AddNodePalette } from '../canvas/AddNodePalette';
import { ResultViewer } from '../components/ResultViewer';
import { useBoardStore } from '../store/board';
import { activeNodeIds, useGenerationStore } from '../store/generation';
import { getBoardByPublicId } from '../store/boardApi';

export const CanvasVideoCreatePage: React.FC = () => {
  const { projectId: routeProjectId } = useParams();
  const navigate = useNavigate();
  const loadInitialBoard = useBoardStore((s) => s.loadInitialBoard);
  const loading = useBoardStore((s) => s.loading);
  const boardId = useBoardStore((s) => s.boardId);
  const boardPublicId = useBoardStore((s) => s.boardPublicId);
  const boardName = useBoardStore((s) => s.boardName);
  const boardNodes = useBoardStore((s) => s.nodes);
  const runningChain = useGenerationStore((s) => s.runningChain);
  const chainNodeIds = useGenerationStore((s) => s.chainNodeIds);
  const activePolls = useGenerationStore((s) => s.active);
  const stoppingBoard = useGenerationStore((s) => s.stoppingBoard);
  const runAll = useGenerationStore((s) => s.runAll);
  const stopBoard = useGenerationStore((s) => s.stopBoard);

  // "Project đang chạy" = it still has work in flight. Stop All is only
  // meaningful while that is true, so once everything settled the button
  // goes dead instead of firing a no-op round-trip at the backend.
  const projectBusy = useMemo(
    () => activeNodeIds(boardNodes, activePolls).length > 0,
    [boardNodes, activePolls],
  );
  // Run All stays disabled for the whole run, not just for the dispatch loop:
  // `runningChain` covers the few hundred ms of dispatching, and a node from
  // this run that is still queued/running covers the rest of it. A second Run
  // All on top of the first would only re-dispatch what is already in flight.
  const chainRunning = runningChain || chainNodeIds.some((id) => {
    const node = boardNodes.find((candidate) => candidate.id === id);
    return node?.data.status === "queued"
      || node?.data.status === "running"
      || activePolls[id] !== undefined;
  });

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
        <header className="page-header" style={{ flexShrink: 0, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <Link className="btn btn-sm" to="/canvas">← Dự án</Link>
          <h2 style={{ margin: 0, fontSize: '15px' }}>{boardName || 'Canvas video'}</h2>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            {boardId !== null && (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  title="Chạy toàn bộ project: bỏ qua node đã xong, xếp theo dependency"
                  disabled={chainRunning}
                  onClick={() => void runAll()}
                >
                  {chainRunning ? 'Đang chạy…' : '▶ Chạy tất cả'}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  title="Dừng mọi node đang chạy / đang chờ trong project"
                  disabled={stoppingBoard || !projectBusy}
                  onClick={() => void stopBoard()}
                >
                  {stoppingBoard ? 'Đang dừng…' : '■ Dừng tất cả'}
                </button>
              </>
            )}
            {boardPublicId && <Link className="btn btn-sm" to={`/library?workspace_id=${boardPublicId}`}>Thư viện project</Link>}
          </div>
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
