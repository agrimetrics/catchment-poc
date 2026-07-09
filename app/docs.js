/* Documentation viewer: fetches the repo's Markdown files (served from root by server.py),
 * renders them with `marked`, and lets you page between them via the sidebar and the docs'
 * own cross-links. Routing lives in the URL hash so back/forward and deep links work:
 *
 *     docs.html#/ttl/sfi/README.md              -> a doc
 *     docs.html#/ttl/sfi/README.md#data-warnings -> a doc, scrolled to a heading
 */

// The docs, grouped for the sidebar. Paths are server-root-absolute (see _serve_markdown).
// An item with `href` (instead of `path`) is an external in-app page (e.g. an interactive explorer),
// linked out of the viewer rather than rendered as Markdown.
const DOCS = [
  { group: "Overview", items: [
    { path: "/README.md", title: "Project overview" },
  ]},
  { group: "Concepts", items: [
    { href: "points.html", title: "Points apart — spatial vs. identifier" },
  ]},
  { group: "Datasets", items: [
    { path: "/ttl/regulation/README.md", title: "Regulation" },
    { path: "/ttl/winep/README.md", title: "WINEP" },
    { path: "/ttl/winep/TODO.md", title: "WINEP — backlog" },
    { path: "/ttl/sfi/README.md", title: "Sustainable Farming Incentive" },
    { path: "/ttl/designations/README.md", title: "Designations (SSSI/SAC/SPA)" },
    { path: "/ttl/designations/TODO.md", title: "Designations — spatial queries" },
  ]},
  { group: "Reference", items: [
    { path: "/ontop/README.md", title: "Ontop CLI" },
    { path: "/raw_datasets/access_database_csv_files/README.md", title: "Access DB extracts" },
    { path: "/LICENSE.md", title: "License" },
  ]},
];
const HOME = "/README.md";
const TITLES = Object.fromEntries(DOCS.flatMap(g => g.items).map(d => [d.path, d.title]));

// The doc paths above are server-root-absolute identifiers (used in the hash route). For the actual
// network request, drop the leading slash so it resolves against the PAGE URL — that keeps the viewer
// working under a sub-path deployment (/catchment-demo/) as well as at the origin root.
const docUrl = (p) => p.replace(/^\//, "");

const NAV = document.getElementById("docs-nav");
const CONTENT = document.getElementById("content");
let loadedPath = null;  // the doc currently rendered, so same-doc anchor jumps skip a refetch

// ---- sidebar ---------------------------------------------------------------
NAV.innerHTML = DOCS.map(g =>
  `<div class="grp">${g.group}</div>` +
  g.items.map(d => d.href
    ? `<a href="${d.href}" class="ext-link">${d.title} ↗</a>`
    : `<a href="#${d.path}" data-path="${d.path}">${d.title}</a>`).join("")
).join("");

function setActive(path) {
  NAV.querySelectorAll("a").forEach(a => a.classList.toggle("active", a.dataset.path === path));
}

// ---- routing ---------------------------------------------------------------
function parseHash() {
  // location.hash keeps everything after the first '#', including a doc's own '#anchor'.
  const raw = location.hash.slice(1);
  if (!raw) return { path: HOME, anchor: "" };
  const i = raw.indexOf("#");
  return i === -1 ? { path: raw, anchor: "" } : { path: raw.slice(0, i), anchor: raw.slice(i + 1) };
}

// GitHub-style heading slug so in-doc links like `#data-warnings` resolve.
function slug(text) {
  return text.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");
}

function addHeadingIds(root) {
  const used = {};
  root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach(h => {
    let s = slug(h.textContent || "");
    if (!s) return;
    if (used[s] != null) { used[s] += 1; s = `${s}-${used[s]}`; } else { used[s] = 0; }
    h.id = s;
  });
}

// Rewrite links in rendered Markdown: internal .md links become in-viewer routes; anchors
// stay in the current doc; everything else opens externally with the ↗ convention.
function rewriteLinks(root, curPath) {
  root.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href");
    if (!href) return;
    if (/^(https?:)?\/\//i.test(href) || /^(mailto|tel):/i.test(href)) {
      a.target = "_blank"; a.rel = "noopener noreferrer"; a.classList.add("ext-link");
      return;
    }
    if (href.startsWith("#")) {              // in-page anchor within the current doc
      a.setAttribute("href", `#${curPath}${href}`);
      return;
    }
    const u = new URL(href, `http://docs${curPath}`);  // resolve relative to the current doc
    if (u.pathname.endsWith(".md")) {        // another doc -> stay in the viewer
      a.setAttribute("href", `#${u.pathname}${u.hash}`);
    } else {                                 // a source file etc. -> open against the server
      a.setAttribute("href", docUrl(u.pathname) + u.hash);  // page-relative, sub-path safe
      a.target = "_blank"; a.rel = "noopener"; a.classList.add("ext-link");
    }
  });
}

function scrollToAnchor(anchor) {
  if (!anchor) { window.scrollTo(0, 0); return; }
  const el = document.getElementById(anchor);
  if (el) el.scrollIntoView(); else window.scrollTo(0, 0);
}

async function load() {
  const { path, anchor } = parseHash();
  setActive(path);
  if (path === loadedPath) { scrollToAnchor(anchor); return; }  // same doc, just move to the anchor

  CONTENT.innerHTML = '<div class="docs-article"><div class="loading">Loading…</div></div>';
  let md;
  try {
    const res = await fetch(docUrl(path), { headers: { accept: "text/markdown" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    md = await res.text();
  } catch (e) {
    loadedPath = null;
    CONTENT.innerHTML = `<div class="docs-article"><p class="loading">Could not load <code>${path}</code> (${e.message}).</p></div>`;
    return;
  }
  CONTENT.innerHTML = `<article class="docs-article">${marked.parse(md)}</article>`;
  const article = CONTENT.firstElementChild;
  addHeadingIds(article);
  rewriteLinks(article, path);
  loadedPath = path;
  document.title = `${TITLES[path] || path} · Docs`;
  scrollToAnchor(anchor);
}

window.addEventListener("hashchange", load);
load();
