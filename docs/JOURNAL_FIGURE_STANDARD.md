# Journal Figure Standard / 論文図版基準

この文書は、Strong Motion Web Viewer の図を「画面上で見やすいチャート」ではなく、地震工学・強震動分野の原稿に組み込める図版として設計するための実装基準です。

## 現在の実装基準

- 作業図幅: 180 mm（double-column 想定）
- ラスター出力: 800 dpi
- 最終図幅での文字: 軸・目盛 10 pt、補助表示 8 pt以上、panel label 12 pt
- 最終図幅での線幅: 補助線 0.5 pt以上、データ線 0.8 pt
- 背景: 白。ダッシュボード用の角丸、影、大きな図内タイトルは図版から除外
- panel label: `(a)`, `(b)`, ... を各 panel の左上に配置
- 複数成分: 色だけでなく実線・破線・点線でも識別
- 波形: 別イベント・別観測点・別チャンネルを同一時間軸へ混在させない
- 三成分波形: 共通縦軸、一番下だけに時間目盛、成分名は直接表示
- 波形の縦軸: 実データの絶対値最大に対して 10–15% のヘッドルームを持たせ、極端な空白を作らない
- 凡例: 必要な場合だけ図内に置き、データを隠さない
- タイトルと説明 caption: 原稿側に置き、artwork 内に重複させない
- grayscale check: 色のない出力でも系列を識別できることを公開前に確認

## 図種別のルール

### Time history

- 成分間の振幅比較が目的の場合は共通縦軸を使う。
- PGA, PGV, PGD は符号付き値ではなく絶対値最大として表示する。
- 解析時刻の基準を metadata と caption に残す。

### Response spectrum

- Sa 図は対数周期軸と明示した減衰定数を使う。
- pSv tripartite 図は、主曲線より補助線が強くならないよう、1–2–5 目盛と decade 単位の Sa/Sd 補助線に制限する。
- ユーザー設定値ではなく、実際に計算できた有限の周期範囲から表示軸を作る。
- 減衰定数、計算手法、実計算周期範囲、各成分の peak 値と周期を artwork、caption、metadata に残す。
- 1:1 log-log は縦横の decade 数が一致する場合だけ使う。一致に未計算周期の追加が必要な場合は tripartite 補助線を外し、理由を caption と metadata に記録する。
- 別イベント・別観測点・別センサーチャンネルは record-set selector で分離する。

### Fourier spectrum

- 窓は 5% cosine taper を既定とし、rectangular も選択できるようにする。選択した窓は caption と metadata に明示する。
- 論文用の既定表示は Parzen 平滑（本アプリの既定 `B = 0.10 Hz`）を主曲線とし、raw FFT は薄い 0.5 pt の補助線とする。`B = 0.05/0.10/0.20/0.40 Hz` と raw/smoothed の切替を残す。これらの値を ViewWave 公式既定値とは表記しない。
- ViewWave の記載に沿い、振幅を直接平均せず、`|DFT|²` を Parzen 窓で平滑化してから平方根で振幅へ戻す。平滑化は表示帯域の切り出し前に全FFTビン上で行い、DC/Nyquist は Hermitian 対称の両側スペクトルとして扱う。
- Parzen 窓は `u = 280/(151B)`、`W(Δf) = 3u/4 [sin(πuΔf/2)/(πuΔf/2)]⁴` とし、離散カーネルの総和を1に正規化する。出力は元の正周波数FFTビンを保つ。
- Konno–Ohmachi `b = 20/40/60` は比較用の明示的な代替手法として残す。H/V 比の Konno–Ohmachi 既定は変更しない。
- 正の片側振幅、`|DFT|Δt`、FFT-bin 間隔 `df`、独立分解能 `1/T`、window、平滑化帯域を caption と metadata に明示する。
- 記録長、Nyquist 周波数、実際の high-pass / low-pass 設定から共通表示周波数帯を決める。
- 別イベント・別観測点・別チャンネルは同一図に重ねず、record-set selector で選択する。
- 対数軸の範囲が広い場合は全 minor tick にラベルを付けない。

### Wavelet scalogram

- 知覚的に単調な Viridis 系の colour map を使う。
- 母関数は `Morlet-6 Balanced` を強震動の過渡変化に対する既定とし、`Morlet-8 Frequency-resolved` を周波数分解能重視の選択肢とする。どちらも普遍的な最適値とは表記しない。
- scale と表示周波数の対応には Morlet の厳密な等価 Fourier 周期を使い、近似 `omega0/(2*pi*f)` を軸作成へ使わない。
- 生の L2 係数 `|W| [input unit · sqrt(s)]` は expert diagnostic とし、論文図の既定は scale bias を補正した量とする。振幅を名乗る場合は母関数の正弦波応答で校正して input unit へ戻し、power はその二乗または明示した `|W|²/s` とする。
- 記録内の時間–周波数形状を見る相対 dB mode と、同一前処理・同一単位の記録間を比較する絶対量 mode を分離する。相対 mode を記録間比較に使わない。
- colour normalization、coefficient unit、scale correction、Morlet parameter、frequency mapping、cone of influence を図と metadata の両方に明示する。
- cone of influence 外は解釈対象外であることをマスクと caption で示す。
- colour percentile と clip rate は COI 内の有限値だけから求め、COI 内に有効点のない周波数行を統計へ混ぜない。
- ridge は COI 内の補正量に基づく記述的 dominant-frequency trace とし、phase pick、mode 推定、不確実性ではないことを明記する。単純な全周波数 argmax を厳密な wavelet ridge と呼ばない。
- 時間 pixel への集約は係数振幅の算術平均ではなく、power-domain mean からの RMS を既定とする。最大値集約を使う場合は transient-preserving 表示と明示する。
- 長記録を計算上限まで縮約する場合は、Kaiser-windowed sinc anti-alias resampling を先に適用し、passband、stopband、入出力サンプル数、実効 `dt`、表示時間 bin 集約法を metadata に残す。非縮約時も Morlet の帯域幅を考慮した安全な Nyquist margin を使う。
- 三成分比較は NS/EW/UD を共通 time/frequency/colour scale で積層し、共通 colour bar は1本にする。単成分 mode は詳細検査用として残す。
- heatmap は高解像度 raster、軸・文字・COI・注記は vector とする mixed artwork を許容し、巨大な SVG cell 群と描画 seam を避ける。

