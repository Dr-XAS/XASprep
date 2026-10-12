import re
import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import xraylib as xrl
import scipy.ndimage as nd

def formula_to_latex(formula: str) -> str:
    """
    Converts a chemical formula string (e.g., "CH2CF2") into a LaTeX-compatible string.
    """
    pattern = r'([A-Z][a-z]*)(\d*\.?\d*)'
    matches = re.findall(pattern, formula)
    
    latex_formula = ""
    for element, count in matches:
        if not count:  # If no number, assume it's '1'
            latex_formula += f"\\text{{{element}}}"
        else:
            latex_formula += f"\\text{{{element}}}_{{{count}}}"
    
    return latex_formula

def interpolate(img, zoom=3, order=1):
    return nd.zoom(img, zoom=zoom, order=order)

class MaterialAbs:
    def __init__(self, compounds_info, element, edge='K'):
        self.compounds_info = compounds_info
        self.element = element
        self.edge = edge
        self.printlst = {}

        # Determine the atomic number of the element
        Z = xrl.SymbolToAtomicNumber(self.element)

        # Map the edge type to the corresponding xraylib shell constant
        edge_map = {
            "K": xrl.K_SHELL,
            "L1": xrl.L1_SHELL,
            "L2": xrl.L2_SHELL,
            "L3": xrl.L3_SHELL
        }

        if self.edge not in edge_map:
            raise ValueError(f"Invalid edge type: {self.edge}. Choose from 'K', 'L1', 'L2', or 'L3'.")

        # Get the edge energy in keV
        self.edge_value = xrl.EdgeEnergy(Z, edge_map[self.edge]) * 1000  # Convert to eV

        # Set up the energy range for the calculations
        self.energy = np.arange(max(100, self.edge_value - 500), self.edge_value + 500) / 1000  # in keV

    def edge_jump_calc(self, E1=None, E2=None):
        mask = np.s_[:] if E1 is None else ~np.ma.masked_outside(self.energy * 1000, E1, E2).mask
        self.jump_mask = mask
        # Handle cases where mask might be empty or all false if range is invalid
        if np.any(mask):
            self.abs_max = self.abs_total[mask].max()
            self.abs_min = self.abs_total[mask].min()
        else:
             # Fallback if range is bad
            self.abs_max = self.abs_total.max()
            self.abs_min = self.abs_total.min()
            
        self.edge_jump = self.abs_max - self.abs_min
        self.printlst.update({
            "01_abs_max": f"Abs Max. is {self.abs_max:.3f}",
            "02_abs_min": f"Abs Min. is {self.abs_min:.3f}",
            "03_abs_edge_jump": f"Abs edge jump is {self.edge_jump:.3f}"
        })
        return self.edge_jump

    def abs_calc(self):
        self.abs_total = np.zeros_like(self.energy)
        self.compound_name_all_latex = "$$"
        self.compound_name_all = ""

        # Validate compounds_info structure
        if not self.compounds_info:
             raise ValueError("No compounds information provided")

        for compound_info in self.compounds_info:
            compound = compound_info["compound"]
            area_density = compound_info["area_density"]

            # Use formula_to_latex to generate LaTeX formula from the compound string
            compound_latex = formula_to_latex(compound)
            
            # Calculate absorption
            # Ensure proper types for xraylib
            try:
                # xrl.CS_Total_CP expects string compound and energy in keV
                # We vectorize it over self.energy
                # However, xraylib isn't naturally vectorized for the first argument, but is for second? 
                # Actually in the original code: [xrl.CS_Total_CP(compound, E) * area_density for E in self.energy]
                # This is a list comprehension, so it's fine.
                # Keep the curve per unit area density too: absorption is linear
                # in area density, so suggest() can rescale without re-querying xraylib.
                compound_info["abs_unit"] = np.array([xrl.CS_Total_CP(compound, float(E)) for E in self.energy])
                compound_info["abs"] = compound_info["abs_unit"] * float(area_density)
                self.abs_total += compound_info["abs"]
            except Exception as e:
                print(f"Error calculating for {compound}: {e}")
                raise e

            # Append LaTeX-formatted compound to title strings
            self.compound_name_all_latex += f"{area_density * 1000:.1f}\\,\\frac{{mg}}{{cm^2}}\\, {compound_latex} + "
            self.compound_name_all += f"{area_density * 1000:.1f} mg/cm² {compound} + "

        # Remove the trailing " + " from the final string
        self.compound_name_all_latex = self.compound_name_all_latex.rstrip(" + ") + "$$"
        self.compound_name_all = self.compound_name_all.rstrip(" + ")

        # Store details in the print list
        self.printlst["00_compounds_info"] = "=" * 80 + f"\n {self.compound_name_all} \n" + "=" * 80
        
        # Calculate the edge jump
        E1 = self.edge_value - 50
        if E1 < 0:
            E1 = 100
        E2 = self.edge_value + 50
        self.edge_jump_calc(E1=E1, E2=E2)
        
        # Calculate the transmission
        self.transmitted_percentage = np.exp(-self.abs_total) * 100
        return self.abs_total

    def suggest(self, jump_target=1.0, abs_limit=4.0):
        """Rescale the stack so the edge jump hits jump_target, then report how
        much of the rest fits under abs_limit. Compounds containing the edge
        element ("absorber") scale together as one group; the others ("matrix")
        form the second group. Absorption is linear in area density, so the
        edge jump is affine in the absorber scale once the absorber dominates
        the window, and the matrix cap is a closed-form minimum over energies.
        Returns None when nothing in the stack contains the element."""
        Z = xrl.SymbolToAtomicNumber(self.element)
        mask = self.jump_mask
        roles = []
        for info in self.compounds_info:
            try:
                elements = xrl.CompoundParser(info["compound"])["Elements"]
            except Exception:
                elements = ()
            roles.append("absorber" if Z in elements else "matrix")

        zero = np.zeros_like(self.energy)
        A = sum((info["abs"] for info, r in zip(self.compounds_info, roles) if r == "absorber"), zero)
        M = sum((info["abs"] for info, r in zip(self.compounds_info, roles) if r == "matrix"), zero)
        if not np.any(A > 0):
            return None

        def jump(k):
            total = k * A + M
            return total[mask].max() - total[mask].min()

        # Two points give the slope; a few corrections absorb the small
        # nonlinearity from the matrix's own slope across the window.
        j1, j2 = jump(1.0), jump(2.0)
        slope = j2 - j1
        if slope <= 0:
            return None
        k = 1.0 + (jump_target - j1) / slope
        for _ in range(5):
            k = max(k, 0.0)
            err = jump(k) - jump_target
            if abs(err) < 1e-6:
                break
            k -= err / slope
        k = float(k)

        # Largest matrix scale m with max(k*A + m*M) <= abs_limit over the window.
        m = None
        if np.any(M[mask] > 0):
            headroom = abs_limit - k * A[mask]
            with np.errstate(divide="ignore", invalid="ignore"):
                ratios = np.where(M[mask] > 0, headroom / M[mask], np.inf)
            m = max(float(ratios.min()), 0.0)

        compounds = []
        for info, r in zip(self.compounds_info, roles):
            scale = k if r == "absorber" else m
            current = float(info["area_density"])
            compounds.append({
                "compound": info["compound"],
                "role": r,
                "area_density": current,
                "suggested_area_density": None if scale is None else current * scale,
            })

        total = k * A + (m if m is not None else 1.0) * M
        return {
            "jump_target": jump_target,
            "abs_limit": abs_limit,
            "absorber_scale": k,
            "matrix_scale": m,
            "edge_jump": float(jump(k)),
            "abs_max": float(total[mask].max()),
            "compounds": compounds,
        }

    def plot(self, plot_transmission=True, fontsize=14, show_label=True, width=800, height=500, abs_edge='', **kwargs):
        fig = make_subplots(
            rows=1, cols=1, 
            shared_xaxes=True,
            specs=[[{"secondary_y": True}]]
        )

        # Absorption spectrum (primary y-axis)
        fig.add_trace(go.Scatter(
            x=self.energy * 1000, 
            y=self.abs_total, 
            mode='lines', 
            name='X-ray Absorption',  
            line=dict(width=4, color='rgba(0, 0, 128, 0.7)'),
            **kwargs
        ), row=1, col=1, secondary_y=False)

        if plot_transmission:
            fig.add_trace(go.Scatter(
                x=self.energy * 1000, 
                y=self.transmitted_percentage, 
                mode='lines', 
                name='X-ray Transmission',  
                line=dict(
                    width=1.5, 
                    color='rgba(128, 0, 128, 0.7)',  
                    dash='dashdot'
                ),  
                **kwargs
            ), row=1, col=1, secondary_y=True)

        # Customize layout with dual y-axes
        fig.update_layout(
            autosize=True, # Use responsive size for web
            # width=width, # Let frontend handle size
            # height=height,
            xaxis_title="Energy (eV)",
            # title=self.compound_name_all_latex, # Title might be better handled by frontend UI
            title_font=dict(size=fontsize + 2),
            paper_bgcolor='white',
            plot_bgcolor='white',
            margin=dict(l=60, r=60, t=60, b=60),
            font=dict(family="Arial, sans-serif", size=fontsize),
            hovermode="x",
            showlegend=show_label
        )

        fig.update_yaxes(
            title_text="Absorption", 
            showgrid=True, 
            gridcolor='LightGray', 
            zeroline=False, 
            tickfont=dict(size=fontsize),
            range=[self.abs_min - 0.1, self.abs_max + 0.1],
            secondary_y=False
        )

        fig.update_yaxes(
            title_text="Transmission (%)", 
            showgrid=False, 
            tickfont=dict(size=fontsize),
            secondary_y=True
        )

        fig.update_xaxes(
            showgrid=True, 
            gridcolor='LightGray', 
            zeroline=False, 
            tickfont=dict(size=fontsize),
            range=[self.edge_value - 50, self.edge_value + 100]
        )

        if show_label:
            fig.update_layout(legend=dict(
                orientation="h",
                x=0.5, y=1.05,
                xanchor="center", yanchor="bottom",
                bgcolor='rgba(255, 255, 255, 0.7)',
            ))
        
        return fig
