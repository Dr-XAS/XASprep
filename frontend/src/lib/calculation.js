// The host owns unit conversion. xraylib receives areal density in g/cm².
export function prepareCalculation({ components, edges, calcMode, pelletDiameter }) {
  if (!components.length) return { error: 'Add at least one sample component.' };
  if (!edges.length) return { error: 'Add at least one measurement edge.' };
  const diameter = Number(pelletDiameter);
  if (calcMode === 'pellet' && (!Number.isFinite(diameter) || diameter <= 0)) {
    return { error: 'Enter a pellet diameter greater than zero.', field: 'pellet-diameter' };
  }
  const area = calcMode === 'pellet' ? Math.PI * (diameter / 20) ** 2 : 1;
  if (!Number.isFinite(area) || area <= 0) return { error: 'The pellet diameter is outside the supported numerical range.', field: 'pellet-diameter' };
  const compounds = [];
  for (const [index, component] of components.entries()) {
    if (!component.compound.trim()) return { error: `Enter a formula for component ${index + 1}.`, field: `formula-${component.id}` };
    const value = calcMode === 'pellet' ? component.mass : component.area_density;
    if (value === '' || !Number.isFinite(Number(value)) || Number(value) <= 0) {
      return { error: `Enter a ${calcMode === 'pellet' ? 'mass' : 'mass per area'} greater than zero for component ${index + 1}.`, field: `amount-${component.id}` };
    }
    const density = Number(value) / area / 1000;
    if (!Number.isFinite(density) || density <= 0) return { error: `The loading for component ${index + 1} is outside the supported numerical range.`, field: `amount-${component.id}` };
    compounds.push({ compound: component.compound.trim(), area_density: density });
  }
  return { payload: { compounds, edges: edges.map(edge => ({ element: edge.element, edge_type: edge.type })) } };
}

export function convertComponents(components, newMode, pelletDiameter) {
  const diameter = Number(pelletDiameter);
  if (!Number.isFinite(diameter) || diameter <= 0) return { error: 'Enter a valid pellet diameter before converting units.' };
  const source = newMode === 'battery' ? 'mass' : 'area_density';
  if (components.some(component => component[source] === '' || !Number.isFinite(Number(component[source])) || Number(component[source]) <= 0)) {
    return { error: 'Enter valid component amounts before converting units.' };
  }
  const area = Math.PI * (diameter / 20) ** 2;
  if (!Number.isFinite(area) || area <= 0) return { error: 'The pellet diameter is outside the supported numerical range.', field: 'pellet-diameter' };
  const converted = components.map(component => ({
    ...component,
    ...(newMode === 'battery' ? { area_density: Number(component.mass) / area } : { mass: Number(component.area_density) * area }),
  }));
  const target = newMode === 'battery' ? 'area_density' : 'mass';
  if (converted.some(component => !Number.isFinite(component[target]) || component[target] <= 0)) {
    return { error: 'The converted loading is outside the supported numerical range.' };
  }
  return { components: converted };
}
