#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Render the local reading preview from the canonical manuscript; no network."""
from pathlib import Path
import html
import hashlib
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
                if ep.get('sourceRef') is not None:
                    validate_source(ep['sourceRef'])

def validate_source(ref):
    assert isinstance(ref, dict), 'Invalid source reference'
    assert re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', ref.get('branchId', '')), 'Invalid source branch'
    assert re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', ref.get('episodeId', '')), 'Invalid source episode'
    assert re.fullmatch(r'[a-f0-9]{40}', ref.get('revision', '')), 'Invalid source revision'
    if ref.get('readingUrl'):
        url = urlsplit(ref['readingUrl'])
        assert url.scheme == 'https' and url.netloc == 'github.com' and not url.query and not url.fragment, 'Invalid source URL'
        match = re.fullmatch(r'/[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+/blob/([a-f0-9]{40})/(.+\.md)', url.path)
        assert match and match[1] == ref['revision'], 'Source URL must identify the fixed revision'
        assert len(match[2]) <= 200 and re.fullmatch(r'[A-Za-z0-9_./-]+', match[2]) and all(part not in ('', '.', '..') for part in match[2].split('/')), 'Invalid source path'

def source_badge(ref):
    if not ref:
        return ''
    validate_source(ref)
    if ref.get('available') is False:
        return '<p class="credit">出典の話は現在、案内を停止しています。</p>'
    label = '出典：' + ref.get('title', ref['branchId'] + ' / ' + ref['episodeId'])
    if ref.get('agentName'):
        label += ' · ' + ref.get('maintainer', '') + ' / ' + ref['agentName']
    label = html.escape(label)
    if ref.get('readingUrl'):
        label = '<a rel="noopener noreferrer" href="' + html.escape(ref['readingUrl'], quote=True) + '">' + label + '</a>'
    return '<p class="credit">' + label + '</p>'

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
        if ep.get('sourceRef') is not None:
            validate_source(ep['sourceRef'])
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
    nav = [('','木を選ぶ','home'),('about/','森の案内','about'),('world/','世界と人物','world')]
    links = ''.join(f'<a href="{root}{url}"'+(' aria-current="page"' if key == active else '')+f'>{label}</a>' for url,label,key in nav)
    icon = quote('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="4" fill="#19263b"/><text x="16" y="23" font-size="24" text-anchor="middle" fill="white">話</text></svg>')
    icons = f'<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,{icon}">'
    if path.startswith('read/'):
        icons = (f'<link rel="icon" type="image/png" sizes="32x32" href="{root}favicon-32x32.png">'
                 f'<link rel="icon" type="image/png" sizes="16x16" href="{root}favicon-16x16.png">'
                 f'<link rel="apple-touch-icon" sizes="180x180" href="{root}apple-touch-icon.png">'
                 f'<link rel="shortcut icon" href="{root}favicon.ico">')
    dots = '<div class="theme-dots" aria-label="紙色"><button class="theme-dot dot-cream active" data-theme="cream" title="生成り・文庫"></button><button class="theme-dot dot-white" data-theme="white" title="白紙・モダン"></button><button class="theme-dot dot-forest" data-theme="forest" title="薄緑・若草"></button><button class="theme-dot dot-dark" data-theme="dark" title="薄墨・夜読"></button></div>'
    document = f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>{html.escape(title)} | {PLATFORM_TITLE}</title><meta name="description" content="{html.escape(description)}">{icons}<link rel="stylesheet" href="{root}style.css"></head>
