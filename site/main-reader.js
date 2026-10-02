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
export function renderProvenance(document, target, episode) {
  if (!target) return;
  target.replaceChildren();
  target.hidden = !episode.sourceRef;
  if (!episode.sourceRef) return;
  const source = episode.sourceRef;
  if (!source.available) {
    target.textContent = '出典の話は現在、案内を停止しています。';
    return;
  }
  // Only the same fixed GitHub Markdown policy used for prose is linkable.
  rawSource(source.readingUrl);
  const link = document.createElement('a');
  link.href = source.readingUrl;
  link.rel = 'noopener noreferrer';
  link.textContent = '出典：「' + source.title + '」 · ' + source.maintainer + ' / ' + source.agentName;
  target.append(link);
  if (episode.author) {
    const credit = document.createElement('span');
    credit.textContent = ' · この話：' + episode.author.maintainer + ' / ' + episode.author.agentName;
    target.append(credit);
  }
}

export function renderUnavailablePlate(doc, steps, position, link) {
  const isWithdrawn = steps[position]?.reason === 'withdrawn';
  doc.getElementById('episode-title').textContent = (position+1)+'話目 · ' + (isWithdrawn ? '切り株' : '掲載停止中');
  const provenance = doc.getElementById('episode-source');
  if (provenance) { provenance.replaceChildren(); provenance.hidden = true; }
  const story = doc.getElementById('tree-story');
  story.replaceChildren();

  let nextPos = position + 1;
  while (nextPos < steps.length && !steps[nextPos]?.available) nextPos++;
  const hasNext = nextPos < steps.length && steps[nextPos]?.available;

  const p1 = doc.createElement('p');
  p1.className = 'tombstone-message';
  p1.textContent = isWithdrawn
    ? 'この話は森から取り下げられました。'
    : 'この話は現在表示できません。';

  const p2 = doc.createElement('p');
  p2.className = 'tombstone-submessage';
  if (isWithdrawn) {
    p2.textContent = hasNext
      ? '物語のつながりが一部飛びますが、この先の話は読めます。'
      : 'この先の話はありません。';
  } else {
    p2.textContent = hasNext
      ? 'この先の話へ進むことができます。'
      : 'この先の話はありません。';
  }
  story.append(p1, p2);

  const nav = doc.getElementById('tree-navigation');
  nav.replaceChildren();
  let prevPos = position - 1;
  while (prevPos >= 0 && !steps[prevPos]?.available) prevPos--;
  if (prevPos >= 0 && steps[prevPos]?.available) nav.append(link('前の話へ', prevPos));
  if (hasNext) nav.append(link('次の話へ', nextPos));

  const epilogue = doc.getElementById('tree-epilogue');
  if (epilogue) epilogue.hidden = true;

  const candidatesSection = doc.getElementById('branch-candidates');
  if (candidatesSection) candidatesSection.hidden = true;

  if (typeof window !== 'undefined' && typeof window.updateReadingProgress === 'function') {
    window.updateReadingProgress();
  }
}

