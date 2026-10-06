import type {AffectedSource, SchemaNode} from '../shared/types';

export interface RevisionDTO {
  revision: number;
  createdAt: number;
  schema: SchemaNode;
}

export interface ContractDTO {
  id: string;
  name: string;
  revision: number;
  revisions: RevisionDTO[];
  latest: RevisionDTO;
}

export interface SummaryDTO {
  id: string;
  name: string;
  revision: number;
  affected: AffectedSource[];
}

export interface IssueDTO {
  scope: 'schema' | 'sample';
  path: string;
  code: string;
  message: string;
}

export interface PreviewDTO {
  parseError: string | null;
  valid: boolean;
  truncated: boolean;
  issues: IssueDTO[];
}

export interface BreakingDTO {
  path: string;
  code: string;
  message: string;
}

export type SaveError =
  | {kind: 'version_conflict'; message: string; current: ContractDTO}
  | {kind: 'breaking'; message: string; currentRevision: number; breaking: BreakingDTO[]}
  | {kind: 'invalid_schema'; issues: IssueDTO[]}
  | {kind: 'bad_request'; message: string}
  | {kind: 'network'; message: string};

async function parseError(response: Response): Promise<SaveError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // 非 JSON 错误页
  }
  const data = (body ?? {}) as Record<string, unknown>;
  switch (data.error) {
    case 'version_conflict':
      return {kind: 'version_conflict', message: String(data.message ?? ''), current: data.current as ContractDTO};
    case 'breaking_change':
      return {
        kind: 'breaking',
        message: String(data.message ?? ''),
        currentRevision: Number(data.currentRevision),
        breaking: data.breaking as BreakingDTO[],
      };
    case 'invalid_schema':
      return {kind: 'invalid_schema', issues: data.issues as IssueDTO[]};
    default:
      return {kind: 'bad_request', message: String(data.message ?? `请求失败（${response.status}）`)};
  }
}

export async function listContracts(): Promise<SummaryDTO[]> {
  const response = await fetch('/api/contracts');
  if (!response.ok) throw new Error(`加载契约列表失败：${response.status}`);
  return response.json();
}

export async function getContract(id: string): Promise<ContractDTO> {
  const response = await fetch(`/api/contracts/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`加载契约失败：${response.status}`);
  return response.json();
}

export async function previewContract(id: string | null, schema: SchemaNode, sample: string): Promise<PreviewDTO> {
  const response = await fetch(id ? `/api/preview/${encodeURIComponent(id)}` : '/api/preview', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({schema, sample}),
  });
  if (!response.ok) throw new Error(`预览失败：${response.status}`);
  return response.json();
}

export interface SavePayload {
  name: string;
  expectedRevision: number;
  schema: SchemaNode;
  confirmBreaking?: boolean;
}

export type SaveResponse = {ok: true; revision: number; breaking: BreakingDTO[]} | {ok: false; error: SaveError};

export async function saveContract(id: string, payload: SavePayload): Promise<SaveResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/contracts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
    });
  } catch (error) {
    return {ok: false, error: {kind: 'network', message: error instanceof Error ? error.message : String(error)}};
  }
  if (response.ok) {
    const body = await response.json();
    return {ok: true, revision: body.revision, breaking: body.breaking ?? []};
  }
  return {ok: false, error: await parseError(response)};
}
