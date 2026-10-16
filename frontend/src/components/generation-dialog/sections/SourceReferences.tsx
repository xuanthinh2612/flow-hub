import type { FlowNode } from "../../../store/board";
import { MediaPicker } from "../../MediaPicker";
import { SourcePendingNotice } from "./SourcePendingNotice";
import type { ConnectedVideoAction, RefSourceEntry } from "../types";
import { mediaUrl } from "../../../canvas/canvasApi";

type PromptSourceEntry = { edgeId: string; node: FlowNode; text: string };

interface SourceReferencesProps {
  isVideo: boolean;
  isEffectiveR2v: boolean;
  connectedVideoAction?: ConnectedVideoAction | null;
  refSourceNodes: Array<RefSourceEntry & { mediaId: string }>;
  promptSourceNodes: PromptSourceEntry[];
  pendingRefNodes: FlowNode[];
  openVariantPicker: string | null;
  setOpenVariantPicker: (value: string | null) => void;
  boardPublicId: string | null;
  isWorking: boolean;
  r2vAdditionalMediaIds: string[];
  setR2vAdditionalMediaIds: (value: string[]) => void;
  pickVariantForEdge: (edgeId: string, variantIdx: number) => void;
}

export function SourceReferences({
  isVideo,
  isEffectiveR2v,
  connectedVideoAction,
  refSourceNodes,
  promptSourceNodes,
  pendingRefNodes,
  openVariantPicker,
  setOpenVariantPicker,
  boardPublicId,
  isWorking,
  r2vAdditionalMediaIds,
  setR2vAdditionalMediaIds,
  pickVariantForEdge,
}: SourceReferencesProps) {
  const isVideoRef = connectedVideoAction === "video_reference";
  const shouldRender =
    (!isVideo || isEffectiveR2v || isVideoRef) &&
    (refSourceNodes.length > 0 ||
      promptSourceNodes.length > 0 ||
      pendingRefNodes.length > 0 ||
      isVideoRef);

  if (!shouldRender) return null;

  const displayRefNodes = isVideoRef
    ? refSourceNodes.filter((r) => r.node.data.type !== "video")
    : refSourceNodes;
  const displayPendingNodes = isVideoRef
    ? pendingRefNodes.filter((n) => n.data.type !== "video")
    : pendingRefNodes;

  return (
    <>
      <div className="gen-dialog__field">
        <span className="gen-dialog__label">
          {isVideoRef
            ? `Ảnh tham chiếu kèm theo (${displayRefNodes.length + r2vAdditionalMediaIds.length})`
            : `Source references (${refSourceNodes.length + promptSourceNodes.length + pendingRefNodes.length})`}
        </span>
        <div className="ref-source-row">
          {promptSourceNodes.map((p) => {
                const preview = p.text.trim() || "(empty prompt)";
                return (
                  <div
                    key={p.edgeId}
                    className="ref-source-chip ref-source-chip--prompt"
                    title={`${p.node.data.title || "Prompt"} — ${preview}`}
                  >
                    <div className="ref-source-chip__prompt-body">
                      <span className="ref-source-chip__prompt-icon" aria-hidden="true">✦</span>
                      <span className="ref-source-chip__prompt-text">
                        {preview}
                      </span>
                    </div>
                    <span className="ref-source-chip__id">
                      #{p.node.data.shortId}
                    </span>
                  </div>
                );
              })}
              {displayRefNodes.map((r) => {
                const isMulti = r.allVariants.length >= 2;
                const isPickerOpen = openVariantPicker === r.edgeId;
                const tooltip = isMulti
                  ? `${r.node.data.title} — variant ${(r.variantIdx ?? 0) + 1} · click to switch`
                  : r.node.data.title;
                return (
                  <div key={r.edgeId} className="ref-source-chip-wrap">
                    {isMulti ? (
                      <button
                        type="button"
                        className={`ref-source-chip ref-source-chip--switchable${
                          isPickerOpen ? " ref-source-chip--active" : ""
                        }`}
                        title={tooltip}
                        onClick={() =>
                          setOpenVariantPicker(isPickerOpen ? null : r.edgeId)
                        }
                      >
                        {r.node.data.type === "video" ? (
                          <video className="ref-source-chip__img" src={mediaUrl(r.mediaId)} muted />
                        ) : (
                          <img
                            className="ref-source-chip__img"
                            src={mediaUrl(r.mediaId)}
                            alt={r.node.data.title}
                          />
                        )}
                        <span className="ref-source-chip__variant">
                          v{(r.variantIdx ?? 0) + 1}
                        </span>
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </button>
                    ) : (
                      <div className="ref-source-chip" title={tooltip}>
                        {r.node.data.type === "video" ? (
                          <video className="ref-source-chip__img" src={mediaUrl(r.mediaId)} muted />
                        ) : (
                          <img
                            className="ref-source-chip__img"
                            src={mediaUrl(r.mediaId)}
                            alt={r.node.data.title}
                          />
                        )}
                        <span className="ref-source-chip__id">
                          #{r.node.data.shortId}
                        </span>
                      </div>
                    )}
                    {isMulti && isPickerOpen && (
                      <div
                        className="ref-source-chip__picker"
                        role="dialog"
                        aria-label={`Pick variant for ${r.node.data.title}`}
                      >
                        {r.allVariants.map((mid, i) => {
                          const isCurrent = i === (r.variantIdx ?? 0);
                          return (
                            <button
                              key={mid}
                              type="button"
                              className={`ref-source-chip__picker-item${
                                isCurrent ? " ref-source-chip__picker-item--current" : ""
                              }`}
                              onClick={() => void pickVariantForEdge(r.edgeId, i)}
                              title={`Variant ${i + 1}`}
                              aria-current={isCurrent ? "true" : undefined}
                            >
                              {r.node.data.type === "video" ? (
                                <video className="ref-source-chip__picker-img" src={mediaUrl(mid)} muted />
                              ) : (
                                <img
                                  className="ref-source-chip__picker-img"
                                  src={mediaUrl(mid)}
                                  alt={`Variant ${i + 1}`}
                                />
                              )}
                              <span className="ref-source-chip__picker-label">
                                v{i + 1}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {(isEffectiveR2v || isVideoRef) && (
                <MediaPicker
                  kind="image"
                  workspaceId={boardPublicId}
                  multi={true}
                  value={r2vAdditionalMediaIds}
                  disabled={isWorking}
                  onChange={(ids) => {
                    const newIds = Array.isArray(ids) ? ids : (ids ? [ids] : []);
                    setR2vAdditionalMediaIds(newIds);
                  }}
                  buttonText="+ Thêm ảnh"
                />
              )}
            </div>
            {/* Upstream refs still generating / never generated — same
                unified notice the video sources use. */}
            <SourcePendingNotice nodes={displayPendingNodes} />
          </div>
    </>
  );
}