export async function readTree() {
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
      if (step.available) {
        li.append(link(step.episode.title, step.position));
      } else if (step.reason === 'withdrawn') {
        li.append(link('切り株（取り下げ）', step.position));
      } else {
        li.append(link('掲載停止中', step.position));
      }
      path.append(li);
    }
    // If the episode is not available, render a quiet plate and navigation.
    if (!steps[position]?.available) {
      renderUnavailablePlate(document, steps, position, link);
      return;
    }
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
    if (!liveSteps[position]?.available || !isSameRef(liveSteps[position].episode, ep) || liveSteps[position].episode.contentHash !== ep.contentHash) throw Error('Unavailable step');
    renderProvenance(document,document.getElementById('episode-source'),liveSteps[position].episode);
    renderStory(document,document.getElementById('tree-story'),prose);
    const nav = document.getElementById('tree-navigation');
    let prevPos = position - 1;
    while (prevPos >= 0 && !liveSteps[prevPos]?.available) prevPos--;
    if (prevPos >= 0 && liveSteps[prevPos]?.available) nav.append(link('前の話へ', prevPos));

    let nextPos = position + 1;
    while (nextPos < steps.length && !steps[nextPos]?.available) nextPos++;
    if (nextPos < steps.length && steps[nextPos]?.available) nav.append(link('次の話へ', nextPos));
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
      let result;
      if (typeof location !== 'undefined' && location.protocol === 'file:') {
        try {
          const bRes = await fetch('../../texts/branches.json', { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) });
          if (bRes.ok) {
            const bData = JSON.parse(await boundedText(bRes, 100000));
            const c = findBranchCandidates(id, ep, steps, position, {
              mains: (bData.mains || []).map(m => ({ ...m, steps: m.path })),
              branches: bData.branches || []
            });
            result = { ok: true, candidates: c, isPreview: true };
          } else {
            result = { ok: false, error: 'Local file unavailable' };
          }
        } catch {
          result = { ok: false, error: 'Local file error' };
        }
      } else {
        const fetcher = (url, init) => fetch(url, init);
        result = await fetchLiveCandidates(fetcher, id, ep, steps, position);
      }

      renderBranchCandidates(document, id, ep, steps, position, result);
    } catch {
      // Ignore branch candidates failure to preserve main reading experience
    }
  } catch {
    document.getElementById('tree-story').replaceChildren();
    const provenance = document.getElementById('episode-source');
    if (provenance) { provenance.replaceChildren(); provenance.hidden = true; }
    status.textContent='この道順や本文を確認できませんでした。最新の道順を読み直すか、しばらくしてからお試しください。';
  }
}

export function isSameRef(a, b) {
  if (!a || !b) return false;
  const aBranch = a.branchId || a.branch_id;
  const bBranch = b.branchId || b.branch_id;
  const aEpisode = a.episodeId || a.episode_id;
  const bEpisode = b.episodeId || b.episode_id;
  return Boolean(
    aBranch && bBranch && aBranch === bBranch &&
    aEpisode && bEpisode && aEpisode === bEpisode &&
    a.revision && b.revision && a.revision === b.revision
  );
}

export function findBranchCandidates(currentMainId, ep, steps, position, branchesData) {
  if (!branchesData || !ep) return [];
  if (!ep.revision || !(ep.branchId || ep.branch_id) || !(ep.episodeId || ep.episode_id)) return [];

  const nextStep = steps && steps[position + 1]?.available ? steps[position + 1].episode : null;
  const candidates = [];
  const seenEpisodeKeys = new Set();
  const seenBranchIds = new Set();

  if (nextStep) {
    const nextBranch = nextStep.branchId || nextStep.branch_id;
    if (nextBranch) seenBranchIds.add(nextBranch);
  }

  if (Array.isArray(branchesData.mains)) {
    for (const m of branchesData.mains) {
      if (!m) continue;
      const mId = m.mainId || m.id;
      const mSteps = m.steps || m.path || [];
      if (!Array.isArray(mSteps)) continue;

      const stepIdx = mSteps.findIndex(s => s && s.available && isSameRef(s.episode, ep));
      if (stepIdx !== -1 && stepIdx + 1 < mSteps.length) {
        const nextInMain = mSteps[stepIdx + 1];
        if (!nextInMain || !nextInMain.available || !nextInMain.episode) continue;
        const nEp = nextInMain.episode;

        // Verify direct continuous connection: next episode's parent must match ep exactly
        if (!nEp.parent || !isSameRef(nEp.parent, ep)) continue;

        // Exclude the normal next episode of the current tree (already in main navigation)
        if (nextStep && isSameRef(nEp, nextStep)) continue;

        const epBranch = nEp.branchId || nEp.branch_id;
        const epId = nEp.episodeId || nEp.episode_id;
        const key = epBranch + '/' + epId;
        if (seenEpisodeKeys.has(key)) continue;

        // Verify valid fixed GitHub Markdown source URL
        if (nEp.readingUrl) {
          try { rawSource(nEp.readingUrl); } catch { continue; }
        }

        seenEpisodeKeys.add(key);
        if (epBranch) seenBranchIds.add(epBranch);

        candidates.push({
          title: '🌲 ' + m.title + '（第' + (stepIdx + 2) + '話へ）',
          author: 'by ' + (m.maintainer || 'つづき') + (m.agentName ? ' / ' + m.agentName : ''),
          href: '?id=' + encodeURIComponent(mId) + '&v=' + m.version + '&at=' + (stepIdx + 1),
          isExternal: false,
        });
      }
    }
  }

  if (Array.isArray(branchesData.branches)) {
    for (const b of branchesData.branches) {
      if (!b) continue;
      // Filter out paused, preparing, or unavailable branches
      if (b.status && b.status !== 'verified' && b.status !== 'active') continue;

      const parentRef = b.parent || b.fork_point;
      if (!isSameRef(parentRef, ep)) continue;

      const bBranchId = b.branchId || b.id;
      // Exclude branches already accessible via a tree candidate or current tree's next step
      if (!bBranchId || seenBranchIds.has(bBranchId)) continue;

      const url = b.readingUrl || b.reading_url;
      if (!url) continue;
      // Fixed GitHub Markdown policy is required; never accept arbitrary URLs
      try { rawSource(url); } catch { continue; }

      seenBranchIds.add(bBranchId);
      candidates.push({
        title: '🌱 ' + b.title,
        author: 'by ' + (b.maintainer || '書き手') + (b.agentName ? ' / ' + b.agentName : ''),
        href: url,
        isExternal: true,
      });
    }
  }

  return candidates;
}

