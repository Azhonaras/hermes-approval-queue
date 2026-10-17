/** JSON envelope from docs/spec.md: { success, data } or { success, error: { code, message } }. */
export function corsHeaders(cors) {
  if (!cors || !cors.origin) return {};
  return {
    'Access-Control-Allow-Origin': cors.origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, X-Review-Session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };
}

export function send(res, status, body, cors) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(cors) });
  res.end(JSON.stringify(body));
}

export function ok(res, data, cors) {
  send(res, 200, { success: true, data }, cors);
}

export function error(res, http, code, message, cors) {
  send(res, http, { success: false, error: { code, message } }, cors);
}
