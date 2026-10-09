import { useEffect } from 'react';
import { withKey, invalidateMedia } from './client';
import { FlowEvent } from './types';

type Listener = (evt: FlowEvent) => void;
const listeners = new Set<Listener>();

let source: EventSource | null = null;

function ensureConnected() {
  if (source) return;
  source = new EventSource(withKey('/api/events'));
  source.onmessage = (e) => {
    try {
      const evt: FlowEvent = JSON.parse(e.data);
      if (evt.type === 'media') {
        invalidateMedia();
      }
      for (const fn of listeners) {
        try {
          fn(evt);
        } catch (err) {
          console.error('Error in event listener:', err);
        }
      }
    } catch {
      /* ignore */
    }
  };
  source.onerror = () => {
    /* EventSource retries by itself */
  };
}

export function subscribeEvents(cb: Listener): () => void {
  listeners.add(cb);
  ensureConnected();
  return () => {
    listeners.delete(cb);
  };
}

export function useFlowEvents(handler: (evt: FlowEvent) => void, deps: any[] = []) {
  useEffect(() => {
    return subscribeEvents(handler);
  }, deps);
}

