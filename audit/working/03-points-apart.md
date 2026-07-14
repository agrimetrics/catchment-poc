# Adversarial audit — "Points apart" (`app/points.js`) and the `app/app.js` ledes

**Date:** 2026-07-13 · **Method:** every number re-derived independently in Python against the live
`http://127.0.0.1:8000/sparql` store (`audit_rederive.py`), and every screen rendered in headless
Firefox to read the *actual* prose users see (`audit_render.py`) rather than trusting the source.
**No project file was changed.**

---

## 0. Headline

The page's arithmetic is **correct**. I re-derived every computed number and all of them match, to the
metre. The page is unusually honest — it computes at render time rather than typing numbers into prose,
it refuses to invent geometry, and `ttl/regulation/README.md` is candid to a fault.

The problems are **not in the sums**. They are in three places:

1. **One tautology presented as a score** (`monitoredAt 91/91 · 100%`).
2. **Two prose statements that are false about the graph** — the explorer's "every `monitoredAt` in the
   catchment, 102 of them" (there are **107** asserted links; 5 are silently dropped for want of
   geometry) and the `#/why` stat label "91 outlets the register names a sampling point for" (it names
   one for **96**). Both are the *exact* sin the page exists to condemn: **letting the presence of
   geometry decide what exists.** The same bug appears a third time in the `app.js` regulated lede.
3. **The single most damaging fact is omitted**: `ttl/regulation/README.md` already knows that with the
   register's *outlet-level* grid reference — which the register publishes and this store chooses not
   to use — proximity scores **53/69 (77%)**, not 46%. `points.html` never mentions this.

---

## 1. Findings table

