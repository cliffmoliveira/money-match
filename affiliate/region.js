const config = require('./config');
// Server-side region resolution. SEAM: a real geo-IP lookup of req.ip plugs in
// here later. For this task (geo-routing out of scope) we capture the configured
// dev region. NEVER read region from the client/body — spoofable, audit-useless.
function resolveRegion(_req) {
  return config.devRegion;
}
module.exports = { resolveRegion };
