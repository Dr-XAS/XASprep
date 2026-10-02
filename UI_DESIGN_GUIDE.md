# EasyXASCalc UI and viewer guide

EasyXASCalc is a compact sample-preparation workbench. Its interface follows the
`drxas-ui-design` and `drxas-scientific-viewers` packages from
`DrXAS_skills/skills/web-app/`.

## Implementation

- `frontend/src/App.jsx` owns sample composition, pellet geometry, measurement
  edges, API requests, calculation snapshots and the persisted light/dark choice.
- `frontend/src/lib/calculation.js` validates finite positive inputs and converts
  mg or mg/cm² to the backend's g/cm². Pellet area is π(diameter_mm / 20)² cm².
  Blank fields remain blank. Switching modes preserves loading without rounding.
- `frontend/src/components/AbsorptionViewer.jsx` adapts the reference panel,
  display controls and plot-height interaction to this app's attenuation data.
- `frontend/src/lib/absorption-viewer.js` clones Plotly payloads at the host
  boundary. Plotly may mutate the clone; the saved calculation remains intact.
- `frontend/src/design-system/` contains the bundled tokens, Figtree fonts,
  licenses, theme helper and source/local adaptation provenance.

## Visual rules

The application has one `.drx-ui` root with `data-drx-theme="light|dark"` and
`data-drx-density="compact"`. Import tokens before component CSS. Use semantic
`--drx-*` variables; existing aliases map to these tokens. Figtree is self-hosted
and used for page and plot text. Keep its OFL license with the font files.

The desktop layout has a 350 px configuration rail and a flexible results column.
Below 850 px they stack. Controls start at 32 px with 8 px related gaps and
12 px panel insets; coarse-pointer controls grow to 44 px. Use visible labels,
units, keyboard focus, thin panel borders and wrapping controls. Magma is reserved
for the main calculation action and interaction accents. Scientific traces retain
their categorical identity and line styles; dark marks may be lightened for contrast.

## Scientific and interaction boundaries

The backend remains the scientific authority. This is an energy-domain
attenuation/transmission viewer, not an Athena processing integration. It does
not expose k/R/q transformations, wavelets, structures, FEFF paths or fitting.
Backend arrays, encoded arrays, axis bindings, edge energies and numerical metrics
are preserved. Energy is in eV, absorption is dimensionless, transmission is %,
and edge-finder limits are in keV.

The default sample calculates on mount. Subsequent input edits require Calculate.
Every displayed result retains its original formula/geometry context; changed
scientific inputs show a stale-result notice. An in-flight or failed request keeps
previous results explicitly labelled. Cancelled requests cannot restore cleared
results or overwrite newer requests. Individual edge errors remain visible.

Theme, legend, height and collapse are view settings and do not call the API.
Plot zoom and legend trace visibility survive presentation changes through a
stable calculation/view revision. Reset zoom explicitly restores calculated
ranges. Collapse keeps the viewer mounted. PNG export captures the current plot.

Existing warning thresholds remain: edge jump below 0.3 or above 3.5, or maximum
absorption above 4. Missing metrics display “Not provided”. These UI thresholds
are guidance, not a new scientific acceptance criterion.

## Verification

Run `npm run lint` and `npm run build` in `frontend/`, start the Flask server and
check `/healthz`. Exercise calculations with known fixtures, both input modes,
validation, auto-edge discovery, per-edge errors, stale results, dark/light themes,
plot zoom/legend/resize/collapse, keyboard focus and a 390 px viewport. Compare
numeric outputs with the unchanged backend; a plausible plot is not validation.

Full skill and upstream commit provenance is recorded in
`frontend/src/design-system/integration-provenance.json` and source comments in
the host viewer. The reference snapshot is not an installed viewer library.
