import React, { useState, useEffect, useCallback } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api/client';
import { OverviewData } from '../api/types';
import { useFlowEvents } from '../api/events';

export const Layout: React.FC = () => {
  const [onlineWorkersCount, setOnlineWorkersCount] = useState<number | null>(null);
  const [unseenAlerts, setUnseenAlerts] = useState<number>(0);
  const [activeJobsCount, setActiveJobsCount] = useState<number>(0);
  const location = useLocation();

  const refreshBadges = useCallback(async () => {
    try {
      const o = await api<OverviewData>('/api/overview');
      const online = (o.workers || []).filter((w) => w.online);
      setOnlineWorkersCount(online.length);
      setUnseenAlerts(o.alerts_unseen || 0);
      const active =
        (o.job_counts?.queued || 0) + (o.job_counts?.running || 0) + (o.job_counts?.polling || 0);
      setActiveJobsCount(active);
    } catch {
      /* auth prompt or server down */
    }
  }, []);

  useEffect(() => {
    refreshBadges();
    const interval = setInterval(refreshBadges, 15000);
    return () => clearInterval(interval);
  }, [refreshBadges]);

  useFlowEvents(
    (evt) => {
      if (['worker', 'alert', 'job'].includes(evt.type)) {
        refreshBadges();
      }
    },
    [refreshBadges]
  );

  useEffect(() => {
    // Document title based on route
    const path = location.pathname.replace(/^\//, '') || 'overview';
    const titles: Record<string, string> = {
      overview: 'Tổng quan',
      image: 'Tạo ảnh',
      character: 'Nhân vật',
      video: 'Tạo video',
      library: 'Thư viện',
      jobs: 'Jobs',
      observe: 'Observation',
      models: 'Models',
      templates: 'Templates & RPC',
      settings: 'Cài đặt',
    };
    document.title = `${titles[path] || 'Flow Hub'} · Flow Hub`;
  }, [location.pathname]);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-name">Flow Hub</span>
          <span
            className={`pill ${onlineWorkersCount && onlineWorkersCount > 0 ? 'ok' : 'err'}`}
            id="worker-pill"
            title="Worker (extension) đang kết nối"
          >
            {onlineWorkersCount === null
              ? '…'
              : onlineWorkersCount > 0
              ? `● ${onlineWorkersCount} worker`
              : '○ chưa có worker'}
          </span>
        </div>
        <nav id="nav">
          <NavLink to="/overview" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>Tổng quan</span>
            {unseenAlerts > 0 && <span className="badge">{unseenAlerts}</span>}
          </NavLink>

          <div className="nav-group">Tạo</div>
          <NavLink to="/image" className={({ isActive }) => (isActive ? 'active' : '')}>
            Ảnh
          </NavLink>
          <NavLink to="/character" className={({ isActive }) => (isActive ? 'active' : '')}>
            Nhân vật
          </NavLink>
          <NavLink to="/video" className={({ isActive }) => (isActive ? 'active' : '')}>
            Video
          </NavLink>
          <NavLink to="/library" className={({ isActive }) => (isActive ? 'active' : '')}>
            Thư viện
          </NavLink>
          <NavLink to="/jobs" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span>Jobs</span>
            {activeJobsCount > 0 && <span className="badge">{activeJobsCount}</span>}
          </NavLink>

          <div className="nav-group">Quan sát &amp; cập nhật</div>
          <NavLink to="/observe" className={({ isActive }) => (isActive ? 'active' : '')}>
            Observation
          </NavLink>
          <NavLink to="/models" className={({ isActive }) => (isActive ? 'active' : '')}>
            Models
          </NavLink>
          <NavLink to="/templates" className={({ isActive }) => (isActive ? 'active' : '')}>
            Templates &amp; RPC
          </NavLink>

          <div className="nav-group">Hệ thống</div>
          <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
            Cài đặt
          </NavLink>
          <a href="/docs" target="_blank" rel="noopener noreferrer">
            API docs ↗
          </a>
        </nav>
      </aside>
      <main id="view">
        <Outlet />
      </main>
    </div>
  );
};