| SCREEN / FILE + LINE | CLAIM | VERDICT | EVIDENCE | WHAT THE HUMAN MUST DECIDE |
|---|---|---|---|---|
| **METHOD** `points.js:171-177` `dist()` | Pythagoras on EPSG:27700 easting/northing is true ground distance | **CONFIRMED** | Code uses `a.en`/`b.en` (BNG metres), not the reprojected `ll`. Verified every geometry in play is BNG: 161/161 sampling points, 95/95 mapped outlets, 11/11 action sites carry `<…/EPSG/0/27700>`. **The haversine fallback is never reached.** BNG scale distortion (≤0.04%) ⇒ ≤0.4 m error at 1 km — immaterial at every distance on the page. | Nothing. This is right. |
| **METHOD** `points.js:156-168` `parseWkt()` | — | **METHODOLOGICALLY QUESTIONABLE** (latent) | The store emits `"POINT(389960 93366) <http://…/EPSG/0/27700>"` — geometry **first**. Standard GeoSPARQL puts the CRS URI **first**. `parseWkt` does `wkt.slice(0, wkt.indexOf("<"))`, so if the store were ever corrected to the standard ordering, `slice(0,0) === ""` ⇒ `nums = []` ⇒ every distance becomes `NaN`. The non-BNG branch is worse: it regexes the *whole* literal, so a WGS84 point carrying its CRS URI would parse `0` and `4326` as coordinates. | Whether to harden `parseWkt` (strip the `<…>` regardless of position). Currently unexercised — the bug is latent, and would break *visibly* (NaN), not silently. |
| **METHOD** `points.js:202-210` `nearestSp()` over all 161 points | The candidate set must be the whole layer, because "you can only restrict it to the outfalls if you already know which points those are" | **CONFIRMED but UNDERSTATED** | The rebuttal is logically sound (it is the same circularity that defeats any oracle-filter defence). **But the page leaves its best argument unmade.** I ran the counterfactual it declines to run: hand proximity the oracle — restrict the layer to the **70** points that *do* monitor a discharge — and it still only scores **47/91 (52%)**. Grant it the *achievable* (non-circular) filter instead — `water:samplingPointType`, which is published — and my effluent/discharge-type filter (35 points) makes it **worse: 29/91 (32%)**. | Whether to add one line: *"Even if you cheat and hand the join only the 70 real outfall points, it still gets 47 of 91."* This converts a circularity argument (which a reviewer can dislike) into an empirical one (which he cannot). |
| **`#/why`** `points.js:512` | proximity **42 / 91** (46%) | **CONFIRMED** | Re-derived independently: **42/91 = 46%**. Denominator = mapped outlets for which `monitoredAt` names a sampling point. Cross-checks against `ttl/regulation/README.md:105` ("42/91"). | Nothing. |
| **`#/why`** `points.js:511` | "**91** outlets the register names a sampling point for" | **WRONG** | The register names a sampling point for **96** outlets, not 91. `SELECT (COUNT(*)) WHERE { ?p a water:WaterDischargePermit ; reg:permitSite ?dp . ?dp water:monitoredAt ?sp }` → **96**. 91 is the count of those that *also have a coordinate*. The label states an identifier-fact but reports a geometry-filtered count. | Reword to *"91 of the 96 outlets the register names a sampling point for — the other 5 have no coordinate to measure from"*. The 42/91 headline is unaffected; only the label is wrong. Note this **flatters proximity**: on all 96 it is 42/96 (44%). |
| **`#/why`** `points.js:513` | `water:monitoredAt` gets right **91 / 91 (100%)** | **METHODOLOGICALLY QUESTIONABLE — tautology** | `truth = c.monOf[dpIri]`, and `c.monOf` **is** `water:monitoredAt` (`points.js:224`). The metric is scored against itself; it cannot return anything but 100%. See §2 — this is the report's central methodological finding. | Whether to keep the tile. See §2 for the honest framing. |
| **`#/why`** `points.js:520-522` | 161 points, 70 monitor a discharge, 91 ambient; nearest is a non-outfall for **8** outlets | **CONFIRMED** | Re-derived: 161 / 70 / 91 / 8. | Nothing. |
| **`#/why`** `points.js:524-526` | **83** of the **95** mapped outlets share a coordinate; all 95 fit on **37** points | **CONFIRMED** | Re-derived: 83 / 95 / 37. Matches `ttl/regulation/README.md:127`. | Nothing. |
| **`#/why`** `points.js:531-532` | **7** of the **102** outlets have no coordinate | **CONFIRMED** | `reg:permitSite` → 102; with geometry → 95; without → 7. | Nothing. |
| **`#/blackheath`** `points.js:295-297` + rendered | Nearest is `SW-50951085` (SHERFORD AT SNAILS BRIDGE US BLACKHEATH), **19 m** | **CONFIRMED** | Outlet BNG (389950, 93350); SP (389960, 93366) ⇒ **18.9 m** → renders "19 m". | Nothing. |
| **`#/blackheath`** rendered | The works' own points are **188 / 201 m** away | **CONFIRMED** | `SW-50951082` (BLACKHEATH STORM OVERFLOW) **187.9 m**; `SW-50951080` (BLACKHEATH STW) **201.2 m**. | Nothing. |
| **`#/blackheath`** rendered | Proximity **0 / 5** | **CONFIRMED** | All 5 mapped outlets of 042451 share one coordinate; all 5 miss. | Nothing. |
| **`#/blackheath`** `points.js:688-690` | `SW-50951085` "is a **FRESHWATER - RIVERS**… monitors no discharge at all" | **CONFIRMED** (with a cosmetic defect) | `samplingPointType` = `FRESHWATER - RIVERS`; zero `monitoredAt` triples point at it. **But** the sentence renders as *"is a FRESHWATER - RIVERS"* — the raw type code dropped into an English article. | Cosmetic: humanise the type string. |
| **`#/blackheath`** `points.js:693-694` | "'US' in its name is **upstream**" | **ASSERTED-NOT-VERIFIED** (well corroborated) | The store holds **no watercourse, flow-direction or river-network data** — I checked. "US" is an EA WIMS naming convention, so the page is *repeating the EA's own assertion*, not deriving it. Corroboration: the other two Sherford stations lie **east** — `SW-50958888` (394000, 92100) and `SW-50951010` KING BRIDGE (395449, 92386) — and the Dorset Sherford runs east/south-east to Poole Harbour, so a station at 389960 E being upstream is consistent. There is **no `DS BLACKHEATH` station** to triangulate against. | Whether to soften to *"'US' is the EA's own abbreviation for upstream"* — attributing the claim rather than asserting it. |
| **`#/blackheath`** `points.js:296-297` | "…the **single place in the catchment** guaranteed to carry none of its effluent" | **WRONG (as literal English) / rhetorical overreach** | There are **91** points in the layer that carry none of this works' effluent (boreholes, bathing waters, other rivers). The intended meaning — *the nearest place, and one guaranteed unaffected* — is defensible; the sentence as written is not. | Reword to *"the one place next door guaranteed to carry none of its effluent"*. Same force, survives a reviewer. |
| **`#/blackheath`** (unstated) | The 19 m is measured from the outlet's coordinate | **METHODOLOGICALLY QUESTIONABLE — unstated** | That coordinate is the **site** grid ref shared by all 5 outlets, not the outfall. So "the river station is 19 m from the outlet" is really "19 m from the site centroid". This **strengthens** the page's thesis (the coordinate is not the thing) but the page never says it, leaving a reviewer to say it first. | Whether to pre-empt it in one clause. |
| **`#/brockhill`** `points.js:301-304` + rendered | 7 outlets, 4 permits (`043244`/`043245`/`401057`/`401058`), one coordinate `POINT(383690 92820)`, 4 distinct sampling points **120–265 m** away, proximity **1/7** | **CONFIRMED** — every element | Stack `BNG:383690.0 92820.0` holds exactly 7 outlets across exactly those 4 permits. The 4 named SPs sit at **120.8 / 130.4 / 161.6 / 264.8 m**. Proximity picks `SW-50430126` (120.8 m) for all 7; exactly **1** (`401058/o2/e1`) is right. | Nothing. |
| **`#/brockhill`** `points.js:736` | "the one it gets right, it gets right **by luck**" | **CONFIRMED as a fair characterisation** | Not merely rhetoric: all 7 outlets present a *byte-identical* input to the join, so its output carries **zero** discriminating information about which outlet it is answering for. A hit under those conditions is definitionally not attributable to the method. Defensible. | Nothing. |
| **`#/brockhill`** hero vs board | Hero scoreline says **0 / 2**; board says **1 of 7** | **CONFIRMED but confusing** | Both correct: the hero scores permit 043245's own 2 outlets (both miss); the board scores the 7-outlet stack. Two different denominators, ~200 px apart, unlabelled. | Whether to label the hero *"permit 043245's own outlets"*. |
| **`#/doreys`** rendered | Nearest **is** the right point, at **1.01 km** | **CONFIRMED** | `SW-50590008` (DOREYS BALL CLAY WORKS EFFLUENT) at **1014.54 m**; it *is* the `monitoredAt` target. | Nothing. |
| **`#/doreys`** `points.js:766-776` radius-trap table | 250/500/1000/1100/1500 m → Doreys 0,0,0,1,1 · Brockhill 3,5,7,7,8 | **CONFIRMED** — exactly | Re-derived `withinRadius()` independently: identical in all 10 cells. | Nothing. |
| **`#/doreys`** `points.js:779-783` | "Under ~1.1 km Doreys matches nothing; at 1.1 km Brockhill's one dot has **7** candidates" | **CONFIRMED** | Doreys' first non-zero radius is **1015 m**. Brockhill reaches ≥1 candidate at **121 m** and >1 at **131 m**. So no radius exists that finds Doreys while leaving Brockhill unambiguous — the claim holds with a **7.7×** gap between the two thresholds. | Nothing. |
| **`#/doreys`** — the hostile version | Would the radius trap survive restricting the layer to real outfalls? | **CONFIRMED — it survives** | I re-ran the table against only the 70 outfall points: at 1100 m Doreys still gets its 1, and Brockhill still gets **4** equally-plausible candidates for one dot (down from 7, still ambiguous). **The Doreys argument is robust to the strongest form of the "restrict the layer" objection.** The page could say so and does not. | Whether to add the oracle-filtered column. It is the page's strongest table and it is missing. |
| **`#/unlocatable`** rendered | **7** outlets have no coordinate; a spatial join can attempt **0 of 7**; `monitoredAt` names a point for **5 of 7** | **CONFIRMED** | 7 no-geom outlets (permits 040070 ×2, 040091 ×2, 040096 ×2, 040137 ×1). 5 have a `monitoredAt`; 2 (`040070/o1/e2`, `040096/o1/e2`) have none. **"0 of 7" is correct and is *not* undermined by the 2 with no sampling point** — the claim is about what a *spatial join* can attempt, and it can attempt nothing without a coordinate, regardless of what else is known. The two claims are about different things and do not interfere. | Nothing. |
| **`#/unlocatable`** circles board | 91 known gaps · **1** within 5 m (1%) · **19** within 50 m (21%) · **87** within 500 m (96%) · **4** beyond 500 m · median **121 m** · max **1.01 km** · 500 m circle = **79 hectares** | **CONFIRMED** — every number | Re-derived: 1/91, 19/91, 87/91, 4 beyond. Median `gaps[45]` = **120.83 m** → "121 m" (n=91 is odd, so the JS index *is* the true median — see caveat). Max **1014.54 m**. π·500²/10⁴ = **78.54 → 79 ha**. ✓ | Nothing. |
| **`#/unlocatable`** `points.js:976` median | `gaps[Math.floor(gaps.length / 2)]` | **CONFIRMED (correct today, fragile)** | Right only because n=91 is odd. At an even n it silently returns the upper of the two central values, not their mean. | Trivial; note only. |
| **`#/unlocatable`** the "1 within 5 m" | — | **CONFIRMED (worth a footnote)** | The single outlet within 5 m is at **0.00 m** — `040111/o1/e1` sits *exactly* on `SW-50900956`. `ttl/regulation/README.md:112` already explains this is genuine source agreement, not fabrication. So "1 within 5 m" is really "1 at zero, and nothing else under 5 m" — *stronger* than the page claims. | Optional: say so. |
| **`#/explorer`** `points.js:1132-1134` | "every `reg:targetPermit` and every `water:monitoredAt` in the catchment, **102** of them" | **WRONG** | The graph holds **96** `water:monitoredAt` + **11** `reg:targetPermit` = **107** asserted links. The page renders **102** because `c.legs` is built only from outlets *that have geometry* (`points.js:246`), so the **5** `monitoredAt` links belonging to unlocatable outlets produce no leg and are never counted. The sentence says *"every … in the catchment"*. It is not every one. **This is the page's own thesis failing inside the page**: geometry has silently decided what exists — and it did so on the very screen that counts the assertions. | Two options: (a) count the assertions (107) and say "102 of them can be drawn"; or (b) reword to "every **drawable** link". **(a) is the one the argument deserves** — "107 asserted, 102 drawable, and the 5 you cannot draw are exactly the ones a spatial pipeline would have lost entirely." |
| **`#/explorer`** `points.js:420` (comment) | "111 bold lines would be a ball of wool" | **STALE** | Comment only, not rendered. True count is 102 drawn / 107 asserted. | Cosmetic. |
| **`#/explorer`** `points.js:238-243` | The WINEP leg is drawn to the permit's primary outlet — "a drawing convention, not a claim" | **CONFIRMED, and currently harmless — but the disclaimer is only in a code comment** | **Verified no leg is ever drawn between two discharge points**: `mon` legs run dp→sp, `winep` legs run action-site→anchor-dp (`points.js:246-259`). Neither has both endpoints in `c.dp`. ✓ **And the anchor choice is currently immaterial**: I checked all 11 actions across 8 permits — *every* permit carrying a WINEP action has exactly **1 distinct discharge coordinate** (all its outlets stack), and every one has an `outlet/1/effluent/1`. So the drawn distance is identical whichever outlet is picked (e.g. Blackheath 1351 m, range 1351–1351). **However**: the disclaimer lives in a `//` comment; the *rendered* legend says "`targetPermit` · WINEP → **permit**" while the line visibly terminates on an **outlet**, and the leg is labelled with a **distance** ("1.35 km") that the focus bar then describes as *"stated by an identifier"*. | Whether to surface the code comment's honesty into the UI. Also: the code is not robust to a future permit with 2 distinct outlet coordinates + an action — `dpIris[0]` would then silently pick one and print a distance with no referent. |
| **`app.js:1391-1397`** regulated lede | 61 permits · 58 with limits · 189 limits · 270 breaches · 1 current · 11 WINEP | **CONFIRMED** (all six) | Rendered live in Firefox. SPARQL: 61 `WaterDischargePermit`; 58 with `reg:hasCondition`; 270 `reg:ConditionBreach`; 11 `reg:Action` with a site. 189 = current-version conditions (587 across all versions — matches the status bar). 27 = `reg:proposesLimit` ✓. | Nothing. |
| **`app.js:1395-1396`** regulated lede | "the **95** outlets sit on just **37** distinct coordinates" | **NOT STALE (95/37 confirmed) — but the NOUN PHRASE IS WRONG** | It does **not** still say 100/42; the numbers are computed (`drawnDps = DB.dischargePoints.filter(d => d.lat != null)`) and render as **95** and **37**, both of which I confirmed. **But the denominator is wrong for the sentence it is in.** There are **102** outlets. "The 95 outlets" asserts that 95 is all of them. It is 95 of 102 — the 7 unlocatable outlets have been dropped by a `lat != null` filter and then written out of the prose. **This is the third instance of the same self-inflicted bug**, and it is the most visible one: it is on the front page of the main app, in a sentence whose *subject* is that you must not let a map decide what exists. | Reword to *"its **102** outlets sit on just **37** distinct coordinates — and 7 of them have no coordinate at all"*. Same rhetorical force, and it stops the app's own lede from committing the sin the linked page condemns. |
| **`app.js:1658`** | `coords` computed from reprojected `lat,lon` strings | **METHODOLOGICALLY QUESTIONABLE** (latent) | `points.js` buckets collisions on the **BNG** key (a fact about the source data); `app.js` buckets on the proj4-reprojected float pair stringified. Both give **37** today, so no live discrepancy — but the app's method makes a collision an artefact of float formatting rather than a fact about the register. `points.js:150-155` explicitly explains why it does *not* do this. | Whether to make `app.js` use the BNG key too, so the two pages cannot ever disagree. |
| **`app.js:1400-1405`** measured lede | **161** sampling points, **91** belong to no permit | **CONFIRMED** | 161 `sosa:FeatureOfInterest` with geometry; 91 with no `monitoredAt` inbound. Consistent with `#/why`'s "91 ambient" and `README.md:166-167`. | Nothing. |
| **INTERNAL CONSISTENCY** `README.md:208-212` | 42/91, 91/91, 19 m, 188–201 m, 0/5, 1/7, 1.01 km, 7 candidates, 7 outlets, 1 within 5 m, 21%, 4 beyond 500 m, 79 ha | **CONFIRMED — README matches the rendered page exactly** | Checked line by line against the headless render. No drift. | Nothing. |
| **INTERNAL CONSISTENCY** `ttl/regulation/README.md:140-145` | Proximity from `OUTLET_GRID_REF` scores **53 / 69 (77%)** | **CONFIRMED — and it CONTRADICTS the impression `points.html` gives** | See §2.1. This is the most important finding in the audit. | See §2.1. |
| **INTERNAL CONSISTENCY** `ttl/regulation/README.md:105` | "the catchment score was inflated from 42/91 to **47/96** by them" | **CONFIRMED** | Independently corroborates both my 96 (`monitoredAt` assertions) and my 42/91. The READMEs are accurate. | Nothing. |
| **INTERNAL CONSISTENCY** `ttl/regulation/README.md:106-108` | The old fabricated geometry made "a leg … look like a link between two discharge points" | **CONFIRMED FIXED — no recurrence** | Only one outlet (`040111/o1/e1`) still sits exactly on a sampling point, and **no other outlet is monitored there**, so no misleading leg is drawn. The bug does not recur. | Nothing. |

