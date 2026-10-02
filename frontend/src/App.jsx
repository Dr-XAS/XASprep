import { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Plus, Trash2, Calculator, Layers, Activity, ThumbsUp, Github, Twitter, Mail, Moon, Sun, ArrowRight, SlidersHorizontal, AlertCircle, RotateCcw } from 'lucide-react';
import AbsorptionViewer from './components/AbsorptionViewer';
import { prepareCalculation, convertComponents } from './lib/calculation';
import { trackEvent } from './analytics';
import logo from './assets/logo/drxas_logo_small.png';
import './App.css';

// The workstation serves HTTP; IDs must also work outside secure contexts.
const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const initialComponents = () => [
  { id: uid(), compound: 'LiNi0.5Mn0.25Co0.25O2', area_density: 60, mass: 5 },
  { id: uid(), compound: 'BN', area_density: 10, mass: 50 },
];
const initialEdges = () => ['Mn', 'Co', 'Ni'].map(element => ({ id: uid(), element, type: 'K' }));
const errorMessage = error => error.response?.data?.error || error.message || 'The calculation could not be completed. Please try again.';

function App() {
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('xasprep-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  const [calcMode, setCalcMode] = useState('pellet');
  const [pelletDiameter, setPelletDiameter] = useState(7);
  const [components, setComponents] = useState(initialComponents);
  const [edges, setEdges] = useState(initialEdges);
  const [autoEdgeMin, setAutoEdgeMin] = useState(4);
  const [autoEdgeMax, setAutoEdgeMax] = useState(30);
  const [elementsList, setElementsList] = useState([]);
  const [elementsError, setElementsError] = useState(false);
  const [isAutoFetching, setIsAutoFetching] = useState(false);
  const [edgeNotice, setEdgeNotice] = useState(null);
  const [isCalculating, setIsCalculating] = useState(false);
  const [calculation, setCalculation] = useState(null);
  const [error, setError] = useState(null);
  const [invalidField, setInvalidField] = useState(null);
  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(null);
  const [likeBusy, setLikeBusy] = useState(false);
  const [likeError, setLikeError] = useState(null);
  const calculationRequest = useRef(null);
  const edgeRequest = useRef(null);
  const revision = useRef(0);
  const prepared = prepareCalculation({ components, edges, calcMode, pelletDiameter });
  const inputKey = JSON.stringify(prepared.payload || null);
  const stale = calculation && calculation.inputKey !== inputKey;
  const results = calculation?.results || [];
  const successfulResults = results.filter(result => !result.error).length;

  useEffect(() => {
    try { localStorage.setItem('xasprep-theme', theme); } catch { /* Theme remains usable without storage. */ }
    document.documentElement.style.colorScheme = theme;
  }, [theme]);

  const loadElements = () => {
    setElementsError(false);
    axios.get('/api/elements').then(response => setElementsList(response.data)).catch(() => setElementsError(true));
  };
  useEffect(() => {
    loadElements();
    axios.get('/api/likes').then(response => setLikeCount(response.data.count)).catch(() => setLikeError('Appreciation count unavailable.'));
  }, []);

  const cancelEdgeLookup = () => {
    edgeRequest.current?.abort();
    edgeRequest.current = null;
    setIsAutoFetching(false);
    setEdgeNotice(null);
  };
  const updateComponent = (id, field, value) => {
    cancelEdgeLookup();
    setComponents(previous => previous.map(component => component.id === id ? { ...component, [field]: value } : component));
    setError(null);
  };
  const updateEdge = (id, field, value) => {
    cancelEdgeLookup();
    setEdges(previous => previous.map(edge => edge.id === id ? { ...edge, [field]: value } : edge));
  };

  const handleModeSwitch = newMode => {
    if (newMode === calcMode) return;
    const converted = convertComponents(components, newMode, pelletDiameter);
    if (converted.error) { setError(converted.error); return; }
    setComponents(converted.components);
    setCalcMode(newMode);
    setError(null);
  };

  const handleCalculate = async () => {
    if (prepared.error) { setError(prepared.error); setInvalidField(prepared.field); return; }
    setInvalidField(null);
    calculationRequest.current?.abort();
    const controller = new AbortController();
    calculationRequest.current = controller;
    const requestRevision = ++revision.current;
    const context = components.map(component => component.compound.trim()).join(' + ');
    const modeLabel = calcMode === 'pellet' ? `${pelletDiameter} mm pellet` : 'Mass per area';
    setIsCalculating(true);
    setError(null);
    try {
      const response = await axios.post('/api/calculate', prepared.payload, { signal: controller.signal });
      if (controller.signal.aborted || calculationRequest.current !== controller) return;
      if (response.data.error) throw new Error(response.data.error);
      if (!Array.isArray(response.data.results)) throw new Error('The server returned an invalid calculation response.');
      setCalculation({ results: response.data.results, inputKey, context, modeLabel, revision: requestRevision });
      trackEvent('calculate_absorption', { calculation_mode: calcMode, sample_count: components.length, edge_count: edges.length });
    } catch (failure) {
      if (!controller.signal.aborted) setError(errorMessage(failure));
    } finally {
      if (calculationRequest.current === controller) setIsCalculating(false);
    }
  };

  useEffect(() => {
    handleCalculate();
    return () => { calculationRequest.current?.abort(); edgeRequest.current?.abort(); };
    // Default example is calculated on mount; editing or changing display settings never calculates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAutoEdges = async () => {
    const min = Number(autoEdgeMin), max = Number(autoEdgeMax);
    if (autoEdgeMin === '' || autoEdgeMax === '' || !Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= min) {
      setEdgeNotice('Enter a positive energy range with the maximum above the minimum.');
      return;
    }
    if (!components[0]?.compound.trim()) { setEdgeNotice('Enter the first component’s formula to find its edges.'); return; }
    cancelEdgeLookup();
    const controller = new AbortController();
    edgeRequest.current = controller;
    setIsAutoFetching(true);
    try {
      const response = await axios.post('/api/auto_edges', {
        compound: components[0].compound, min_energy: min, max_energy: max,
      }, { signal: controller.signal });
      if (controller.signal.aborted || edgeRequest.current !== controller) return;
      if (response.data.edges?.length) {
        setEdges(response.data.edges.map(edge => ({ id: uid(), type: edge.type, element: edge.element })));
        setEdgeNotice(`Found ${response.data.edges.length} edges for ${components[0].compound}.`);
        trackEvent('auto_edges_found', { edge_count: response.data.edges.length, min_energy: min, max_energy: max });
      } else setEdgeNotice('No edges found in this range for the first component. Existing edges were kept.');
    } catch (failure) {
      if (!controller.signal.aborted) setEdgeNotice(`Edge lookup failed: ${errorMessage(failure)}`);
    } finally {
      if (edgeRequest.current === controller) setIsAutoFetching(false);
    }
  };

  const handleClear = () => {
    if (!window.confirm('Clear all sample components, measurement edges, and calculated results?')) return;
    calculationRequest.current?.abort();
    calculationRequest.current = null;
    cancelEdgeLookup();
    setComponents([]); setEdges([]); setCalculation(null); setIsCalculating(false); setError(null);
  };

  const handleLike = async () => {
    setLikeBusy(true); setLikeError(null);
    try {
      const action = liked ? 'unlike' : 'like';
      const response = await axios.post('/api/likes', { action });
      setLikeCount(response.data.count); setLiked(!liked);
      trackEvent(liked ? 'unlike_app' : 'like_app', { value: response.data.count });
    } catch { setLikeError('Could not update appreciation. Please try again.'); }
    finally { setLikeBusy(false); }
  };

  return (
    <div className="drx-ui app-container" data-drx-theme={theme} data-drx-density="compact">
      <a className="skip-link" href="#calculation-results">Skip to results</a>
      <header className="app-header">
        <a className="brand" href="https://dr-xas.org/" target="_blank" rel="noreferrer">
          <img className="brand-logo" src={logo} alt="Dr. XAS" />
          <div className="brand-copy"><span className="eyebrow">DR. XAS / SAMPLE PREPARATION</span><h1>EasyXASCalc</h1></div>
        </a>
        <div className="header-actions">
          <a className="secondary" href="https://github.com/Dr-XAS/XASprep" target="_blank" rel="noreferrer"><Github size={16} /> Source</a>
          <button className="theme-toggle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`} title={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}>
            {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
          </button>
        </div>
      </header>
      <main>
        <div className="workspace-intro"><div><h2>Plan your sample. See the absorption.</h2><p>Compare component contributions and transmission at your measurement edges.</p></div><span className="badge">X-ray attenuation calculator</span></div>
        <div className="workbench">
          <aside className="controls-panel" aria-label="Sample configuration">
            <div className="calculation-actions">
              {error && <div id="calculation-error" className="status-banner error" role="alert"><AlertCircle size={17} /><span>{error}</span></div>}
              <button className="primary calculate-button" onClick={handleCalculate} disabled={isCalculating} aria-describedby={error ? 'calculation-error' : undefined}><Calculator size={18} />{isCalculating ? 'Calculating absorption…' : 'Calculate absorption'}{!isCalculating && <ArrowRight size={17} />}</button>
            </div>
            <section className="panel" aria-labelledby="geometry-title">
              <div className="panel-heading"><div className="section-title"><span className="section-step">01</span><h2 id="geometry-title">Sample geometry</h2></div><SlidersHorizontal size={16} /></div>
              <div className="panel-body">
                <div className="segmented-control" aria-label="Calculation mode">
                  <button aria-pressed={calcMode === 'pellet'} onClick={() => handleModeSwitch('pellet')}>Pellet mass</button>
                  <button aria-pressed={calcMode === 'battery'} onClick={() => handleModeSwitch('battery')}>Mass per area</button>
                </div>
                <div className="diameter-row">
                  <div className="field"><label htmlFor="pellet-diameter">Pellet diameter (mm)</label><input id="pellet-diameter" type="number" min="0" step="any" value={pelletDiameter} onChange={event => { setPelletDiameter(event.target.value); setError(null); }} aria-invalid={!!error && invalidField === 'pellet-diameter'} aria-describedby={error && invalidField === 'pellet-diameter' ? 'diameter-error diameter-help' : 'diameter-help'} />{error && invalidField === 'pellet-diameter' && <span className="validation-error" id="diameter-error">{error}</span>}</div>
                  <div className="diameter-presets" aria-label="Diameter presets">{[7, 13].map(diameter => <button key={diameter} aria-pressed={Number(pelletDiameter) === diameter} onClick={() => setPelletDiameter(diameter)}>{diameter} mm</button>)}</div>
                </div>
                <p className="field-hint" id="diameter-help">{calcMode === 'pellet' ? 'Component mass is divided by the circular pellet area.' : 'Diameter is used only when converting back to pellet mass.'}</p>
              </div>
            </section>
            <section className="panel" aria-labelledby="sample-title">
              <div className="panel-heading"><div className="section-title"><span className="section-step">02</span><h2 id="sample-title">Sample composition</h2></div><Layers size={16} /></div>
              <div className="panel-body">
                <div className="sample-list">{components.map((component, index) => (
                  <div className="sample-row" key={component.id}>
                    <div className="sample-row-header"><span className="row-number">Component {String(index + 1).padStart(2, '0')}</span><button className="icon-button danger" aria-label={`Remove component ${index + 1}`} onClick={() => { cancelEdgeLookup(); setComponents(previous => previous.filter(item => item.id !== component.id)); }}><Trash2 size={14} /></button></div>
                    <div className="sample-fields">
                      <div className="field"><label htmlFor={`formula-${component.id}`}>Formula</label><input id={`formula-${component.id}`} type="text" spellCheck={false} value={component.compound} onChange={event => updateComponent(component.id, 'compound', event.target.value)} aria-invalid={!!error && invalidField === `formula-${component.id}`} aria-describedby={error && invalidField === `formula-${component.id}` ? `formula-error-${component.id}` : undefined} />{error && invalidField === `formula-${component.id}` && <span className="validation-error" id={`formula-error-${component.id}`}>{error}</span>}</div>
                      <div className="field"><label htmlFor={`amount-${component.id}`}>{calcMode === 'pellet' ? 'Mass (mg)' : 'Mass/area (mg/cm²)'}</label><input id={`amount-${component.id}`} type="number" min="0" step="any" value={calcMode === 'pellet' ? component.mass : component.area_density} onChange={event => updateComponent(component.id, calcMode === 'pellet' ? 'mass' : 'area_density', event.target.value)} aria-invalid={!!error && invalidField === `amount-${component.id}`} aria-describedby={error && invalidField === `amount-${component.id}` ? `amount-error-${component.id}` : undefined} />{error && invalidField === `amount-${component.id}` && <span className="validation-error" id={`amount-error-${component.id}`}>{error}</span>}</div>
                    </div>
                  </div>
                ))}</div>
                {!components.length && <p className="empty-state">Add a component to begin preparing your sample.</p>}
                <button className="secondary" onClick={() => { cancelEdgeLookup(); setComponents(previous => [...previous, { id: uid(), compound: 'Al', mass: 5, area_density: 10 }]); }}><Plus size={15} /> Add component</button>
              </div>
            </section>
            <section className="panel" aria-labelledby="edges-title">
              <div className="panel-heading"><div className="section-title"><span className="section-step">03</span><h2 id="edges-title">Measurement edges</h2></div><Activity size={16} /></div>
              <div className="panel-body">
                <div className="edge-range">
                  <div className="field"><label htmlFor="edge-min">From (keV)</label><input id="edge-min" type="number" min="0" step="any" value={autoEdgeMin} onChange={event => { cancelEdgeLookup(); setAutoEdgeMin(event.target.value); }} /></div>
                  <div className="field"><label htmlFor="edge-max">To (keV)</label><input id="edge-max" type="number" min="0" step="any" value={autoEdgeMax} onChange={event => { cancelEdgeLookup(); setAutoEdgeMax(event.target.value); }} /></div>
                  <button className="secondary" onClick={handleAutoEdges} disabled={isAutoFetching || !components.length}>{isAutoFetching ? 'Finding…' : 'Find edges'}</button>
                </div>
                <p className="field-hint">Find edges replaces this list using the first component.</p>
                {edgeNotice && <p className="status-banner info" role="status">{edgeNotice}</p>}
                {elementsError && <div className="status-banner warning" role="status">Element list unavailable. <button onClick={loadElements}>Retry</button></div>}
                <div className="edge-list">{edges.map((edge, index) => (
                  <div className="edge-row" key={edge.id}>
                    <div className="field"><label htmlFor={`element-${edge.id}`}>Element {index + 1}</label><select id={`element-${edge.id}`} value={edge.element} onChange={event => updateEdge(edge.id, 'element', event.target.value)}>{elementsList.length ? elementsList.map(element => <option key={element.symbol} value={element.symbol}>{element.symbol} · Z {element.atomic_number}</option>) : <option value={edge.element}>{edge.element}</option>}</select></div>
                    <div className="field"><label htmlFor={`shell-${edge.id}`}>Shell</label><select id={`shell-${edge.id}`} value={edge.type} onChange={event => updateEdge(edge.id, 'type', event.target.value)}>{['K', 'L1', 'L2', 'L3'].map(shell => <option key={shell}>{shell}</option>)}</select></div>
                    <button className="icon-button danger" aria-label={`Remove ${edge.element} ${edge.type} edge ${index + 1}`} onClick={() => { cancelEdgeLookup(); setEdges(previous => previous.filter(item => item.id !== edge.id)); }}><Trash2 size={14} /></button>
                  </div>
                ))}</div>
                {!edges.length && <p className="field-hint">Find edges or add an edge manually.</p>}
                <button className="secondary" onClick={() => { cancelEdgeLookup(); setEdges(previous => [...previous, { id: uid(), type: 'K', element: 'Co' }]); }}><Plus size={15} /> Add edge</button>
              </div>
            </section>
              <button className="clear-button" onClick={handleClear}><RotateCcw size={13} /> Clear configuration</button>

          </aside>
          <section id="calculation-results" className="results-panel" aria-labelledby="results-title" aria-busy={isCalculating} tabIndex={-1}>
            <div className="results-heading"><div><span className="eyebrow">CALCULATED SPECTRA</span><h2 id="results-title">Absorption & transmission</h2></div><span className="badge">{results.length ? `${successfulResults} / ${results.length} edges calculated` : 'No results yet'}</span></div>
            {calculation && <div className="results-context"><span>{calculation.context}</span><span>{calculation.modeLabel} · xraylib calculation</span></div>}
            <div aria-live="polite">
              {isCalculating && <div className="status-banner info">Calculating the requested edges…{calculation && ' Previous results remain visible below.'}</div>}
              {stale && <div className="status-banner warning"><AlertCircle size={17} /><span>Inputs have changed. These results use the previous configuration. Calculate again to update.</span></div>}
              {error && calculation && <div className="status-banner error">Calculation needs attention. Previous results are shown below.</div>}
            </div>
            {!results.length && !isCalculating && <div className="empty-state"><Activity size={32} /><h3>Your sample, at each edge</h3><p>Set the composition and measurement edges, then calculate absorption to see the predicted spectra.</p></div>}
            {results.map((result, index) => <AbsorptionViewer key={`${result.element}-${result.edge}-${index}`} result={result} theme={theme} revision={calculation.revision} />)}
          </section>
        </div>
      </main>
      <footer className="footer"><div className="footer-links"><span>Built by the <a href="https://dr-xas.org/" target="_blank" rel="noreferrer">Dr. XAS team</a></span><a href="https://x.com/drx_xas" target="_blank" rel="noreferrer" aria-label="Dr. XAS on X"><Twitter size={15} /></a><a href="mailto:dr.xas.drx@gmail.com" aria-label="Email Dr. XAS"><Mail size={15} /></a></div><div className="like-control"><span>Useful for your experiment?</span><button onClick={handleLike} disabled={likeBusy} aria-pressed={liked} aria-label={liked ? 'Remove appreciation' : 'Appreciate this app'}><ThumbsUp size={15} fill={liked ? 'currentColor' : 'none'} />{likeCount ?? '—'}</button>{likeError && <span role="status">{likeError}</span>}</div></footer>
    </div>
  );
}
export default App;
