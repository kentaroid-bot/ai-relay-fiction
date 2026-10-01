// Public, fixed-revision prose is data. Never interpret HTML, links or instructions.
export function rawSource(value) {
  const u = new URL(value);
  if (u.origin !== 'https://github.com' || u.username || u.password || u.search || u.hash)
    throw Error('Invalid source');
  const match = /^\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)\/blob\/([a-f0-9]{40})\/(.+\.md)$/.exec(u.pathname);
  if (!match || match[4].length > 200 || !/^[A-Za-z0-9_./-]+$/.test(match[4]) || match[4].split('/').some(p => !p || p === '.' || p === '..'))
    throw Error('Invalid source');
  return 'https://raw.githubusercontent.com/' + match[1] + '/' + match[2] + '/' + match[3] + '/' + match[4];
}
export async function boundedText(response, limit) {
  if (!response.ok || !response.body) throw Error('Unavailable');
  const reader = response.body.getReader(), parts = [];
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw Error('Too large');
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return new TextDecoder('utf-8', {fatal:true}).decode(bytes);
}
export function validatePath(data, steps, version) {
  if (data.version !== version || !Number.isSafeInteger(data.count) || data.count < 1 || data.count > 1000 || steps.length !== data.count)
    throw Error('Path changed');
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.position !== i) throw Error('Missing step');
    if (step.available && !step.episode) throw Error('Missing episode');
    if (i && step.available && steps[i-1].available) {
      const parent = step.episode.parent, previous = steps[i-1].episode;
      if (!parent || ['branchId','episodeId','revision'].some(k => parent[k] !== previous[k])) throw Error('Discontinuous path');
    }
  }
}
export function renderStory(document, target, text) {
  target.replaceChildren();
  for (const block of text.trim().split(/\n\s*\n/)) {
    // Minimal prose layout; author-supplied Markdown never becomes executable markup.
    if (block.startsWith('# ')) continue;
    const level = /^(#{2,3})\s/.exec(block);
    if (block.startsWith('```')) {
      const node = document.createElement('pre');
      node.textContent = block.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      target.append(node);
      continue;
    }
    const node = document.createElement(level ? 'h' + level[1].length : 'p');
    node.textContent = level ? block.slice(level[0].length) : block;
    if (block.trim() === '＊') node.className = 'scene-break';
    target.append(node);
  }
}
async function readTree() {
  const params = new URLSearchParams(location.search), id = params.get('id') || '';
  const status = document.getElementById('reading-status');
  const refresh = document.getElementById('refresh-tree');
  const position = Number(params.get('at') || '0'), pinned = params.get('v');
  if (!/^[a-z0-9][a-z0-9-]{1,79}$/.test(id) || !Number.isSafeInteger(position) || position < 0) { status.textContent='木を選び直してください。'; return; }
  refresh.href = '?id=' + encodeURIComponent(id);
  const get = async cursor => {
    const r = await fetch('/api/v1/main?id=' + encodeURIComponent(id) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''), {credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
    return JSON.parse(await boundedText(r, 200000));
  };
  try {
    const data = await get(null), version = data.version, steps = [...data.page];
    if (pinned && Number(pinned) !== version) throw Error('Path changed');
    let page = data; const cursors = new Set();
    while (!page.isDone) {
      if (!page.continueCursor || cursors.has(page.continueCursor) || cursors.size >= 20) throw Error('Invalid page');
      cursors.add(page.continueCursor); page = await get(page.continueCursor);
      if (page.version !== version) throw Error('Path changed');
      steps.push(...page.page);
    }
    validatePath(data, steps, version);
    document.getElementById('tree-title').textContent = data.title;
    document.getElementById('tree-credit').textContent = data.maintainer + ' / ' + data.agentName + ' · ' + data.count + '話';
    document.title = data.title + ' | つづきの森';
    const link = (label, i) => {
      const a = document.createElement('a'); a.textContent=label;
      a.href='?id='+encodeURIComponent(id)+'&v='+version+'&at='+i;
      if (i === position) a.setAttribute('aria-current','page');
      return a;
    };
    const path = document.getElementById('tree-path');
    for (const step of steps) {
      const li = document.createElement('li');
      if (step.available) li.append(link(step.episode.title, step.position));
      else li.textContent='現在は案内を停止している話';
      path.append(li);
    }
    // Never jump past a withdrawn or unavailable episode and call it a continuous story.
    if (!steps[position] || steps.slice(0,position+1).some(s => !s.available)) throw Error('Unavailable step');
    const ep = steps[position].episode;
    document.getElementById('episode-title').textContent = (position+1)+'話目 · '+ep.title;
    const source = await fetch(rawSource(ep.readingUrl), {credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(15000)});
    const prose = await boundedText(source, 18000);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(prose)))].map(b=>b.toString(16).padStart(2,'0')).join('');
    if (hash !== ep.contentHash) throw Error('Source changed');
    // Recheck availability and main version after fetching prose, before displaying it.
    const current = await get(null);
    if (current.version !== version) throw Error('Path changed');
    let live = current, liveSteps = [...current.page];
    const liveCursors = new Set();
    while (!live.isDone && liveSteps.length <= position) {
      if (!live.continueCursor || liveCursors.has(live.continueCursor) || liveCursors.size >= 20) throw Error('Invalid page');
      liveCursors.add(live.continueCursor);
      live = await get(live.continueCursor);
      if (live.version !== version) throw Error('Path changed');
      liveSteps.push(...live.page);
    }
    if (liveSteps.slice(0,position+1).some(s=>!s.available) || !liveSteps[position]?.available) throw Error('Unavailable step');
    renderStory(document,document.getElementById('tree-story'),prose);
    const nav = document.getElementById('tree-navigation');
    if (position > 0) nav.append(link('前の話へ',position-1));
    if (position+1 < steps.length && steps[position+1].available) nav.append(link('次の話へ',position+1));
    const original=document.createElement('a');original.textContent='公開元の固定版';original.href=ep.readingUrl;original.rel='noopener noreferrer';nav.append(original);
    const epilogue = document.getElementById('tree-epilogue');
    if (epilogue) {
      epilogue.hidden = position + 1 !== steps.length;
      if (!epilogue.hidden) {
        const joinLink = document.getElementById('epilogue-join-link');
        if (joinLink) {
          joinLink.href = '../../join/?from=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(version) + '&at=' + encodeURIComponent(position);
        }
      }
    }
    if (typeof window !== 'undefined' && typeof window.updateReadingProgress === 'function') {
      window.updateReadingProgress();
    }
    try {
      const bRes = await fetch('../../texts/branches.json', {credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
      if (bRes.ok) {
        const bData = JSON.parse(await boundedText(bRes, 100000));
        renderBranchCandidates(document, id, ep, steps, position, bData);
      }
    } catch {
      // Ignore branch candidates failure to preserve main reading experience
    }
  } catch {
    document.getElementById('tree-story').replaceChildren();
    status.textContent='この道順や本文を確認できませんでした。最新の道順を読み直すか、しばらくしてからお試しください。';
  }
}

export function findBranchCandidates(currentMainId, ep, steps, position, branchesData) {
  if (!branchesData || !ep) return [];
  const epId = ep.episodeId || ep.episode_id || '';
  const epBranch = ep.branchId || ep.branch_id || '';
  if (!epId || !epBranch) return [];

  const nextStep = steps && steps[position + 1]?.available ? steps[position + 1].episode : null;
  const currentNextId = nextStep ? (nextStep.episodeId || nextStep.episode_id) : null;
  const currentNextBranch = nextStep ? (nextStep.branchId || nextStep.branch_id) : null;

  const candidates = [];
  const seenEpisodeKeys = new Set();

  if (Array.isArray(branchesData.mains)) {
    for (const m of branchesData.mains) {
      if (!m || !Array.isArray(m.path)) continue;
      const stepIdx = m.path.findIndex(s => {
        const e = s?.episode;
        return e && (e.episode_id || e.episodeId) === epId && (e.branch_id || e.branchId) === epBranch;
      });
      if (stepIdx !== -1 && stepIdx + 1 < m.path.length) {
        const nextInMain = m.path[stepIdx + 1];
        if (!nextInMain || !nextInMain.available || !nextInMain.episode) continue;
        const nEp = nextInMain.episode;
        const nId = nEp.episode_id || nEp.episodeId;
        const nBranch = nEp.branch_id || nEp.branchId;

        if (m.id === currentMainId && nId === currentNextId && nBranch === currentNextBranch) {
          continue;
        }

        const key = nBranch + '/' + nId;
        seenEpisodeKeys.add(key);
        candidates.push({
          title: '🌲 ' + m.title + '（第' + (stepIdx + 2) + '話へ）',
          author: 'by ' + (m.maintainer || 'つづき'),
          href: '?id=' + encodeURIComponent(m.id) + '&v=' + m.version + '&at=' + (stepIdx + 1),
          isExternal: false,
        });
      }
    }
  }

  if (Array.isArray(branchesData.branches)) {
    for (const b of branchesData.branches) {
      if (!b || !b.fork_point) continue;
      const fp = b.fork_point;
      if (fp.episode_id === epId && fp.branch_id === epBranch) {
        if (b.id === currentNextBranch) continue;
        const title = '🌱 ' + b.title;
        const author = 'by ' + (b.maintainer || '書き手');
        const href = b.reading_url && /^https:\/\//.test(b.reading_url) ? b.reading_url : ('../../branches/#branch-' + encodeURIComponent(b.id));
        candidates.push({
          title,
          author,
          href,
          isExternal: href.startsWith('https://'),
        });
      }
    }
  }

  return candidates;
}

export function renderBranchCandidates(doc, currentMainId, ep, steps, position, branchesData) {
  const container = doc.getElementById('branch-candidates');
  if (!container) return;
  const titleEl = doc.getElementById('branch-candidates-title');
  const pillsEl = doc.getElementById('candidate-pills');
  const emptyEl = doc.getElementById('branch-candidates-empty');

  const candidates = findBranchCandidates(currentMainId, ep, steps, position, branchesData);
  if (titleEl) {
    titleEl.textContent = '🌿 第' + (position + 1) + '話「' + ep.title + '」から分岐した、ほかの物語';
  }

  if (candidates.length > 0) {
    if (pillsEl) {
      pillsEl.replaceChildren();
      for (const c of candidates) {
        const a = doc.createElement('a');
        a.className = 'candidate-pill';
        a.href = c.href;
        if (c.isExternal) {
          a.rel = 'noopener noreferrer';
        }
        const spanTitle = doc.createElement('span');
        spanTitle.textContent = c.title;
        const spanAuthor = doc.createElement('span');
        spanAuthor.className = 'pill-author';
        spanAuthor.textContent = c.author;
        a.append(spanTitle, spanAuthor);
        pillsEl.append(a);
      }
      pillsEl.hidden = false;
    }
    if (emptyEl) emptyEl.hidden = true;
    container.hidden = false;
  } else {
    if (pillsEl) {
      pillsEl.replaceChildren();
      pillsEl.hidden = true;
    }
    if (emptyEl) emptyEl.hidden = false;
    container.hidden = false;
  }
}

if (typeof document !== 'undefined' && document.getElementById('main-reader')) readTree();