---

## 2. The methodological verdict — is `monitoredAt 91/91` a tautology?

**Yes. Read as a score, it is worthless, and it should not be displayed as one.**

`renderWhy` sets `truth = c.monOf[dpIri]`, and `c.monOf` is populated *directly from* `water:monitoredAt`
(`points.js:224`). The green tile therefore measures `monitoredAt` against `monitoredAt`. It is not 100%
accurate; it is 100% **identical**. No dataset, no error, and no amount of corruption in the register
could ever make that tile read anything but 100%. Placing it beside `42 / 91` in a matched pair of stat
tiles invites the reader to compare two accuracies, and only one of them is an accuracy.

**But the experiment underneath it is not a tautology, and the page's thesis survives intact.** The
honest reconstruction is:

> There is **no independent ground truth** here. Nobody has surveyed these outfalls. The register's
> `water:monitoredAt` is not a *measurement* of which sampling point belongs to an outlet — it is the
> *regulator's statement* of it, and it is the only such statement in existence. The real question the
> page is answering is therefore **not** "which method is more accurate?" but:
>
> **"If you throw the identifier away and try to reconstruct it from the map — as every spatial join
> silently does — how much of it do you get back?"**
>
> Answer: **42 of 91.** And *that* number is a genuine, falsifiable, adversarially-checkable result. It
> is the whole argument, and it does not need the green tile at all.

