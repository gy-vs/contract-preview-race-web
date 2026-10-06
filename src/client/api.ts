import type {ContractDetail, ContractSummary, Issue, SchemaNode} from '../shared/schema';

export interface PreviewResult {
  contractId: string;
  valid: boolean;
  errors: Issue[];
}

export type SaveResult =
  | {ok: true; revision: number; breaking: boolean; changes: Issue[]}
  | {ok: false; kind: 'conflict'; message: string; current: {revision: number; schema: SchemaNode}}
  | {ok: false; kind: 'breaking'; report: Issue[]}
  | {ok: false; kind: 'invalid'; details: Issue[]}
  | {ok: false; kind: 'error'; message: string};

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, init);
  return response;
}

export async function listContracts(): Promise<ContractSummary[]> {
  const response = await request('/api/contracts');
  if (!response.ok) throw new Error(`加载契约列表失败 (${response.status})`);
  return response.json();
}

export async function getContract(id: string): Promise<ContractDetail> {
  const response = await request(`/api/contracts/${encodeURIComponent(id)}`);
  if (!response.ok) throw new Error(`加载契约 ${id} 失败 (${response.status})`);
  return response.json();
}

export async function createContract(id: string, name: string, schema: SchemaNode): Promise<{ok: true} | {ok: false; message: string}> {
  const response = await request('/api/contracts', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({id, name, schema}),
  });
  if (response.status === 201) return {ok: true};
  const body = await response.json().catch(() => ({}));
  return {ok: false, message: body.message ?? body.error ?? `创建失败 (${response.status})`};
}

export async function saveContract(id: string, schema: unknown, baseRevision: number, force: boolean): Promise<SaveResult> {
  const response = await request(`/api/contracts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({schema, baseRevision, force}),
  });
  const body = await response.json().catch(() => ({}));
  if (response.ok) return {ok: true, revision: body.revision, breaking: body.breaking, changes: body.changes};
  if (response.status === 409 && body.error === 'conflict') {
    return {ok: false, kind: 'conflict', message: body.message, current: body.current};
  }
  if (response.status === 422 && body.error === 'breaking') {
    return {ok: false, kind: 'breaking', report: body.report};
  }
  if (response.status === 422 && body.error === 'invalid_schema') {
    return {ok: false, kind: 'invalid', details: body.details};
  }
  return {ok: false, kind: 'error', message: body.message ?? `保存失败 (${response.status})`};
}

/**
 * 预览校验。sample 以原始文本（sampleText）发送：几千层嵌套的样例在
 * JSON.stringify 时会栈溢出，原文传输由服务端解析则没有这个问题。
 */
export async function previewContract(id: string, schema: unknown, sampleText: string, signal?: AbortSignal): Promise<PreviewResult> {
  const response = await request(`/api/contracts/${encodeURIComponent(id)}/preview`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({schema, sampleText}),
    signal,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const details: Issue[] = body.details ?? [{path: '$', message: body.message ?? `预览失败 (${response.status})`}];
    return {contractId: id, valid: false, errors: details};
  }
  return body;
}
