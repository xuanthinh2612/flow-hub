import type { MediaProviderKey } from "../../../store/settings";
import { ENABLE_MUSE_BACKEND } from "../constants";
import { InfoTip } from "../InfoTip";

interface BackendFieldProps {
  isPrompt: boolean;
  mediaProvider: MediaProviderKey;
  setMediaProvider: (value: MediaProviderKey) => void;
  isWorking: boolean;
}

export function BackendField({ isPrompt, mediaProvider, setMediaProvider, isWorking }: BackendFieldProps) {
  return (
    <>
      {/* Backend ? which engine renders this dispatch. Sticky across
          dialogs (settings store). Muse = muse2api gateway, or a
          Pax worker via the provider-job queue; no Flow plan or
          extension needed. */}
        {!isPrompt && (
          <div className="gen-dialog__field">
            <span className="gen-dialog__label">
              Backend
              <InfoTip tip="Flow = Chrome extension → Google Flow (cần Flow plan). Muse = muse2api gateway (hoặc Pax worker) tự render, không cần Flow plan hay extension — cần cấu hình muse2api hoặc có worker đang chạy (xem hướng dẫn ở AI Providers → Muse)." />
            </span>
            <div className="aspect-chip-row">
              <button
                key="flow"
                type="button"
                className={`aspect-chip${mediaProvider === "flow" ? " aspect-chip--active" : ""}`} disabled={isWorking}
                onClick={() => setMediaProvider("flow")}
              >
                Flow
              </button>
              {ENABLE_MUSE_BACKEND && (
<button
                key="muse"
                type="button"
                className={`aspect-chip${mediaProvider === "muse" ? " aspect-chip--active" : ""}`} disabled={isWorking}
                onClick={() => setMediaProvider("muse")}
              >
                Muse
              </button>
              )}
            </div>
          </div>
        )}
    </>
  );
}
