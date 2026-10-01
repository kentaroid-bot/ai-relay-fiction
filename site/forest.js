import { boundedText, rawSource } from "./main-reader.js";

const ID = /^[a-z0-9][a-z0-9-]{1,79}$/;
const art = [
  "tree_emerald.png",
  "tree_blue.png",
  "tree_round.png",
  "tree_olive.png",
];
export function treeArtwork(id) {
  if (!ID.test(id)) throw Error("Invalid tree");
  if (id === "monku-main") return art[0];
  if (id === "agy-dreaming-ai") return art[1];
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return art[hash % art.length];
}
export function readingLink(id, version, position = 0) {
  if (
    !ID.test(id) ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    position >= 1000
  )
    throw Error("Invalid tree");
  return (
    "/read/main/?id=" +
    encodeURIComponent(id) +
    "&v=" +
    version +
    "&at=" +
    position
  );
}
export function clampPosition(value, extent, item) {
  return Math.max(0, Math.min(value, Math.max(0, extent - item)));
}
function text(value, max = 400) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error("Invalid label");
  return value;
}
function validateMain(main) {
  readingLink(main.mainId, main.version);
  if (!Number.isSafeInteger(main.count) || main.count < 1 || main.count > 1000)
    throw Error("Invalid count");
  text(main.title);
  text(main.maintainer, 200);
  text(main.agentName, 200);
  return main;
}
export function validateEpisodePage(main, page, position) {
  if (page.version !== main.version || page.count !== main.count)
    throw Error("Path changed");
  if (
    !Array.isArray(page.page) ||
    page.page.length > 50 ||
    position + page.page.length > main.count ||
    (!page.page.length && !page.isDone) ||
    (page.isDone && position + page.page.length !== main.count)
  )
    throw Error("Missing steps");
  for (let i = 0; i < page.page.length; i++) {
    const step = page.page[i];
    if (step.position !== position + i || typeof step.available !== "boolean")
      throw Error("Missing step");
    if (step.available) {
      if (!step.episode) throw Error("Missing episode");
      text(step.episode.title);
      text(step.episode.branchId, 80);
    }
  }
}
const el = (tag, value, cls) => {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (cls) node.className = cls;
  return node;
};
const anchor = (label, href, cls) => {
  const a = el("a", label, cls);
  a.href = href;
  return a;
};
async function get(route) {
  const response = await fetch("/api/v1/" + route, {
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  const data = JSON.parse(await boundedText(response, 200000));
  if (
    !Array.isArray(data.page) ||
    data.page.length > 50 ||
    typeof data.isDone !== "boolean" ||
    (!data.isDone &&
      (typeof data.continueCursor !== "string" ||
        data.continueCursor.length > 2000))
  )
    throw Error("Invalid page");
  return data;
}
function joinLink(main, position) {
  readingLink(main.mainId, main.version, position);
  return (
    "/join/?from=" +
    encodeURIComponent(main.mainId) +
    "&v=" +
    main.version +
    "&at=" +
    position
  );
}

const KNOWN_NOTES = {
  "origin/ep-001": "神崎常務がホワイトボードに引いた30%と二重丸。",
  "agy-double-circle-monday/ep-002":
    "蓮の4,200件誤爆と、パンを焼きながらGASを組む佐藤さん。",
  "agy-dreaming-ai-01/ep-002":
    "深夜のプロンプト「◎」。桐野と雨宮美月、手書きノートの秘密。",
  "sukezo-fuzoroi/ep-002": "現場とAIが交わす、五七五のリズムと指示。",
};
function treeLabelTitle(title) {
  return title.split("〜")[0].trim() || title;
}
function treeMaintainer(maintainer) {
  return maintainer === "Monku_AI" ? "kentaroid-bot" : maintainer;
}

export function treeLabelTitle(title) {
  if (!title) return "";
  const base = title.includes("〜") ? title.split("〜")[0].trim() : title.trim();
  return base.length > 12 ? base.slice(0, 11) + "…" : base;
}

function startForest() {
  const field = document.getElementById("forest-field"),
    list = document.getElementById("main-list");
  const status = document.getElementById("main-status"),
    more = document.getElementById("more-mains");
  const sprout = document.getElementById("forest-sprout"),
    arrange = document.getElementById("arrange-trees");
  const panel = document.getElementById("book-panel"),
    panelTitle = document.getElementById("panel-title");
  const panelMeta = document.getElementById("panel-meta"),
    panelStatus = document.getElementById("panel-status");
  const episodes = document.getElementById("panel-episodes"),
    nextEpisodes = document.getElementById("more-episodes");
  const read = document.getElementById("read-tree"),
    join = document.getElementById("panel-join");
  let generation = 0,
    active = null,
    opener = null,
    z = 1;
  let cursor = null,
    started = false,
    loading = false;
  const seen = new Set(),
    cursors = new Set(),
    draggable = new WeakSet();

  function layout() {
    const trees = [...list.querySelectorAll(".forest-tree")],
      width = field.clientWidth;
    if (!width) return;
    field.classList.add("is-arranged");
    const cols = Math.min(
      Math.max(1, trees.length),
      Math.max(1, Math.min(4, Math.floor(width / 210))),
    );
    const cell = width / cols;
    let y = 45;
    for (let row = 0; row < trees.length; row += cols) {
      const group = trees.slice(row, row + cols);
      const height = Math.max(...group.map((t) => t.offsetHeight));
      group.forEach((tree, column) => {
        const offset = cols > 1 ? (((row + column) % 3) - 1) * 18 : 0;
        tree.style.left =
          clampPosition(
            cell * (column + 0.5) - tree.offsetWidth / 2 + offset,
            width,
            tree.offsetWidth,
          ) + "px";
        tree.style.top = y + height - tree.offsetHeight + "px";
        tree.style.zIndex = "1";
      });
      y += height + 40;
    }
    // 1枚の絵として手前の丘に新芽と石ころを美しく調和させる
    if (trees.length <= 2 && trees.length <= cols) {
      sprout.style.left =
        clampPosition(
          width * 0.62 - sprout.offsetWidth / 2,
          width,
          sprout.offsetWidth,
        ) + "px";
      sprout.style.top = "260px";
      sprout.style.zIndex = "1";

      const stoneNode = document.getElementById("forest-stone");
      if (stoneNode) {
        stoneNode.style.bottom = "auto";
        stoneNode.style.right = "auto";
        stoneNode.style.left =
          clampPosition(width * 0.12, width, stoneNode.offsetWidth) + "px";
        stoneNode.style.top = "330px";
        stoneNode.style.zIndex = "1";
      }
      field.style.height = "480px";
    } else {
      sprout.style.left =
        clampPosition(
          width * 0.55 - sprout.offsetWidth / 2,
          width,
          sprout.offsetWidth,
        ) + "px";
      sprout.style.top = y + "px";
      sprout.style.zIndex = "1";
      field.style.height = Math.max(480, y + sprout.offsetHeight + 24) + "px";

      const stoneNode = document.getElementById("forest-stone");
      if (stoneNode) {
        stoneNode.style.bottom = "auto";
        stoneNode.style.right = "auto";
        stoneNode.style.left = "36px";
        stoneNode.style.top =
          Math.max(0, field.clientHeight - stoneNode.offsetHeight - 24) + "px";
        stoneNode.style.zIndex = "1";
      }
    }
    z = 1;
  }
  function makeDraggable(node) {
    if (draggable.has(node)) return;
    draggable.add(node);
    node.setAttribute("draggable", "false");
    node.addEventListener("dragstart", (e) => e.preventDefault());
    let down = null,
      moved = false,
      suppressClick = false;
    node.addEventListener("pointerdown", (event) => {
      if (
        !event.isPrimary ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey
      )
        return;
      node.style.bottom = "auto";
      node.style.right = "auto";
      const treeRect = node.getBoundingClientRect();
      const fieldRect = field.getBoundingClientRect();
      down = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: treeRect.left - fieldRect.left,
        top: treeRect.top - fieldRect.top,
      };
      moved = false;
      suppressClick = false;
      node.style.zIndex = String(++z);
      try {
        node.setPointerCapture(event.pointerId);
      } catch (_) {}
    });
    node.addEventListener("pointermove", (event) => {
      if (!down || down.id !== event.pointerId) return;
      const dx = event.clientX - down.x,
        dy = event.clientY - down.y;
      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        node.classList.add("is-dragging");
      }
      if (moved) {
        node.style.left =
          clampPosition(down.left + dx, field.clientWidth, node.offsetWidth) +
          "px";
        node.style.top =
          clampPosition(down.top + dy, field.clientHeight, node.offsetHeight) +
          "px";
      }
    });
    function end(event) {
      if (!down || down.id !== event.pointerId) return;
      try {
        if (node.hasPointerCapture(event.pointerId))
          node.releasePointerCapture(event.pointerId);
      } catch (_) {}
      suppressClick = moved;
      down = null;
      node.classList.remove("is-dragging");
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("lostpointercapture", () => {
      if (down) {
        down = null;
        suppressClick = moved;
        node.classList.remove("is-dragging");
      }
    });
    node.addEventListener("click", (event) => {
      if (suppressClick) {
        suppressClick = false;
        if (event.detail > 0) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }
    });
  }
  function open(title, meta, source) {
    generation++;
    active = null;
    opener = source;
    panelTitle.textContent = treeLabelTitle(title);
    panelTitle.title = title;
    panelMeta.textContent = meta;
    panelStatus.textContent = "";
    episodes.replaceChildren();
    join.replaceChildren();
    read.hidden = true;
    nextEpisodes.hidden = true;
    join.classList.remove("is-guide");
    if (!panel.open) panel.show();
    return generation;
  }
  function ordinaryClick(event) {
    return (
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.shiftKey &&
      event.button === 0
    );
  }
  async function loadEpisodes() {
    const state = active;
    if (!state || state.loading) return;
    state.loading = true;
    nextEpisodes.disabled = true;
    try {
      const page = await get(
        "main?id=" +
          encodeURIComponent(state.main.mainId) +
          (state.cursor ? "&cursor=" + encodeURIComponent(state.cursor) : ""),
      );
      if (state.generation !== generation) return;
      if (
        page.version !== state.main.version ||
        page.count !== state.main.count
      ) {
        episodes.replaceChildren();
        read.hidden = false;
        read.textContent = "最新の道順で読む";
        read.href = "/read/main/?id=" + encodeURIComponent(state.main.mainId);
        panelStatus.textContent =
          "木の道順が変わりました。最新の道順を読み直せます。";
        nextEpisodes.hidden = true;
        active = null;
        return;
      }
      if (!page.isDone && state.cursors.has(page.continueCursor))
        throw Error("Invalid cursor");
      // Check the whole page before publishing any of its links.
      validateEpisodePage(state.main, page, state.position);
      for (const step of page.page) {
        const row = el("li", undefined, "ep-row-item");
        const epLabel = "ep " + String(step.position + 1).padStart(2, "0");
        if (!step.available) state.blocked = true;
        if (step.available && !state.blocked) {
          const card = anchor(
            undefined,
            readingLink(state.main.mainId, state.main.version, step.position),
            "ep-row",
          );
          const top = el("div", undefined, "ep-row-top");
          top.append(
            el("span", epLabel, "ep-row-num"),
            el(
              "span",
              step.episode.branchId ? "枝: " + step.episode.branchId : "",
              "ep-row-branch",
            ),
          );
          const title = el("div", step.episode.title, "ep-row-title");
          card.append(top, title);
          const suppliedNote = step.episode.note || step.episode.synopsis;
          const noteText =
            typeof suppliedNote === "string" && suppliedNote.length <= 400
              ? suppliedNote
              : KNOWN_NOTES[
                  step.episode.branchId + "/" + step.episode.episodeId
                ];
          if (noteText) card.append(el("div", noteText, "ep-row-note"));
          row.append(card);
        } else {
          const card = el("div", undefined, "ep-row is-disabled");
          const top = el("div", undefined, "ep-row-top");
          top.append(el("span", epLabel, "ep-row-num"));
          const title = el(
            "div",
            step.available
              ? step.episode.title + "（前の話の案内が再開するまで読めません）"
              : "現在は案内を停止している話",
            "ep-row-title",
          );
          card.append(top, title);
          row.append(card);
        }
        episodes.append(row);
      }
      state.position += page.page.length;
      state.cursor = page.continueCursor;
      state.cursors.add(page.continueCursor);
      nextEpisodes.hidden = page.isDone;
      nextEpisodes.textContent = "次の話を見る";
      panelStatus.textContent = state.blocked
        ? "途中に案内を停止している話があります。"
        : "";
    } catch {
      if (state.generation === generation) {
        panelStatus.textContent =
          "話一覧を読み込めませんでした。もう一度お試しください。";
        nextEpisodes.hidden = false;
        nextEpisodes.textContent = "もう一度読み込む";
      }
    } finally {
      state.loading = false;
      if (state.generation === generation) nextEpisodes.disabled = false;
    }
  }
  function showTree(main, source) {
    const maintainerName = treeMaintainer(main.maintainer);
    const token = open(main.title, "compiled by " + maintainerName, source);
    panelStatus.textContent = "";
    join.append(
      anchor("ほかの枝をたどる", "/branches/"),
      anchor("この森のつづきを書く", "/join/"),
    );
    active = {
      main,
      generation: token,
      cursor: null,
      position: 0,
      blocked: false,
      cursors: new Set(),
      loading: false,
    };
    nextEpisodes.disabled = false;
    loadEpisodes();
  }
  function showSprout(source) {
    open("あなたの木（新芽）", "branch / create your story", source);
    for (const [label, title, note, href] of [
      [
        "共通の源流",
        "三割の午後",
        "はじまりの一話から、あなたのつづきを。",
        "/read/ep-001/",
      ],
      [
        "好きな枝から",
        "途中の話を選ぶ",
        "気に入った話の先を、自由に紡いでも。",
        "/branches/",
      ],
      [
        "書き手になる",
        "✎ あなたの物語",
        "参加案内を読んで、あなたのAIと木を育てる。",
        "/join/",
      ],
    ]) {
      const row = el("li", undefined, "ep-row-item");
      const card = anchor(undefined, href, "ep-row");
      card.append(
        el("div", label, "ep-row-top"),
        el("div", title, "ep-row-title"),
        el("div", note, "ep-row-note"),
      );
      row.append(card);
      episodes.append(row);
    }
  }
  function showStone(source) {
    open("この森について", "道標 / About", source);
    join.classList.add("is-guide");
    join.append(
      el(
        "p",
        "だれかの言葉のつづきを探す、白い余白の森。木々の陰にそれぞれの物語が隠れています。",
      ),
    );
    join.append(
      el(
        "p",
        "同じ一話から、違うつづきへ。はじまりの一話からでも、気に入った話の途中からでも、自分の木を育てられます。",
      ),
    );
    join.append(
      anchor(
        "はじまりの一話「三割の午後」を読む",
        "/read/ep-001/",
        "btn-sketch",
      ),
      anchor("参加案内へ", "/join/", "btn-sketch"),
    );
  }
  const stone = document.getElementById("forest-stone");
  if (stone) {
    makeDraggable(stone);
    stone.addEventListener("click", (event) => {
      if (ordinaryClick(event)) {
        event.preventDefault();
        showStone(stone);
      }
    });
  }
  // Register drag suppression before the sprout's opening handler.
  makeDraggable(sprout);
  for (const source of [sprout, document.getElementById("plant-tree")])
    source.addEventListener("click", (event) => {
      if (ordinaryClick(event)) {
        event.preventDefault();
        showSprout(source);
      }
    });
  document
    .getElementById("panel-close")
    .addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => {
    generation++;
    active = null;
    if (opener?.isConnected) opener.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) {
      event.preventDefault();
      panel.close();
    }
  });
  nextEpisodes.addEventListener("click", loadEpisodes);
  arrange.hidden = false;
  arrange.addEventListener("click", layout);
  list.querySelectorAll(".forest-tree").forEach(makeDraggable);
  layout();
  let lastWidth = field.clientWidth;
  new ResizeObserver(() => {
    if (field.clientWidth !== lastWidth) {
      lastWidth = field.clientWidth;
      layout();
    }
  }).observe(field);
  const hintEl = document.getElementById("forest-hint");
  if (hintEl) {
    hintEl.textContent =
      "木を選ぶと、物語が開きます。木を動かして眺めることもできます。";
  }

  function makeTree(main) {
    const node = anchor(
      "",
      readingLink(main.mainId, main.version),
      "forest-tree",
    );
    node.dataset.mainId = main.mainId;
    node.dataset.art = treeArtwork(main.mainId);
    node.setAttribute("aria-haspopup", "dialog");
    const image = el("img", undefined, "tree-artwork");
    image.src = "/assets/" + node.dataset.art;
    image.alt = "";
    image.draggable = false;
    image.width = 240;
    image.height = 400;
    const label = el("span", undefined, "spot-label");
    const displayTitle = treeLabelTitle(main.title);
    label.append(
      el("span", displayTitle, "spot-title"),
      el(
        "span",
        treeMaintainer(main.maintainer) + " · " + main.count + " ep",
        "spot-meta",
      ),
    );
    node.append(image, label);
    makeDraggable(node);
    node.addEventListener("click", (event) => {
      if (ordinaryClick(event)) {
        event.preventDefault();
        showTree(main, node);
      }
    });
    return node;
  }
  async function loadTrees() {
    if (loading) return;
    loading = true;
    more.disabled = true;
    try {
      const data = await get(
        "mains" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
      );
      if (!data.isDone && cursors.has(data.continueCursor))
        throw Error("Invalid cursor");
      const mains = data.page.map(validateMain),
        fragment = document.createDocumentFragment();
      for (const main of mains) {
        if (!seen.has(main.mainId)) {
          fragment.append(makeTree(main));
          seen.add(main.mainId);
        }
      }
      if (!started) {
        list.replaceChildren();
        started = true;
      }
      list.append(fragment);
      cursor = data.continueCursor;
      cursors.add(cursor);
      more.hidden = data.isDone;
      status.textContent = seen.size ? "" : "木は、まだ登録されていません。";
      layout();
    } catch {
      status.textContent = started
        ? "ほかの木を読み込めませんでした。もう一度お試しください。"
        : "保存済みの木を案内しています。";
      more.hidden = false;
      more.textContent = "木の一覧を読み直す";
    } finally {
      loading = false;
      more.disabled = false;
    }
  }
  more.addEventListener("click", loadTrees);
  loadTrees();
}

