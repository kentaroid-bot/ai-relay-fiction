# 『つづきの森』木々生成プロンプト＆スタイル設計書

このドキュメントは、リレー小説『つづきの森』における木々や新芽のアセットを生成・透過加工するための思想とプロンプトの原本です。

---

## 1. スタイルの哲学（引き算の美学）

- **モチーフの原点**:
  harmonic hammock『もういいかい?』（3曲目『つもりの森』）のジャケット世界観。
- **「8歳の絵」のバランス**:
  - × 大人の写実的な植物デッサン（リアルすぎて植物図鑑になってしまう）
  - × 3歳のぐちゃぐちゃ落書き（形が崩壊して認識できない）
  - ○ **8歳の小学生の絵**: 形（三角形、たまご型、雲型）を一生懸命とらえ、色鉛筆でざくざくと無心にハッチング（斜線）で塗りつぶした素朴さ。
- **徹底した引き算**:
  - 葉っぱの細かい輪郭、小鳥、花、星、木の実などの**説明的なディテールは一切描かない**。
  - 「緑のシルエットの塗り絵」＋「一本の茶色い幹の線」だけ。
  - うまく描こうとしない、素直で無心な塗り。

---

## 2. 確定生成プロンプト

### ① 木々シート（4種の基本シルエット）
```text
Four extremely minimal, abstract colored pencil tree silhouettes neatly side-by-side on clean white textured watercolor sketchbook paper. Zero decorative details: NO individual leaves, NO birds, NO flowers, NO stars, NO fruits, NO decorations, absolutely unpretentious and non-illustrative. Just raw, pure silhouettes and shapes: a solid green canopy (moss green, olive, muted forest green) filled roughly with simple colored pencil hatching/scribble strokes, and a simple brown stick trunk. 1. A rough triangle fir tree silhouette. 2. A simple rounded cloud/blob tree silhouette. 3. A slender three-tiered triangle tree silhouette. 4. A simple round egg-shaped tree silhouette. Naive, quiet, minimalist, not trying to draw well, spacious clean white paper background, poetic Japanese indie folk album artwork aesthetic.
```

### ② 新芽（双葉）
```text
A single tiny, cute little plant sprout / seedling with two small green leaves and a short brown stem, drawn with colored pencil by an 8-year-old child. Extremely simple, minimal naive art, colored pencil hatching, unpretentious and non-illustrative, just a sweet tiny green sprout emerging on vast clean white watercolor paper, indie folk album cover aesthetic.
```

### ③ 森のミニシンボル（5種の2Dフラット絵本アイコン）
```text
Five extremely minimal, flat 2D colored pencil drawings neatly side-by-side on clean white textured watercolor sketchbook paper, drawn naively by an 8-year-old child. Absolutely NO 3D shading, NO volumetric gradients, NO drop shadows, NO realistic details, NO decorative inside patterns, strictly flat 2D naive picture book art: 1) a simple flat red ladybug with a black head and three simple black dots, flat colored pencil hatching; 2) a simple flat pastel yellow butterfly with plain wings and no inside patterns; 3) a simple flat brown acorn with a dark cap, flat shape without crosshatching; 4) a tiny flat naive light-blue bird in profile, simple dot eye, purely flat shape; 5) a simple smooth grey stone pebble, minimal flat shape. Pure 2D flat colored pencil strokes, unpretentious and non-illustrative, generous white paper background, poetic Japanese indie folk aesthetic.
```

### ④ 羽ばたく小鳥（シェア用・レオ・レオニ風着想）
```text
A single tiny, cute minimalist light-blue bird in flight with open wings fluttering happily, side profile flying bird. Leo Lionni inspired naive children picture book art, simple colored pencil strokes and soft texture on clean white textured paper. Absolutely NO text, NO words, NO letters, NO 3D shading, NO drop shadows. Flat 2D naive graphic silhouette, sweet and poetic Japanese indie folk album aesthetic, vast white breathing room.
```

---

## 3. クロップと完全透過PNG変換の手順

生成された画像は周囲に画用紙のテクスチャ（オフホワイト RGB: 230〜245）を含んでいるため、Webで四角い枠を出さないためにピクセル解析で背景を完全透明（アルファ0）に抜く。

### 透過処理アルゴリズム（Python + PAM/PPM）
- 紙テクスチャの特性: 高明度（`min(r,g,b) >= 222`）かつ超低彩度（`max(r,g,b) - min(r,g,b) < 22`）。
- この条件を満たすピクセルを `alpha = 0`（完全透明）にする。
- `min(r,g,b)` が 190〜222 の境界部分は `t ** 1.5` でスムーズにフェードインさせ、色鉛筆の描画輪郭を自然に残す。
- 出力は `mix-blend-mode: multiply` と併用することで、サイトの画用紙テクスチャ（`#fbf9f4`）に完全に同化する。
