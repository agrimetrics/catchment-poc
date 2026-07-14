# SFI TODO — Farmscoper pollutant impact

The SFI concept scheme now carries FARMSCOPER-modelled pollutant impact rates (see the README).
Two source questions remain open, and the store deliberately declines to answer either.

## 1. Validate what `Kg … Ha-1 Yr-1` actually means

**This is the load-bearing assumption of the whole impact model and it is currently unverified.**
We read the column headers literally — "kilograms of pollutant, per hectare, per year" — and the
graph acts on that reading in two places:

- the concept's rate is emitted with `qudt:unit unit:KiloGM-PER-HA-YR`, and
- the option's applied impact is computed as **summed option area (ha) × rate → kg/yr**
  (`unit:KiloGM-PER-YR`), then summed to the application.

If the reading is wrong, **every applied figure in the graph is wrong by whatever the real
denominator is** — the concept rates would survive (they are verbatim from source) but the
`defra-farming:annualPollutantImpact` quantities on 272 options and 160 applications would not.

Specifically, confirm with whoever produced the workbook:

- **Per hectare of _what_?** Of land the treatment is *applied to* (which is what we assume, and what
  makes `area × rate` valid), or per hectare of the *whole farm/holding* modelled by FARMSCOPER, or
  per hectare of some modelled baseline farm type? FARMSCOPER models a whole farm system, so a
  per-farm-hectare denominator is entirely plausible — and would make our multiplication by the
  option's own mapped area a category error.
- **A reduction in loss, or a reduction in load delivered to water?** Losses at the field edge and
  loads reaching a waterbody are not the same number, and only the latter is comparable to the
  observations at a sampling point.
- **Is the `Yr-1` a real annualisation** or an artefact of a multi-year model run divided through?
- **Does a negative value mean "reduction"** in every column? We assume yes throughout.

Until answered, treat `annualPollutantImpact` as indicative of relative scale and ranking, not as a
payable/reportable kg figure.

## 2. What is the `Kg Z Ha-1 Yr-1` column?

**Dropped from the graph. It is not zinc, and we do not know what it is.**

We originally bound it to substance `6455` (Zinc) because that is what the header says. It is not:

- **Magnitude.** Rates reach **−1,651 kg/ha/yr**; the catchment total came to **−4,407 tonnes/yr**.
  A hectare of topsoil holds on the order of **150–250 kg** of zinc *in total*, so each action would
  be removing several times the soil's entire zinc stock, every year.
- **Ratio.** The column tracks the phosphorus column at a near-constant **~870:1** (range 528–1085)
  across all twelve valued treatments. That is the **sediment**-to-particulate-P relationship (soil P
  is ~0.1% of sediment by mass). Zinc, at ~60–100 mg/kg of soil, would give a ratio nearer **0.06:1**
  — four orders of magnitude out.
- **Provenance.** FARMSCOPER's pollutant set is nitrate, phosphorus, **sediment**, ammonia, nitrous
  oxide, methane, pesticides and FIOs. It does not model zinc.

The overwhelmingly likely reading is that `Kg Z` is FARMSCOPER's **sediment** output under a wrong or
mis-abbreviated header. But "overwhelmingly likely" is not "confirmed", and the store is in the
business of stating things it knows — so the column is simply absent rather than present-and-wrong.

**To close:** confirm the column's identity against the workbook's provenance. If it is sediment,
add a sediment substance concept (the water-quality substance vocabulary has no sediment
determinand today — a suspended-solids determinand may be the closest monitored analogue, which is
its own mapping question) and re-add the column to `IMPACT_COLUMNS` in `sfi_to_db.py`. The fix is a
**rebind, not a rescale** — the numbers are not wrong, the label is.

## 3. Nitrate vs total nitrogen

Lower stakes, but not nothing. The source column is `Kg Nitrate Ha-1 Yr-1`; the store's substance
vocabulary has **no nitrate concept**, so the figure binds to `9686` "Nitrogen, Total as N". The
units are consistent (FARMSCOPER reports nitrate loss as kg of N), but the bound concept is *total*
nitrogen while the source figure is a *nitrate* loss. They are not the same measurand, and a query
that compares this impact against total-N observations at a sampling point is quietly comparing a
part to a whole. Either add a nitrate determinand to the substance scheme and rebind, or record the
part/whole relationship (e.g. `skos:broader`) so the gap is visible in the graph rather than only
here.
