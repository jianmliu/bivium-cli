export interface ToolFailure { code: string; message: string; retryable: boolean; field?: string; nextAction?: string }
export class ToolError extends Error {
  constructor(readonly failure: ToolFailure) { super(failure.message); this.name = 'ToolError'; }
}
export type Result<T> = { ok: true; data: T } | { ok: false; error: ToolFailure };
export const success = <T>(data: T): Result<T> => ({ ok: true, data });
export const toJsonText = (value: unknown): string => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
export function toolFailure(error: unknown): ToolFailure {
 if (error instanceof ToolError) return error.failure;
 const e = error as { code?: unknown; message?: unknown; retryable?: unknown; field?: string; nextAction?: string } | null;
 return { code: typeof e?.code === 'string' ? e.code : 'TOOL_FAILED', message: typeof e?.message === 'string' ? e.message : String(error), retryable: e?.retryable === true, ...(e?.field ? {field:e.field} : {}), ...(e?.nextAction ? {nextAction:e.nextAction} : {}) };
}
export function toolContent(value: unknown, isError = false) {
 const text = toJsonText(value);
 return { content: [{type:'text' as const, text}], structuredContent: JSON.parse(text), ...(isError ? {isError:true} : {}) };
}