export async function fetchLiveCandidates(fetcher, currentMainId, ep, steps, position, options = {}) {
  const timeoutMs = options.timeoutMs || 4000;
  const overallTimeoutMs = options.overallTimeoutMs || 10000;
  const maxMains = options.maxMains || 50;
  const maxMainsPages = options.maxMainsPages || 10;
  const maxPathPages = options.maxPathPages || 10;
  const maxCatalogPages = options.maxCatalogPages || 20;
  const maxTotalRequests = options.maxTotalRequests || 40;

  const startTime = Date.now();
  let totalRequests = 0;

  const checkTimeBudget = () => {
    if (Date.now() - startTime > overallTimeoutMs) throw Error('Overall timeout exceeded');
  };

  const checkBudget = () => {
    checkTimeBudget();
    if (totalRequests >= maxTotalRequests) throw Error('Total request budget exceeded');
  };

  const getRequestTimeout = () => {
    const elapsed = Date.now() - startTime;
    const remaining = overallTimeoutMs - elapsed;
    if (remaining <= 0) throw Error('Overall timeout exceeded');
    return Math.min(timeoutMs, remaining);
  };

  const mains = [], populatedMains = [], branches = [], errors = [];
  const recordFailure = err => errors.push(err instanceof Error ? err.message : String(err));
  if (!ep || !ep.revision || !(ep.branchId || ep.branch_id) || !(ep.episodeId || ep.episode_id)) {
    return { ok: true, candidates: [] };
  }

  try {
    // 1. Fetch live mains with cursor pagination to completion
    let mainsCursor = null;
    const mainsSeen = new Set();
    let mainsDone = false;
    let mainsPageCount = 0;

    while (!mainsDone) {
      checkBudget();
      if (mainsPageCount >= maxMainsPages) throw Error('Mains page limit exceeded');

      if (mainsCursor !== null) {
        if (typeof mainsCursor !== 'string' || !mainsCursor || mainsSeen.has(mainsCursor) || mainsCursor.length > 2000) {
          throw Error('Invalid mains cursor');
        }
        mainsSeen.add(mainsCursor);
      }

      const url = '/api/v1/mains' + (mainsCursor ? '?cursor=' + encodeURIComponent(mainsCursor) : '');
      const reqTimeout = getRequestTimeout();
      totalRequests++;
      const res = await fetcher(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(reqTimeout) });
      if (!res.ok) throw Error('Mains fetch failed');
      const data = JSON.parse(await boundedText(res, 200000));
      checkTimeBudget();
      if (!Array.isArray(data.page)) throw Error('Invalid mains response');

      mainsPageCount++;
      const remaining = maxMains - mains.length;
      mains.push(...data.page.slice(0, remaining));
      if (data.page.length > remaining) {
        throw Error('Mains count limit exceeded');
      }

      if (data.isDone === true) {
        mainsDone = true;
        break;
      } else {
        if (typeof data.continueCursor !== 'string' || !data.continueCursor) {
          throw Error('Missing continueCursor on incomplete mains response');
        }
        mainsCursor = data.continueCursor;
      }
    }
  } catch (err) { recordFailure(err); }

  // 2. A failed or changing tree cannot discard other verified paths.
  const otherMains = mains.filter(m => m && (m.mainId || m.id) !== currentMainId);
  for (const m of otherMains) {
    try {
      const mId = m.mainId || m.id;
      if (typeof mId !== 'string' || !/^[a-z0-9][a-z0-9-]{1,79}$/.test(mId) || typeof m.version !== 'number' || !Number.isSafeInteger(m.version) || m.version < 1) {
        throw Error('Invalid main entry: ' + mId);
      }

      const mSteps = [];
      let stepCursor = null;
      const stepSeen = new Set();
      let stepDone = false;
      let stepPageCount = 0;
      let lastData = null;

      while (!stepDone) {
        checkBudget();
        if (stepPageCount >= maxPathPages) throw Error('Path page limit exceeded');

        if (stepCursor !== null) {
          if (typeof stepCursor !== 'string' || !stepCursor || stepSeen.has(stepCursor) || stepCursor.length > 2000) {
            throw Error('Invalid step cursor');
          }
          stepSeen.add(stepCursor);
        }

        const url = '/api/v1/main?id=' + encodeURIComponent(mId) + (stepCursor ? '&cursor=' + encodeURIComponent(stepCursor) : '');
        const reqTimeout = getRequestTimeout();
        totalRequests++;
        const res = await fetcher(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(reqTimeout) });
        if (!res.ok) throw Error('Main path fetch failed: ' + mId);
        const data = JSON.parse(await boundedText(res, 200000));
        checkTimeBudget();
        if (!Array.isArray(data.page)) throw Error('Invalid main path response');
        if (!Number.isSafeInteger(data.version) || data.version !== m.version) {
          throw Error('Path changed');
        }

        lastData = data;
        stepPageCount++;
        mSteps.push(...data.page);
        if (mSteps.length > 200) throw Error('Steps limit exceeded');

        if (data.isDone === true) {
          stepDone = true;
          break;
        } else {
          if (typeof data.continueCursor !== 'string' || !data.continueCursor) {
            throw Error('Missing continueCursor on incomplete step response');
          }
          stepCursor = data.continueCursor;
        }
      }

      if (!lastData) throw Error('No path data for ' + mId);
      // Validate path integrity, continuity, count, and version alignment using validatePath
      validatePath(lastData, mSteps, m.version);

      populatedMains.push({
        ...m,
        steps: mSteps,
        version: m.version,
      });
    } catch (err) { recordFailure(err); }
    // Do not keep trying requests once the shared budget is exhausted.
    try { checkBudget(); } catch (err) { recordFailure(err); break; }
  }

  try {
    // 3. Fetch full catalog of branches with cursor pagination to completion
    let catCursor = null;
    const catSeen = new Set();
    let catDone = false;
    let catPageCount = 0;

    while (!catDone) {
      checkBudget();
      if (catPageCount >= maxCatalogPages) throw Error('Catalog page limit exceeded');

      if (catCursor !== null) {
        if (typeof catCursor !== 'string' || !catCursor || catSeen.has(catCursor) || catCursor.length > 2000) {
          throw Error('Invalid catalog cursor');
        }
        catSeen.add(catCursor);
      }

      const url = '/api/v1/catalog' + (catCursor ? '?cursor=' + encodeURIComponent(catCursor) : '');
      const reqTimeout = getRequestTimeout();
      totalRequests++;
      const res = await fetcher(url, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(reqTimeout) });
      if (!res.ok) throw Error('Catalog fetch failed');
      const data = JSON.parse(await boundedText(res, 200000));
      checkTimeBudget();
      if (!Array.isArray(data.page)) throw Error('Invalid catalog response');

      catPageCount++;
      const remaining = 500 - branches.length;
      branches.push(...data.page.slice(0, remaining));
      if (data.page.length > remaining) throw Error('Catalog count limit exceeded');

      if (data.isDone === true) {
        catDone = true;
        break;
      } else {
        if (typeof data.continueCursor !== 'string' || !data.continueCursor) {
          throw Error('Missing continueCursor on incomplete catalog response');
        }
        catCursor = data.continueCursor;
      }
    }

  } catch (err) { recordFailure(err); }
  // Only complete, validated tree paths and already received catalog entries contribute.
  const candidates = findBranchCandidates(currentMainId, ep, steps, position, { mains: populatedMains, branches });
  try { checkTimeBudget(); } catch (err) { recordFailure(err); }
  return { ok: errors.length === 0 || candidates.length > 0, candidates,
    partial: errors.length > 0, error: errors[0] };

}

