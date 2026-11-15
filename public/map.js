'use strict';
// Small dependency-free map: OpenStreetMap tiles, drag to move, +/- to zoom, tap to pick a point.
(function () {
  const TILE = 256;
  const project = (lat, lng) => {
    const s = Math.sin((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
    return { x: (lng + 180) / 360, y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI) };
  };
  const unproject = (x, y) => ({
    lng: x * 360 - 180,
    lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
  });
  const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

  class MiniMap {
    constructor(host, opts = {}) {
      this.host = host;
      host.classList.add('mmap');
      host.dir = 'ltr';
      this.onPick = opts.onPick || null;
      this.c = project(opts.lat ?? 25.3, opts.lng ?? 55.4);
      this.z = opts.zoom ?? 8;
      this.tiles = new Map();
      this.markers = [];
      this.layer = el('div', 'mmap-layer');
      this.pins = el('div', 'mmap-pins');
      const ctl = el('div', 'mmap-ctl');
      const plus = el('button'); plus.type = 'button'; plus.textContent = '+'; plus.setAttribute('aria-label', 'Zoom in');
      const minus = el('button'); minus.type = 'button'; minus.textContent = '−'; minus.setAttribute('aria-label', 'Zoom out');
      plus.addEventListener('click', (e) => { e.stopPropagation(); this.zoom(1); });
      minus.addEventListener('click', (e) => { e.stopPropagation(); this.zoom(-1); });
      ctl.append(plus, minus);
      const attr = el('div', 'mmap-attr');
      attr.textContent = '© OpenStreetMap contributors';
      host.append(this.layer, this.pins, ctl, attr);
      if (this.onPick) host.classList.add('mmap-pick');

      let start = null;
      host.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.mmap-ctl, .mmap-marker')) return;
        start = { x: e.clientX, y: e.clientY, cx: this.c.x, cy: this.c.y, moved: false };
        host.setPointerCapture(e.pointerId);
      });
      host.addEventListener('pointermove', (e) => {
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) start.moved = true;
        if (!start.moved) return;
        const scale = TILE * 2 ** this.z;
        this.c = { x: start.cx - dx / scale, y: Math.max(0, Math.min(1, start.cy - dy / scale)) };
        this.draw();
      });
      const end = (e) => {
        if (!start) return;
        const wasMove = start.moved;
        start = null;
        if (!wasMove && this.onPick && e.type === 'pointerup') {
          const r = host.getBoundingClientRect();
          const scale = TILE * 2 ** this.z;
          const p = unproject(this.c.x + (e.clientX - r.left - r.width / 2) / scale, this.c.y + (e.clientY - r.top - r.height / 2) / scale);
          this.onPick(Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6);
        }
      };
      host.addEventListener('pointerup', end);
      host.addEventListener('pointercancel', end);
      if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(host);
      this.draw();
    }
    zoom(d) { this.z = Math.max(2, Math.min(18, this.z + d)); this.draw(); }
    setView(lat, lng, zoom) { this.c = project(lat, lng); if (zoom != null) this.z = zoom; this.draw(); }
    clearMarkers() { for (const m of this.markers) m.el.remove(); this.markers = []; }
    addMarker(lat, lng, node) {
      node.classList.add('mmap-marker');
      this.pins.append(node);
      this.markers.push({ p: project(lat, lng), el: node });
      this.draw();
    }
    setPin(lat, lng) {
      this.clearMarkers();
      const pin = el('div', 'mmap-pin');
      this.addMarker(lat, lng, pin);
      this.setView(lat, lng, Math.max(this.z, 15));
    }
    fit() {
      if (!this.markers.length) return;
      const xs = this.markers.map((m) => m.p.x), ys = this.markers.map((m) => m.p.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
      this.c = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
      const w = Math.max(120, this.host.clientWidth - 140), h = Math.max(120, this.host.clientHeight - 140);
      let z = 15;
      while (z > 2 && ((maxX - minX) * TILE * 2 ** z > w || (maxY - minY) * TILE * 2 ** z > h)) z--;
      this.z = z;
      this.draw();
    }
    draw() {
      const w = this.host.clientWidth, h = this.host.clientHeight;
      if (!w || !h) return;
      const n = 2 ** this.z, scale = TILE * n;
      const left = this.c.x * scale - w / 2, top = this.c.y * scale - h / 2;
      const want = new Set();
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + h) / TILE); ty++) {
        if (ty < 0 || ty >= n) continue;
        for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + w) / TILE); tx++) {
          const key = this.z + '/' + tx + '/' + ty;
          want.add(key);
          let img = this.tiles.get(key);
          if (!img) {
            img = new Image(TILE, TILE);
            img.alt = '';
            img.draggable = false;
            img.decoding = 'async';
            img.src = 'https://tile.openstreetmap.org/' + this.z + '/' + (((tx % n) + n) % n) + '/' + ty + '.png';
            img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
            this.layer.append(img);
            this.tiles.set(key, img);
          }
          img.style.transform = 'translate(' + Math.round(tx * TILE - left) + 'px,' + Math.round(ty * TILE - top) + 'px)';
        }
      }
      for (const [key, img] of this.tiles) if (!want.has(key)) { img.remove(); this.tiles.delete(key); }
      for (const m of this.markers) {
        m.el.style.left = Math.round(m.p.x * scale - left) + 'px';
        m.el.style.top = Math.round(m.p.y * scale - top) + 'px';
      }
    }
  }
  window.MiniMap = MiniMap;
})();
