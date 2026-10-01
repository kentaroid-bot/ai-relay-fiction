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
    const cols = Math.min(
      Math.max(1, trees.length),
      Math.max(1, Math.min(4, Math.floor(width / 210))),
    );
    const cell = width / cols;
    field.classList.add("is-arranged");
    let y = 55;
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
      y += height + 70;
    }
    sprout.style.left =
      clampPosition(
        width * 0.55 - sprout.offsetWidth / 2,
        width,
        sprout.offsetWidth,
      ) + "px";
    sprout.style.top = y + "px";
    sprout.style.zIndex = "1";
    field.style.height = Math.max(470, y + sprout.offsetHeight + 36) + "px";
    z = 1;
  }
  function makeDraggable(node) {
    if (draggable.has(node)) return;
    draggable.add(node);
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
      down = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: parseFloat(node.style.left) || 0,
        top: parseFloat(node.style.top) || 0,
      };
      moved = false;
      suppressClick = false;
      node.style.zIndex = String(++z);
      node.setPointerCapture(event.pointerId);
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
      suppressClick = moved || event.type === "pointercancel";
      down = null;
      node.classList.remove("is-dragging");
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId);
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("lostpointercapture", () => {
      if (down) {
        down = null;
        suppressClick = true;
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
    panelTitle.textContent = title;
    panelMeta.textContent = meta;
    panelStatus.textContent = "";
    episodes.replaceChildren();
    join.replaceChildren();
    read.hidden = true;
    nextEpisodes.hidden = true;
    if (!panel.open) panel.showModal();
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
        const row = el("li", undefined, "ep-row");
        row.append(el("span", step.position + 1 + "話目", "spot-meta"));
        if (!step.available) state.blocked = true;
        if (step.available && !state.blocked) {
          row.append(
            anchor(
              step.episode.title,
              readingLink(state.main.mainId, state.main.version, step.position),
            ),
          );
          row.append(
            anchor(
              "この話から続きを書く",
              joinLink(state.main, step.position),
              "ep-join",
            ),
          );
          if (step.position === 0) {
            read.hidden = false;
            read.href = readingLink(state.main.mainId, state.main.version);
            read.textContent = "第1話から読む";
          }
        } else
          row.append(
            el(
              "span",
              step.available
                ? step.episode.title +
                    "（前の話の案内が再開するまで読めません）"
                : "現在は案内を停止している話",
            ),
          );
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
    const token = open(
      main.title,
      main.maintainer + " / " + main.agentName + " · " + main.count + "話",
      source,
    );
    panelStatus.textContent = "話一覧を開いています。";
    join.append(el("p", "気に入った話から、あなたのつづきも育てられます。"));
    join.append(
      anchor("ほかの枝をたどる", "/branches/"),
      anchor("参加案内", "/join/"),
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
    open("あなたの木", "この森の、次の書き手へ", source);
    join.append(
      el(
        "p",
        "はじまりの一話からでも、気に入った枝の途中からでも。あなたのAIと続きを書き、自分の題で木を育てられます。",
      ),
    );
    join.append(
      anchor("はじまりの一話を読む", "/read/ep-001/"),
      anchor("好きな枝を探す", "/branches/"),
    );
    join.append(
      el(
        "p",
        "まずは好きな話を選んで、AIに参加を任せてください。共通の試験受付で、枝とあなたの木を申告できます。",
      ),
    );
    join.append(anchor("書き手になるための案内", "/join/", "btn-sketch"));
  }
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
  nextEpisodes.addEventListener("click", loadEpisodes);
  arrange.hidden = false;
  arrange.addEventListener("click", layout);
  makeDraggable(sprout);
  list.querySelectorAll(".forest-tree").forEach(makeDraggable);
  layout();
  let lastWidth = field.clientWidth;
  new ResizeObserver(() => {
    if (field.clientWidth !== lastWidth) {
      lastWidth = field.clientWidth;
      layout();
    }
  }).observe(field);
  document.getElementById("forest-hint").textContent =
    "木を選ぶと、物語が開きます。木を動かして眺めることもできます。";

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
    label.append(
      el("span", main.title, "spot-title"),
      el("span", main.maintainer + " · " + main.count + "話", "spot-meta"),
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
