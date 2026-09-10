import { validator } from './schema.ts';
import { ToolError } from './result.ts';
export const REQUEST_TIMEOUT_MS = 30_000;
export const SIMULATION_TIMEOUT_MS = 60_000;
export const UPSTREAM_TIMEOUT_MS = 8_000;
export const RPC_CONCURRENCY = 8;
export const READ_ONLY_ANNOTATIONS = { readOnlyHint:true, destructiveHint:false, idempotentHint:true } as const;
export interface ToolDef { name: string; description: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean } }
export interface ToolContext { signal: AbortSignal }
export interface ToolDefinition extends ToolDef {
 handler(args: Record<string, unknown>, context: ToolContext): Promise<unknown> | unknown;
 timeoutMs?: number;
 /** Bounded by default. Only trusted local handlers or handlers with their own per-RPC limiter may bypass the shared legacy pool. */
 concurrency?: 'bounded' | 'local' | 'managed';
}
const timeoutError = () => new ToolError({code:'TIMEOUT',message:'Request deadline exceeded; an upstream operation without cancellation support may still be running.',retryable:true});
/** Abort-aware caller deadline. A legacy operation may continue; this does not claim cancellation. */
export async function withDeadline<T>(operation: (signal: AbortSignal) => Promise<T> | T, timeoutMs = REQUEST_TIMEOUT_MS, parent?: AbortSignal): Promise<T> {
 const controller = new AbortController();
 const abort = () => controller.abort(parent?.reason ?? timeoutError());
 if (parent?.aborted) abort(); else parent?.addEventListener('abort',abort,{once:true});
 let timer: ReturnType<typeof setTimeout> | undefined;
 let onAbort: (() => void) | undefined;
 const deadline = new Promise<never>((_,reject) => {
  onAbort = () => reject(controller.signal.reason ?? timeoutError());
  if (controller.signal.aborted) onAbort(); else controller.signal.addEventListener('abort',onAbort,{once:true});
  timer = setTimeout(() => controller.abort(timeoutError()),timeoutMs);
 });
 try { return await Promise.race([deadline, Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(controller.signal); })]); }
 finally { clearTimeout(timer); parent?.removeEventListener('abort',abort); if (onAbort) controller.signal.removeEventListener('abort',onAbort); }
}
/** Slots remain occupied until work actually settles, including uncancellable legacy RPCs. */
export function createConcurrencyLimiter(max = RPC_CONCURRENCY) {
 if (!Number.isInteger(max) || max < 1) throw new Error('concurrency must be positive');
 let active = 0;
 const queue: Array<() => void> = [];
 return async function limit<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (active >= max) await new Promise<void>((resolve,reject) => {
   const ready = () => { signal?.removeEventListener('abort',abort); active++; resolve(); };
   const abort = () => { const index = queue.indexOf(ready); if (index >= 0) queue.splice(index,1); reject(signal?.reason); };
   queue.push(ready); signal?.addEventListener('abort',abort,{once:true});
  }); else active++;
  try { signal?.throwIfAborted(); return await operation(); }
  finally { active--; queue.shift()?.(); }
 };
}
export class ToolRegistry {
 private entries = new Map<string, {definition: ToolDefinition; validate: ReturnType<typeof validator>}>();
 private limit = createConcurrencyLimiter();
 constructor(definitions: ToolDefinition[] = [], private readonly compile: typeof validator = validator) { for (const definition of definitions) this.register(definition); }
 register(definition: ToolDefinition): void {
  if (this.entries.has(definition.name)) throw new Error(`duplicate tool: ${definition.name}`);
  this.entries.set(definition.name,{definition,validate:this.compile(definition.inputSchema)});
 }
 list(): ToolDef[] { return [...this.entries.values()].map(({definition: {handler,timeoutMs,concurrency,...definition}}) => definition); }
 async call(name: string, args: unknown, context?: {signal?: AbortSignal}): Promise<unknown> {
  const entry = this.entries.get(name);
  if (!entry) throw new ToolError({code:'UNKNOWN_TOOL',message:`unknown tool ${JSON.stringify(name)}`,retryable:false});
  if (!entry.validate(args)) {
   const errors = entry.validate.errors ?? [];
   const first = errors[0];
   throw new ToolError({code:'INVALID_ARGUMENT',message:errors.map(e => `${e.instancePath || 'arguments'} ${e.message}${e.keyword === 'required' ? `: ${e.params.missingProperty}` : ''}`).join('; '),retryable:false,field:first?.instancePath || (first?.params.missingProperty as string | undefined)});
  }
  return withDeadline(signal => {
   const invoke = () => entry.definition.handler(args as Record<string,unknown>,{signal});
   return entry.definition.concurrency === 'local' || entry.definition.concurrency === 'managed'
    ? invoke()
    : this.limit(invoke,signal);
  },entry.definition.timeoutMs,context?.signal);
 }
}