Framed that way, the comparison is legitimate and standard (it is exactly how you evaluate whether a
heuristic can recover an authoritative link). Framed as `46% vs 100%`, it is a rigged scoreboard, and it
is the first thing a hostile reviewer will reach for — **which is a shame, because the page does not
need it and is weaker for having it.**

Two further honesty points the page should own:

- The identifier could itself be **wrong** in the register, and nothing here would detect it. Neither
  method is validated against reality. The page's claim is not "`monitoredAt` is true" — it is
  "`monitoredAt` is *stated*, and proximity cannot recover what was stated". That is a claim about
  **recoverability**, not correctness, and the page occasionally slides between the two.
- The one thing `monitoredAt` demonstrably does that proximity cannot is **Example 4**: it still names a
  sampling point for 5 outlets that have no coordinate at all. That is not a tautology — it is a
  structural fact, and it is the page's strongest evidence. It is currently the *last* screen.

**Recommendation:** relabel the green tile `91 / 91 — by construction: this is what the register states`,
or delete it and lead with `42 of 91 recovered`. The argument gets *stronger*, not weaker.

### 2.1 The omission that matters most

`ttl/regulation/README.md:140-145` — the project's own documentation — contains this table:

| geometry hung on the discharge point | distinct coords | nearest-neighbour correct |
| --- | --- | --- |
| `DISCHARGE_NGR` — site (**what this store uses**) | 37 | **33 / 69** (48%) |
| `OUTLET_GRID_REF` — outlet | 60 | **53 / 69 (77%)** |
| `EFFLUENT_GRID_REF` — effluent | 66 | 53 / 69 (77%) |

