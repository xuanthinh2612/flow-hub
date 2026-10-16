import type { Dispatch, SetStateAction } from "react";
import type { FlowNode } from "../../../store/board";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import { MINI_SELECT_STYLE } from "../constants";
import { SourcePendingNotice } from "../SourcePendingNotice";
import { mediaUrl } from "../../../canvas/canvasApi";

interface ConnectedImageSourcesProps {
  videoInfo: VideoUpstreamInfo | null;
  totalConnectedSources: number;
  connectedVideoMode: "i2v" | "r2v";
  setConnectedVideoMode: (value: "i2v" | "r2v") => void;
  actualConnectedMode: string | undefined;
  sourceMediaIds: string[];
  sourceNode: FlowNode | undefined;
  selectedSourceIdx: Set<number>;
  setSelectedSourceIdx: Dispatch<SetStateAction<Set<number>>>;
  isWorking: boolean;
}

export function ConnectedImageSources({
  videoInfo,
  totalConnectedSources,
  connectedVideoMode,
  setConnectedVideoMode,
  actualConnectedMode,
  sourceMediaIds,
  sourceNode,
  selectedSourceIdx,
  setSelectedSourceIdx,
  isWorking,
}: ConnectedImageSourcesProps) {
  return (
    <>
            {(videoInfo?.mode === "i2v" || videoInfo?.mode === "r2v") && (
              <>
                <div className="gen-dialog__label-row">
                  <span className="gen-dialog__label" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    Chế độ:
                    {videoInfo?.mode === "i2v" && totalConnectedSources <= 1 ? (
                      <select
                        className="source-select-mini"
                        value={connectedVideoMode}
                        onChange={(e) => setConnectedVideoMode(e.target.value as "i2v" | "r2v")}
                        disabled={isWorking}
                        style={MINI_SELECT_STYLE}
                      >
                        <option value="i2v">Nối tiếp (i2v)</option>
                        <option value="r2v">Ingredients (r2v)</option>
                      </select>
                    ) : (
                      <span className="source-select-mini" style={{ ...MINI_SELECT_STYLE, color: '#fb923c', display: 'inline-block' }}>
                        Ingredients (r2v)
                      </span>
                    )}
                  </span>
                </div>
                
                {actualConnectedMode === "i2v" && (
                  <>
                    <div className="gen-dialog__label-row" style={{ marginTop: '10px' }}>
                      <span className="gen-dialog__label">
                        Source image{sourceMediaIds.length > 1 ? `s (${sourceMediaIds.length})` : ""}
                      </span>
                      {sourceMediaIds.length > 1 && (
                        <div className="source-select-actions">
                          <button
                            type="button"
                            className="source-select-mini"
                            onClick={() =>
                              setSelectedSourceIdx(
                                new Set(sourceMediaIds.map((_, i) => i)),
                              )
                            }
                          >
                            All
                          </button>
                          <button
                            type="button"
                            className="source-select-mini"
                            onClick={() => setSelectedSourceIdx(new Set())}
                          >
                            None
                          </button>
                        </div>
                      )}
                    </div>
                {sourceMediaIds.length > 0 && sourceNode ? (
                  <>
                    <div className="source-image-row">
                      {sourceMediaIds.map((mid, i) => {
                        const checked = selectedSourceIdx.has(i);
                        return (
                          <button
                            key={mid}
                            type="button"
                            disabled={isWorking}
                            className={`source-thumb${checked ? " source-thumb--checked" : ""}`}
                            onClick={() => {
                              setSelectedSourceIdx((prev) => {
                                const next = new Set(prev);
                                if (next.has(i)) next.delete(i);
                                else next.add(i);
                                return next;
                              });
                            }}
                            aria-pressed={checked}
                            aria-label={`Variant ${i + 1}${checked ? " selected" : ""}`}
                          >
                            <img
                              className="source-image-row__thumb"
                              src={mediaUrl(mid)}
                              alt={sourceNode.data.title}
                            />
                            <span className="source-thumb__check" aria-hidden="true">
                              {checked ? "✓" : ""}
                            </span>
                          </button>
                        );
                      })}
                      <span className="source-image-row__label">
                        #{sourceNode.data.shortId}
                      </span>
                    </div>
                    <p className="gen-dialog__hint">
                      {selectedSourceIdx.size === 0 ? (
                        <span style={{ color: "#ef4444" }}>
                          Chọn ít nhất 1 variant để gen video.
                        </span>
                      ) : (
                        <>
                          Sẽ gen <strong>{selectedSourceIdx.size} video</strong>
                          {selectedSourceIdx.size === sourceMediaIds.length
                            ? " (tất cả variants)"
                            : ` (${selectedSourceIdx.size}/${sourceMediaIds.length} variants)`}
                          — cùng prompt + camera setting.
                        </>
                      )}
                    </p>
                  </>
                ) : (
                  <SourcePendingNotice
                    nodes={sourceNode ? [sourceNode] : []}
                  />
                )}
                  </>
                )}
              </>
            )}
    </>
  );
}
