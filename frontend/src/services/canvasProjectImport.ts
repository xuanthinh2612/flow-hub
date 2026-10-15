import { api } from '../api/client';
import type { Board } from '../store/boardApi';
import { isAutoGenEnabled } from './autoGen';

const SUPPORTED_FORMAT = 'flow-hub-canvas-project';
const SUPPORTED_FORMAT_VERSION = 1;

export interface CanvasProjectImportResult {
  board: Board;
  nodeCount: number;
  edgeCount: number;
  autoGen: boolean;
}

/**
 * Rebuild a whole canvas project from a `flow-hub-canvas-project` file —
 * the exact document `exportCanvasProjectJson` downloads.
 *
 * The browser only checks that the file is parseable JSON and looks like a
 * project export; every rule that protects the database (format version,
 * duplicate ids, dangling edges, asset payloads…) lives in the backend so
 * there is one implementation of "what is a valid project" and a bad file
 * can never reach SQLite.
 */
export async function importCanvasProjectJson(file: File): Promise<CanvasProjectImportResult> {
  const text = await file.text();

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error(`File không phải JSON hợp lệ: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('File JSON phải là một object project, không phải danh sách hay giá trị thuần.');
  }

  const document = payload as Record<string, unknown>;
  if (document.format !== SUPPORTED_FORMAT) {
    throw new Error(
      `File không phải project Flow Hub (format “${String(document.format)}”, cần “${SUPPORTED_FORMAT}”).`,
    );
  }
  if (document.format_version !== SUPPORTED_FORMAT_VERSION) {
    throw new Error(
      `File dùng format_version “${String(document.format_version)}”, server hỗ trợ bản ${SUPPORTED_FORMAT_VERSION}.`,
    );
  }

  const result = await api<{ board: Board; imported?: { nodes?: number; edges?: number } }>(
    '/api/boards/import-project',
    { method: 'POST', body: payload },
  );

  return {
    board: result.board,
    nodeCount: result.imported?.nodes ?? 0,
    edgeCount: result.imported?.edges ?? 0,
    // Opt in only for the literal boolean true. Missing or malformed values
    // keep the legacy import behavior and can never trigger a run.
    autoGen: isAutoGenEnabled(document.auto_gen),
  };
}
