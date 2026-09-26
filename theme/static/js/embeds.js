/* Show every page of an attached PDF (pdf.js) and the full height of an attached HTML file. */

const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289';
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_PARALLEL_RENDERS = 2;

/* ---------------- PDF ---------------- */

let pdfjsPromise = null;
const loadPdfjs = () => {
  if (!pdfjsPromise) {
    pdfjsPromise = import(`${PDFJS}/build/pdf.min.mjs`).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
      return lib;
    });
  }
  return pdfjsPromise;
};

const queue = [];
let running = 0;
const schedule = (job) => new Promise((resolve, reject) => {
  queue.push({ job, resolve, reject });
  pump();
});
function pump() {
  while (running < MAX_PARALLEL_RENDERS && queue.length) {
    const { job, resolve, reject } = queue.shift();
    running += 1;
    job().then(resolve, reject).finally(() => { running -= 1; pump(); });
  }
}

/*
 * Two looks:
 *  - document (.embed-pdf): framed viewer, separate pages on a grey background
 *  - handwritten note (.pdf-note): pages stacked with no gap, like consecutive note images,
 *    so strokes that cross a page boundary stay continuous. Click a page to zoom.
 */
class PdfEmbed {
  constructor(root) {
    this.root = root;
    this.url = root.dataset.src;
    this.joined = root.dataset.layout === 'joined';
    this.pagesEl = root.querySelector('.pdf-pages');
    this.metaEl = root.querySelector('[data-pages]');
    this.slots = [];
    this.bySlot = new Map();
    this.actual = false;
    this.lastWidth = 0;
  }

  async start() {
    const loading = this.pagesEl.querySelector('.embed-loading');
    try {
      const lib = await loadPdfjs();
      const task = lib.getDocument({
        url: this.url,
        cMapUrl: `${PDFJS}/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS}/standard_fonts/`,
        wasmUrl: `${PDFJS}/wasm/`,
        iccUrl: `${PDFJS}/iccs/`,
      });
      task.onProgress = ({ loaded, total }) => {
        if (loading && total) loading.textContent = `${this.joined ? '필기' : 'PDF'} 불러오는 중… ${Math.min(100, Math.round((loaded / total) * 100))}%`;
      };
      this.doc = await task.promise;
      const first = await this.doc.getPage(1);
      this.build(first);
    } catch (error) {
      console.error(error);
      this.pagesEl.innerHTML = `<div class="embed-error">PDF를 표시하지 못했습니다. <a href="${this.url}" target="_blank" rel="noopener">파일을 직접 열기</a></div>`;
    }
  }

  build(firstPage) {
    const total = this.doc.numPages;
    if (this.metaEl) this.metaEl.textContent = `${total}쪽`;
    if (!this.joined) this.addZoomButton();
    const size = firstPage.getViewport({ scale: 1 });
    this.pagesEl.textContent = '';
    for (let index = 1; index <= total; index += 1) {
      const el = document.createElement('div');
      el.className = 'pdf-page';
      if (!this.joined) {
        const label = document.createElement('span');
        label.className = 'pdf-num';
        label.textContent = `${index} / ${total}`;
        el.appendChild(label);
      }
      this.pagesEl.appendChild(el);
      const slot = {
        el,
        index,
        page: index === 1 ? firstPage : null,
        width: size.width,
        ratio: size.height / size.width,
        near: false,
        busy: false,
        canvas: null,
        rendered: 0,
      };
      this.slots.push(slot);
      this.bySlot.set(el, slot);
    }
    if (this.joined) this.pagesEl.addEventListener('click', (event) => this.zoom(event));
    this.layoutSlots();
    this.observe();
    this.readSizes();
  }

  addZoomButton() {
    const actions = this.root.querySelector('.embed-actions');
    if (!actions || actions.querySelector('.embed-zoom')) return;
    const button = document.createElement('a');
    button.href = '#';
    button.className = 'embed-zoom';
    button.textContent = '실제 크기';
    button.addEventListener('click', (event) => {
      event.preventDefault();
      this.actual = !this.actual;
      button.textContent = this.actual ? '폭에 맞추기' : '실제 크기';
      this.layoutSlots();
    });
    actions.prepend(button);
  }

