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
      const match = String(main.repository).match(/^https?:\/\/github\.com\/([^/]+)/);
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
  const stage = document.getElementById("forest-stage"),
    camera = document.getElementById("forest-camera");
  const status = document.getElementById("main-status"),
    more = document.getElementById("more-mains");
  const sprout = document.getElementById("forest-sprout"),
    stone = document.getElementById("forest-stone");
  const guide = document.getElementById("walkGuide");
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

  // カメラ・仮想スクロール管理
  const MIN_Z = -50;
  const MAX_Z = 880;
  let targetZ = 0;
  let currentZ = 0;
  let targetMouseX = 0;
  let targetMouseY = 0;
  let currentMouseX = 0;
  let currentMouseY = 0;
  let isMovingToTarget = false;

  function parseTranslate3d(el) {
    const style = el.style.transform;
    const match = style.match(
      /translate3d\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/,
    );
    if (match) {
      return {
        x: parseFloat(match[1]),
        y: parseFloat(match[2]),
        z: parseFloat(match[3]),
      };
    }
    return { x: 0, y: 0, z: 0 };
  }

  // 3D空間への木の配置（手前: 最新 〜 奥: 原点）
  function layout() {
    const trees = [...list.querySelectorAll(".forest-tree")];
    if (!trees.length) return;

    // 最新（index 0）を手前に、古い木（末尾）を奥に配置
    const total = trees.length;
    trees.forEach((tree, i) => {
      // 既に手動ドラッグされた木は再配置をスキップ
      if (tree.dataset.manualMoved === "true") return;

      let zPos, xPos, yPos, depth;
      if (total === 1) {
        xPos = 0;
        yPos = 0;
        zPos = -100;
        depth = "near";
      } else {
        const ratio = i / (total - 1); // 0 (最新) 〜 1 (最奥)
        zPos = 150 - ratio * 900; // +150px 〜 -750px
        // 小道の蛇行に沿って左右に配分
        const wave = Math.sin(ratio * Math.PI * 2.2);
        xPos = (i % 2 === 0 ? -1 : 1) * (140 + Math.abs(wave) * 70);
        if (i === total - 1) xPos = 30; // 最奥は丘の中央付近
        yPos = 90 - ratio * 170; // 手前は下寄り(90px)、奥は丘の上(-80px)

        if (zPos > 50) depth = "near";
        else if (zPos > -300) depth = "mid-near";
        else if (zPos > -600) depth = "mid-deep";
        else depth = "deepest";
      }

      tree.dataset.depth = depth;
      tree.style.transform = `translate3d(${xPos.toFixed(1)}px, ${yPos.toFixed(1)}px, ${zPos.toFixed(1)}px)`;
      tree.style.zIndex = String(Math.round(1000 + zPos));
    });

    // スプラウト（若芽）と道標の石の配置
    if (sprout && sprout.dataset.manualMoved !== "true") {
      sprout.style.transform = "translate3d(240px, 130px, 120px)";
      sprout.style.zIndex = "1120";
    }
    if (stone && stone.dataset.manualMoved !== "true") {
      stone.style.transform = "translate3d(-380px, 160px, 160px)";
      stone.style.zIndex = "1160";
    }
  }

  // 3Dドラッグ移動（つかんで配置できるインタラクティブ機能）
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

      const pos = parseTranslate3d(node);
      down = {
        id: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        initialX: pos.x,
        initialY: pos.y,
        initialZ: pos.z,
      };
      moved = false;
      suppressClick = false;
      node.style.zIndex = String(++z + 2000);

      try {
        node.setPointerCapture(event.pointerId);
      } catch (_) {}
    });

    node.addEventListener("pointermove", (event) => {
      if (!down || down.id !== event.pointerId) return;
      const dx = event.clientX - down.clientX;
      const dy = event.clientY - down.clientY;

      if (!moved && Math.hypot(dx, dy) > 5) {
        moved = true;
        node.classList.add("is-dragging");
      }

      if (moved) {
        // カメラの現在Zと木のZに応じたスケーリングで移動
        const effectiveScale = Math.max(
          0.35,
          (800 + down.initialZ + currentZ) / 800,
        );
        const newX = down.initialX + dx / effectiveScale;
        const newY = down.initialY + dy / effectiveScale;
        node.style.transform = `translate3d(${newX.toFixed(1)}px, ${newY.toFixed(1)}px, ${down.initialZ}px)`;
        node.dataset.manualMoved = "true";
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

    node.addEventListener(
      "click",
      (event) => {
        if (suppressClick) {
          suppressClick = false;
          if (event.detail > 0) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }
      },
      true,
    );
  }

  // 1. スクロールで小道を歩く
  window.addEventListener(
    "wheel",
    (e) => {
      if (panel.open) return;
      const delta = e.deltaY * 0.7;
      targetZ = Math.max(MIN_Z, Math.min(MAX_Z, targetZ + delta));
      isMovingToTarget = false;
      if (guide) guide.style.opacity = "0";
    },
    { passive: true },
  );

  // 2. スマホ・タッチスワイプ
  let touchStartY = 0;
  window.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 1) {
        touchStartY = e.touches[0].clientY;
      }
    },
    { passive: true },
  );

  window.addEventListener(
    "touchmove",
    (e) => {
      if (panel.open) return;
      if (e.touches.length === 1) {
        const touchY = e.touches[0].clientY;
        const delta = (touchStartY - touchY) * 1.3;
        touchStartY = touchY;
        targetZ = Math.max(MIN_Z, Math.min(MAX_Z, targetZ + delta));
        isMovingToTarget = false;
        if (guide) guide.style.opacity = "0";
      }
    },
    { passive: true },
  );

  // 3. マウス微細パララックス（酔い防止：数ピクセルのみ）
  window.addEventListener("mousemove", (e) => {
    const x = e.clientX / window.innerWidth - 0.5;
    const y = e.clientY / window.innerHeight - 0.5;
    targetMouseX = x * 7;
    targetMouseY = y * 4;
  });

  // 4. 背景タップで入り口に戻る
  if (stage) {
    stage.addEventListener("click", (e) => {
      // 木やボタン以外の余白をクリックした場合
      if (e.target === stage || e.target.classList.contains("forest-field")) {
        targetZ = 0;
        isMovingToTarget = true;
      }
    });
  }

  // アニメーションループ（慣性イージング）
  function renderLoop() {
    if (camera) {
      const zEase = isMovingToTarget ? 0.08 : 0.16;
      currentZ += (targetZ - currentZ) * zEase;
      currentMouseX += (targetMouseX - currentMouseX) * 0.08;
      currentMouseY += (targetMouseY - currentMouseY) * 0.08;

      camera.style.transform = `translate3d(${currentMouseX.toFixed(2)}px, ${currentMouseY.toFixed(2)}px, ${currentZ.toFixed(2)}px)`;
    }
    requestAnimationFrame(renderLoop);
  }
  requestAnimationFrame(renderLoop);
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
          const title = el(
            "div",
            "現在は案内を停止している話",
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
    if (source) {
      const pos = parseTranslate3d(source);
      targetZ = Math.max(MIN_Z, Math.min(MAX_Z, -pos.z - 80));
      isMovingToTarget = true;
    }
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
    if (source) {
      const pos = parseTranslate3d(source);
      targetZ = Math.max(MIN_Z, Math.min(MAX_Z, -pos.z - 80));
      isMovingToTarget = true;
    }
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
    if (source) {
      const pos = parseTranslate3d(source);
      targetZ = Math.max(MIN_Z, Math.min(MAX_Z, -pos.z - 80));
      isMovingToTarget = true;
    }
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
    if (opener?.isConnected) opener.focus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && panel.open) {
      event.preventDefault();
      panel.close();
    }
  });
  nextEpisodes.addEventListener("click", loadEpisodes);
  list.querySelectorAll(".forest-tree").forEach((tree) => {
    makeDraggable(tree);
    tree.addEventListener("click", (event) => {
      if (ordinaryClick(event)) {
        const pos = parseTranslate3d(tree);
        targetZ = Math.max(MIN_Z, Math.min(MAX_Z, -pos.z - 80));
        isMovingToTarget = true;
      }
    });
  });
  list.addEventListener("focusin", (event) => {
    const tree = event.target.closest(".forest-tree");
    if (tree) {
      const pos = parseTranslate3d(tree);
      targetZ = Math.max(MIN_Z, Math.min(MAX_Z, -pos.z - 80));
      isMovingToTarget = true;
    }
  });
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
    const wrap = el("div", undefined, "tree-artwork-wrap");
    const image = el("img", undefined, "tree-artwork");
    image.src = "/assets/" + node.dataset.art;
    image.alt = "";
    image.draggable = false;
    image.width = 240;
    image.height = 400;
    wrap.append(image);
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
    node.append(wrap, label);
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
