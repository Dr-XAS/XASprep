# 🔬 EasyXASCalc

<div align="center">

**A user-friendly tool to calculate X-ray attenuation for optimizing sample thickness in XAS measurements**

[![Live Demo](https://img.shields.io/badge/🌐_Live_Demo-easyxascalc.onrender.com-blue?style=for-the-badge)](https://easyxascalc.onrender.com/)
[![Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gh/Cathyhjj/EasyXASCalc/main?labpath=easyXasCalc.ipynb)
[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/drive/1oYaxn7C7hpnAjmTeeLx9YxLdnH-0t8as?usp=sharing)

</div>

---

## ✨ Features

- 🎯 **Intuitive Interface** — Easy-to-use web app and Jupyter notebook GUI
- 📊 **Interactive Plots** — Visualize absorption, attenuation length, and more
- 🧪 **Chemical Formula Support** — Enter any compound formula for calculations
- ⚡ **Explicit Calculation** — Calculate a sample snapshot and see when edited inputs make results stale
- 🎨 **Beautiful Design** — Modern, responsive interface with dark mode support

---

## 🚀 Try It Now

### 🌐 Web Application (Recommended)

**👉 [Launch EasyXASCalc](https://easyxascalc.onrender.com/)**

No installation required! Just open the link and start calculating.

> ⏳ *Note: The free server may take 30-60 seconds to wake up if it has been idle.*

### 📓 Jupyter Notebook

For more flexibility and scripting capabilities:

| Platform | Link |
|----------|------|
| 🔗 Binder | [![Binder](https://mybinder.org/badge_logo.svg)](https://mybinder.org/v2/gh/Cathyhjj/EasyXASCalc/main?labpath=easyXasCalc.ipynb) |
| 🔗 Google Colab | [![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/drive/1oYaxn7C7hpnAjmTeeLx9YxLdnH-0t8as?usp=sharing) |

---

## 📸 Screenshots

<div align="center">

### 🖥️ Web Application

*Compact Dr.XAS workbench with light/dark themes and interactive plots*

### 📓 Jupyter Notebook GUI

![Jupyter GUI Snapshot](Jupyter_notebook/snapshot.png)

</div>

---

## 🛠️ Built With

- 🐍 **Backend**: Python + Flask + [xraylib](https://github.com/tschoonj/xraylib)
- ⚛️ **Frontend**: React + Vite
- 📊 **Plotting**: Plotly.js
- 🎨 **Styling**: Dr.XAS semantic tokens, Figtree and Magma accents

---

## 📖 Local Development

### Prerequisites

- Python 3.9+
- Node.js 22+

### Quick Start

```bash
# Clone the repository
git clone https://github.com/Dr-XAS/XASprep.git
cd XASprep

# Install backend dependencies
cd backend
pip install -r requirements.txt

# Install frontend dependencies
cd ../frontend
npm install

# Run development servers
npm run dev  # Frontend at http://localhost:5173
# In another terminal:
cd backend && python app.py  # Backend at http://localhost:5002
```

---

## 👩‍🔬 Author

**Juanjuan Huang**  
📧 [juanjuan.huang@anl.gov](mailto:juanjuan.huang@anl.gov)

---

## 📄 License

This project is open source and available for scientific research and education.

---

<div align="center">

**⭐ If you find this tool useful, please consider giving it a star! ⭐**

Made with ❤️ for the X-ray spectroscopy community

</div>
