import { ApiError } from './errors.mjs';

// File-system operations may finish late; their discarded results cannot submit.
export function boundedLocalRead(operation, signal, timeoutMs = 5000) {
  if (signal?.aborted) return Promise.reject(new ApiError('API_CANCELLED'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(new ApiError('API_CANCELLED'));
    const timer = setTimeout(() => finish(new ApiError('API_METADATA_TIMEOUT')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
