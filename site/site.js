// Tiny progressive enhancements: copy buttons + screenshot lightbox. The page is fully usable without JavaScript.
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy.replace(/&#10;/g, '\n')); const t = b.textContent; b.textContent = 'Copied'; setTimeout(() => (b.textContent = t), 1600); }
    catch { b.textContent = 'Press Ctrl+C'; }
  });
});
const lb = document.getElementById('lb');
if (lb && lb.showModal) {
  const img = lb.querySelector('img');
  document.querySelectorAll('[data-lightbox]').forEach((b) => b.addEventListener('click', () => { img.src = b.dataset.lightbox; img.alt = b.querySelector('img')?.alt || ''; lb.showModal(); }));
  lb.querySelector('.lb-x').addEventListener('click', () => lb.close());
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target === img) lb.close(); });
}
