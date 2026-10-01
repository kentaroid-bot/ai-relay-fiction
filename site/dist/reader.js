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
    if (typeof window.updateReadingProgress === 'function') {
      window.updateReadingProgress();
    }
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

// 3. 読書プログレスバー
const progress = document.getElementById('read-progress');
function updateProgress() {
  if (!progress) return;
  if (document.body.classList.contains('mode-vertical')) {
    const story = document.querySelector('.story');
    if (story) {
      const maxScroll = story.scrollWidth - story.clientWidth;
      if (maxScroll > 0) {
        const current = Math.abs(story.scrollLeft);
        const pct = Math.min(100, Math.max(0, (current / maxScroll) * 100));
        progress.style.width = pct + '%';
        return;
      }
      progress.style.width = '100%';
      return;
    }
  }
  const h = document.documentElement;
  const total = h.scrollHeight - h.clientHeight;
  if (total > 0) {
    const pct = Math.min(100, Math.max(0, (h.scrollTop / total) * 100));
    progress.style.width = pct + '%';
  } else {
    progress.style.width = '0%';
  }
}
window.updateReadingProgress = updateProgress;
window.addEventListener('scroll', updateProgress);
window.addEventListener('resize', updateProgress);

// 本文コンテナのスクロールも監視
document.addEventListener('scroll', (e) => {
  if (e.target && e.target.classList && e.target.classList.contains('story')) {
    updateProgress();
  }
}, true);

// 4. 縦書き / 横書き切り替え
const btnH = document.getElementById('btn-horizontal');
const btnV = document.getElementById('btn-vertical');

if (btnV && btnH) {
  btnV.addEventListener('click', () => {
    btnV.classList.add('active');
    btnV.setAttribute('aria-pressed', 'true');
    btnH.classList.remove('active');
    btnH.setAttribute('aria-pressed', 'false');
    document.body.classList.add('mode-vertical');
    const story = document.querySelector('.story');
    if (story) story.scrollLeft = 0;
    updateProgress();
  });

  btnH.addEventListener('click', () => {
    btnH.classList.add('active');
    btnH.setAttribute('aria-pressed', 'true');
    btnV.classList.remove('active');
    btnV.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('mode-vertical');
    updateProgress();
  });

  // 縦書き時のホイール横スクロール（本文 .story をスクロール）
  window.addEventListener('wheel', (e) => {
    if (!document.body.classList.contains('mode-vertical')) return;
    const story = document.querySelector('.story');
    if (story && e.deltaY !== 0) {
      story.scrollLeft -= e.deltaY;
      updateProgress();
      e.preventDefault();
    }
  }, { passive: false });
}