  /* Joined pages get whole-pixel heights so no hairline shows where two pages meet. */
  layoutSlots() {
    this.slots.forEach((slot) => {
      slot.el.style.maxWidth = this.actual ? `${Math.round((slot.width * 96) / 72)}px` : '';
    });
    const widths = this.slots.map((slot) => slot.el.clientWidth);
    this.slots.forEach((slot, i) => {
      if (this.joined) {
        slot.el.style.aspectRatio = '';
        slot.el.style.height = `${Math.round(widths[i] * slot.ratio)}px`;
      } else {
        slot.el.style.height = '';
        slot.el.style.aspectRatio = `${slot.width} / ${slot.width * slot.ratio}`;
      }
    });
    this.lastWidth = this.pagesEl.clientWidth;
    this.slots.forEach((slot) => { if (slot.near) this.request(slot); });
  }

  async readSizes() {
    // Pages can differ in size (e.g. a landscape page inside a portrait deck).
    let changed = false;
    for (const slot of this.slots) {
      if (!slot.page) {
        try { slot.page = await this.doc.getPage(slot.index); } catch (error) { continue; }
      }
      const size = slot.page.getViewport({ scale: 1 });
      const ratio = size.height / size.width;
      if (size.width !== slot.width || Math.abs(ratio - slot.ratio) > 1e-6) {
        slot.width = size.width;
        slot.ratio = ratio;
        changed = true;
      }
    }
    if (changed) this.layoutSlots();
  }

  observe() {
    const near = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const slot = this.bySlot.get(entry.target);
        slot.near = entry.isIntersecting;
        if (slot.near) this.request(slot);
      }
    }, { rootMargin: '150% 0px' });
    const far = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) this.release(this.bySlot.get(entry.target));
      }
    }, { rootMargin: '600% 0px' });
    this.slots.forEach((slot) => { near.observe(slot.el); far.observe(slot.el); });

    let timer = null;
    new ResizeObserver(() => {
      if (Math.abs(this.pagesEl.clientWidth - this.lastWidth) < 1) return;   // only width changes matter
      clearTimeout(timer);
      timer = setTimeout(() => this.layoutSlots(), 150);
    }).observe(this.pagesEl);
  }

  request(slot) {
    const cssWidth = slot.el.clientWidth;
    if (!cssWidth || slot.busy) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const target = Math.round(cssWidth * ratio);
    if (slot.canvas && Math.abs(slot.rendered - target) / target < 0.08) return;
    slot.busy = true;
    schedule(() => this.render(slot, cssWidth, ratio))
      .catch((error) => console.warn('pdf page render failed', slot.index, error))
      .finally(() => {
        slot.busy = false;
        if (slot.near && Math.abs(slot.el.clientWidth - cssWidth) > 2) this.request(slot);
      });
  }

  async draw(slot, pixelWidth) {
    if (!slot.page) slot.page = await this.doc.getPage(slot.index);
    const size = slot.page.getViewport({ scale: 1 });
    let scale = pixelWidth / size.width;
    const pixels = size.width * size.height * scale * scale;
    if (pixels > MAX_CANVAS_PIXELS) scale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
    const viewport = slot.page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await slot.page.render({ canvas, viewport }).promise;
    return canvas;
  }

  async render(slot, cssWidth, ratio) {
    if (!slot.near) return;
    const canvas = await this.draw(slot, cssWidth * ratio);
    if (slot.canvas) slot.canvas.remove();
    slot.el.prepend(canvas);
    slot.canvas = canvas;
    slot.rendered = canvas.width;
  }

  release(slot) {
    if (!slot || !slot.canvas || slot.busy) return;
    slot.canvas.width = 0;
    slot.canvas.height = 0;
    slot.canvas.remove();
    slot.canvas = null;
    slot.rendered = 0;
    if (slot.page) slot.page.cleanup();
  }

  /* Same behaviour as note images: click a page to see it large. */
  async zoom(event) {
    const el = event.target.closest('.pdf-page');
    const slot = el && this.bySlot.get(el);
    if (!slot || !window.BLOG || typeof window.BLOG.zoom !== 'function' || this.zooming) return;
    this.zooming = true;
    document.body.style.cursor = 'progress';
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const canvas = await this.draw(slot, Math.min(4000, Math.max(2400, el.clientWidth * 2 * dpr)));
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (blob) window.BLOG.zoom(URL.createObjectURL(blob), `${slot.index}쪽`);
    } catch (error) {
      console.warn('zoom failed', error);
    } finally {
      this.zooming = false;
      document.body.style.cursor = '';
    }
  }
}

