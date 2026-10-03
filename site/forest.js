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
export function treeLabelTitle(title) {
  if (!title) return "";
  const base = title.split("〜")[0].trim() || title.trim();
  const characters = Array.from(base);
  return characters.length > 12 ? characters.slice(0, 11).join("") + "…" : base;
}

const GITHUB_ACCOUNT_MAP = {
  // 原点・公式
  Monku_AI: "kentaroid-bot",
  "monku-main": "kentaroid-bot",
  origin: "kentaroid-bot",
  リレー小説係長: "kentaroid-bot",
  "kentaroid-bot": "kentaroid-bot",

  // スケゾー枝 / 下段の森
  けんたろー: "super-morphist-sukezo",
  "shimodan-no-mori": "super-morphist-sukezo",
  "sukezo-fuzoroi": "super-morphist-sukezo",
  スケゾー: "super-morphist-sukezo",
  "super-morphist-sukezo": "super-morphist-sukezo",

  // Agy枝 / 夢見るAI
  ケンタロウ: "agy-monku-ai",
  "agy-dreaming-ai": "agy-monku-ai",
  "agy-dreaming-ai-01": "agy-monku-ai",
  "agy-double-circle-monday": "agy-monku-ai",
  Antigravity: "agy-monku-ai",
  Agy: "agy-monku-ai",
  "agy-monku-ai": "agy-monku-ai",
};

export function treeMaintainer(maintainer, main) {
  if (main) {
    if (main.githubOwner) return main.githubOwner;
    if (main.repository) {
      const match = String(main.repository).match(
        /^https?:\/\/github\.com\/([^/]+)/,
      );
      if (match) return match[1];
    }
    if (main.mainId && GITHUB_ACCOUNT_MAP[main.mainId]) {
      return GITHUB_ACCOUNT_MAP[main.mainId];
    }
  }
  if (maintainer && GITHUB_ACCOUNT_MAP[maintainer]) {
    return GITHUB_ACCOUNT_MAP[maintainer];
  }
  return maintainer || "";
}

