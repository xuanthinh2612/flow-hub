export interface WorkerFlowProject {
  projectId: string;
}

export interface WorkerFlow {
  tabs?: number;
  projects?: WorkerFlowProject[];
}

export interface WorkerStats {
  rpcs?: number;
  observed?: number;
}

export interface WorkerInfo {
  id: string;
  label: string;
  version?: string;
  online: boolean;
  connected_at?: number;
  last_seen?: number;
  flow?: WorkerFlow;
  stats?: WorkerStats;
}

export interface JobCounts {
  queued?: number;
  running?: number;
  polling?: number;
  done?: number;
  partial?: number;
  failed?: number;
  timeout?: number;
  canceled?: number;
}

export interface AlertItem {
  id?: string;
  kind: string;
  title: string;
  detail?: string;
  ts: number;
  seen: boolean;
}

export interface OverviewData {
  workers: WorkerInfo[];
  job_counts: JobCounts;
  recent_jobs: JobItem[];
  alerts: AlertItem[];
  alerts_unseen: number;
  media_count: number;
  observation_count: number;
  last_build?: string;
}

export interface JobResult {
  media_id: string;
  kind?: string;
  poster_url?: string;
}

export interface JobOp {
  id: string;
  label: string;
  done: boolean;
  status?: string;
  rounds?: number;
  complaint?: string;
}

export interface RpcLogEntry {
  rpcid: string;
  captcha_action?: string;
  status?: number;
  duration_ms?: number;
  reqid?: string;
  error?: string;
  body?: string;
  response?: string;
}

export interface JobItem {
  id: string;
  type: string;
  status: string;
  created_at: number;
  updated_at?: number;
  model?: string;
  prompt?: string;
  note?: string;
  error?: string;
  warnings?: string[];
  worker_id?: string;
  results?: JobResult[];
  ops?: JobOp[];
  rpc_log?: RpcLogEntry[];
  spec?: any;
}

export interface MediaItem {
  id: string;
  kind: 'image' | 'video';
  source?: string;
  model?: string;
  prompt?: string;
  aspect?: string;
  job_id?: string;
  local_path?: string;
  url?: string;
  poster_url?: string;
  mime?: string;
  size?: number;
  created_at?: number;
  note?: string;
}

export interface ModelVariant {
  id: string;
  key: string;
  aspect?: string;
  duration?: number;
  resolution?: string;
  status: 'verified' | 'unverified' | 'disabled';
  source: string;
  note?: string;
  first_seen?: number;
  last_seen?: number;
}

export interface ModelFamily {
  family: string;
  label: string;
  mode: string;
  default?: boolean;
  variants: ModelVariant[];
}

export interface ModelsResponse {
  modes: Record<string, string>;
  families: ModelFamily[];
}

export interface ResolveModelResponse {
  key: string;
  status: string;
  duration?: number;
  resolution?: string;
}

export interface SettingsData {
  version: string;
  host: string;
  port: number;
  ws_url: string;
  worker_token: string;
  worker_token_from_env?: boolean;
  auth_enabled: boolean;
  project_id?: string;
  observe_enabled: boolean;
  observe_responses: boolean;
  download_media: boolean;
  poll_interval_s: number;
  min_submit_gap_s: number;
  job_timeout_min: number;
  wait_worker_s: number;
  max_observations: number;
  last_build?: string;
}

export interface RpcItem {
  rpcid: string;
  name?: string;
  count: number;
}

export interface ObservationItem {
  id: string;
  ts: number;
  kind?: string;
  source: string;
  status?: number;
  error?: string;
  duration_ms?: number | null;
  path?: string;
  worker_id?: string;
  tab_id?: number;
  rpcids?: string[];
  freq_size?: number;
  form_keys?: string[];
  params?: Record<string, any>;
  headers?: { name: string; value: string }[];
  summary?: {
    keys?: string[];
    prompt?: string;
  };
  has_response?: boolean;
  response?: {
    size: number;
    raw?: string;
    rpcs?: {
      rpcid: string;
      error?: any;
      error_text?: string;
      data?: any;
      data_size?: number;
    }[];
  };
  rpcs?: {
    rpcid: string;
    size: number;
    tag?: string;
    raw?: string;
    inner?: any;
    shortened?: boolean;
  }[];
  check_result?: {
    rpcid?: string;
    supported: boolean;
    reason?: string;
    ok: boolean;
    error?: string;
    diffs?: {
      path: string;
      observed: any;
      built: any;
    }[];
  }[];
  actions?: string[];
  strings?: string[];
  requested_action?: string;
  url?: string;
}

export interface TemplateItem {
  id: number;
  name: string;
  rpcid: string;
  captcha_action?: string | null;
  result_kind: 'image' | 'video' | 'raw';
  note?: string;
  inner: any;
  variables?: string[];
  created_at: number;
  updated_at: number;
  observation_id?: string | null;
}

export interface CharacterPresets {
  genders: { key: string; label: string }[];
  countries: { key: string; label: string }[];
  vibes: { key: string; label: string }[];
}

export interface FlowEvent {
  type: 'media' | 'worker' | 'alert' | 'job' | 'observation';
  data?: any;
}

