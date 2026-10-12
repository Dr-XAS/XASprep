import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, AlertTriangle, ChevronDown, Download, RotateCcw } from 'lucide-react';
import { BlockMath } from 'react-katex';
import { absorptionWarnings, createAbsorptionPlot, formatMetric } from '../lib/absorption-viewer';
import { plotlyThemePatch, readPlotTheme } from '../design-system/plot-theme.mjs';
import 'katex/dist/katex.min.css';
import './AbsorptionViewer.css';

const Plot = lazy(() => import('react-plotly.js'));
const DEFAULT_HEIGHT = 380;
const MIN_HEIGHT = 280;
const MAX_HEIGHT = 800;

// Adapted from ViewerPanel, ViewerDisplayControls and ResizablePlotCard in
// xraylarch-web 5abaf8c784cd5f056ab783f9556d35a0937b7056. Host-owned controls
// intentionally expose only the attenuation data provided by XASprep.
export default function AbsorptionViewer({ result, theme = 'light', revision }) {
  const id = useId();
  const plotRef = useRef(null);
  const dragRef = useRef(null);
  const [collapsed, setCollapsed] = useState(false);
  const [showLegend, setShowLegend] = useState(true);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [viewRevision, setViewRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [viewerError, setViewerError] = useState('');
  const [plotReady, setPlotReady] = useState(false);
  const warnings = absorptionWarnings(result);
  const title = `${result.element} ${result.edge} edge`;
  const plot = useMemo(() => createAbsorptionPlot(result.plot, {
    theme, height, showLegend, sourceRevision: revision, viewRevision,
  }), [result.plot, theme, height, showLegend, revision, viewRevision]);

  useEffect(() => {
    if (!plotReady || !plotRef.current) return;
    let cancelled = false;
    const graphDiv = plotRef.current;
    const root = graphDiv.closest('.drx-ui');
    if (!root) return;
    // Resolve the host's actual CSS values and extend the shared theme bridge
    // to the transmission axis. A relayout patch leaves zoom and data intact.
    const colors = readPlotTheme(root);
    const patch = Object.fromEntries(Object.entries(plotlyThemePatch(colors)).filter(([key]) => !key.startsWith('scene.')));
    for (const [key, value] of Object.entries(patch)) {
      if (key.startsWith('yaxis.')) patch[key.replace('yaxis.', 'yaxis2.')] = value;
    }
    import('plotly.js/dist/plotly').then(({ default: Plotly }) => {
      if (!cancelled) return Plotly.relayout(graphDiv, patch);
    }).catch(() => { /* The concrete theme in the host adapter remains readable. */ });
    return () => { cancelled = true; };
  }, [theme, plotReady]);

  function toggleCollapsed() {
    setCollapsed(value => !value);
    if (collapsed) requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function resize(next) {
    setHeight(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(next))));
  }

  function beginResize(event) {
    if (event.button !== 0 || event.isPrimary === false) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: event.pointerId, y: event.clientY, height };
  }

  function keyboardResize(event) {
    const step = event.shiftKey ? 48 : 16;
    const next = { ArrowUp: height - step, ArrowDown: height + step, Home: MIN_HEIGHT, End: MAX_HEIGHT, Enter: DEFAULT_HEIGHT, ' ': DEFAULT_HEIGHT }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    resize(next);
  }

  async function downloadImage() {
    if (!plotRef.current) return;
    setExporting(true);
    setViewerError('');
    try {
      const { default: Plotly } = await import('plotly.js/dist/plotly');
      await Plotly.downloadImage(plotRef.current, {
        format: 'png', filename: `xasprep-${result.element}-${result.edge}-absorption`, scale: 2,
      });
    } catch {
      setViewerError('The plot image could not be downloaded. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="absorption-viewer" aria-label={`${title} calculation result`} data-collapsed={collapsed}>
      <header className="absorption-viewer-heading">
        <h3>
          <button type="button" className="absorption-viewer-toggle" aria-expanded={!collapsed} aria-controls={id} aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${title}`} onClick={toggleCollapsed}>
            <ChevronDown size={15} className="absorption-viewer-chevron" aria-hidden="true" />
            <Activity size={18} aria-hidden="true" />
            <span>{title}</span>
          </button>
        </h3>
        <span className="absorption-edge-energy">{formatMetric(result.edge_value, 1)}{Number.isFinite(result.edge_value) ? ' eV' : ''}</span>
      </header>

      <div id={id} className="absorption-viewer-body" hidden={collapsed}>
        {result.error ? <div className="absorption-viewer-error" role="alert">{result.error}</div> : <>
          <div className="absorption-summary">
            <dl className="absorption-metrics">
              <div className={warnings.edgeJump ? 'absorption-metric is-warning' : 'absorption-metric'} title="Target edge jump: about 1.0. Warning below 0.3 or above 3.5.">
                <dt>Edge jump {warnings.edgeJump && <AlertTriangle size={12} aria-label="Outside suggested range" />}</dt>
                <dd>{formatMetric(result.edge_jump)}</dd>
              </div>
              <div className={warnings.maxAbsorption ? 'absorption-metric is-warning' : 'absorption-metric'} title="Total absorption should ideally stay below 4.0.">
                <dt>Max absorption {warnings.maxAbsorption && <AlertTriangle size={12} aria-label="Above suggested maximum" />}</dt>
                <dd>{formatMetric(result.abs_max)}</dd>
              </div>
            </dl>
            {result.compound_latex && <div className="absorption-composition"><BlockMath>{result.compound_latex.replace(/\$\$/g, '')}</BlockMath></div>}
          </div>

          {plot ? <>
            <div className="absorption-plot" id={`${id}-plot`} style={{ height }} aria-label={`Calculated absorption and transmission near the ${title}`}>
              <Suspense fallback={<div className="absorption-plot-placeholder" role="status">Loading plot…</div>}>
                <Plot
                  data={plot.data}
                  layout={plot.layout}
                  config={{ responsive: true, displaylogo: false, scrollZoom: false, modeBarButtonsToRemove: ['sendChartToCloud'], toImageButtonOptions: { format: 'png', filename: `xasprep-${result.element}-${result.edge}-absorption`, scale: 2 } }}
                  useResizeHandler
                  onInitialized={(_figure, graphDiv) => { plotRef.current = graphDiv; setPlotReady(true); }}
                  onUpdate={(_figure, graphDiv) => { plotRef.current = graphDiv; }}
                  onError={() => setViewerError('The plot could not be displayed. Calculation metrics are still available above.')}
                  style={{ width: '100%', height: '100%' }}
                />
              </Suspense>
            </div>

            <div className="absorption-display-controls" role="group" aria-label={`${title} display controls`}>
              <label className="absorption-legend-toggle"><input type="checkbox" checked={showLegend} onChange={event => setShowLegend(event.target.checked)} />Legend</label>
              <label className="absorption-height-field">Height
                <select value={height} onChange={event => resize(Number(event.target.value))} aria-label={`${title} plot height`}>
                  {[...new Set([280, DEFAULT_HEIGHT, 520, 680, height])].sort((a, b) => a - b).map(value => <option key={value} value={value}>{value} px</option>)}
                </select>
              </label>
              <div className="absorption-view-actions">
                <button type="button" onClick={() => setViewRevision(value => value + 1)} title="Restore the calculated energy and absorption ranges"><RotateCcw size={13} />Reset zoom</button>
                <button type="button" onClick={downloadImage} disabled={exporting || !plotReady} title="Download the current plot as a PNG image"><Download size={13} />{exporting ? 'Exporting…' : 'PNG'}</button>
              </div>
            </div>

            <div className="absorption-plot-resizer" role="separator" tabIndex={0} aria-label={`Resize ${title} plot height`} aria-controls={`${id}-plot`} aria-orientation="horizontal" aria-valuemin={MIN_HEIGHT} aria-valuemax={MAX_HEIGHT} aria-valuenow={height} aria-valuetext={`${height} pixels`}
              title="Drag to resize. Up/Down arrows adjust height; Enter or double-click restores the default."
              onPointerDown={beginResize}
              onPointerMove={event => { if (dragRef.current?.id === event.pointerId) resize(dragRef.current.height + event.clientY - dragRef.current.y); }}
              onPointerUp={() => { dragRef.current = null; }}
              onPointerCancel={() => { if (dragRef.current) resize(dragRef.current.height); dragRef.current = null; }}
              onLostPointerCapture={() => { dragRef.current = null; }}
              onKeyDown={keyboardResize}
              onDoubleClick={() => resize(DEFAULT_HEIGHT)}><span aria-hidden="true" /></div>
          </> : <div className="absorption-viewer-error" role="status">Plot data not provided. Available calculation metrics are shown above.</div>}

          {viewerError && <p className="absorption-viewer-error" role="alert">{viewerError}</p>}
          <div className="absorption-scientific-note">
            <span>Calculated with xraylib · Energy in eV</span>
            {(warnings.edgeJump || warnings.maxAbsorption) && <span className="absorption-warning-note"><AlertTriangle size={12} />{warnings.edgeJump ? 'Edge jump outside 0.3–3.5.' : ''} {warnings.maxAbsorption ? 'Max absorption exceeds 4.' : ''}</span>}
          </div>
        </>}
      </div>
    </section>
  );
}