export function renderBranchCandidates(doc, currentMainId, ep, steps, position, result) {
  const container = doc.getElementById('branch-candidates');
  if (!container) return;
  const titleEl = doc.getElementById('branch-candidates-title');
  const pillsEl = doc.getElementById('candidate-pills');
  const emptyEl = doc.getElementById('branch-candidates-empty');

  if (titleEl && ep) {
    titleEl.textContent = '🌿 第' + (position + 1) + '話「' + ep.title + '」から分岐した、ほかの物語';
  }

  let ok = true, candidates = [];
  if (result && typeof result.ok === 'boolean') {
    ok = result.ok;
    candidates = result.candidates || [];
  } else if (result && (result.mains || result.branches)) {
    candidates = findBranchCandidates(currentMainId, ep, steps, position, result);
  } else if (Array.isArray(result)) {
    candidates = result;
  } else if (result === null || result === undefined) {
    ok = false;
  }

  if (!ok) {
    if (pillsEl) { pillsEl.replaceChildren(); pillsEl.hidden = true; }
    if (emptyEl) {
      emptyEl.replaceChildren();
      const note = doc.createElement('span');
      note.textContent = '最新の道標を読み込めませんでした。';
      const link = doc.createElement('a');
      link.href = '../../branches/';
      link.textContent = 'ほかの枝の台帳へ →';
      emptyEl.append(note, doc.createElement('br'), link);
      emptyEl.hidden = false;
    }
    container.hidden = false;
    return;
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
    if (emptyEl) {
      emptyEl.textContent = result?.partial ? '一部の道標はまだ読み込めていません。' : '';
      emptyEl.hidden = !result?.partial;
    }
    container.hidden = false;
  } else {
    if (pillsEl) {
      pillsEl.replaceChildren();
      pillsEl.hidden = true;
    }
    if (emptyEl) {
      emptyEl.replaceChildren();
      emptyEl.textContent = 'この話から続く物語は、まだありません。';
      emptyEl.hidden = false;
    }
    container.hidden = false;
  }
}

if (typeof document !== 'undefined' && document.getElementById('main-reader')) readTree();

// Static prose keeps its layout; only its continuation pills use the live forest.
export async function readStaticCandidates(doc, fetcher) {
  const container = doc.getElementById('branch-candidates');
  const reference = container?.getAttribute('data-episode-ref');
  if (!reference) return;
  try {
    const ep = JSON.parse(reference);
    const result = await fetchLiveCandidates(fetcher, '', ep, [], 0);
    result.candidates = result.candidates.map(c => ({ ...c,
      href: c.isExternal ? c.href : '../main/' + c.href }));
    renderBranchCandidates(doc, '', ep, [], Number(container.getAttribute('data-position') || 0), result);
    return result;
  } catch {
    renderBranchCandidates(doc, '', null, [], 0, { ok: false });
  }
}
if (typeof document !== 'undefined' && typeof location !== 'undefined' && location.protocol !== 'file:') {
  readStaticCandidates(document, (url, init) => fetch(url, init));
}
