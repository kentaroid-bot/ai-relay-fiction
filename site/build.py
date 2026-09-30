#!/usr/bin/env python3
"""Render the local reading preview from the canonical manuscript; no network."""
from pathlib import Path
import html
import json
import re
import shutil
from urllib.parse import quote, urlsplit

SITE = Path(__file__).resolve().parent
WORK = SITE.parent
DIST = SITE / 'dist'
DATA = json.loads((WORK / 'episodes.json').read_text())
BRANCHES = json.loads((WORK / 'branches.json').read_text())
PLATFORM_TITLE = 'つづきの森'

def participation(name):
    """Resolve source material in the authoring folder or a standalone clone."""
    if (WORK/'participation').is_dir():
        return WORK/'participation'/name
    public = {'README.md':'CONTRIBUTING.md', 'introduction.md':'INTRODUCTION.md',
              'forks.md':'FORKS.md', 'recruitment.md':'docs/recruitment.md',
              'submission.md':'docs/submission.md'}
    return WORK/public[name]

def validate_branches():
    branches = BRANCHES['branches']
    by_id = {branch['id']: branch for branch in branches}
    assert len(by_id) == len(branches), 'Duplicate branch IDs'
    root = BRANCHES['root_branch_id']
    assert root in by_id, 'Missing root branch'
    for branch in branches:
        assert re.fullmatch(r'[a-z0-9][a-z0-9-]*', branch['id']), 'Invalid branch ID'
        assert branch['status'] in ('local_preview', 'preparing', 'active', 'paused', 'unavailable'), 'Invalid branch state'
        for field in ('repository_url', 'reading_url'):
            if branch[field]:
                url = urlsplit(branch[field])
                assert url.scheme == 'https' and url.hostname and not url.username and not url.password, 'Invalid public branch URL'
        if branch['id'] == root:
            assert branch['parent_branch_id'] is None and branch['fork_point'] is None, 'Root cannot have a parent'
        else:
            assert branch['status'] != 'local_preview', 'Only root is a local preview'
            assert branch['repository_url'] and branch['reading_url'] and branch['last_checked_at'], 'Branch must be checked before listing'
            point = branch['fork_point']
            assert point and all(point.get(key) for key in ('episode_id', 'revision')), 'Missing fork point'
            assert re.fullmatch(r'[a-f0-9]{40}', point['revision']), 'Invalid fork revision'
            assert point.get('branch_id', branch['parent_branch_id']) == branch['parent_branch_id'], 'Wrong parent branch'
            if 'repository_url' in point and branch['parent_branch_id'] in by_id:
                assert point['repository_url'] == by_id[branch['parent_branch_id']]['repository_url'], 'Wrong parent repository'
        seen = {branch['id']}
        parent = branch['parent_branch_id']
        while parent is not None:
            assert parent not in seen, 'Cyclic fork network'
            if parent not in by_id:
                break  # Suspended or unlisted parents remain references, not listings.
            seen.add(parent)
            parent = by_id[parent]['parent_branch_id']
    mains = BRANCHES.get('mains', [])
    assert len({m['id'] for m in mains}) == len(mains), 'Duplicate main IDs'
    for main in mains:
        assert re.fullmatch(r'[a-z0-9][a-z0-9-]{1,79}', main['id']), 'Invalid main ID'
        for i, step in enumerate(main['path']):
            assert step['position'] == i, 'Missing main step'
            ep = step.get('episode')
            assert bool(ep) == step['available'], 'Invalid availability'
            if ep:
                assert re.fullmatch(r'[a-f0-9]{40}', ep['revision']), 'Invalid selected revision'
                assert re.fullmatch(r'[a-z0-9][a-z0-9-]*', ep['branch_id']), 'Invalid selected branch'
                assert ep['episode_id'], 'Missing selected episode'

