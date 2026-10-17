import { ApprovalError } from '../core/errors.mjs';
import { parseStrictJson, BadJson } from '../core/strict-json.mjs';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const notAnObject = () => new ApprovalError('BAD_REQUEST', 'Request body must be a JSON object.');
const notJson = () => new ApprovalError('UNSUPPORTED_MEDIA_TYPE', 'Send the body as application/json.');

/** The media type is application/json, whatever its parameters or case ("application/json; charset=utf-8"). */
export const isJsonMediaType = (value) => String(value).split(';')[0].replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase() === 'application/json';

/**
 * Reads a UTF-8 JSON body. Uses req.body when a framework already parsed it (the stream is spent by then, so it must
 * never be waited on: a primitive or an array there used to leave the request hanging forever).
 *
 * The Content-Type must be application/json (415 otherwise), also when the body turns out to be empty; a request with
 * no Content-Type is only accepted if its body is empty. Without this rule a web page on another site could send a JSON
 * body as a "simple" cross-origin request (text/plain), which a browser sends without asking first.
 */
export function readJson(req, { limit = 200000 } = {}) {
  if (req.body !== undefined) return isPlainObject(req.body) ? Promise.resolve(req.body) : Promise.reject(notAnObject());
  if (req.readableEnded) return Promise.reject(new ApprovalError('BAD_REQUEST', 'Request body was already consumed.'));
  const type = req.headers?.['content-type'];
  if (type !== undefined && !isJsonMediaType(type)) return Promise.reject(notJson());
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) tooLarge = true; // keep draining so the client can read our 413
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) return reject(new ApprovalError('PAYLOAD_TOO_LARGE', 'Request body is too large.'));
      const bytes = Buffer.concat(chunks);
      if (type === undefined && bytes.length > 0) return reject(notJson());
      const raw = bytes.toString('utf8');
      if (raw.includes('\ufffd') && !bytes.includes(Buffer.from('\ufffd'))) return reject(new ApprovalError('BAD_REQUEST', 'Body is not valid UTF-8.'));
      if (!raw) return resolve({});
      let parsed;
      try { parsed = parseStrictJson(raw); } catch (e) {
        return reject(new ApprovalError('BAD_REQUEST', e instanceof BadJson ? 'Body is not acceptable JSON: ' + e.message : 'Body is not valid JSON.'));
      }
      if (!isPlainObject(parsed)) return reject(notAnObject());
      resolve(parsed);
    });
    req.on('error', reject);
  });
}