The register publishes a grid reference at **three** levels. This store deliberately hangs the
**coarsest** one (the *site's*) on its **finest** feature (the *effluent*). That choice is *why*
7 outlets stack on one dot at Brockhill, and it is a large part of why proximity scores 46%.

**`points.html` never mentions this.** A reader finishes the page believing proximity is a ~46% method.
The project's own analysis says that with the outlet-level coordinate — which the EA publishes, and which
`regulation_to_db.py` could join on tomorrow — it is a **77%** method.

The store's justification (README:132-134) is good: *the site NGR is what the public register surfaces as
"the" discharge location, so the store reproduces what a consumer of that register actually gets.* That is
a real and defensible position. **But it is a defence, and it is not on the page it is defending.**

---

## 3. The strongest objections a hostile expert reviewer would raise

**① "Your 46% is a schema choice, not a fact about proximity. Use `OUTLET_GRID_REF` and it is 77%."**
- *The page's answer:* **none.** The page is silent.
- *The project's answer (README only):* the site NGR is what the public register actually surfaces, so
  the store reproduces what a real consumer gets; and even at best proximity tops out at ~77%, with the
  quarter it drops decided by a schema choice two levels above the feature being joined.
- *Does it hold?* **The defence holds; the silence does not.** This is the one finding that could
  genuinely embarrass the page in front of a GIS audience, and the fix is a single sentence with a link
  to the README table. Leaving your own strongest counter-evidence in a sub-README, unlinked from the
  page that needs it, reads as concealment even when it is merely tidiness. **Fix this first.**

**② "`monitoredAt 91/91` is scored against itself. Your scoreboard is rigged."**
- *The page's answer:* none — it presents the tile as a peer of the 42/91 tile.
- *Does it hold?* **The objection lands.** See §2. The page's *argument* survives completely; the
  *scoreboard* does not. Relabel or delete the tile.

**③ "Nobody does a nearest-feature join here. They'd match on the name."**
- *The page's answer:* none — it never considers name-matching.
- *The evidence:* the sampling-point labels **literally contain the site names**: `BROCKHILL WATERCRESS
  FARM B & C 1`, `DOREYS BALL CLAY WORKS EFFLUENT`, `BLACKHEATH STW BLOXWORTH WAREHAM`. A practitioner
  would fuzzy-match on those long before reaching for a spatial join. This is the biggest **strawman**
  risk on the page.
- *Does it hold?* **The objection is fair, and answering it makes the page stronger.** A name match *is*
  an identifier join — a weak, string-typed, unversioned one — so conceding it concedes the thesis. And
  it still fails where it matters: at Brockhill, `043244/o1/e1` and `401057/o1/e1` both name
  `SW-C7022000` and both sites are "Brockhill Watercress Farm A"; **no name match separates permit
  `043244` from `401057`.** Only the outlet-level identifier does. The page should say this. Right now
  its silence lets a reviewer frame the whole argument as a strawman.

**④ "A real GIS practitioner would restrict the layer to effluent points, or use a radius."**
- *The page's answer* (`points.js:698-701`): *"You cannot fix this by filtering the layer down to 'just
  the outfalls', because knowing which points are this permit's outfalls is precisely what the join was
  supposed to tell you."*
- *Does it hold?* **Yes — and the empirical answer is far stronger than the logical one the page gives.**
  I ran both:
  - Grant the oracle filter (only the 70 points that *do* monitor a discharge): proximity still scores
    only **47 / 91 (52%)**.
  - Grant the *achievable*, non-circular filter (`water:samplingPointType`, which is published and does
    not require knowing the answer): a reasonable "effluent/discharge type" cut gives **29 / 91 (32%)** —
    **worse**, because outlets are routinely monitored at points typed `AGRICULTURE - WATER CRESS
    FARMING`, and the practitioner has to *guess* which type codes count.
  - And the radius trap **survives the oracle filter**: at the 1100 m needed to find Doreys, Brockhill's
    single dot still has **4** equally-plausible outfall candidates.
  The circularity argument is sound but sounds like a debating move. **The numbers are not a debating
  move.** The page should lead with them.

**⑤ "Your own explorer drops 5 links because they have no geometry — the exact bug you wrote this page to condemn."**
- *The page's answer:* none. It says *"every `reg:targetPermit` and every `water:monitoredAt` in the
  catchment, 102 of them"*. There are **107**.
- *Does it hold?* **It lands, hard, and it is unanswerable as written.** The same error recurs in the
  `#/why` stat label ("91 outlets the register names a sampling point for" — it is 96) and in the
  `app.js` regulated lede ("the 95 outlets" — there are 102). Three instances of *geometry deciding what
  exists*, on the pages whose thesis is that geometry must not decide what exists. **A reviewer who finds
  one of these will find all three, and will use them to discredit the whole argument.** They are also
  the easiest fixes in this report, and fixing them turns the flaw into a flourish: *"107 asserted,
  102 drawable — and the 5 you cannot draw are precisely the 5 a spatial pipeline would have lost."*

**⑥ "'Upstream' is doing a lot of work, and you got it from a string."**
- *The page's answer:* *"'US' in its name is upstream."* — asserted flatly.
- *Does it hold?* **Partially.** The store contains **no flow-direction or river-network data**; "US" is
  an EA naming convention, so the page is repeating the EA's claim, not verifying it. It is well
  corroborated (the other two Sherford stations lie east, and the river runs east to Poole Harbour), and
  it is almost certainly true — but the page states it as a derived fact when it is a **borrowed
  assertion**. Attribute it (*"'US' is the EA's own abbreviation for upstream"*) and the objection
  evaporates at zero cost. Note the argument does **not depend** on it: the join returned a *river
  station that monitors no discharge*, which is already fatal. Upstream is the twist of the knife, not
  the knife.

**⑦ "Your headline 19 m is measured from a coordinate you spend the rest of the page saying is meaningless."**
- *The page's answer:* none (the point is made *around* this, never *about* it).
- *Does it hold?* **It is a genuine tension, and it resolves in the page's favour — but only if the page
  says so.** The 19 m is from the *site* grid ref shared by all five outlets, not from the outfall. So
  the true statement is stronger and stranger: *proximity's answer is 19 m from a coordinate that is not
  the outlet's location at all.* Left unstated, it looks like an oversight; stated, it is the thesis.

---

## 4. What I could not verify

- **River flow direction** (Blackheath, "upstream"). No flow, network or watercourse data in the store.
  **ASSERTED-NOT-VERIFIED**, corroborated but not derived.
- **Whether `water:monitoredAt` is itself correct.** There is no independent ground truth in or out of
  this store. The page's claim is about *recoverability*, not correctness — and where it slides toward
  the latter, it is over-claiming.
- **"By luck" (Brockhill).** A rhetorical characterisation — but a defensible one, since all 7 outlets
  are a byte-identical input and the join's output therefore carries no information about which one it is
  answering for.

---

## 5. Fix list, by value

1. **Explorer: 102 → 107 asserted / 102 drawable.** (`points.js:1115`, `:1132-1134`) — turns the page's
   worst self-inflicted wound into its best flourish.
2. **Regulated lede: "the 95 outlets" → "its 102 outlets … 7 with no coordinate at all".**
   (`app.js:1395-1396`, `:1666`) — same bug, most visible location.
3. **`#/why` stat label: "91 outlets the register names a sampling point for" → 96.** (`points.js:511`)
4. **Relabel or drop the `91 / 91 · 100%` tile.** (`points.js:513`) — see §2.
5. **Add the `OUTLET_GRID_REF` counterfactual (77%) to `#/why`,** linking `ttl/regulation/README.md`. — §2.1.
6. **Add the empirical rebuttals** to the "restrict the layer" objection: **47/91 with the oracle filter**;
   Brockhill still has **4** candidates at 1100 m. (`points.js:698-701`, `:766-776`)
7. **Attribute "US" to the EA**, and soften "the single place in the catchment". (`points.js:296`, `:693`)
8. **Address name-matching** in one paragraph — and show that it still cannot separate `043244` from
   `401057` at Brockhill.
9. Minor: humanise `"is a FRESHWATER - RIVERS"`; label the Brockhill hero's 0/2 denominator; stale
   comment `points.js:420` ("111"); harden `parseWkt` against standard CRS-first WKT; make `app.js`
   bucket collisions on the BNG key, not reprojected floats.
