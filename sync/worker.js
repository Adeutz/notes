/* Plan sync — a dumb box that holds one encrypted blob per sync id.
 *
 * This Worker never sees a single one of your numbers. The page encrypts the
 * tracker with your passphrase before the bytes ever leave the device, so what
 * lands in KV is indistinguishable from random noise. That is the whole point:
 * the security of your data does not depend on this code, on Cloudflare, or on
 * the sync id staying secret. It depends only on the passphrase, exactly as the
 * published plan already does.
 *
 * Routes:
 *   GET  /s/<id>  -> the stored blob, plus X-Sync-Version
 *   PUT  /s/<id>  -> store a blob; send If-Match: <version> for a safe write
 *
 * The version counter is what stops the two devices from silently clobbering
 * each other: a PUT carrying a stale version is refused with 409 rather than
 * applied, and the page then re-reads, merges month by month, and tries again.
 */

/* Only this page may talk to the Worker from a browser. Note that CORS is a
   browser-enforced rule, not a lock — it stops a random site from poking at
   your blob in your own browser, and nothing more. The unguessable id is the
   real access control, and the encryption is what makes losing it survivable. */
var ALLOWED_ORIGINS = [
  'https://adeutz.github.io'
];

var MAX_BYTES = 256 * 1024;   /* the real blob is a few KB; this is just a lid */
var ID_RE = /^[0-9a-f]{32,64}$/;

function cors(origin){
  var h = new Headers();
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1){
    h.set('Access-Control-Allow-Origin', origin);
    h.set('Vary', 'Origin');
  }
  h.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, If-Match');
  /* without this the page's JavaScript cannot read X-Sync-Version at all —
     cross-origin responses hide every header that is not named here */
  h.set('Access-Control-Expose-Headers', 'X-Sync-Version');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function reply(status, body, origin, extra){
  var h = cors(origin);
  if (extra) for (var k in extra) h.set(k, extra[k]);
  return new Response(body, {status: status, headers: h});
}

export default {
  async fetch(request, env){
    var origin = request.headers.get('Origin');
    var path = new URL(request.url).pathname;

    if (request.method === 'OPTIONS') return reply(204, null, origin);

    var m = path.match(/^\/s\/([^/]+)$/);
    if (!m) return reply(404, 'no such route', origin);

    var id = m[1];
    if (!ID_RE.test(id)) return reply(400, 'bad sync id', origin);
    var key = 'blob:' + id;

    if (request.method === 'GET'){
      var got = await env.PLAN.getWithMetadata(key, {type: 'arrayBuffer'});
      if (!got || !got.value){
        /* version 0 means "nothing here yet", which is a normal first run and
           not an error the page should complain about */
        return reply(404, 'nothing stored', origin, {'X-Sync-Version': '0'});
      }
      return reply(200, got.value, origin, {
        'X-Sync-Version': String((got.metadata && got.metadata.v) || 1),
        'Content-Type': 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
    }

    if (request.method === 'PUT'){
      var body = await request.arrayBuffer();
      if (body.byteLength === 0)         return reply(400, 'empty body', origin);
      if (body.byteLength > MAX_BYTES)   return reply(413, 'blob too large', origin);

      var cur  = await env.PLAN.getWithMetadata(key, {type: 'arrayBuffer'});
      var curV = (cur && cur.metadata && cur.metadata.v) || 0;

      /* If-Match: '*' forces the write. Anything else must equal the version
         the caller last saw, or the other device has written in the meantime. */
      var ifMatch = request.headers.get('If-Match');
      if (ifMatch && ifMatch !== '*' && Number(ifMatch) !== curV){
        return reply(409, 'stale version', origin, {'X-Sync-Version': String(curV)});
      }

      var v = curV + 1;
      await env.PLAN.put(key, body, {metadata: {v: v, t: new Date().toISOString()}});
      return reply(200, 'ok', origin, {'X-Sync-Version': String(v)});
    }

    return reply(405, 'method not allowed', origin);
  }
};
