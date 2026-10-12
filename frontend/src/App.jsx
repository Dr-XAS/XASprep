import React, { useState, useEffect } from 'react';
import Plot from 'react-plotly.js';
import axios from 'axios';
import { Plus, Trash2, Calculator, FlaskConical, Layers, Activity, Info, ThumbsUp, SlidersHorizontal, Github, Twitter, Mail, AlertTriangle, ListChecks } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import 'katex/dist/katex.min.css';
import { BlockMath } from 'react-katex';
import './App.css';
import logo from './assets/logo/logo.png';
import { trackEvent } from './analytics';

// Utility for generating unique IDs
const uid = () => Math.random().toString(36).substr(2, 9);
const MotionDiv = motion.div;

function App() {
  // State
  const [calcMode, setCalcMode] = useState('pellet');
  const [pelletDiameter, setPelletDiameter] = useState(7);

  // Original single-sample + matrices are removed. We only keep a list of generic components (now labeled as "Samples").
  const [components, setComponents] = useState([
    { id: uid(), compound: 'LiNi0.5Mn0.25Co0.25O2', area_density: 60, mass: 5 },
    { id: uid(), compound: 'BN', area_density: 10, mass: 50 }
  ]);
  const [isCalculating, setIsCalculating] = useState(false);
  const [results, setResults] = useState([]);
  // The sample list the current results were computed from, so a suggestion
  // can be applied to the right rows even after the user edits the list.
  const [calcSnapshot, setCalcSnapshot] = useState([]);
  const [error, setError] = useState(null);

  const [liked, setLiked] = useState(false);
  const [likeCount, setLikeCount] = useState(0);

  // Edge selection
  const [edges, setEdges] = useState([
    { id: uid(), type: 'K', element: 'Mn' },
    { id: uid(), type: 'K', element: 'Co' },
    { id: uid(), type: 'K', element: 'Ni' }
  ]);
  const [autoEdgeMin, setAutoEdgeMin] = useState(4);
  const [autoEdgeMax, setAutoEdgeMax] = useState(30);
  const [isAutoFetching, setIsAutoFetching] = useState(false);

  const [elementsList, setElementsList] = useState([]);

  // Fetch elements on mount
  useEffect(() => {
    axios.get('/api/elements')
      .then(res => setElementsList(res.data))
      .catch(err => console.error("Failed to fetch elements", err));
  }, []);

  const addComponent = () => {
    setComponents(prev => [...prev, { id: uid(), compound: 'Al', area_density: 10, mass: 5 }]);
  };

  const removeComponent = (id) => {
    setComponents(prev => prev.filter(c => c.id !== id));
  };

  const addEdge = () => {
    setEdges(prev => [...prev, { id: uid(), type: 'K', element: 'Co' }]);
  };

  const removeEdge = (id) => {
    setEdges(prev => prev.filter(e => e.id !== id));
  };

  const handleLike = async () => {
    try {
      const action = liked ? 'unlike' : 'like';
      const response = await axios.post('/api/likes', { action });
      setLikeCount(response.data.count);
      setLiked(!liked);
      trackEvent(action === 'like' ? 'like_app' : 'unlike_app', {
        value: response.data.count
      });
    } catch (err) {
      console.error('Failed to update like:', err);
    }
  };

  // Fetch likes count on mount
  useEffect(() => {
    axios.get('/api/likes')
      .then(res => setLikeCount(res.data.count))
      .catch(err => console.error('Failed to fetch likes:', err));
  }, []);

  const handleAutoEdges = async () => {
    if (components.length === 0) return;
    setIsAutoFetching(true);
    try {
      const resp = await axios.post('/api/auto_edges', {
        compound: components[0].compound,
        min_energy: autoEdgeMin,
        max_energy: autoEdgeMax
      });
      if (resp.data.edges && resp.data.edges.length > 0) {
        const newEdges = resp.data.edges.map(e => ({
          id: uid(),
          type: e.type,
          element: e.element
        }));
        setEdges(newEdges);
        trackEvent('auto_edges_found', {
          edge_count: newEdges.length,
          min_energy: autoEdgeMin,
          max_energy: autoEdgeMax
        });
      } else {
        alert("No edges found in this energy range for the first sample layer.");
      }
    } catch (err) {
      console.error(err);
      alert("Failed to auto-fetch edges.");
    } finally {
      setIsAutoFetching(false);
    }
  };

  const handleClearAll = () => {
    if (window.confirm("Are you sure you want to clear all samples and measurement edges?")) {
      setComponents([]);
      setEdges([]);
      setResults([]);
    }
  };

  const handleModeSwitch = (newMode) => {
    if (calcMode === newMode) return;

    const area = Math.PI * Math.pow(pelletDiameter / 20, 2);
    setComponents(prev => prev.map(c => {
      if (newMode === 'battery') {
        const ad = (c.mass || 0) / area;
        return { ...c, area_density: parseFloat(ad.toFixed(4)) };
      } else {
        const m = (c.area_density || 0) * area;
        return { ...c, mass: parseFloat(m.toFixed(4)) };
      }
    }));

    setCalcMode(newMode);
  };

  // The button passes a click event; applySuggestion passes the list it just built,
  // since the state update has not landed yet.
  const handleCalculate = async (override) => {
    const stack = Array.isArray(override) ? override : components;
    setIsCalculating(true);
    setError(null);
    setResults([]);

    try {
      const isPellet = calcMode === 'pellet';
      const area = isPellet ? Math.PI * Math.pow(pelletDiameter / 20, 2) : 1;

      const getAreaDensity = (item) => {
        if (isPellet) {
          return (item.mass || 0) / area;
        }
        return item.area_density || 0;
      };

      // 1. Components (now representing the entire sample stack)
      const allCompounds = stack.map(c => ({
        compound: c.compound,
        area_density: getAreaDensity(c) / 1000
      }));

      const edgesPayload = edges.map(e => ({
        element: e.element,
        edge_type: e.type
      }));

      const response = await axios.post('/api/calculate', {
        compounds: allCompounds,
        edges: edgesPayload
      });

      if (response.data.error) throw new Error(response.data.error);
      setResults(response.data.results);
      setCalcSnapshot(stack);
      trackEvent('calculate_absorption', {
        calculation_mode: calcMode,
        sample_count: allCompounds.length,
        edge_count: edgesPayload.length
      });

    } catch (err) {
      setError(err.message || 'Calculation failed');
    } finally {
      setIsCalculating(false);
    }
  };

  // Suggested area densities come back in g/cm²; show them in the unit the
  // current mode edits (mg for a pellet, mg/cm² otherwise).
  const toInputUnit = (gPerCm2) => {
    const mgPerCm2 = gPerCm2 * 1000;
    if (calcMode !== 'pellet') return mgPerCm2;
    return mgPerCm2 * Math.PI * Math.pow(pelletDiameter / 20, 2);
  };
  const inputUnitLabel = calcMode === 'pellet' ? 'mg' : 'mg/cm²';

  const suggestedAbsorbers = (suggestion) =>
    suggestion ? suggestion.compounds.filter(c => c.role === 'absorber' && c.suggested_area_density != null) : [];

  // Set every absorber to its suggested amount and cap the matrix only when
  // the current amount already breaks the absorption limit; adding more
  // diluent is the user's call.
  const applySuggestion = (suggestion) => {
    if (!suggestion) return;
    const suggestedById = new Map();
    suggestion.compounds.forEach((c, i) => {
      const snap = calcSnapshot[i];
      if (!snap || snap.compound !== c.compound || c.suggested_area_density == null) return;
      const apply = c.role === 'absorber' || (suggestion.matrix_scale != null && suggestion.matrix_scale < 1);
      if (apply) suggestedById.set(snap.id, c.suggested_area_density);
    });
    const next = components.map(c => {
      if (!suggestedById.has(c.id)) return c;
      const value = parseFloat(toInputUnit(suggestedById.get(c.id)).toFixed(3));
      return calcMode === 'pellet' ? { ...c, mass: value } : { ...c, area_density: value };
    });
    setComponents(next);
    trackEvent('apply_suggestion', { calculation_mode: calcMode });
    handleCalculate(next);
  };

  // Auto-calculate on mount
  useEffect(() => {
    handleCalculate();
    // The first calculation should run once with the default inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-container">
      <header className="header">
        <div className="logo">
          <img src={logo} alt="EasyXASCalc Logo" style={{ height: '32px' }} />
          <div style={{ height: '24px', width: '2px', background: 'var(--border-color)', borderRadius: '1px', margin: '0 4px' }} />
          <h1>EasyXASCalc</h1>
        </div>
      </header>

      <main className="main-content">
        <div className="panels-grid">
          {/* Left Panel: Controls */}
          <div className="controls-panel">
            <button
              className="primary calculate-btn"
              onClick={handleCalculate}
              disabled={isCalculating}
            >
              {isCalculating ? 'Calculating...' : <><Calculator size={18} /> Calculate Absorption</>}
            </button>

            {/* Mode Switcher */}
            <section className="card highlight-card">
              <div className="section-header" style={{ position: 'relative', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
                <div style={{ position: 'absolute', left: 0, display: 'flex', alignItems: 'center' }}>
                  <SlidersHorizontal size={18} />
                </div>
                <h2 style={{ margin: 0 }}>Calculation Mode</h2>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: calcMode === 'pellet' ? '1rem' : '0' }}>
                <div className="toggle-group" style={{ display: 'flex', background: 'var(--bg-color)', borderRadius: '8px', padding: '4px', gap: '4px', width: '100%' }}>
                  <button
                    className={clsx('toggle-btn', { active: calcMode === 'pellet' })}
                    onClick={() => handleModeSwitch('pellet')}
                    style={{ flex: 1, padding: '6px 12px', border: 'none', borderRadius: '6px', cursor: 'pointer', background: calcMode === 'pellet' ? 'var(--primary)' : 'transparent', color: calcMode === 'pellet' ? '#fff' : 'inherit', fontSize: '0.85rem', fontWeight: 600, transition: 'all 0.2s' }}
                  >
                    Prepare Pellet
                  </button>
                  <button
                    className={clsx('toggle-btn', { active: calcMode === 'battery' })}
                    onClick={() => handleModeSwitch('battery')}
                    style={{ flex: 1, padding: '6px 12px', border: 'none', borderRadius: '6px', cursor: 'pointer', background: calcMode === 'battery' ? 'var(--primary)' : 'transparent', color: calcMode === 'battery' ? '#fff' : 'inherit', fontSize: '0.85rem', fontWeight: 600, transition: 'all 0.2s' }}
                  >
                    Area Density
                  </button>
                </div>
              </div>

              <AnimatePresence>
                {calcMode === 'pellet' && (
                  <MotionDiv
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    style={{ overflow: 'hidden' }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', paddingTop: '0.5rem', borderTop: '1px dashed var(--border-color)', fontSize: '0.85rem' }}>
                      <span className="label" style={{ marginBottom: 0, fontWeight: 600 }}>Diameter:</span>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', padding: '8px', borderRadius: '6px', flex: 1 }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          <button
                            onClick={() => setPelletDiameter(7)}
                            style={{ border: 'none', background: pelletDiameter === 7 ? 'rgba(148, 120, 172, 0.15)' : 'transparent', color: pelletDiameter === 7 ? 'var(--primary)' : 'inherit', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: pelletDiameter === 7 ? 600 : 400, transition: 'all 0.2s', width: '100%', justifyContent: 'flex-start' }}
                          >
                            <span style={{ fontSize: '0.75rem', width: '20px', textAlign: 'center' }}>⚪</span> 7 mm
                          </button>
                          <button
                            onClick={() => setPelletDiameter(13)}
                            style={{ border: 'none', background: pelletDiameter === 13 ? 'rgba(148, 120, 172, 0.15)' : 'transparent', color: pelletDiameter === 13 ? 'var(--primary)' : 'inherit', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: pelletDiameter === 13 ? 600 : 400, transition: 'all 0.2s', width: '100%', justifyContent: 'flex-start' }}
                          >
                            <span style={{ fontSize: '1.2rem', lineHeight: 1, width: '20px', textAlign: 'center' }}>⚪</span> 13 mm
                          </button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', paddingRight: '8px' }}>
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>Custom:</span>
                          <input
                            type="number"
                            step="0.1"
                            value={pelletDiameter === '' ? '' : pelletDiameter}
                            onChange={e => {
                              const v = e.target.value;
                              setPelletDiameter(v === '' ? '' : parseFloat(v));
                            }}
                            style={{ width: '60px', padding: '6px', fontSize: '0.85rem', outline: 'none', border: '1px solid var(--border-color)', borderRadius: '4px', background: 'var(--card-bg)' }}
                          />
                          <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>mm</span>
                        </div>
                      </div>
                    </div>
                  </MotionDiv>
                )}
              </AnimatePresence>
            </section>

            {/* Sample Stack Section (Formerly Components) */}
            <section className="card">
              <div className="section-header">
                <Layers size={18} />
                <h2>Sample</h2>
                <button className="icon-btn" onClick={addComponent} title="Add Layer"><Plus size={16} /></button>
              </div>

              <AnimatePresence>
                {components.map((c, idx) => (
                  <MotionDiv
                    key={c.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="row item-row"
                  >
                    <div style={{ flex: 1, display: 'grid', gap: '0.8rem' }}>
                      <div>
                        <label className="label">Formula</label>
                        <input
                          type="text"
                          value={c.compound}
                          onChange={e => {
                            const newC = [...components];
                            newC[idx].compound = e.target.value;
                            setComponents(newC);
                          }}
                        />
                      </div>
                      <div>
                        {calcMode === 'battery' ? (
                          <>
                            <label
                              className="label help-cursor"
                              data-tooltip="Mass per unit area. Example: A 10 mm diameter round pellet (area ≈ 0.79 cm²) weighing 100 mg has a density of 100 mg ÷ 0.79 cm² ≈ 127.3 mg/cm²."
                              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                            >
                              Area Density (mg/cm²) <Info size={12} />
                            </label>
                            <input
                              type="number"
                              value={c.area_density}
                              onChange={e => {
                                const newC = [...components];
                                newC[idx].area_density = parseFloat(e.target.value);
                                setComponents(newC);
                              }}
                            />
                          </>
                        ) : (
                          <>
                            <label
                              className="label help-cursor"
                              data-tooltip="Total mass of this component in mg."
                              style={{ display: 'flex', alignItems: 'center', gap: '4px' }}
                            >
                              Mass (mg) <Info size={12} />
                            </label>
                            <input
                              type="number"
                              value={c.mass}
                              onChange={e => {
                                const newC = [...components];
                                newC[idx].mass = parseFloat(e.target.value);
                                setComponents(newC);
                              }}
                            />
                          </>
                        )}
                      </div>
                    </div>
                    <button className="danger icon-btn" onClick={() => removeComponent(c.id)} style={{ alignSelf: 'flex-start', marginTop: '1.8rem' }}>
                      <Trash2 size={16} />
                    </button>
                  </MotionDiv>
                ))}
              </AnimatePresence>
              {components.length === 0 && <div className="empty-state">No sample compounds</div>}
            </section>


            {/* Edges Section */}
            <section className="card highlight-card">
              <div className="section-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Activity size={18} />
                  <h2 style={{ margin: 0 }}>Measurement Edges</h2>
                </div>
                <button className="icon-btn" onClick={addEdge} title="Add Manually"><Plus size={16} /></button>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '1rem', background: 'var(--bg-color)', padding: '8px 12px', borderRadius: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Auto Add:</span>
                <input
                  type="number"
                  value={autoEdgeMin === '' ? '' : autoEdgeMin}
                  onChange={e => {
                    const v = e.target.value;
                    setAutoEdgeMin(v === '' ? '' : Number(v))
                  }}
                  style={{ width: '60px', padding: '4px 6px' }}
                />
                <span style={{ fontSize: '0.85rem' }}>to</span>
                <input
                  type="number"
                  value={autoEdgeMax === '' ? '' : autoEdgeMax}
                  onChange={e => {
                    const v = e.target.value;
                    setAutoEdgeMax(v === '' ? '' : Number(v))
                  }}
                  style={{ width: '60px', padding: '4px 6px' }}
                />
                <span style={{ fontSize: '0.85rem' }}>keV</span>
                <button className="primary" onClick={handleAutoEdges} disabled={isAutoFetching} style={{ padding: '6px 12px', fontSize: '0.85rem', marginLeft: 'auto' }}>
                  {isAutoFetching ? 'Adding...' : 'Auto'}
                </button>
              </div>

              <AnimatePresence>
                {edges.map((edge, idx) => (
                  <MotionDiv
                    key={edge.id}
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="row item-row"
                  >
                    <div style={{ flex: 1 }}>
                      <label className="label">Edge</label>
                      <select
                        value={edge.type}
                        onChange={e => {
                          const newE = [...edges];
                          newE[idx].type = e.target.value;
                          setEdges(newE);
                        }}
                      >
                        {['K', 'L1', 'L2', 'L3'].map(t => <option key={t} value={t}>{t}</option>)}
                      </select>
                    </div>
                    <div style={{ flex: 2 }}>
                      <label className="label">Element</label>
                      <select
                        value={edge.element}
                        onChange={e => {
                          const newE = [...edges];
                          newE[idx].element = e.target.value;
                          setEdges(newE);
                        }}
                      >
                        {elementsList.length > 0 ? elementsList.map(el => (
                          <option key={el.atomic_number} value={el.symbol}>{el.symbol} (Z={el.atomic_number})</option>
                        )) : <option value={edge.element}>{edge.element}</option>}
                      </select>
                    </div>
                    <button className="danger icon-btn" onClick={() => removeEdge(edge.id)}>
                      <Trash2 size={16} />
                    </button>
                  </MotionDiv>
                ))}
              </AnimatePresence>
              <div style={{ marginTop: '1rem', paddingTop: '1rem', borderTop: '1px dashed var(--border-color)' }}>
                <button
                  className="danger"
                  onClick={handleClearAll}
                  style={{ width: '100%', padding: '0.6rem', fontSize: '0.9rem', backgroundColor: 'transparent', border: '1px solid rgba(239, 68, 68, 0.4)', color: '#ef4444', transition: 'all 0.2s' }}
                >
                  <Trash2 size={16} /> Clear all configurations
                </button>
              </div>
            </section>





            {error && <div className="error-msg">{error}</div>}

          </div>

          {/* Right Panel: Results */}
          <div className="results-panel">
            {results.length === 0 && !isCalculating && (
              <div className="placeholder-state">
                <Activity size={48} className="text-muted" opacity={0.2} />
                <p>Configure composition and edges, then click Calculate.</p>
              </div>
            )}

            {results.length > 0 && (
              <MotionDiv className="card summary-card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }}>
                <div className="section-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <ListChecks size={18} />
                    <h2 style={{ margin: 0 }}>Summary</h2>
                  </div>
                  <span className="summary-hint">Target edge jump 1.0, max absorption below 4</span>
                </div>
                <div className="summary-scroll">
                  <table className="summary-table">
                    <thead>
                      <tr>
                        <th>Edge</th>
                        <th>Edge jump</th>
                        <th>Max abs.</th>
                        <th>Status</th>
                        <th>Sample for jump 1.0</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((res, idx) => {
                        if (res.error) {
                          return (
                            <tr key={idx}>
                              <td>{res.element} {res.edge}</td>
                              <td colSpan={5} className="summary-error">{res.error}</td>
                            </tr>
                          );
                        }
                        const jumpBad = res.edge_jump < 0.3 || res.edge_jump > 3.5;
                        const absBad = res.abs_max > 4;
                        const absorbers = suggestedAbsorbers(res.suggestion);
                        const matrixOver = res.suggestion?.matrix_scale != null && res.suggestion.matrix_scale < 1;
                        return (
                          <tr key={idx}>
                            <td className="summary-edge">{res.element} {res.edge} <span className="summary-muted">{res.edge_value?.toFixed(0)} eV</span></td>
                            <td className={clsx({ 'summary-bad': jumpBad })}>{res.edge_jump?.toFixed(2)}</td>
                            <td className={clsx({ 'summary-bad': absBad })}>{res.abs_max?.toFixed(2)}</td>
                            <td>
                              <span className={clsx('summary-badge', jumpBad || absBad ? 'warn' : 'ok')}>
                                {jumpBad || absBad ? 'Adjust' : 'OK'}
                              </span>
                            </td>
                            <td>
                              {absorbers.length === 0 ? (
                                <span className="summary-muted">No sample contains {res.element}</span>
                              ) : (
                                absorbers.map(c => (
                                  <div key={c.compound}>
                                    <strong>{toInputUnit(c.suggested_area_density).toFixed(1)}</strong> {inputUnitLabel} {c.compound}
                                  </div>
                                ))
                              )}
                              {matrixOver && (
                                <div className="summary-muted">
                                  matrix over limit, cap at {res.suggestion.compounds.filter(c => c.role === 'matrix').map(c => `${toInputUnit(c.suggested_area_density).toFixed(1)} ${inputUnitLabel} ${c.compound}`).join(', ')}
                                </div>
                              )}
                            </td>
                            <td>
                              {absorbers.length > 0 && (
                                <button className="primary summary-apply" onClick={() => applySuggestion(res.suggestion)} disabled={isCalculating}>
                                  Apply
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </MotionDiv>
            )}

            {results.map((res, idx) => {
              const isEdgeJumpAlert = res.edge_jump < 0.3 || res.edge_jump > 3.5;
              const isMaxAbsAlert = res.abs_max > 4;
              const alertColor = '#de425b';

              return (
                <MotionDiv
                  key={idx}
                  className="card plot-card"
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.1 }}
                >
                  {res.error ? (
                    <div className="error-msg">Error: {res.error}</div>
                  ) : (
                    <>
                      <div style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '0.5rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Activity size={18} />
                        <h3 style={{ margin: 0, fontSize: '1.2rem' }}>{res.element} - {res.edge} Edge ({res.edge_value?.toFixed(1)} eV)</h3>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div className="stats-row" style={{ margin: 0, padding: '0.4rem 1rem', background: 'rgba(0,0,0,0.03)', borderRadius: '8px', border: '1px solid var(--border-color)' }}>
                          <div className="stat" data-tooltip="The optimal edge jump is 1.0, with a recommended range of 0.3 to 3.0.">
                            <span className="label help-cursor" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: isEdgeJumpAlert ? alertColor : undefined }}>
                              Edge Jump {isEdgeJumpAlert ? <AlertTriangle size={12} color={alertColor} /> : <Info size={10} />}
                            </span>
                            <span className="value" style={{ fontSize: '1.1rem', color: isEdgeJumpAlert ? alertColor : undefined }}>{res.edge_jump?.toFixed(3)}</span>
                          </div>
                          <div className="stat" data-tooltip="Total absorption should ideally be kept below 4.0.">
                            <span className="label help-cursor" style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.75rem', color: isMaxAbsAlert ? alertColor : undefined }}>
                              Max Absorption {isMaxAbsAlert ? <AlertTriangle size={12} color={alertColor} /> : <Info size={10} />}
                            </span>
                            <span className="value" style={{ fontSize: '1.1rem', color: isMaxAbsAlert ? alertColor : undefined }}>{res.abs_max?.toFixed(3)}</span>
                          </div>
                        </div>

                        {res.compound_latex && (
                          <div className="latex-container" style={{ margin: 0, flex: 1 }}>
                            <BlockMath>{res.compound_latex.replace(/\$\$/g, '')}</BlockMath>
                          </div>
                        )}
                      </div>
                      <div className="plot-container">
                        <Plot
                          data={res.plot.data}
                          layout={{
                            ...res.plot.layout,
                            width: undefined, // Let it be responsive
                            height: 450,
                            paper_bgcolor: '#ffffff',
                            plot_bgcolor: '#ffffff',
                            font: { color: '#1e293b' },
                            xaxis: { ...res.plot.layout.xaxis, gridcolor: '#e2e8f0', color: '#64748b' },
                            yaxis: { ...res.plot.layout.yaxis, gridcolor: '#e2e8f0', color: '#64748b' },
                            yaxis2: { ...res.plot.layout.yaxis2, gridcolor: '#e2e8f0', color: '#64748b' },
                            legend: { ...res.plot.layout.legend, bgcolor: 'rgba(255,255,255,0.7)' }
                          }}
                          config={{ responsive: true, displaylogo: false }}
                          style={{ width: '100%', height: '100%' }}
                        />
                      </div>
                    </>
                  )}
                </MotionDiv>
              );
            })}
          </div>
        </div>
      </main>

      <footer className="footer">
        <div className="footer-content">
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span>Developed by <a href="https://dr-xas.org/" target="_blank" rel="noopener noreferrer">Dr. XAS team</a></span>
            <div style={{ height: '14px', width: '1px', background: 'currentColor', opacity: 0.3 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <a href="https://github.com/Dr-XAS" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', display: 'flex', opacity: 0.7, transition: 'opacity 0.2s' }} onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.7} aria-label="GitHub">
                <Github size={18} />
              </a>
              <a href="https://x.com/drx_xas" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', display: 'flex', opacity: 0.7, transition: 'opacity 0.2s' }} onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.7} aria-label="X (Twitter)">
                <Twitter size={18} />
              </a>
              <a href="mailto:dr.xas.drx@gmail.com" style={{ color: 'inherit', display: 'flex', opacity: 0.7, transition: 'opacity 0.2s' }} onMouseEnter={e => e.currentTarget.style.opacity = 1} onMouseLeave={e => e.currentTarget.style.opacity = 0.7} aria-label="Email">
                <Mail size={18} />
              </a>
            </div>
          </div>

          <div className="divider" />

          <div className="like-section">
            <span>Give me a thumbs up if you found this useful!</span>
            <button
              className={clsx("like-btn", { liked })}
              onClick={handleLike}
              aria-label="Like"
            >
              <ThumbsUp size={18} fill={liked ? "currentColor" : "none"} />
            </button>
            <span className="like-count" key={likeCount}>{likeCount}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
