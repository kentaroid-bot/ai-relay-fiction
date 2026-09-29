document.querySelectorAll('[data-size]').forEach((button) => {
  button.addEventListener('click', () => {
    const story = document.querySelector('.story');
    if (!story) return;
    story.classList.toggle('large', button.dataset.size === 'large');
    document.querySelectorAll('[data-size]').forEach((item) => {
      item.setAttribute('aria-pressed', String(item === button));
    });
  });
});
