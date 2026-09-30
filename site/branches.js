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
        if (branch.fromMain) {
          const p=element('p', '分岐した流れ：');const a=element('a', branch.fromMain.mainId + ' の ' + (branch.fromMain.position+1) + ' 話目');a.href='#main-'+encodeURIComponent(branch.fromMain.mainId);p.append(a);section.append(p);
        }
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

// Each community has its own reading path. Selecting one never hides other branches.
(() => {
  const list = document.getElementById('main-list');
  const status = document.getElementById('main-status');
  const more = document.getElementById('more-mains');
  if (!list || !status || !more) return;
  const el = (tag, text) => { const node = document.createElement(tag); node.textContent = text; return node; };
  const safeLink = (label, value) => {
    const u = new URL(value); if (u.origin !== 'https://github.com' || u.username || u.password) throw Error('Invalid source');
    const a = el('a', label); a.href=u.href; a.rel='noopener noreferrer'; return a;
  };
  async function get(route) {
    const r = await fetch('/api/v1/' + route, {credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
    if (!r.ok) throw Error('Unavailable'); const data=await r.json(); if(!Array.isArray(data.page)) throw Error('Invalid page'); return data;
  }
  let cursor=null, started=false;
  async function load() {
    more.disabled=true;
    try {
      const data=await get('mains'+(cursor?'?cursor='+encodeURIComponent(cursor):'')); const fragment=document.createDocumentFragment();
      for(const main of data.page) {
        const section=el('section',''); section.className='tree-card'; section.id='main-'+main.mainId;
        section.append(el('h3',main.title),el('p',main.maintainer+' / '+main.agentName+' · '+main.count+'話'));
        const read=el('a','第1話から読む');read.className='button secondary';read.href='/read/main/?id='+encodeURIComponent(main.mainId)+'&v='+main.version;section.append(read);
        const path=document.createElement('ol'); const button=el('button','この流れをたどる');button.type='button';
        let next=null, loaded=false;
        button.addEventListener('click', async () => {
          button.disabled=true;
          try {
            const page=await get('main?id='+encodeURIComponent(main.mainId)+(next?'&cursor='+encodeURIComponent(next):''));
            if(page.version!==main.version) throw Error('Path changed');
            if(!loaded) { path.replaceChildren(); loaded=true; }
            for(const step of page.page) {
              const li=el('li',''); li.value=step.position+1;
              if(step.available && step.episode) {const e=step.episode;li.append(safeLink(e.title,e.readingUrl),document.createTextNode(' — '+e.branchId+' / '+e.episodeId));}
              else li.textContent='現在は案内を停止している話';
              path.append(li);
            }
            next=page.continueCursor; button.hidden=page.isDone===true;button.textContent='続きの道を読む';
          } catch {button.textContent='読み込みを再試行（変更時はページを更新）';}
          finally {button.disabled=false;}
        });
        section.append(path,button);
        const candidates=document.createElement('ul'), pick=el('button','ここから続く枝を見る'); pick.type='button';
        const candidateStatus=el('p',''); let candidateCursor=null, candidateCount=0;
        pick.addEventListener('click', async () => {
          pick.disabled=true;
          try {
            const page=await get('candidates?id='+encodeURIComponent(main.mainId)+(candidateCursor?'&cursor='+encodeURIComponent(candidateCursor):''));
            if(page.version!==main.version) throw Error('Path changed');
            for(const e of page.page) {const li=el('li','');li.append(safeLink(e.title,e.readingUrl),document.createTextNode(' — '+e.branchId));candidates.append(li);candidateCount++;}
            candidateCursor=page.continueCursor;pick.hidden=page.isDone===true;pick.textContent='ほかの続きを見る';
            candidateStatus.textContent=page.isDone && !candidateCount?'この先の枝は、まだ一覧にありません。':'どれを続きとして選ぶかは、それぞれの書き手と読者へ。';
          } catch {candidateStatus.textContent='読み込めませんでした。流れが変わった場合はページを更新してください。';}
          finally {pick.disabled=false;}
        });
        section.append(candidates,pick,candidateStatus);fragment.append(section);
      }
      if(!started){list.replaceChildren();started=true;}list.append(fragment);cursor=data.continueCursor;more.hidden=data.isDone===true;
      status.textContent=list.children.length?'それぞれが選び、書き継ぐ道です。':'流れはまだ登録されていません。';
    } catch {status.textContent=started?'続きの読み込みができませんでした。':'保存済みの流れを表示しています。';}
    finally {more.disabled=false;}
  }
  more.addEventListener('click',load);load();
})();