### A4 overview report

- 1ページ目は意思決定に必要な overview とし、event/station、M、depth、distance、duration、主要 ground-motion 指標、三成分 acceleration、Parzen FAS、減衰を明示した Sa を優先する。
- 外部 tile に依存しない locator inset を使い、station と epicentre の相対位置、北、距離を小面積で伝える。
- velocity、dense tripartite、三成分 scalogram は詳細 plate または2ページ目へ分離し、1ページ目へ詰め込まない。
- A4最終寸法で本文 7.5 pt以上、軸目盛 8 pt以上、補助線 0.5 pt以上、data line 0.8 pt以上を確保する。
- peak annotation は data region の外または専用 margin に置き、波形を隠さない。時間 grid は sparse にし、zero line、major grid、data trace の濃度階層を分ける。
- tripartite guide は decade major と必要な 2・5 minor に制限し、主曲線より弱くする。
- 座標・距離・peak の表示桁は source precision と図の用途に合わせ、意味のない小数桁を増やさない。
- footer と本文は一般的な印刷 safe area 内に置き、print CSS に `size: A4 portrait` と余白を明示する。
- Methods JSON と SVG metadata に source files、component consistency、preprocessing、Parzen bandwidth/window、response method/damping/period grid、time reference、app version、build revision を記録する。

## 再現性ルール

- 図版ごとに `Methods JSON` を書き出し、ソースファイル、観測点、イベント時刻、成分、サンプリング周波数、記録長、前処理、解析条件、app version、build revision を記録する。
- 同じ metadata を SVG にも埋め込み、caption には観測点・イベント・前処理・解析手法の人間が読める要約を載せる。

## 公開前チェック

1. 実データで SVG と PNG を書き出す。
2. PNG の幅が 180 mm × 800 dpi = 5669 px で、pHYs metadata が 800 dpi であることを確認する。
3. SVG の幅が 180 mm、補助線が 0.5 pt以上、データ線が 0.8 pt であることを確認する。
4. colour と grayscale の両方を目視確認する。
5. 長い記録、複数イベント、時刻ずれ、非標準周期範囲、ゼロ付近の軸目盛を確認する。
6. Methods JSON と SVG metadata が実際の UI 設定と一致し、app version/build revision を含むことを確認する。

## 出力形式の制約

現在の SVG と PNG は、図の編集・確認・原稿作成のための working export です。SVG は Arial/Helvetica の system font を参照し、font file の埋め込みや outline 化は行いません。投稿先が求める PDF/EPS/TIFF、font embedding、CMYK などは最終投稿時に別途変換・検査が必要です。

## 一次資料

- [BSSA Submission Guidelines](https://www.seismosoc.org/publications/bssa-submission-guidelines-2/)
- [SSA Art Guidelines](https://www.seismosoc.org/publications/ssa-art-guidelines/)
- [Earthquake Spectra Author Guidelines (Wiley)](https://onlinelibrary.wiley.com/page/journal/19448201/homepage/author-guidelines)
- [Earthquake Engineering & Structural Dynamics Author Guidelines](https://onlinelibrary.wiley.com/page/journal/10969845/homepage/forauthors.html)
- [Wiley Electronic Artwork Guidelines](https://authorservices.wiley.com/asset/photos/electronic_artwork_guidelines.pdf)
- [ViewWave official overview](https://iisee.kenken.go.jp/staff/kashima/viewwave_j.html)
- [ViewWave Fourier-spectrum documentation](https://smo.kenken.go.jp/~kashima/viewwave/basic/fourier)
- [ViewWave 2.2 manual, Fourier spectrum equations 29–32](https://smo.kenken.go.jp/~kashima/sites/default/files/viewwave/vw_manual220.pdf)
- [IISEE strong-motion lecture, Parzen 0/0.1/0.2/0.4 Hz comparison](https://iisee.kenken.go.jp/lna/download.php?cid=E1-230-2009&f=201110074263b195.pdf&n=E1-230-2009_smo2009.pdf)
- [NILIM technical report, Parzen bandwidth definition](https://www.nilim.go.jp/lab/bcg/siryou/rpn/rpn0075pdf/kh0075.pdf)
- [ViewWave response-spectrum documentation](https://smo.kenken.go.jp/~kashima/viewwave/basic/response)
- [ViewWave update history](https://smo.kenken.go.jp/~kashima/viewwave/technical/updates)
- [Torrence and Compo (1998), A Practical Guide to Wavelet Analysis](https://psl.noaa.gov/people/gilbert.p.compo/Torrence_compo1998.pdf)
- [Liu, Liang, and Weisberg (2007), Rectification of the Bias in the Wavelet Power Spectrum](https://doi.org/10.1175/2007JTECHO511.1)

ViewWave は比較基準です。本アプリは、共通スケール、論文用 typography、SVG/800 dpi PNG、解析条件と provenance の同時出力を検証可能な上位互換の判定項目とします。一方、投稿先ごとの PDF/EPS/TIFF、font embedding、CMYK は最終投稿時に別途検査します。