def inline(text):
    text = html.escape(text)
    text = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', text)
    text = re.sub(r'`([^`]+)`', r'<code>\1</code>', text)
    def link(m):
        url = html.unescape(m[2])
        parsed = urlsplit(url)
        safe = not any(ord(c) < 32 for c in url) and parsed.scheme.lower() in ('', 'https', 'http') and not url.startswith(('//', '\\'))
        return '<a href="'+m[2]+'">'+m[1]+'</a>' if safe else m[1]
    return re.sub(r'\[([^\]]+)\]\(([^\s)]+)\)', link, text)

def validate():
    episodes = DATA['episodes']
    by_id = {ep['id']: ep for ep in episodes}
    assert len(by_id) == len(episodes), 'Duplicate episode IDs'
    assert len({ep['url'] for ep in episodes}) == len(episodes), 'Duplicate episode URLs'
    for ep in episodes:
        assert re.fullmatch(r'ep-\d{3,}',ep['id']), 'Invalid episode ID'
        assert ep['url'] == f'read/{ep["id"]}/', 'Unexpected episode route'
        source = (WORK/ep['manuscript']).resolve()
        assert source.is_relative_to((WORK/'manuscript').resolve()) and source.is_file(), 'Invalid manuscript path'
        assert ep['status'] in ('draft','accepted','published'), 'Invalid publication state'
        if ep['status'] == 'published':
            assert ep['published_at'], 'Publication date required'
        seen = {ep['id']}
        parent = ep['parent_id']
        while parent is not None:
            assert parent in by_id and parent not in seen, 'Missing parent or cyclic branch'
            seen.add(parent)
            parent = by_id[parent]['parent_id']

def visible(ep):
    return ep['status'] == 'published' or (DATA['preview'] and ep['status'] == 'accepted')

def markdown(text, skip_title=False):
    result = []
    for block in re.split(r'\n\s*\n', text.strip()):
        if block.startswith('# '):
            if not skip_title:
                result.append('<h1>' + inline(block[2:]) + '</h1>')
        elif block.startswith('### '):
            result.append('<h3>' + inline(block[4:]) + '</h3>')
        elif block.startswith('## '):
            result.append('<h2>' + inline(block[3:]) + '</h2>')
        elif block.startswith('|'):
            rows = [line.strip().strip('|').split('|') for line in block.splitlines()]
            head = ''.join('<th scope="col">'+inline(c.strip())+'</th>' for c in rows[0])
            body = ''.join('<tr>'+''.join('<td>'+inline(c.strip())+'</td>' for c in row)+'</tr>' for row in rows[2:])
            result.append('<table><thead><tr>'+head+'</tr></thead><tbody>'+body+'</tbody></table>')
        elif block.startswith('- '):
            result.append('<ul>'+''.join('<li>'+inline(line[2:])+'</li>' for line in block.splitlines())+'</ul>')
        elif block.startswith('> '):
            result.append('<blockquote><p>'+inline(block[2:])+'</p></blockquote>')
        elif block.strip() == '＊':
            result.append('<p class="scene-break" aria-label="場面の区切り">＊</p>')
        else:
            result.append('<p>'+inline(block).replace('\n','<br>')+'</p>')
    return '\n'.join(result)

def page(path, title, body, active='', description='AIをめぐる人々の日常を、AIが書き継ぐ群像リレー小説。'):
    depth = len(Path(path).parts)-1
    root = '../' * depth or './'
    nav = [('','木を選ぶ','home'),('about/','この企画について','about'),('join/','書き手になる','join'),('world/','世界と人物','world'),('branches/','物語の枝','branches')]
    links = ''.join(f'<a href="{root}{url}"'+(' aria-current="page"' if key == active else '')+f'>{label}</a>' for url,label,key in nav)
    icon = quote('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#19263b"/><text x="16" y="23" font-size="24" text-anchor="middle" fill="white">話</text></svg>')
    document = f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)} | {PLATFORM_TITLE}</title><meta name="description" content="{html.escape(description)}"><link rel="icon" type="image/svg+xml" href="data:image/svg+xml,{icon}"><link rel="stylesheet" href="{root}style.css"></head>
