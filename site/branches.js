(() => {
  const container = document.getElementById('live-branches');
  if (!container) return;
  const list = document.getElementById('branch-list');
  const status = document.getElementById('branch-status');
  const more = document.getElementById('more-branches');
  let cursor = null;
  let started = false;
  const element = (tag, value) => { const node = document.createElement(tag); node.textContent = value; return node; };
  const link = (label, value) => {
    const url = new URL(value);
    if (url.origin !== 'https://github.com' || url.username || url.password) throw Error('Invalid source');
    const node = element('a', label); node.href = url.href; node.rel = 'noopener noreferrer'; return node;
  };
  async function load() {
    more.disabled = true;
    try {
      const response = await fetch('/api/v1/catalog' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Unavailable');
      const data = await response.json();
      if (!Array.isArray(data.page)) throw Error('Invalid catalogue');
      const fragment = document.createDocumentFragment();
      for (const branch of data.page) {
        const section = document.createElement('section'); section.className = 'endnote'; section.id = branch.branchId;
        section.append(element('h2', branch.title), element('p', branch.maintainer + ' / ' + branch.agentName));
        if (branch.parent) {
          section.append(element('p', '親の枝：' + branch.parent.branchId + ' · 親話：' + branch.parent.episodeId));
          section.append(element('p', '受け継いだ版：' + branch.parent.revision.slice(0, 12)));
        } else section.append(element('p', 'ここが物語の起点です。'));
        const reading = element('p', '');
        if (branch.branchId === 'origin') { const first = element('a', '第1話を読む'); first.href = '../read/ep-001/'; reading.append(first); }
        else reading.append(link('この枝を読む', branch.readingUrl));
        reading.append(document.createTextNode(' / '), link('リポジトリ', branch.repository));
        section.append(reading);
        if (branch.checkedAt) section.append(element('p', '最終確認：' + new Date(branch.checkedAt).toLocaleDateString('ja-JP')));
        fragment.append(section);
      }
      if (!started) { list.replaceChildren(); started = true; }
      list.append(fragment);
      cursor = data.continueCursor;
      more.hidden = data.isDone === true;
      status.textContent = data.isDone && list.children.length <= 1 ? '外部の枝は、まだ登録されていません。' : '確認した版へ案内しています。';
    } catch {
      status.textContent = started ? '続きの読み込みができませんでした。もう一度お試しください。' : '保存済みの台帳を表示しています。';
    } finally { more.disabled = false; }
  }
  more.addEventListener('click', load);
  load();
})();
