import type { FlowNode } from "../../store/board";
import { pendingSourceMessage } from "../lib/pendingSource";

export function SourcePendingNotice({ nodes }: { nodes: FlowNode[] }) {
  if (nodes.length === 0) return null;
  return (
    <div className="source-pending-notice" role="status">
      {nodes.map((n) => (
        <div key={n.id} className="source-pending-notice__item">
          ⚠ {pendingSourceMessage(n)}
        </div>
      ))}
    </div>
  );
}