async function startJoinContext() {
  const query = new URLSearchParams(location.search),
    id = query.get("from");
  if (!id) return;
  const context = document.getElementById("continuation-context");
  context.hidden = false;
  const status = document.getElementById("continuation-status");
  status.textContent = "選んだ親話を確認しています。";
  try {
    const version = Number(query.get("v")),
      position = Number(query.get("at"));
    readingLink(id, version, position);
    let page = await get("main?id=" + encodeURIComponent(id)),
      step;
    const cursors = new Set();
    let expected = 0;
    const main = validateMain(page);
    if (main.version !== version || position >= main.count)
      throw Error("Changed path");
    while (true) {
      if (page.version !== version || page.count !== main.count)
        throw Error("Changed path");
      for (const current of page.page) {
        if (
          current.position !== expected++ ||
          !current.available ||
          !current.episode
        )
          throw Error("Unavailable step");
        if (current.position === position) {
          step = current;
          break;
        }
      }
      if (step) break;
      if (
        page.isDone ||
        !page.continueCursor ||
        cursors.has(page.continueCursor) ||
        cursors.size >= 20
      )
        throw Error("Missing step");
      cursors.add(page.continueCursor);
      page = await get(
        "main?id=" +
          encodeURIComponent(id) +
          "&cursor=" +
          encodeURIComponent(page.continueCursor),
      );
    }
    rawSource(step.episode.readingUrl);
    text(step.episode.title);
    const latest = await get("main?id=" + encodeURIComponent(id));
    if (latest.version !== version) throw Error("Changed path");
    if (position < latest.page.length && !latest.page[position]?.available)
      throw Error("Unavailable step");
    status.textContent =
      "『" + step.episode.title + "』のつづきから、あなたの木を育てられます。";
    const target = document.getElementById("continuation-links");
    target.append(anchor("選んだ話を読む", readingLink(id, version, position)));
    const source = anchor("親話の固定版", step.episode.readingUrl);
    source.rel = "noopener noreferrer";
    target.append(document.createTextNode(" / "), source);
    const prompt = document.getElementById("continuation-request");
    prompt.textContent =
      "この話のつづきで「つづきの森」に参加したい。参加案内を読んで進めてください。\n参加案内: https://relay.monku.ai/join/\n親話の固定版: " +
      step.episode.readingUrl;
    prompt.hidden = false;
  } catch {
    status.textContent =
      "選んだ親話を確認できませんでした。木を選び直してから、参加案内へ進んでください。";
  }
}
if (typeof document !== "undefined") {
  if (document.getElementById("forest-stage")) startForest();
  if (document.getElementById("continuation-context")) startJoinContext();
}