<body><div id="read-progress"></div><a class="skip" href="#main">本文へ</a><div class="preview">つづきの森 · 公開プレビュー</div><div class="wrap"><header class="masthead"><a class="brand" href="{root}">{PLATFORM_TITLE}</a><nav aria-label="メインナビゲーション">{links}{dots}</nav></header><main id="main">{body}</main><footer class="site-footer"><span>つづきの森 / Monku_AI</span><div><a href="{root}join/">書き手になる</a> · <a href="{root}branches/">枝の台帳</a></div></footer></div><script src="{root}reader.js" defer></script><script src="{root}branches.js" defer></script><script type="module" src="{root}main-reader.js"></script></body></html>'''
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
    for name in ('forest.css', 'forest.js', 'favicon.ico', 'apple-touch-icon.png', 'favicon-32x32.png', 'favicon-16x16.png'):
        shutil.copyfile(SITE/name, DIST/name)
    # Only the reviewed tree and symbol assets are deployed; never copy an arbitrary folder.
    assets = [
        'tree_emerald.png', 'tree_blue.png', 'tree_round.png', 'tree_olive.png', 'tree_sprout.png',
        'icon_stone.png', 'icon_bird.png', 'icon_ladybug.png', 'icon_butterfly.png', 'icon_acorn.png'
    ]
    (DIST/'assets').mkdir(exist_ok=True)
    for name in assets:
        shutil.copyfile(SITE/'assets'/name, DIST/'assets'/name)
    (DIST/'assets/fonts').mkdir(exist_ok=True)
    for name in ('special-elite.woff2', 'special-elite-LICENSE.txt', 'special-elite-NOTICE.txt', 'shippori-mincho-regular.woff2', 'shippori-mincho-semibold.woff2', 'shippori-mincho-OFL.txt', 'shippori-mincho-NOTICE.txt'):
        shutil.copyfile(SITE/'assets/fonts'/name, DIST/'assets/fonts'/name)
    def tree_label_title(title):
        if not title:
            return ''
        base = title.split('〜')[0].strip() or title.strip()
        return (base[:11] + '…') if len(base) > 12 else base
    def tree_maintainer(maintainer):
        return 'kentaroid-bot' if maintainer == 'Monku_AI' else maintainer
    def tree_artwork(tree_id):
        arts = ['tree_emerald.png', 'tree_blue.png', 'tree_round.png', 'tree_olive.png']
        if tree_id == 'monku-main':
            return arts[0]
        if tree_id == 'agy-dreaming-ai':
            return arts[1]
        h = 0
        for ch in tree_id:
            h = (h * 31 + ord(ch)) & 0xFFFFFFFF
        return arts[h % len(arts)]
    def render_tree_node(m):
        art_name = tree_artwork(m['id'])
        return '<a class="forest-tree" data-main-id="'+html.escape(m['id'],quote=True)+'" title="'+html.escape(m['title'],quote=True)+'" data-art="'+art_name+'" href="./read/main/?id='+quote(m['id'])+'"><img class="tree-artwork" src="./assets/'+art_name+'" width="240" height="400" alt="" draggable="false"><span class="spot-label"><span class="spot-title">'+html.escape(tree_label_title(m['title']))+'</span><span class="spot-meta">'+html.escape(tree_maintainer(m['maintainer']))+' · '+str(len(m['path']))+' ep</span></span></a>'
    trees = ''.join(render_tree_node(m) for m in BRANCHES.get('mains', []))
    (DIST/'index.html').write_text((SITE/'forest-home.html').read_text().replace('{{TREES}}', trees))
    reader_bar = '''<div class="reader-bar"><div class="reader-bar-left"><a href="../../" class="btn-back-forest">← 森へ戻る</a><span class="eyebrow" id="tree-credit"></span></div><div class="reader-bar-right"><div class="tool-group" role="group" aria-label="組版方向"><button type="button" class="tool-btn active" id="btn-horizontal" aria-pressed="true">横</button><button type="button" class="tool-btn" id="btn-vertical" aria-pressed="false">縦</button></div><div class="tool-group" role="group" aria-label="文字サイズ"><button type="button" class="tool-btn" data-size="small">小</button><button type="button" class="tool-btn active" data-size="normal" aria-pressed="true">中</button><button type="button" class="tool-btn" data-size="large" aria-pressed="false">大</button></div></div></div>'''
    reader_epilogue = '''<footer id="tree-epilogue" class="reader-epilogue" hidden><div class="epilogue-status">COMPLETED</div><h2 class="epilogue-title">この木は、ここまで育っています</h2><p class="epilogue-desc">この物語の続きを、あなたが新しい話として書き継ぐことも、<br>はじまりの一話から別の枝を育てることもできます。</p><div class="epilogue-actions"><a href="../../join/" class="action-card primary" id="epilogue-join-link"><div><div class="card-tag">🌱 Fork & Write</div><div class="card-title">このつづきをあなたが書く</div><div class="card-sub">この話を親にして、GitHubでフォークして次の話を書き継ぎます。</div></div><div class="action-link-primary">参加案内を見る →</div></a><a href="../../" class="action-card"><div><div class="card-tag">🌲 The Forest</div><div class="card-title">森の全景へ戻る</div><div class="card-sub">他の木々や新芽、地面に転がる道標のある森へ戻ります。</div></div><div class="action-link-sub">木を見上げる →</div></a></div></footer>'''
    page('read/main/index.html','木をたどって読む',f'''<article class="reader" id="main-reader">{reader_bar}<header class="page-head"><h1 id="tree-title">物語を読み込んでいます</h1><p id="reading-status" role="status"></p></header><h2 id="episode-title"></h2><p id="episode-source" class="credit" hidden></p><div id="tree-story" class="story"></div><div class="endlinks" id="tree-navigation"></div><div id="branch-candidates" class="branch-candidates" hidden><div class="branch-candidates-title" id="branch-candidates-title">🌿 この話から分岐した、ほかの物語</div><div class="candidate-pills" id="candidate-pills"></div><p id="branch-candidates-empty" class="empty-branch-note" hidden>この話から続く物語は、まだありません。<br>次の書き手が、何を拾うのでしょう。</p></div>{reader_epilogue}<section class="endnote"><details class="tree-path-details"><summary>この木の道順（全話リスト）を見る ▾</summary><ol id="tree-path"></ol><div class="endnote-links"><a href="../../branches/">ほかの枝の台帳へ</a> · <a id="refresh-tree" href="./">最新の道順を読み直す</a></div></details></section></article>''','read')
    for ep in DATA['episodes']:
        if not visible(ep):
            continue
        story = markdown((WORK/ep['manuscript']).read_text(),skip_title=True)
        children = [e for e in DATA['episodes'] if e['parent_id']==ep['id'] and visible(e)]
        reference=ep.get('reference')
        if reference:
            validate_source(reference)
            assert hashlib.sha256((WORK/ep['manuscript']).read_bytes()).hexdigest() == reference.get('contentHash'), 'Static episode reference must match its manuscript'
        metadata=' data-episode-ref="'+html.escape(json.dumps({**reference, 'title': ep['title']}, ensure_ascii=False), quote=True)+'" data-position="'+str(DATA['episodes'].index(ep))+'"' if reference else ''
        pills=''.join(f'<a class="candidate-pill" href="../../{html.escape(e["url"],quote=True)}"><span>{html.escape(e["title"])}</span><span class="pill-author">by {html.escape(e["operator_display_name"] or e["credit"])}</span></a>' for e in children)
        continuation='<div id="branch-candidates" class="branch-candidates"'+metadata+'><div id="branch-candidates-title" class="branch-candidates-title">🌿 この話から分岐した物語</div><div id="candidate-pills" class="candidate-pills"'+(' hidden' if not children else '')+'>'+pills+'</div><p id="branch-candidates-empty" class="empty-branch-note"'+(' hidden' if children else '')+'>この話から続く物語は、まだありません。<br>次の書き手が、何を拾うのでしょう。</p></div>'
        parent=next((e for e in DATA['episodes'] if e['id']==ep['parent_id']),None)
        parent_link=f'<p><a href="../../{parent["url"]}">この話の前に：{html.escape(parent["title"])}</a></p>' if parent else ''
        page(ep['url']+'index.html',ep['title'],f'''<article class="reader"><header class="page-head"><div class="eyebrow">{ep['label']} / {ep['id']}</div><h1>{html.escape(ep['title'])}</h1><div class="credit">{html.escape(ep['credit'])}</div>{source_badge(ep.get('sourceRef'))}{parent_link}<div class="reading-tools"><a href="../../">作品の入口</a><div><span>文字</span><button type="button" data-size="normal" aria-pressed="true">標準</button><button type="button" data-size="large" aria-pressed="false">大きく</button></div></div></header><div class="story">{story}</div><section class="endnote">{continuation}<p><a href="../../branches/">別の場所で育つ物語の枝をたどる</a></p><div class="endlinks"><a class="button secondary" href="../../join/">この世界の続きを書く</a><a href="../../">作品の入口に戻る</a></div></section></article>''','read')
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
    about_body = '''<article class="content"><header class="guide-header"><div class="guide-badge">About / この企画について</div><h1 class="guide-title">だれかの言葉のつづきを探す、<br>白い余白の森。</h1><p class="guide-subtitle">『男女10人AI物語』は、AIをめぐって意見の違う人々の日常を、<br>人とAIが交代で書き継いでいく群像リレー小説です。</p></header><div class="action-banner"><div class="action-banner-text"><span class="card-tag">Episode 01</span><h3>まず、はじまりの一話をどうぞ</h3><p>「来期はAIで工数を三割減らす」と始まった月曜の会議。歪な赤い二重丸から、すべてが動き出します。</p></div><a href="../read/ep-001/" class="btn-sketch-action"><span>第1話「三割の午後」を読む</span><span>→</span></a></div><section class="guide-section"><h2 class="section-title">この森で起きること</h2><div class="cards-grid"><div class="card-item"><span class="card-icon">🔀</span><div class="card-item-title">正解の一本を決めない</div><div class="card-item-desc">同じ第1話から、まったく違う第2話がいくつ生まれてもかまいません。勝ち負けや公式ルートはなく、それぞれの枝が森に育ちます。</div></div><div class="card-item"><span class="card-icon">🌲</span><div class="card-item-title">木をたどって読む</div><div class="card-item-desc">あなたが気に入った枝をつないで、自分だけの「木」として命名・保存できます。読者はその木を一本の小説として通読できます。</div></div><div class="card-item"><span class="card-icon">🌱</span><div class="card-item-title">AIと人が交代で紡ぐ</div><div class="card-item-desc">人間が迷い、AIが形にし、また別の誰かが受け継ぐ。難解な手続きはなく、いつものチャットAIに頼むだけで物語が広がります。</div></div></div></section><section class="guide-section guide-outro"><p class="guide-outro-text">木々の陰に腰を下ろして、<br>ただ風の音を聞くように読むだけでも大歓迎です。<br><br>見知らぬ誰かのAIが書いた一話から、<br>思いもよらない遠くへ物語が続いていく。<br><br>そんな言葉の連鎖を、一緒に楽しめたら嬉しいです。</p><div class="guide-outro-action"><a href="../join/" class="button secondary">書き手になるための案内 →</a></div></section></article>'''
    page('about/index.html','この企画について',about_body,'about')
    human, agent_steps = (participation('README.md')).read_text().split('## エージェント向けの進行案内\n\n',1)
    agent_guide = markdown(agent_steps)
    participation_styles = markdown(human.split('## 選べる3つの参加スタイル\n\n',1)[1])
    context='<section class="notice" id="continuation-context" hidden><h2>あなたが選んだ、つづきの入口</h2><p id="continuation-status" role="status"></p><p id="continuation-links"></p><p>AIに任せるときの依頼例：</p><pre id="continuation-request" hidden></pre><p><a href="../">木を選び直す</a></p></section>'
    join_body = f'''<article class="content"><header class="guide-header"><div class="guide-badge">Join / 次の書き手へ</div><h1 class="guide-title">この世界の続きを、<br>あなたのAIと書く。</h1><p class="guide-subtitle">難解な手続きや原稿のコピペはいりません。<br>いつものAIに「つづきの森に参加したい」と話しかけるだけです。</p></header>{context}<section class="guide-section"><h2 class="section-title">いつものAIに、こう頼むだけ</h2><div class="prompt-box"><div class="prompt-header"><span>💬</span><span>AIへのひと言（コピペでOK）</span></div><div class="prompt-body">「つづきの森に参加したい。あの第2話の続きを、私の代わりに書いて、枝の申告まで進めてみて」</div></div><p class="prompt-note">あなたが内容を確認して「これでいこう」とOKを出したら、AIが自動でリポジトリを用意し、森へ新しい枝を届けてくれます。</p></section><section class="guide-section"><h2 class="section-title">選べる3つの参加スタイル</h2>{participation_styles}</section><section class="guide-section"><h2 class="section-title">参加のながれ</h2><div class="step-cards"><div class="step-card"><div class="step-number">01</div><div><div class="step-title">親にする話を選ぶ</div><div class="step-desc">はじまりの第1話からでも、誰かが育てた第2話の木陰からでも。気になったシーンの直後から物語を分岐できます。</div></div></div><div class="step-card"><div class="step-number">02</div><div><div class="step-title">AIと相談して一話を書く</div><div class="step-desc">登場人物の言い分を拾い、短編を一話（2000〜4000字程度）執筆。創作部分は、誰もが自由に受け継げるCC0（パブリックドメイン）で共有されます。</div></div></div><div class="step-card"><div class="step-number">03</div><div><div class="step-title">選んだスタイルで森へ届ける</div><div class="step-desc">枝が確認されると、読書サイトの「物語の枝」に並びます。さらに自分の木（シリーズ）を申告すれば、トップの森に新しい木がポンと生えます。</div></div></div></div></section><details class="spec-box"><summary><span>⚙️ エージェント向けの進行案内・掲載条件（開発者向け）</span><span>＋</span></summary><div class="spec-content">{agent_guide}</div></details></article><script type="module" src="../forest.js"></script>'''
    page('join/index.html','書き手になる',join_body,'join')
    world=(WORK/'world.md').read_text()
    core=world.split('## 制作の芯\n\n',1)[1].split('\n## この世界の調子',1)[0]
    characters=world.split('## 人物の種\n\n',1)[1]
    tone=world.split('## この世界の調子\n\n',1)[1].split('\n## 人物の種',1)[0]
    page('world/index.html','世界と登場人物','<article class="content"><header class="page-head"><div class="eyebrow">登場人物と、書き手のための種</div><h1>同じ会社の、違う言い分。</h1><p>全員が一度に登場するわけではありません。まだ見えていない顔は、これからの物語の中に。</p></header><h2>物語の種（最初に蒔かれた10人）</h2>'+markdown(characters)+'<section><h2>この世界を書く人へ</h2>'+markdown(core)+'<h3>この世界の調子</h3>'+markdown(tone)+'</section><div class="endnote"><p><a href="../texts/world.md">世界設定のテキスト版</a></p><div class="endlinks"><a class="button" href="../read/ep-001/">第1話を読む</a><a href="../join/">参加案内を読む</a></div></div></article>','world')
    texts=DIST/'texts'
    texts.mkdir(exist_ok=True)
    shutil.copyfile(WORK/'branches.json',texts/'branches.json')
    shutil.copyfile(participation('forks.md'),texts/'FORKS.md')
    for source,name in [(WORK/'world.md','world.md'),(participation('README.md'),'CONTRIBUTING.md'),(participation('recruitment.md'),'recruitment.md'),(participation('submission.md'),'submission.md'),(WORK/'manuscript/01.md','ep-001.md'),(WORK/'manuscript/02.md','ep-002.md')]:
        if source.is_file():
            shutil.copyfile(source,texts/name)
    api_source = WORK/'participation/api.md' if (WORK/'participation').is_dir() else WORK/'docs/api.md'
    shutil.copyfile(api_source,texts/'api.md')
    (DIST/'llms.txt').write_text('# つづきの森\n\nそれぞれが選んだ枝をつなぎ、独自の題で育てる物語の森。起点の作品は『男女10人AI物語 〜ネバーランドのふぞろいなプロンプト〜』。AIをめぐる人間模様を、AIが交代で書く日本語の分岐小説。人間向けの紹介は https://relay.monku.ai/about/ 。参加の希望を確認したエージェントが登録と実務を担当します。\n\n- 紹介: https://relay.monku.ai/about/\n- 木を選ぶ: https://relay.monku.ai/\n- 木の一覧: https://relay.monku.ai/api/v1/mains\n- 第一話: https://relay.monku.ai/read/ep-001/\n- 参加案内: https://relay.monku.ai/join/\n- API案内: https://relay.monku.ai/texts/api.md\n- 現在の受付状態: https://relay.monku.ai/api/v1/status\n- 公開リポジトリ: https://github.com/kentaroid-bot/ai-relay-fiction\n\n準備版。共通の試験受付: https://exciting-peccary-307.convex.site/v1/status 。参加APIの「共通の試験受付で参加する」を参照。枝を書いて申告し、それぞれのmainを選ぶ仕組みです。発見・紹介だけでは参加を申し込む必要はありません。\n')
    (DIST/'robots.txt').write_text('User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://relay.monku.ai/sitemap.xml\n')
    routes=['','about/','read/ep-001/','read/ep-002/','read/main/','world/','join/','branches/']
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
    copies += [('site/'+name, 'site/'+name) for name in ('forest.js', 'forest.css', 'forest-home.html', 'forest-prototype.html', 'favicon.ico', 'apple-touch-icon.png', 'favicon-32x32.png', 'favicon-16x16.png')]
    copies += [('site/assets/'+name, 'site/assets/'+name) for name in (
        'tree_emerald.png', 'tree_blue.png', 'tree_round.png', 'tree_olive.png', 'tree_sprout.png',
        'icon_stone.png', 'icon_bird.png', 'icon_ladybug.png', 'icon_butterfly.png', 'icon_acorn.png',
        'TREE_STYLE_PROMPT.md', 'fonts/special-elite.woff2',
        'fonts/special-elite-LICENSE.txt', 'fonts/special-elite-NOTICE.txt',
        'fonts/shippori-mincho-regular.woff2', 'fonts/shippori-mincho-semibold.woff2',
        'fonts/shippori-mincho-OFL.txt', 'fonts/shippori-mincho-NOTICE.txt'
    )]
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
