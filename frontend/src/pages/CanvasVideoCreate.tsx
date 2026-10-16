import React, { useEffect, useMemo, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import '../canvas-styles.css';
import '@xyflow/react/dist/style.css';
import { ReactFlowProvider } from '@xyflow/react';
import { Board } from '../canvas/Board';
import { GenerationDialog } from '../components/GenerationDialog';
import { AddNodePalette } from '../canvas/AddNodePalette';
import { ResultViewer } from '../components/ResultViewer';
import { useBoardStore } from '../store/board';
import { activeNodeIds, useGenerationStore } from '../store/generation';
import { getBoardByPublicId, patchBoard, type Board as CanvasBoard } from '../store/boardApi';
import { api } from '../api/client';
import type { WorkerInfo } from '../api/types';
import { extensionLabel } from '../utils/format';

export const CanvasVideoCreatePage: React.FC = () => {
  const { projectId: routeProjectId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Consume the import request after the board and its dependency graph have
  // been loaded. Refs keep this one-shot across renders and Strict Mode replay.
  const autoGenRequested = useRef(location.state?.autoGen === true);
  const autoRunStarted = useRef(false);
  const [projectMeta, setProjectMeta] = React.useState<CanvasBoard | null>(null);
  const [workers, setWorkers] = React.useState<WorkerInfo[]>([]);
  const [updatingFlowProject, setUpdatingFlowProject] = React.useState(false);
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
    setProjectMeta(null);
    if (!routeProjectId) {
      navigate('/canvas', { replace: true });
      return () => { active = false; };
    }
    getBoardByPublicId(routeProjectId).then(async (project) => {
      if (!active) return;
      if (!project) {
        navigate('/canvas', { replace: true });
        return;
      }
      setProjectMeta(project);
      await loadInitialBoard(project.id);
      if (!active || !autoGenRequested.current || autoRunStarted.current) return;

      const loadedBoard = useBoardStore.getState();
      if (loadedBoard.loading || loadedBoard.boardId !== project.id) return;

      // Clear transient navigation state and mark it consumed before invoking
      // the same Run All action the canvas toolbar calls.
      autoRunStarted.current = true;
      autoGenRequested.current = false;
      navigate(location.pathname, { replace: true, state: null });
      await useGenerationStore.getState().runAll();
    }).catch(() => {
      if (active) navigate('/canvas', { replace: true });
    });
    return () => { active = false; };
  }, [loadInitialBoard, location.pathname, navigate, routeProjectId]);

  useEffect(() => {
    let active = true;
    const refreshWorkers = () => api<WorkerInfo[]>('/api/workers').then((items) => {
      if (active) setWorkers(items);
    }).catch(() => {});
    void refreshWorkers();
    const timer = window.setInterval(refreshWorkers, 5000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const linkedWorker = workers.find((worker) => worker.id === projectMeta?.worker_id);
  const linkedWorkerDisplay = linkedWorker
    ? extensionLabel(linkedWorker.label, linkedWorker.credits)
    : null;
  const currentFlowProject = linkedWorker?.flow?.projects?.find((project) => project.active);
  const hasFlowProjects = (linkedWorker?.flow?.projects?.length ?? 0) > 0;
  const flowProjectMismatch = !!linkedWorker?.online
    && !!currentFlowProject
    && currentFlowProject.projectId !== projectMeta?.flow_project_id;

  const updateFlowProject = async () => {
    if (!projectMeta || !currentFlowProject) return;
    setUpdatingFlowProject(true);
    try {
      const updated = await patchBoard(projectMeta.id, { flow_project_id: currentFlowProject.projectId });
      setProjectMeta(updated);
      useGenerationStore.setState({ projectId: null });
    } catch (err) {
      window.alert(err instanceof Error ? err.message : 'Không cập nhật được project Flow');
    } finally {
      setUpdatingFlowProject(false);
    }
  };

  return (
    <ReactFlowProvider>
      <div className="canvas-container" style={{ width: '100%', height: '100%', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <header className="page-header" style={{ flexShrink: 0, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
          <Link className="btn btn-sm" to="/canvas">← Dự án</Link>
          <h2 style={{ margin: 0, fontSize: '15px' }}>{boardName || 'Canvas video'}</h2>
          {projectMeta?.worker_id && linkedWorker && linkedWorkerDisplay && (
            <span
              className={`pill ${linkedWorker.online ? 'ok' : 'err'}`}
              title={linkedWorkerDisplay.title || `Extension ${linkedWorker.id}`}
              style={{ fontSize: '12px' }}
            >
              {linkedWorkerDisplay.text}
              {typeof linkedWorker.credits?.value !== 'number' ? ' · ch\u01b0a c\u00f3 s\u1ed1 d\u01b0' : ''}
              {linkedWorkerDisplay.stale ? ' · stale' : ''}
              {!linkedWorker.online ? ' · offline' : ''}
            </span>
          )}
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
        {projectMeta && !projectMeta.worker_id && (
          <div role="status" style={{ padding: '8px 16px', color: '#cbd5e1', background: '#1e293b', borderBottom: '1px solid #475569' }}>
            Project đang dùng extension mặc định; chọn extension cho project trong danh sách để theo dõi trạng thái offline và project Flow.
          </div>
        )}
        {projectMeta?.worker_id && linkedWorker && !linkedWorker.online && (
          <div role="status" style={{ padding: '10px 16px', color: '#fecaca', background: '#7f1d1d', borderBottom: '1px solid #ef4444' }}>
            Extension {extensionLabel(linkedWorker.label, linkedWorker.credits).text} đang offline. Kết nối extension để kiểm tra project Flow.
          </div>
        )}
        {projectMeta?.worker_id && linkedWorker?.online && !currentFlowProject
          && (!projectMeta.flow_project_id || !hasFlowProjects) && (
          <div role="status" style={{ padding: '10px 16px', color: '#fde68a', background: '#78350f', borderBottom: '1px solid #f59e0b' }}>
            {!hasFlowProjects
              ? 'Extension \u0111ang online nh\u01b0ng ch\u01b0a m\u1edf project n\u00e0o tr\u00ean Flow. M\u1edf project Flow \u0111\u1ec3 ti\u1ebfp t\u1ee5c t\u1ea1o video.'
              : 'Extension \u0111ang online nh\u01b0ng ch\u01b0a c\u00f3 tab Flow active. M\u1edf project Flow \u0111\u1ec3 ch\u1ecdn project li\u00ean k\u1ebft.'
            }
          </div>
        )}
        {projectMeta?.worker_id && flowProjectMismatch && currentFlowProject && (
          <div role="status" style={{ padding: '10px 16px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, color: '#fde68a', background: '#78350f', borderBottom: '1px solid #f59e0b' }}>
            <span>
              {projectMeta.flow_project_id
                ? `Project Flow không khớp: đã liên kết ${projectMeta.flow_project_id}, tab active hiện tại là ${currentFlowProject.title || currentFlowProject.projectId} (${currentFlowProject.projectId}).`
                : `Project local chưa liên kết Flow; tab active hiện tại là ${currentFlowProject.title || currentFlowProject.projectId} (${currentFlowProject.projectId}).`}
              {' '}Node tham chiếu media cũ có thể cần xử lý riêng.
            </span>
            <button type="button" className="btn btn-sm" disabled={updatingFlowProject} onClick={() => void updateFlowProject()}>
              {updatingFlowProject ? 'Đang cập nhật…' : 'Cập nhật project Flow'}
            </button>
          </div>
        )}
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
