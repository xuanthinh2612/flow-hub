import type { Dispatch, SetStateAction } from "react";
import type { FlowNode } from "../../../store/board";
import type { VideoUpstreamInfo } from "../../../utils/videoFrame";
import { VideoContinuationPanel } from "./VideoContinuationPanel";
import { ConnectedImageSources } from "./ConnectedImageSources";

interface VideoConnectedSourceProps {
  isVideo: boolean;
  videoInfo: VideoUpstreamInfo | null;
  isExtend: boolean;
  isOmniVideo: boolean;
  omniVideoMode: "default" | "video_reference";
  setOmniVideoMode: (value: "default" | "video_reference") => void;
  isUpstreamVeoVideo: boolean;
  videoExtendMode: "continuation" | "extend";
  setVideoExtendMode: (value: "continuation" | "extend") => void;
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
  return (
    <>
      {/* Video connected source section */}
      {isVideo && videoInfo?.mode !== "t2v" && (
        <div className="gen-dialog__field">
          <VideoContinuationPanel
            videoInfo={videoInfo}
            isExtend={props.isExtend}
            isOmniVideo={props.isOmniVideo}
            omniVideoMode={props.omniVideoMode}
            setOmniVideoMode={props.setOmniVideoMode}
            isUpstreamVeoVideo={props.isUpstreamVeoVideo}
            videoExtendMode={props.videoExtendMode}
            setVideoExtendMode={props.setVideoExtendMode}
            isWorking={props.isWorking}
          />
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
        </div>
      )}
    </>
  );
}
