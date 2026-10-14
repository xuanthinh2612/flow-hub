import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Download, Pencil, Upload } from 'lucide-react';
import { createBoard, deleteBoard, listBoards, patchBoard, type Board } from '../store/boardApi';
import { useToast } from '../context/ToastContext';
import { api, projectMediaZipUrl } from '../api/client';
import type { WorkerInfo } from '../api/types';
import { exportCanvasProjectJson } from '../services/canvasProjectJson';
import { importCanvasProjectJson } from '../services/canvasProjectImport';

type Project = Board & { node_count?: number; video_count?: number; image_count?: number };


export const CanvasProjectsPage: React.FC = () => {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [exporting, setExporting] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [workers, setWorkers] = useState<WorkerInfo[]>([]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [boards, extensions] = await Promise.all([
        listBoards(),
        api<WorkerInfo[]>('/api/workers'),
      ]);
      setProjects(boards as Project[]);
      setWorkers(extensions);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không tải được project', 'err');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      api<WorkerInfo[]>('/api/workers').then(setWorkers).catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const linkExtension = async (project: Project, workerId: string) => {
    try {
      const updated = await patchBoard(project.id, { worker_id: workerId || null });
      setProjects((items) => items.map((item) => item.id === project.id ? { ...item, ...updated } : item));
      toast(workerId ? 'Đã liên kết extension với project' : 'Đã bỏ liên kết extension', 'ok');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không cập nhật được extension', 'err');
    }
  };

  const createProject = async () => {
    const name = window.prompt('Tên project video', 'Project mới');
    if (name === null) return;
    setCreating(true);
    try {
      const project = await createBoard(name.trim() || 'Project mới');
      navigate(`/canvas/${project.public_id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không tạo được project', 'err');
    } finally {
      setCreating(false);
    }
  };

  const removeProject = async (project: Project) => {
    if (!window.confirm(`Xóa project “${project.name}”? Canvas, video và thư viện ảnh thuộc project này sẽ bị xóa.`)) return;
    try {
      await deleteBoard(project.id);
      setProjects((items) => items.filter((item) => item.id !== project.id));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không xóa được project', 'err');
    }
  };

  const renameProject = async (project: Project) => {
    const name = window.prompt('Tên project', project.name);
    if (name === null || !name.trim() || name.trim() === project.name) return;
    try {
      const updated = await patchBoard(project.id, { name: name.trim() });
      setProjects((items) => items.map((item) => item.id === project.id ? { ...item, ...updated } : item));
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Không đổi được tên project', 'err');
    }
  };

  const copyProjectId = async (project: Project) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(project.public_id);
      } else {
        const input = document.createElement('textarea');
        input.value = project.public_id;
        input.setAttribute('readonly', '');
        input.style.position = 'fixed';
        input.style.opacity = '0';
        document.body.appendChild(input);
        input.select();
        const copied = document.execCommand('copy');
        input.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      toast('Đã sao chép ID project', 'ok');
    } catch {
      toast('Không thể sao chép ID project', 'err');
    }
  };

  const exportProject = async (project: Project) => {
    setExporting(project.id);
    try {
      const unresolvedNodeCount = await exportCanvasProjectJson(project);
      toast(
        unresolvedNodeCount
          ? `\u0110\u00e3 t\u1ea3i JSON; c\u00f3 ${unresolvedNodeCount} node tham chi\u1ebfu media ngo\u00e0i project ch\u01b0a \u00e1nh x\u1ea1 th\u00e0nh node.`
          : '\u0110\u00e3 t\u1ea3i JSON project',
        'ok',
      );
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Kh\u00f4ng xu\u1ea5t \u0111\u01b0\u1ee3c JSON project', 'err');
    } finally {
      setExporting(null);
    }
  };

  const openImportDialog = () => {
    fileInputRef.current?.click();
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const { board, nodeCount, edgeCount } = await importCanvasProjectJson(file);
      toast(`\u0110\u00e3 import project “${board.name}” (${nodeCount} node, ${edgeCount} li\u00ean k\u1ebft)`, 'ok');
      navigate(`/canvas/${board.public_id}`);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Kh\u00f4ng import \u0111\u01b0\u1ee3c project', 'err');
    } finally {
      setImporting(false);
    }
  };

  return (
    <section style={{ padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <header className="page-head" style={{ alignItems: 'center' }}>
        <div>
          <h1>Project video</h1>
          <p>Mỗi project có canvas và thư viện media riêng.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {!!projects.length && <button className="btn btn-primary" onClick={createProject} disabled={creating}>+ Project mới</button>}
          <button className="btn" onClick={openImportDialog} disabled={importing}>
            <Upload size={15} /> {importing ? 'Đang import…' : 'Import Project'}
          </button>
        </div>
      </header>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        style={{ display: 'none' }}
        onChange={(event) => void handleImportFile(event)}
      />

      {loading ? <p className="empty">Đang tải project…</p> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
          {!projects.length && (
            <button type="button" onClick={createProject} disabled={creating} style={{ minHeight: 210, textAlign: 'left', cursor: 'pointer', border: '1px dashed #64748b', borderRadius: 14, padding: 24, background: '#111827', color: 'inherit' }}>
              <span style={{ fontSize: 32 }}>＋</span>
              <h2>Tạo dự án mới</h2>
              <span className="muted">Canvas, video và thư viện sẽ được lưu riêng.</span>
            </button>
          )}
          {projects.map((project) => (
            <article key={project.id} style={{ minHeight: 190, border: '1px solid #334155', borderRadius: 14, padding: 18, background: '#111827', display: 'flex', flexDirection: 'column' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <button type="button" onClick={() => navigate(`/canvas/${project.public_id}`)} style={{ flex: 1, minWidth: 0, textAlign: 'left', cursor: 'pointer', border: 0, padding: 0, color: 'inherit', background: 'transparent' }}>
                  <h2 style={{ margin: 0, fontSize: '1.05rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: 25, marginBottom: 12 }}>▦</span>&nbsp;&nbsp;&nbsp;
                    {project.name}
                  </h2>
                </button>
                <button type="button" className="btn btn-sm" aria-label={`Đổi tên ${project.name}`} title="Đổi tên project" onClick={() => void renameProject(project)} style={{ padding: 5, lineHeight: 0, flexShrink: 0 }}>
                  <Pencil size={15} />
                </button>
              </div>
              <button type="button" onClick={() => navigate(`/canvas/${project.public_id}`)} style={{ flex: 1, textAlign: 'left', cursor: 'pointer', border: 0, padding: 0, color: 'inherit', background: 'transparent' }}>
                <span className="muted">{project.node_count ?? 0} node · {project.video_count ?? 0} video · {project.image_count ?? 0} ảnh</span>
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, marginTop: 10 }}>
                <span className="muted" style={{ flex: 1, minWidth: 0, fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={project.public_id}>
                  ID: {project.public_id}
                </span>
                <button type="button" className="btn btn-sm" aria-label="Sao chép ID project" title="Sao chép ID" onClick={() => void copyProjectId(project)} style={{ padding: 5, lineHeight: 0, flexShrink: 0 }}>
                  <Copy size={14} />
                </button>
              </div>
              <label style={{ display: 'grid', gap: 6, marginTop: 12, fontSize: 12 }}>
                <span className="muted">Client extension cho project</span>
                <select
                  className="input"
                  value={project.worker_id ?? ''}
                  onChange={(event) => void linkExtension(project, event.target.value)}
                  title="Các project có thể dùng chung một extension."
                >
                  <option value="">Mặc định — tự chọn extension</option>
                  {workers.map((worker) => (
                    <option key={worker.id} value={worker.id}>
                      {worker.label} · {worker.online ? 'online' : 'offline'} · {worker.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
                <a
                  className="btn btn-sm"
                  href={projectMediaZipUrl(project.public_id)}
                  title="Tải toàn bộ ảnh / video của project thành file zip"
                >
                  Export media
                </a>
                <button type="button" className="btn btn-sm" disabled={exporting === project.id} onClick={() => void exportProject(project)} title="Tải cấu hình node và liên kết thành JSON">
                  <Download size={14} /> {exporting === project.id ? 'Đang xuất…' : 'Export JSON'}
                </button>
                <button type="button" className="btn btn-sm btn-danger" onClick={() => removeProject(project)}>Xóa</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
};