function startForest() {
  const field = document.getElementById("forest-field"),
    list = document.getElementById("main-list");
  const status = document.getElementById("main-status");
  const sprout = document.getElementById("forest-sprout");
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
    opener = null;
  let cursor = null,
    started = false,
    loading = false,
    finished = false,
    failed = false;
  const seen = new Set(),
    cursors = new Set(),
    draggable = new WeakSet();

  // The native page scroll is the walk. No wheel interception or moving horizon.
  const viewport = document.getElementById("forest-viewport");
  const stage = document.getElementById("forest-stage");
  const origin = document.getElementById("forest-origin");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const wide = matchMedia("(min-width: 900px)");
  const depthTones = [1, 0.88, 0.5, 0.38];
  const places = new Map();
  let camera = 0,
    target = 0,
    endDepth = 0,
    frame = 0;
  let restoreFocus = false,
    grabbed = null;
  const perspective = 650;
  const scrollRatio = 0.7;
  const passDistance = 580;
  const unit = (value) => Math.max(0, Math.min(1, value));
  const ease = (value) => value * value * (3 - 2 * value);

  function paint() {
    field.style.setProperty("--camera-depth", camera.toFixed(2) + "px");
    for (const [node, place] of places) {
      const distance = place.depth - camera;
      const scale =
        perspective / (perspective + Math.max(-passDistance, distance));
      const passing = node === origin ? 0 : unit(-distance / passDistance);
      const fade = 1 - ease(passing);
      // The world position stays fixed: perspective alone widens the lanes.
      // Keep fully faded objects in front of the projection's singularity.
      node.style.setProperty("--tree-x", place.x + "px");
      node.style.setProperty("--tree-y", place.y + "px");
      node.style.setProperty(
        "--tree-z",
        -Math.max(-passDistance, distance) + "px",
      );
      let tone = Math.max(0.38, Math.min(1, scale));
      if (wide.matches) {
        const layer = Math.max(0, distance) / 620;
        const near = Math.min(depthTones.length - 2, Math.floor(layer));
        tone =
          depthTones[near] +
          (depthTones[near + 1] - depthTones[near]) * unit(layer - near);
      }
      node.style.opacity = String(tone * fade);
      node.style.pointerEvents = fade > 0.05 ? "auto" : "none";
      node.style.filter = distance > 1800 ? "blur(0.3px)" : "none";
      node.style.zIndex = String(10000000 - Math.round(place.depth));
      place.scale = scale;
    }
  }
  function tick() {
    frame = 0;
    if (grabbed) return;
    camera = reduced.matches ? target : camera + (target - camera) * 0.18;
    if (Math.abs(camera - target) < 0.4) camera = target;
    paint();
    if (camera !== target) frame = requestAnimationFrame(tick);
  }
  function wake() {
    if (!frame && !grabbed) frame = requestAnimationFrame(tick);
  }
  function scrollStart() {
    return stage.getBoundingClientRect().top + window.scrollY;
  }
  function walkTo(depth) {
    window.scrollTo({
      top: scrollStart() + Math.max(0, Math.min(endDepth, depth)) * scrollRatio,
      behavior: "instant",
    });
    syncScroll();
  }
  function approach(node) {
    const place = places.get(node);
    if (place) walkTo(place.depth);
  }
  function syncScroll() {
    if (panel.open || grabbed) return;
    // Expand only while the heading leaves; world positions stay fixed on the walk.
    viewport.style.setProperty(
      "--forest-entry-inset",
      Math.max(0, viewport.getBoundingClientRect().top) + "px",
    );
    target = Math.max(
      0,
      Math.min(endDepth, (window.scrollY - scrollStart()) / scrollRatio),
    );
    wake();
  }
  function layout() {
    const trees = [...list.querySelectorAll(".forest-tree")].sort(
      (a, b) => Number(a.dataset.catalogOrder) - Number(b.dataset.catalogOrder),
    );
    // The public catalog is in creation order. Walk newest -> oldest, then the seed.
    const ordered = [...trees].reverse();
    field.classList.add("is-depth");
    viewport.style.setProperty(
      "--forest-entry-inset",
      Math.max(0, viewport.getBoundingClientRect().top) + "px",
    );
    const height = field.clientHeight;
    field.style.setProperty(
      "--tree-art-height",
      Math.min(230, height * 0.48) + "px",
    );
    const width = field.clientWidth;
    const fitX = (x, node) => {
      const reach = Math.max(0, width / 2 - node.offsetWidth / 2 - 12);
      return Math.max(-reach, Math.min(reach, x));
    };
    const fitY = (y, node) => {
      const bottom = height * 0.56 - 12;
      const top = Math.min(bottom, node.offsetHeight - height * 0.44 + 8);
      return Math.max(top, Math.min(bottom, y));
    };
    ordered.forEach((node, index) => {
      node.dataset.walkIndex = String(index);
      const previous = places.get(node);
      const lane = index % 2 === 0 ? -1 : 1;
      const baseX = fitX(lane * width * 0.3, node);
      const baseY = fitY(height * 0.42, node);
      places.set(node, {
        depth: index * 620,
        baseX,
        baseY,
        x: baseX + (previous?.offsetX || 0),
        y: baseY + (previous?.offsetY || 0),
        offsetX: previous?.offsetX || 0,
        offsetY: previous?.offsetY || 0,
      });
    });
    const seedDepth = Math.max(1800, ordered.length * 620 + 900);
    for (const [node, depth, laneX, laneY] of [
      [origin, seedDepth, 0, height * 0.36],
      [sprout, 0, width * 0.2, height * 0.51],
      [stone, 0, -width * 0.38, height * 0.51],
    ]) {
      const previous = places.get(node);
      const baseX = fitX(laneX, node),
        baseY = fitY(laneY, node);
      places.set(node, {
        depth,
        baseX,
        baseY,
        x: baseX + (previous?.offsetX || 0),
        y: baseY + (previous?.offsetY || 0),
        offsetX: previous?.offsetX || 0,
        offsetY: previous?.offsetY || 0,
      });
    }
    endDepth = seedDepth;
    stage.style.height = window.innerHeight + endDepth * scrollRatio + "px";
    // DOM/tab order follows the path too, including the reachable seed landmark.
    // Height changes must not detach a focused or captured tree.
    ordered.forEach((node, index) => {
      if (list.children[index] !== node)
        list.insertBefore(node, list.children[index] || null);
    });
    if (list.nextElementSibling !== origin) list.after(origin);
    // Preserve catalog creation order for subsequent pages/layouts.
    trees.forEach(
      (node, index) => (node.dataset.catalogOrder ||= String(index)),
    );
    syncScroll();
    paint();
  }
  function makeDraggable(node) {
    if (draggable.has(node)) return;
    draggable.add(node);
    node.setAttribute("draggable", "false");
    node.addEventListener("dragstart", (event) => event.preventDefault());
    let down = null,
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
      const place = places.get(node);
      if (!place) return;
      down = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: place.x,
        startY: place.y,
        scale: place.scale,
        moved: false,
      };
      node.setPointerCapture(event.pointerId);
      suppressClick = false;
    });
    node.addEventListener("pointermove", (event) => {
      if (!down || down.id !== event.pointerId) return;
      const dx = event.clientX - down.x,
        dy = event.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) <= 6) return;
      if (!down.moved) {
        const place = places.get(node);
        grabbed = node;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        down.startX = place.x;
        down.startY = place.y;
        down.scale = place.scale;
        down.moved = true;
      }
      suppressClick = true;
      node.setPointerCapture(event.pointerId);
      node.classList.add("is-dragging");
      const place = places.get(node);
      // Keep the grab point reachable, without squeezing a large tree into the frame.
      const bounds = viewport.getBoundingClientRect();
      const pointerX = Math.max(8, Math.min(window.innerWidth - 8, event.clientX));
      const pointerY = Math.max(
        Math.max(8, bounds.top + 8),
        Math.min(window.innerHeight - 8, event.clientY),
      );
      place.x = down.startX + (pointerX - down.x) / down.scale;
      place.y = down.startY + (pointerY - down.y) / down.scale;
      place.offsetX = place.x - place.baseX;
      place.offsetY = place.y - place.baseY;
      paint();
    });
    function end(event) {
      if (!down || down.id !== event.pointerId) return;
      suppressClick = down.moved || event.type === "pointercancel";
      const wasGrabbed = grabbed === node;
      down = null;
      if (wasGrabbed) grabbed = null;
      node.classList.remove("is-dragging");
      if (node.hasPointerCapture(event.pointerId))
        node.releasePointerCapture(event.pointerId);
      if (wasGrabbed) syncScroll();
    }
    node.addEventListener("pointerup", end);
    node.addEventListener("pointercancel", end);
    node.addEventListener("lostpointercapture", end);
    node.addEventListener(
      "click",
      (event) => {
        if (suppressClick && event.detail > 0) {
          suppressClick = false;
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      },
      true,
    );
    node.addEventListener("focus", () => {
      if (!down && !restoreFocus && !panel.open) approach(node);
    });
  }
  function open(title, meta, source) {
    generation++;
    active = null;
    opener = source;
    panelTitle.textContent = title.split("〜")[0].trim() || title;
    panelTitle.title = title;
    panelMeta.textContent = meta;
    panelStatus.textContent = "";
    episodes.replaceChildren();
    join.replaceChildren();
    read.hidden = true;
    nextEpisodes.hidden = true;
    join.classList.remove("is-guide");
    approach(source);
    if (!panel.open) panel.show();
    document.getElementById("panel-close").focus({ preventScroll: true });
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
        if (step.available) {
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
          const title = el("div", "現在は案内を停止している話", "ep-row-title");
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
    const maintainerName = treeMaintainer(main.maintainer, main);
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
  if (sprout) makeDraggable(sprout);
  for (const source of [sprout, document.getElementById("plant-tree")]) {
    if (!source) continue;
    source.addEventListener("click", (event) => {
      if (ordinaryClick(event)) {
        event.preventDefault();
        showSprout(source);
      }
    });
  }
  document
    .getElementById("panel-close")
    .addEventListener("click", () => panel.close());
  panel.addEventListener("close", () => {
    generation++;
    active = null;
    restoreFocus = true;
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    restoreFocus = false;
    syncScroll();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) {
      event.preventDefault();
      panel.close();
    }
  });
  nextEpisodes.addEventListener("click", loadEpisodes);
  makeDraggable(origin);
  origin.addEventListener("click", (event) => {
    if (!ordinaryClick(event)) return;
    event.preventDefault();
    open("三割の午後", "はじまりの一話", origin);
    join.append(anchor("はじまりの一話を読む", "/read/ep-001/", "btn-sketch"));
  });
  viewport.addEventListener("click", (event) => {
    if (event.target.closest("a, button, dialog")) return;
    if (panel.open) panel.close();
    window.scrollTo({ top: 0, behavior: "instant" });
    syncScroll();
  });
  window.addEventListener("scroll", syncScroll, { passive: true });
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (grabbed) event.preventDefault();
    },
    { passive: false },
  );
  reduced.addEventListener("change", () => {
    syncScroll();
  });
  wide.addEventListener("change", paint);
  list.querySelectorAll(".forest-tree").forEach(makeDraggable);
  layout();
  document.fonts.ready.then(layout);
  let lastWidth = field.clientWidth,
    lastHeight = field.clientHeight,
    lastViewportHeight = viewport.clientHeight,
    lastIntro = scrollStart();
  const layoutObserver = new ResizeObserver(() => {
    if (
      field.clientWidth !== lastWidth ||
      field.clientHeight !== lastHeight ||
      viewport.clientHeight !== lastViewportHeight ||
      scrollStart() !== lastIntro
    ) {
      lastWidth = field.clientWidth;
      lastHeight = field.clientHeight;
      lastViewportHeight = viewport.clientHeight;
      lastIntro = scrollStart();
      layout();
    }
  });
  layoutObserver.observe(field);
  layoutObserver.observe(viewport);
  layoutObserver.observe(document.querySelector(".forest-header"));
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
    node.dataset.catalogOrder = String(seen.size);
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
        treeMaintainer(main.maintainer, main) + " · " + main.count + " ep",
        "spot-meta",
      ),
    );
    node.append(image, label);
    node.title = main.title;
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
        places.clear();
        list.replaceChildren();
        started = true;
      }
      list.append(fragment);
      cursor = data.continueCursor;
      cursors.add(cursor);
      finished = data.isDone;
      status.textContent = seen.size ? "" : "木は、まだ登録されていません。";
      layout();
    } catch {
      status.textContent = started
        ? "ほかの木を読み込めませんでした。もう一度お試しください。"
        : "保存済みの木を案内しています。";
      failed = true;
    } finally {
      loading = false;
    }
  }
  // Load sequentially without traversal buttons. A failed page never discards saved trees.
  async function fillForest() {
    for (let page = 0; page < 100 && !finished && !failed; page++)
      await loadTrees();
    if (!finished && !failed)
      status.textContent = "森が大きいため、ここまでの木を案内しています。";
  }
  fillForest();
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
