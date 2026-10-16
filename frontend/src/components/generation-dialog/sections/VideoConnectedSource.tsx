import type { Dispatch, SetStateAction } from "react";
import type { FlowNode } from "../../../store/board";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import type { ConnectedVideoAction } from "../types";
import { VideoContinuationPanel } from "./VideoContinuationPanel";
import { ConnectedImageSources } from "./ConnectedImageSources";

interface VideoConnectedSourceProps {
  isVideo: boolean;
  videoInfo: VideoUpstreamInfo | null;
  action: ConnectedVideoAction | null;
  onActionChange: (value: ConnectedVideoAction) => void;
  isExtend: boolean;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  isUpstreamVeoVideo: boolean;
  isWorking: boolean;
  totalConnectedSources: number;
  connectedVideoMode: "i2v" | "r2v";
  setConnectedVideoMode: (value: "i2v" | "r2v") => void;
  actualConnectedMode: string | undefined;
  sourceMediaIds: string[];
  sourceNode: FlowNode | undefined;
  selectedSourceIdx: Set<number>;
  setSelectedSourceIdx: Dispatch<SetStateAction<Set<number>>>;
}

export function VideoConnectedSource(props: VideoConnectedSourceProps) {
  const { isVideo, videoInfo } = props;
  const upstreamVideoCount = videoInfo?.upstreamVideoNodes?.length ??
    (videoInfo?.mode === "video_continuation" ? 1 : 0);
  const upstreamImageCount = videoInfo?.upstreamImageNodes?.length ??
    (videoInfo?.mode === "i2v" ? 1 : (videoInfo?.isImageUpstream ? 1 : 0));
  const hasSingleUpstreamVideo = upstreamVideoCount === 1;
  const hasUpstreamImages = upstreamImageCount > 0;

  return (
    <>
      {/* Video connected source section */}
      {isVideo && videoInfo?.mode !== "t2v" && (
        <div className="gen-dialog__field">
          {hasSingleUpstreamVideo && (
            <VideoContinuationPanel
              videoInfo={videoInfo}
              action={props.action ?? "continuation"}
              onActionChange={props.onActionChange}
              isExtend={props.isExtend}
              isOmniVideo={props.isOmniVideo}
              omniVideoMode={props.omniVideoMode}
              isUpstreamVeoVideo={props.isUpstreamVeoVideo}
              connectedVideoMode={props.connectedVideoMode}
              isWorking={props.isWorking}
              hasUpstreamImages={hasUpstreamImages}
            />
          )}
          {!hasSingleUpstreamVideo && (
            <ConnectedImageSources
              videoInfo={videoInfo}
              totalConnectedSources={props.totalConnectedSources}
              connectedVideoMode={props.connectedVideoMode}
              setConnectedVideoMode={props.setConnectedVideoMode}
              actualConnectedMode={props.actualConnectedMode}
              sourceMediaIds={props.sourceMediaIds}
              sourceNode={props.sourceNode}
              selectedSourceIdx={props.selectedSourceIdx}
              setSelectedSourceIdx={props.setSelectedSourceIdx}
              isWorking={props.isWorking}
            />
          )}
        </div>
      )}
    </>
  );
}