const startWhenNear = (elements, start) => {
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      io.unobserve(entry.target);
      start(entry.target);
    }
  }, { rootMargin: '200% 0px' });
  elements.forEach((el) => io.observe(el));
};

startWhenNear(document.querySelectorAll('.embed-pdf[data-src], .pdf-note[data-src]'), (el) => new PdfEmbed(el).start());

/* ---------------- HTML ---------------- */

function autoHeight(frame) {
  let last = 0;
  let lastDelta = 0;
  let lastSet = 0;
  let streak = 0;
  let stopped = false;
  let observer = null;
  let timer = null;

  const scrollMode = () => {
    stopped = true;
    if (observer) observer.disconnect();
    frame.setAttribute('scrolling', 'yes');
    frame.style.height = '85vh';
  };

  const measure = () => {
    if (stopped) return;
    let doc = null;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc || !doc.documentElement) return;
    // scrollHeight never drops below the frame's own height, so it can only grow.
    // The <html> box height is the real content height and lets the frame shrink too.
    const boxHeight = Math.ceil(doc.documentElement.getBoundingClientRect().height);
    const scrollHeight = doc.documentElement.scrollHeight;
    const height = scrollHeight > frame.clientHeight + 1 ? Math.max(scrollHeight, boxHeight) : boxHeight;
    if (!height || Math.abs(height - last) <= 1) return;
    const delta = height - last;
    // A page whose height follows its own frame (100vh + margin) would grow forever.
    const echo = last && delta > 0 && Math.abs(delta - lastDelta) <= 2 && performance.now() - lastSet < 120;
    streak = echo ? streak + 1 : 0;
    if (streak >= 6 || height > 2_000_000) { scrollMode(); return; }
    lastDelta = delta;
    last = height;
    lastSet = performance.now();
    frame.style.height = `${height}px`;
  };

  const onLoad = () => {
    last = 0; lastDelta = 0; streak = 0; stopped = false;
    let doc = null;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc || !doc.documentElement) { scrollMode(); return; }
    frame.setAttribute('scrolling', 'no');
    measure();
    if (observer) observer.disconnect();
    observer = new ResizeObserver(() => measure());
    observer.observe(doc.documentElement);
    if (doc.body) observer.observe(doc.body);
    doc.addEventListener('load', measure, true);
    clearInterval(timer);
    let ticks = 0;
    timer = setInterval(() => { measure(); ticks += 1; if (ticks > 40) clearInterval(timer); }, 500);

    // Links inside the frame: #anchors scroll this page, other links open in a new tab.
    doc.addEventListener('click', (event) => {
      const link = event.target.closest && event.target.closest('a[href]');
      if (!link) return;
      const href = link.getAttribute('href');
      if (href.startsWith('#')) {
        if (stopped) return;
        const id = decodeURIComponent(href.slice(1));
        const target = id ? (doc.getElementById(id) || doc.getElementsByName(id)[0]) : doc.body;
        if (!target) return;
        event.preventDefault();
        const top = frame.getBoundingClientRect().top + target.getBoundingClientRect().top + window.scrollY - 16;
        const start = window.scrollY;
        window.scrollTo({ top, behavior: 'smooth' });
        setTimeout(() => { if (window.scrollY === start) window.scrollTo(0, top); }, 80);
      } else if (!link.target && !href.startsWith('javascript:')) {
        link.target = '_blank';
        link.rel = 'noopener';
      }
    });
  };

  frame.addEventListener('load', onLoad);
  // The frame may have finished loading before this module ran.
  try {
    const doc = frame.contentDocument;
    if (doc && doc.readyState === 'complete' && doc.URL !== 'about:blank') onLoad();
  } catch (error) { /* cross-origin: handled on load */ }
}

document.querySelectorAll('iframe[data-autoheight]').forEach(autoHeight);