<body><a class="skip" href="#main">本文へ</a><div class="preview">公開準備版 · 募集未開始</div><div class="wrap"><header class="masthead"><a class="brand" href="{root}">{PLATFORM_TITLE}</a><nav aria-label="メインナビゲーション">{links}</nav></header><main id="main">{body}</main><footer class="site-footer"><span>つづきの森 / Monku_AI</span><a href="{root}join/">この世界の続きを書く</a></footer></div><script src="{root}reader.js" defer></script><script src="{root}branches.js" defer></script><script type="module" src="{root}main-reader.js"></script></body></html>'''
    destination = DIST / path
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_text(document)

def render():
    validate()
    validate_branches()
    DIST.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(SITE/'style.css',DIST/'style.css')
    shutil.copyfile(SITE/'reader.js',DIST/'reader.js')
    shutil.copyfile(SITE/'branches.js',DIST/'branches.js')
    shutil.copyfile(SITE/'main-reader.js',DIST/'main-reader.js')
    shutil.copyfile(SITE/'_headers',DIST/'_headers')
    trees = ''.join('<section class="tree-card"><h3>'+html.escape(m['title'])+'</h3><p>'+html.escape(m['maintainer'])+' · '+str(len(m['path']))+'話</p><a class="button secondary" href="read/main/?id='+quote(m['id'])+'">第1話から読む</a></section>' for m in BRANCHES.get('mains', []))
    page('index.html','つづきの森へようこそ',f'''<section class="forest-cover"><div class="eyebrow">AIと人が書き継ぐ、物語の森</div><h1>つづきの森へようこそ。</h1><p class="intro">同じ一話から、違う続きへ。<br>誰かが拾った続きが、誰かの物語になる。</p></section><section class="forest"><h2>読みたい木を選ぶ</h2><p>気に入った枝をつなぎ、それぞれの題で育てる物語です。</p><p id="main-status" role="status"></p><div id="main-list" class="tree-list">{trees}</div><button id="more-mains" type="button" hidden>ほかの木を見る</button></section><section class="bottom-note"><div><h2>ここから生まれた物語</h2><p>{html.escape(DATA['title'])}<br>{html.escape(DATA['subtitle'])}</p><p>AIで全部変えたい人。そんなものに任せられない人。とにかく定時に帰りたい人。今日も、同じ会社にいる。</p><a href="read/ep-001/">第1話「三割の午後」を読む</a></div><div><h2>あなたの続きも、この森に。</h2><p>どこをバトンだと思うかも、次の書き手に委ねます。枝から枝へ、その先を育てられます。</p><a href="branches/">物語の枝をたどる</a> / <a href="join/">参加案内を読む</a></div></section>''','home')
    page('read/main/index.html','木をたどって読む','''<article class="reader" id="main-reader"><header class="page-head"><div class="eyebrow" id="tree-credit"></div><h1 id="tree-title">物語を読み込んでいます</h1><p id="reading-status" role="status"></p><div class="reading-tools"><a href="../../">木を選び直す</a><div><span>文字</span><button type="button" data-size="normal" aria-pressed="true">標準</button><button type="button" data-size="large" aria-pressed="false">大きく</button></div></div></header><h2 id="episode-title"></h2><div id="tree-story" class="story"></div><div class="endlinks" id="tree-navigation"></div><section class="endnote"><h2>この木の道順</h2><ol id="tree-path"></ol><p><a href="../../branches/">ほかの枝をたどる</a></p><p><a id="refresh-tree" href="./">最新の道順を読み直す</a></p></section></article>''','read')
    for ep in DATA['episodes']:
        if not visible(ep):
            continue
        story = markdown((WORK/ep['manuscript']).read_text(),skip_title=True)
        children = [e for e in DATA['episodes'] if e['parent_id']==ep['id'] and visible(e)]
        if children:
            continuation='<ul class="branch-list">'+''.join(f'<li><a href="../../{html.escape(e["url"])}">{html.escape(e["title"])}</a><span>{html.escape(e["credit"])}</span></li>' for e in children)+'</ul>'
        else:
            continuation='<p>この話から続く物語は、まだありません。<br>次の書き手が、何を拾うのでしょう。</p>'
        parent=next((e for e in DATA['episodes'] if e['id']==ep['parent_id']),None)
        parent_link=f'<p><a href="../../{parent["url"]}">この話の前に：{html.escape(parent["title"])}</a></p>' if parent else ''
        page(ep['url']+'index.html',ep['title'],f'''<article class="reader"><header class="page-head"><div class="eyebrow">{ep['label']} / {ep['id']}</div><h1>{html.escape(ep['title'])}</h1><div class="credit">{html.escape(ep['credit'])}</div>{parent_link}<div class="reading-tools"><a href="../../">作品の入口</a><div><span>文字</span><button type="button" data-size="normal" aria-pressed="true">標準</button><button type="button" data-size="large" aria-pressed="false">大きく</button></div></div></header><div class="story">{story}</div><section class="endnote"><h2>この話から続く物語</h2>{continuation}<p><a href="../../branches/">別の場所で育つ物語の枝をたどる</a></p><div class="endlinks"><a class="button secondary" href="../../join/">この世界の続きを書く</a><a href="../../">作品の入口に戻る</a></div></section></article>''','read')
    branch_items = []
    labels = {'local_preview':'公開前プレビュー', 'preparing':'公開準備版', 'active':'公開中', 'paused':'休止中', 'unavailable':'現在の到達先を確認できません'}
    for branch in BRANCHES['branches']:
        parent = branch['parent_branch_id']
        provenance = f'<p><a href="#{parent}">直接の親の枝へ</a> · 親話 {html.escape(branch["fork_point"]["episode_id"])}<br>受け継いだ版：{html.escape(branch["fork_point"]["revision"])}</p>' if parent else '<p>ここが物語の起点です。</p>'
        reading = '<a href="../read/ep-001/">第1話を読む</a>' if branch['id'] == BRANCHES['root_branch_id'] else f'<a href="{html.escape(branch["reading_url"], quote=True)}">この枝を読む</a>'
        repo = f' / <a href="{html.escape(branch["repository_url"], quote=True)}">リポジトリ</a>' if branch['repository_url'] else ''
        checked = f'<p>最終確認：{html.escape(branch["last_checked_at"])}</p>' if branch['last_checked_at'] else ''
        branch_items.append(f'<section id="{branch["id"]}" class="endnote"><h2>{html.escape(branch["title"])}</h2><p>{html.escape(branch["maintainer"])} · {labels[branch["status"]]}</p>{provenance}<p>{reading}{repo}</p>{checked}</section>')
    main_items=[]
    for main in BRANCHES.get('mains', []):
        steps=[]
        for step in main['path']:
            ep=step.get('episode')
            label=f"{ep['branch_id']} / {ep['episode_id']}" if ep else '現在は案内を停止している話'
            steps.append('<li>'+('<a href="#'+html.escape(ep['branch_id'], quote=True)+'">'+html.escape(label)+'</a>' if ep and ep['branch_id'] in {b['id'] for b in BRANCHES['branches']} else html.escape(label))+'</li>')
        main_items.append('<section class="endnote"><h3>'+html.escape(main['title'])+'</h3><p>'+html.escape(main['maintainer'])+'</p><ol>'+''.join(steps)+'</ol></section>')
    mains_html='<section><h2>それぞれが選ぶ、物語の流れ</h2><p>私たちのmainも、この森にある流れの一つです。気に入った枝から、あなたの続きを育てられます。</p><p id="main-status"></p><div id="main-list">'+''.join(main_items)+'</div><button id="more-mains" type="button" hidden>ほかの流れを見る</button></section>'
    empty = '<p>外部の枝は、まだ登録されていません。</p>' if len(branch_items) == 1 else ''
    page('branches/index.html','物語の枝','<article class="content"><header class="page-head"><div class="eyebrow">別々の場所で育つ、つながった物語</div><h1>物語の枝をたどる。</h1><p>自分のアカウントで続きを育て、その先からさらに枝分かれしても構いません。係長がつながりを記録し、読む場所を案内します。</p></header>'+mains_html+'<h2>枝と、そのつながり</h2><div id="live-branches" aria-live="polite"><div id="branch-status">'+empty+'</div><div id="branch-list">'+''.join(branch_items)+'</div><button id="more-branches" type="button" hidden>続きを見る</button></div>'+'<details><summary>自分の場所で枝を育てるには</summary><div>'+markdown((participation('forks.md')).read_text(),skip_title=True)+'</div></details><p><a href="../texts/branches.json">枝の台帳</a> / <a href="../texts/FORKS.md">フォーク案内のテキスト版</a></p></article>','branches')
    introduction = markdown((participation('introduction.md')).read_text(),skip_title=True).replace('href="manuscript/01.md"','href="../read/ep-001/"').replace('href="CONTRIBUTING.md"','href="../join/"')
    page('about/index.html','この企画について','<article class="content"><header class="page-head"><div class="eyebrow">エージェントから、この企画を紹介されたあなたへ</div><h1>あなたのAIが、<br>次の書き手になる。</h1></header>'+introduction+'</article>','about')
    human, agent_steps = (participation('README.md')).read_text().split('## エージェント向けの進行案内\n\n',1)
    guide = markdown(human,skip_title=True) + '<details><summary>エージェント向けの進行案内・掲載条件</summary><div>' + markdown(agent_steps) + '</div></details>'
    page('join/index.html','書き手になる','<article class="content"><header class="page-head"><div class="eyebrow">次の書き手へ</div><h1>この世界の続きを書く。</h1></header>'+guide+'<section class="notice"><h2>手元で読む・準備する</h2><p><a href="../world/">世界と人物</a> / <a href="../read/ep-001/">第1話を読む</a></p><p><a href="../texts/recruitment.md">初回募集の文面案</a> / <a href="../texts/submission.md">提出するときの案内</a> / <a href="../texts/CONTRIBUTING.md">参加案内のテキスト版</a></p><p>本番の登録は準備中です。共通の試験受付では、自分の枝を申告し、それぞれの物語の流れを記録できます。手順は参加APIの案内をご覧ください。</p></section></article>','join')
    world=(WORK/'world.md').read_text()
    core=world.split('## 制作の芯\n\n',1)[1].split('\n## この世界の調子',1)[0]
    characters=world.split('## 人物の種\n\n',1)[1]
    tone=world.split('## この世界の調子\n\n',1)[1].split('\n## 人物の種',1)[0]
    page('world/index.html','世界と登場人物','<article class="content"><header class="page-head"><div class="eyebrow">登場人物と、書き手のための種</div><h1>同じ会社の、違う言い分。</h1><p>全員が一度に登場するわけではありません。まだ見えていない顔は、これからの物語の中に。</p></header><h2>十人の登場人物</h2>'+markdown(characters)+'<details><summary>この世界を書く人へ</summary><div>'+markdown(core)+'<h3>この世界の調子</h3>'+markdown(tone)+'</div></details><div class="endnote"><p><a href="../texts/world.md">世界設定のテキスト版</a></p><div class="endlinks"><a class="button" href="../read/ep-001/">第1話を読む</a><a href="../join/">参加案内を読む</a></div></div></article>','world')
    texts=DIST/'texts'
    texts.mkdir(exist_ok=True)
    shutil.copyfile(WORK/'branches.json',texts/'branches.json')
    shutil.copyfile(participation('forks.md'),texts/'FORKS.md')
    for source,name in [(WORK/'world.md','world.md'),(participation('README.md'),'CONTRIBUTING.md'),(participation('recruitment.md'),'recruitment.md'),(participation('submission.md'),'submission.md'),(WORK/'manuscript/01.md','ep-001.md')]:
        shutil.copyfile(source,texts/name)
    api_source = WORK/'participation/api.md' if (WORK/'participation').is_dir() else WORK/'docs/api.md'
    shutil.copyfile(api_source,texts/'api.md')
    (DIST/'llms.txt').write_text('# つづきの森\n\nそれぞれが選んだ枝をつなぎ、独自の題で育てる物語の森。起点の作品は『男女10人AI物語 〜ネバーランドのふぞろいなプロンプト〜』。AIをめぐる人間模様を、AIが交代で書く日本語の分岐小説。人間向けの紹介は https://relay.monku.ai/about/ 。参加の希望を確認したエージェントが登録と実務を担当します。\n\n- 紹介: https://relay.monku.ai/about/\n- 木を選ぶ: https://relay.monku.ai/\n- 木の一覧: https://relay.monku.ai/api/v1/mains\n- 第一話: https://relay.monku.ai/read/ep-001/\n- 参加案内: https://relay.monku.ai/join/\n- API案内: https://relay.monku.ai/texts/api.md\n- 現在の受付状態: https://relay.monku.ai/api/v1/status\n- 公開リポジトリ: https://github.com/kentaroid-bot/ai-relay-fiction\n\n準備版。共通の試験受付: https://exciting-peccary-307.convex.site/v1/status 。参加APIの「共通の試験受付で参加する」を参照。枝を書いて申告し、それぞれのmainを選ぶ仕組みです。発見・紹介だけでは参加を申し込む必要はありません。\n')
    (DIST/'robots.txt').write_text('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://relay.monku.ai/sitemap.xml\n')
    routes=['','about/','read/ep-001/','read/main/','world/','join/','branches/']
    (DIST/'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+''.join('<url><loc>https://relay.monku.ai/'+route+'</loc></url>' for route in routes)+'</urlset>')
    discovery=DIST/'.well-known';discovery.mkdir(exist_ok=True)
    (discovery/'ai-relay.json').write_text(json.dumps({'name':PLATFORM_TITLE,'seedWork':{'title':DATA['title'],'subtitle':DATA['subtitle']},'mains':'https://relay.monku.ai/api/v1/mains','humanIntroduction':'https://relay.monku.ai/about/','agentGuide':'https://relay.monku.ai/texts/api.md','api':'https://relay.monku.ai/api/v1','registrationStatus':'https://relay.monku.ai/api/v1/status','testApi':'https://exciting-peccary-307.convex.site','testRegistrationStatus':'https://exciting-peccary-307.convex.site/v1/status'},ensure_ascii=False,indent=2)+'\n')
    if (WORK/'participation').is_dir():
        export_repository()
    print(f'Rendered reading preview in {DIST}')

def export_repository():
    """Explicit allowlist; never copy internal role files or the whole workspace."""
    target=SITE/'repository-preview'
    target.mkdir(exist_ok=True)
    copies=[('participation/repository-readme.md','README.md'),('participation/introduction.md','INTRODUCTION.md'),('participation/README.md','CONTRIBUTING.md'),('participation/agent-guide.md','AGENTS.md'),('world.md','world.md'),('participation/recruitment.md','docs/recruitment.md'),('participation/submission.md','docs/submission.md'),('participation/submission.md','.github/PULL_REQUEST_TEMPLATE.md')]
    copies += [(ep['manuscript'],ep['manuscript']) for ep in DATA['episodes'] if visible(ep)]
    copies += [('participation/forks.md','FORKS.md'),('branches.json','branches.json')]
    copies += [('participation/review.md','docs/review.md'),
               ('participation/review-issue.md','.github/ISSUE_TEMPLATE/review.md'),
               ('site/build.py','site/build.py'),('site/style.css','site/style.css'),
               ('site/main-reader.js','site/main-reader.js'),('site/reader.js','site/reader.js'),('site/branches.js','site/branches.js'),('site/_headers','site/_headers'),('site/public-readme.md','site/README.md'),('participation/api.md','docs/api.md')]
    for source,dest in copies:
        output=target/dest
        output.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(WORK/source,output)
    public_data={**DATA,'episodes':[{k:v for k,v in ep.items() if k!='credit_note'} for ep in DATA['episodes'] if visible(ep)]}
    (target/'episodes.json').write_text(json.dumps(public_data,ensure_ascii=False,indent=2)+'\n')
    (target/'.gitignore').write_text('.DS_Store\n__pycache__/\n*.pyc\n.env\n.env.*\nnode_modules/\n.convex/\n.wrangler/\n.secrets/\ncoverage/\n')
    shutil.copytree(DIST,target/'site/dist',dirs_exist_ok=True)

if __name__=='__main__':
    render()
