/* Runtime configuration for the frontend.
 *
 * Edit this file to point the app at different endpoints — NO rebuild required, it is a plain static
 * asset loaded before app.js. This is what makes the app deployable as a static site against your own
 * infrastructure: set `sparqlEndpoint` to your triplestore (or, more usually, to a same-origin path
 * your reverse proxy forwards to an internal one), and `observationsEndpoint` to a proxy for the EA
 * Water Quality Archive.
 *
 * Absolute vs relative:
 *   - A RELATIVE path ("sparql", no leading slash) resolves against the page URL, so the app works
 *     unchanged at the origin root OR under a sub-path (e.g. /catchment-demo/). Keep these relative
 *     unless you have a specific reason not to — a LEADING SLASH ("/sparql") pins the request to the
 *     origin root and will break a sub-path deployment.
 *   - An ABSOLUTE URL ("https://data.internal/sparql") targets another host directly. That host MUST
 *     send CORS headers (Access-Control-Allow-Origin) or the browser will block the response. Note the
 *     EA Water Quality Archive does NOT send CORS headers, so it can only be reached via a proxy —
 *     never as an absolute URL here.
 *
 * Quick override without editing this file: append ?sparql=<url> or ?observations=<url> to the page
 * URL (handy for testing against a different endpoint).
 */
window.APP_CONFIG = {
  // SPARQL 1.1 query endpoint used by every table and the query editor (GET/POST ?query=).
  sparqlEndpoint: "sparql",
  // EA Water Quality Archive observation proxy (powers the substance time-series chart).
  observationsEndpoint: "observations",
  // Basemap tile template. Defaults to the same-origin proxy (app/server.py's /tiles route) so the
  // browser never calls an external tile CDN; point at any {z}/{x}/{y} XYZ source if you prefer.
  tilesUrl: "tiles/{z}/{x}/{y}.png",
};

// Per-page overrides via the query string, so you can retarget without editing the file.
(function () {
  var p = new URLSearchParams(location.search);
  if (p.get("sparql")) window.APP_CONFIG.sparqlEndpoint = p.get("sparql");
  if (p.get("observations")) window.APP_CONFIG.observationsEndpoint = p.get("observations");
})();
