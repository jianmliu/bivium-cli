import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';
/** Draft 7 validation is strict and never rewrites caller arguments. */
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, strictNumbers: true });
export const validator = (schema: Record<string, unknown>): ValidateFunction => ajv.compile(schema as AnySchema);
export const decimalAmountSchema = { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]+)?$', maxLength: 100 } as const;
export const integerStringSchema = { type: 'string', pattern: '^(0|[1-9][0-9]*)$', maxLength: 100 } as const;
export const integerSchema = { anyOf: [integerStringSchema, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }] } as const;
export const positiveIntegerSchema = { anyOf: [{ type: 'string', pattern: '^[1-9][0-9]*$', maxLength: 100 }, { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER }] } as const;
export const addressSchema = { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' } as const;
export const tokenSchema = { anyOf: [addressSchema, { type: 'string', pattern: '^(?!0[xX])[A-Za-z][A-Za-z0-9._-]{0,63}$' }] } as const;
export const listLimitSchema = { type: 'integer', minimum: 1, maximum: 100, default: 20 } as const;
export const marketArraySchema = (items: Record<string, unknown> = integerStringSchema) => ({ type: 'array', items, maxItems: 20 });
export const listLimit = (value: number | undefined): number => value ?? 20;
