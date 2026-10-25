export class ApiError extends Error {
  constructor(code) { super(code); this.name = 'ApiError'; this.code = code; }
}
export const reject = code => { throw new ApiError(code); };
export function safeCode(error) {
  return error instanceof ApiError && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'API_OPERATION_REJECTED';
}
