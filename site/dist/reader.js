// 1. 文字サイズ切り替え
document.querySelectorAll('[data-size]').forEach((button) => {
  button.addEventListener('click', () => {
    const story = document.querySelector('.story');
    if (!story) return;
    const size = button.dataset.size;
    story.classList.toggle('large', size === 'large');
    story.classList.toggle('small', size === 'small');
    document.querySelectorAll('[data-size]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
      item.classList.toggle('active', item === button);
    });
  });
});

// 2. テーマ切り替え (紙色)
document.querySelectorAll('.theme-dot').forEach((dot) => {
  dot.addEventListener('click', () => {
    const theme = dot.dataset.theme;
    document.body.dataset.theme = theme;
    document.querySelectorAll('.theme-dot').forEach((d) => d.classList.remove('active'));
    dot.classList.add('active');
    try { localStorage.setItem('relay_theme', theme); } catch {}
  });
});
try {
  const savedTheme = localStorage.getItem('relay_theme');
  if (savedTheme) {
    document.body.dataset.theme = savedTheme;
    document.querySelectorAll('.theme-dot').forEach((d) => {
      d.classList.toggle('active', d.dataset.theme === savedTheme);
    });
  }
} catch {}

// 3. 縦書き / 横書き切り替え
const btnH = document.getElementById('btn-horizontal');
const btnV = document.getElementById('btn-vertical');

if (btnV && btnH) {
  btnV.addEventListener('click', () => {
    btnV.classList.add('active');
    btnV.setAttribute('aria-pressed', 'true');
    btnH.classList.remove('active');
    btnH.setAttribute('aria-pressed', 'false');
    document.body.classList.add('mode-vertical');
    const reader = document.querySelector('.reader');
    if (reader) reader.scrollLeft = 0;
  });

  btnH.addEventListener('click', () => {
    btnH.classList.add('active');
    btnH.setAttribute('aria-pressed', 'true');
    btnV.classList.remove('active');
    btnV.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('mode-vertical');
  });

  // 縦書き時のホイール横スクロール
  window.addEventListener('wheel', (e) => {
    if (!document.body.classList.contains('mode-vertical')) return;
    const reader = document.querySelector('.reader');
    if (reader && e.deltaY !== 0) {
      reader.scrollLeft -= e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
}

// 4. 読書プログレスバー
const progress = document.getElementById('read-progress');
if (progress) {
  window.addEventListener('scroll', () => {
    const h = document.documentElement;
    const total = h.scrollHeight - h.clientHeight;
    if (total > 0) {
      const pct = (h.scrollTop / total) * 100;
      progress.style.width = pct + '%';
    }
  });
}
