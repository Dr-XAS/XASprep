from flask import Flask, request, jsonify
from core import MaterialAbs
import xraylib as xrl
import json
import logging
import re

import os
try:
    from flask_cors import CORS
except ImportError:
    CORS = None

# Serve static files from the React app build folder
app = Flask(__name__, static_folder="../frontend/dist", static_url_path="/")
if CORS:
    CORS(app)
logging.basicConfig(level=logging.INFO)

# --- Likes Storage ---
# The likes counter is the app's only mutable state. In a deployment it lives
# outside the release tree (XASPREP_DATA_DIR, see ops/deploy.sh) so a redeploy
# cannot reset it; locally it stays next to this file.
DATA_DIR = os.environ.get('XASPREP_DATA_DIR') or os.path.dirname(__file__)
LIKES_FILE = os.path.join(DATA_DIR, 'likes.json')

def get_likes_count():
    """Read the current likes count from file."""
    try:
        if os.path.exists(LIKES_FILE):
            with open(LIKES_FILE, 'r') as f:
                data = json.load(f)
                return data.get('count', 0)
    except Exception as e:
        logging.error(f"Error reading likes: {e}")
    return 0

def save_likes_count(count):
    """Save the likes count to file."""
    try:
        with open(LIKES_FILE, 'w') as f:
            json.dump({'count': max(0, count)}, f)
        return True
    except Exception as e:
        logging.error(f"Error saving likes: {e}")
        return False

SHELL_MAP = {
    "K": xrl.K_SHELL,
    "L1": xrl.L1_SHELL,
    "L2": xrl.L2_SHELL,
    "L3": xrl.L3_SHELL
}

@app.route('/')
def index():
    return app.send_static_file('index.html')

@app.route('/healthz')
def healthz():
    """Liveness probe for the deploy scripts: proves the process answers and
    that xraylib is importable and working, not merely that the port is open."""
    try:
        cu_k_kev = xrl.EdgeEnergy(29, xrl.K_SHELL)
        if not 8.9 < cu_k_kev < 9.1:
            raise ValueError(f"unexpected Cu K edge energy {cu_k_kev}")
    except Exception as e:
        logging.error(f"healthz failed: {e}")
        return jsonify({"ok": False, "error": str(e)}), 503
    return jsonify({"ok": True})

@app.route('/api/calculate', methods=['POST'])
def calculate():
    try:
        data = request.json
        compounds = data.get('compounds', [])
        edges = data.get('edges', [])
        
        results = []
        
        for edge_cfg in edges:
            element = edge_cfg.get('element')
            edge_type = edge_cfg.get('edge_type')
            
            try:
                # MaterialAbs expects [{'compound': str, 'area_density': float}]
                mat = MaterialAbs(compounds, element, edge_type)
                mat.abs_calc()
                
                # Generate plot figure
                fig = mat.plot(abs_edge=f'{mat.element} {mat.edge}')
                
                # Convert to JSON
                plot_json = json.loads(fig.to_json())
                
                results.append({
                    "element": element,
                    "edge": edge_type,
                    "plot": plot_json,
                    "edge_jump": getattr(mat, 'edge_jump', 0),
                    "abs_max": getattr(mat, 'abs_max', 0),
                    "edge_value": getattr(mat, 'edge_value', 0),
                    "compound_latex": getattr(mat, 'compound_name_all_latex', "")
                })
            except Exception as e:
                logging.error(f"Error calculating {element} {edge_type}: {e}")
                results.append({
                    "element": element,
                    "edge": edge_type,
                    "error": str(e)
                })

        return jsonify({"results": results})

    except Exception as e:
        logging.error(f"Global error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/elements', methods=['GET'])
def get_elements():
    elements = []
    for Z in range(1, 101):
        try:
             sym = xrl.AtomicNumberToSymbol(Z)
             elements.append({"symbol": sym, "atomic_number": Z})
        except:
            pass
    return jsonify(elements)

@app.route('/api/auto_edges', methods=['POST'])
def auto_edges():
    try:
        data = request.json
        compound = data.get('compound', '')
        min_e = float(data.get('min_energy', 4.0))
        max_e = float(data.get('max_energy', 30.0))
        
        # Regex to extract all element symbols like Li, Ni, Mn, Co, O
        elements = list(set(re.findall(r'[A-Z][a-z]*', compound)))
        
        edges = []
        for el in elements:
            try:
                Z = xrl.SymbolToAtomicNumber(el)
                for edge_name, edge_val in SHELL_MAP.items():
                    try:
                        energy_kev = xrl.EdgeEnergy(Z, edge_val)
                        if min_e <= energy_kev <= max_e:
                            edges.append({
                                "element": el,
                                "type": edge_name,
                                "energy": energy_kev
                            })
                    except Exception:
                        pass
            except Exception:
                pass
                
        # Sort edges by descending energy or ascending energy
        edges = sorted(edges, key=lambda x: x['energy'])
        return jsonify({"edges": edges})
    except Exception as e:
        logging.error(f"Error auto_edges: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/likes', methods=['GET'])
def get_likes():
    """Get the current likes count."""
    return jsonify({"count": get_likes_count()})

@app.route('/api/likes', methods=['POST'])
def update_likes():
    """Update the likes count (increment or decrement)."""
    try:
        data = request.json or {}
        action = data.get('action', 'like')  # 'like' or 'unlike'
        
        current_count = get_likes_count()
        
        if action == 'like':
            new_count = current_count + 1
        elif action == 'unlike':
            new_count = max(0, current_count - 1)
        else:
            return jsonify({"error": "Invalid action"}), 400
        
        save_likes_count(new_count)
        return jsonify({"count": new_count})
    except Exception as e:
        logging.error(f"Error updating likes: {e}")
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5002, debug=True)

