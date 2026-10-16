import { CAMERA_MOVEMENTS, type CameraKey } from "../constants";

export function cameraInstruction(key: CameraKey): string {
  return CAMERA_MOVEMENTS.find((c) => c.key === key)?.instruction ?? "";
}
