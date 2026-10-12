/** Presentation bridge only: no Plotly dependency, data, ranges or view state. */
export function readPlotTheme(root) {
  if (!root || root.nodeType !== 1) throw new TypeError('readPlotTheme needs the themed DOM element.');
  const view = root.ownerDocument.defaultView;
  const css = view.getComputedStyle(root);
  const get = (name) => {
    const value = css.getPropertyValue(name).trim();
    if (!value) throw new Error(`Missing ${name}; load drxas-tokens.css and use a .drx-ui root.`);
    return value;
  };
  // Resolve inherited rem sizes in the browser rather than hardcoding a 16 px root.
  const probe = root.ownerDocument.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;font-size:var(--drx-text-sm);';
  root.append(probe);
  const size = Number.parseFloat(view.getComputedStyle(probe).fontSize);
  probe.remove();
  return {
    fontFamily: get('--drx-font-sans'), fontSize: size,
    text: get('--drx-text'), muted: get('--drx-text-muted'),
    background: get('--drx-plot-bg'), grid: get('--drx-plot-grid'),
    border: get('--drx-control-border'),
  };
}

/** Use with Plotly.relayout so existing axis titles/ranges and camera survive. */
export function plotlyThemePatch(theme) {
  const patch = {
    'font.family': theme.fontFamily, 'font.size': theme.fontSize, 'font.color': theme.text,
    paper_bgcolor: theme.background, plot_bgcolor: theme.background,
    'legend.font.family': theme.fontFamily, 'legend.font.color': theme.text,
    'scene.bgcolor': theme.background,
  };
  for (const name of ['xaxis', 'yaxis', 'scene.xaxis', 'scene.yaxis', 'scene.zaxis']) {
    patch[`${name}.color`] = theme.muted;
    patch[`${name}.gridcolor`] = theme.grid;
    patch[`${name}.linecolor`] = theme.border;
    patch[`${name}.zerolinecolor`] = theme.border;
    patch[`${name}.tickfont.family`] = theme.fontFamily;
    patch[`${name}.tickfont.size`] = theme.fontSize;
  }
  return patch;
}
