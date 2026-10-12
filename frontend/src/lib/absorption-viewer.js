// Host adapter for the Dr.XAS scientific-viewers reference snapshot:
// xraylarch-web 5abaf8c784cd5f056ab783f9556d35a0937b7056, plot-theme.ts and
// plot-typography.ts. No Athena processing or transforms are used here.
export const PLOT_FONT = '"DrXAS Figtree", "Avenir Next", Avenir, "Helvetica Neue", Arial, sans-serif';

const themes = {
  light: { canvas: '#ffffff', text: '#1f1f1f', muted: '#5f6368', grid: '#e4e0e9', border: '#8b8493', accent: '#8c2981' },
  dark: { canvas: '#1e1b26', text: '#f3eff6', muted: '#bdb5c6', grid: '#393241', border: '#897a97', accent: '#e6a0d8' },
};

function luminance(channels) {
  return channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}

// Preserve categorical hues and line styles; lift dark thin marks for contrast.
// Continuous scales and scientific values are never recolored or normalized.
function readableLine(color, theme) {
  if (theme !== 'dark' || typeof color !== 'string') return color;
  const rgb = color.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  const channels = rgb ? rgb.slice(1).map(Number)
    : /^#[\da-f]{6}$/i.test(color) ? [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)) : null;
  if (!channels) return color;
  const background = luminance([30, 27, 38]);
  for (let step = 0; step <= 20; step += 1) {
    const adjusted = channels.map(channel => Math.round(channel + (255 - channel) * step / 20));
    if ((luminance(adjusted) + 0.05) / (background + 0.05) >= 3.5) {
      return `rgb(${adjusted.join(', ')})`;
    }
  }
  return color;
}

function axisForTheme(axis, colors) {
  const title = typeof axis.title === 'string' ? { text: axis.title } : axis.title;
  return {
    ...axis,
    color: colors.muted,
    gridcolor: colors.grid,
    zerolinecolor: colors.border,
    linecolor: colors.border,
    automargin: true,
    tickfont: { ...axis.tickfont, family: PLOT_FONT, size: 11, color: colors.muted },
    title: { ...title, font: { ...title?.font, family: PLOT_FONT, size: 12, color: colors.text }, standoff: 10 },
  };
}

/**
 * Clone the Plotly payload at the host boundary: Plotly may mutate its inputs.
 * Encoded arrays, numbers, trace identities, axes and ranges remain unchanged.
 * Source revision identifies the calculation; view revision only resets zoom.
 */
export function createAbsorptionPlot(plot, { theme = 'light', height = 380, showLegend = true, sourceRevision, viewRevision = 0 } = {}) {
  if (!plot || !Array.isArray(plot.data) || plot.data.length === 0) return null;
  const { data, layout = {} } = structuredClone(plot);
  const colors = themes[theme] || themes.light;
  const resultLayout = {
    ...layout,
    width: undefined,
    height,
    autosize: true,
    paper_bgcolor: colors.canvas,
    plot_bgcolor: colors.canvas,
    font: { ...layout.font, family: PLOT_FONT, size: 12, color: colors.text },
    margin: { ...layout.margin, l: 58, r: 62, t: showLegend ? 54 : 24, b: 54 },
    showlegend: showLegend,
    legend: {
      ...layout.legend,
      orientation: 'h', x: 0, xanchor: 'left', y: 1.04, yanchor: 'bottom',
      bgcolor: 'rgba(0,0,0,0)', bordercolor: colors.grid,
      font: { ...layout.legend?.font, family: PLOT_FONT, size: 11, color: colors.text },
    },
    hoverlabel: { ...layout.hoverlabel, bgcolor: colors.canvas, bordercolor: colors.border, font: { family: PLOT_FONT, size: 12, color: colors.text } },
    modebar: { ...layout.modebar, bgcolor: 'rgba(0,0,0,0)', color: colors.muted, activecolor: colors.accent },
    datarevision: sourceRevision,
    uirevision: `${sourceRevision ?? 'absorption'}:${viewRevision}`,
  };
  for (const [key, value] of Object.entries(layout)) {
    if (/^[xy]axis\d*$/.test(key)) resultLayout[key] = axisForTheme(value, colors);
  }
  return {
    data: data.map(trace => ({
      ...trace,
      ...(trace.line ? { line: { ...trace.line, color: readableLine(trace.line.color, theme) } } : {}),
    })),
    layout: resultLayout,
  };
}

export function absorptionWarnings(result) {
  return {
    edgeJump: Number.isFinite(result?.edge_jump) && (result.edge_jump < 0.3 || result.edge_jump > 3.5),
    maxAbsorption: Number.isFinite(result?.abs_max) && result.abs_max > 4,
  };
}

export function formatMetric(value, digits = 3) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'Not provided';
}
