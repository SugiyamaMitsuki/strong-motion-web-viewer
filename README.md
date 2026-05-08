# Strong Motion Web Viewer

K-NET / KiK-net 形式ファイルとCSV時系列データをブラウザ内で読み込み、時刻歴、フーリエスペクトル、応答スペクトル、計測震度、振幅最大値を計算・表示する静的Webアプリです。

ViewWaveを移植したものではなく、GitHub Pagesで公開できるオリジナル実装です。

## 実装済み機能

- K-NET / KiK-netファイル読み込み
  - `*.NS`, `*.EW`, `*.UD`, `*.NS1`, `*.EW1`, `*.UD1` など
  - `Scale Factor` を読み取り、平均値除去後に `cm/s²` へ変換
- CSV時系列データ読み込み
  - ドラッグ&ドロップ
  - ファイル選択
  - Chromium系ブラウザでのフォルダ選択
  - サブフォルダを含む観測記録フォルダの再帰読み込み
- 未知テキストフォーマットの手入力読み込み
  - 自動判定できないファイルを保留し、ヘッダー行数・区切り文字・時間列・時間刻み・振幅倍率・成分列を入力して読み込み
  - データ列数と先頭行プレビューを表示
- 加速度・速度・変位の自動推定
  - CSVヘッダ名・単位から推定
  - 画面上で手動上書き可能
- 前処理
  - 平均値除去、線形トレンド除去
  - calcFFT / calcDerivative系のFFT cosine taperによるHigh-pass / Low-pass
  - High-pass / Low-pass の有効化とカットオフ周波数指定
- 時刻歴表示
  - 加速度
  - 速度
  - 変位
  - NS/EW/UDの重ね描き表示と個別表示を切り替え可能
  - 最大絶対振幅と発生時刻をグラフ内に表示
- 粒子軌跡・オービット表示
  - EW-NS、EW-UD、NS-UD投影
  - 加速度・速度・変位の切り替え
  - X/Y同一縮尺の正方形プロット
- フーリエ振幅スペクトル
- 水平上下スペクトル比
  - 既定はSESAME推奨の水平2成分幾何平均: H/V = `sqrt(NS * EW) / UD`
  - RMS平均: H/V = `sqrt((NS² + EW²) / 2) / UD` も切り替え可能
  - 片方の水平成分のみの場合は、その水平成分とUDの比を表示
  - 時間端5% cosine taper後にFFTし、Konno-Ohmachi平滑化したスペクトルで比を計算
  - 対数周波数グリッド上で計算し、表示解像度はFast/Standard/Detailedを切り替え可能
  - 平滑化なし・弱・標準・強を切り替え可能
  - 縦軸は外れ値に強いRobust表示と全範囲Full表示を切り替え可能
  - ピーク周波数・ピーク周期・ピーク比を表示
- 応答スペクトル
  - Nigam-Jennings法
  - 既定減衰定数 5%
  - Sd / pSv / Sa 表示
  - 両対数1:1表示と最大値・最小値に合わせた表示の切り替え
  - pSvの両対数1:1表示時のトリパタイトスペクトル背景
- 計測震度
  - NS/EW/UD 3成分がそろった場合に計算
  - JMA計測震度フィルタをFFT領域で適用
- 振幅最大値
  - PGA
  - PGV
  - PGD
- 観測点地図
  - K-NET / KiK-netヘッダの緯度経度を読み取り、観測点位置をOpenStreetMap上に表示
  - 震央緯度経度がある場合は震央も表示
- 位置・距離
  - 震源緯度・震源経度・深さ、観測点緯度経度を手入力で修正可能
  - 震央距離と震源距離を表示
- 図出力
  - SVG
  - PNG
- 処理データ出力
  - 時刻歴CSV
  - 距離CSV
  - フーリエCSV
  - 水平上下スペクトル比CSV
  - 応答スペクトルCSV
  - サマリJSON
  - 一括ZIP

## ローカル起動

```bash
npm install
npm run dev
```

ブラウザで表示されたローカルURLを開きます。

トップの `Load Real Sample` から、2024年8月9日19時57分頃の神奈川県西部の地震における K-NET KNG001 のNS/EW/UD 3成分を読み込めます。

## ビルド

```bash
npm run build
npm run preview
```

## GitHub Pages公開

1. GitHubで新規リポジトリを作成します。
2. このプロジェクト一式をpushします。
3. GitHubの `Settings > Pages` で、GitHub Actionsによる公開を有効化します。
4. `main` ブランチへpushすると `.github/workflows/deploy.yml` が実行され、`dist` がGitHub Pagesへ公開されます。

Viteの `base` はGitHub Actions実行時にリポジトリ名から自動設定されます。

## CSV形式例

時刻列あり:

```csv
time,acc_NS(gal),acc_EW(gal),acc_UD(gal)
0.00,0.1,0.2,0.0
0.01,0.2,0.1,0.0
```

時刻列なし:

```csv
acc_NS(gal),acc_EW(gal),acc_UD(gal)
0.1,0.2,0.0
0.2,0.1,0.0
```

時刻列がない場合は、画面の「CSV既定サンプリング周波数」を使います。

## 注意事項

- Webブラウザのセキュリティ制約により、`C:\data\file.csv` や `/Users/.../file.csv` のようなローカルパス文字列を直接入力して読むことはできません。ファイル選択、フォルダ選択、ドラッグ&ドロップを使用してください。
- CSVの量種別（加速度・速度・変位）は、ヘッダ情報がない場合は完全自動判定できません。画面の表で手動修正してください。
- 積分処理は平均値除去・ドリフト補正設定に依存します。研究・業務で使用する場合は、既知データとの照合を行ってください。
- 計測震度は3成分入力時のみ計算します。初期実装ではブラウザ内FFTによる実装です。正式な運用では検証用データセットでの差分確認を推奨します。

## 主要ファイル

```text
src/parsers/knet.ts               K-NET / KiK-netパーサ
src/parsers/csv.ts                CSVパーサ
src/parsers/customText.ts         未知テキストフォーマット手入力パーサ
src/analysis/derive.ts            加速度・速度・変位の相互変換
src/analysis/distance.ts          震央距離・震源距離
src/analysis/fourier.ts           フーリエ振幅スペクトル
src/analysis/horizontalVerticalRatio.ts 水平上下スペクトル比
src/analysis/orbit.ts             粒子軌跡・オービット
src/analysis/responseSpectrum.ts  Nigam-Jennings応答スペクトル
src/analysis/jmaIntensity.ts      計測震度
src/components/LocationDistancePanel.tsx 位置入力と距離表示
src/components/ManualFormatImportPanel.tsx 未知フォーマット入力UI
src/components/ParticleOrbitPanel.tsx 粒子軌跡・オービット表示
src/components/StationMap.tsx     観測点地図
src/components/SvgChart.tsx       SVGグラフとPNG/SVG出力
src/export/                       CSV/JSON/ZIP出力
```
