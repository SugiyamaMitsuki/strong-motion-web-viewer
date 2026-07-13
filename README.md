# Strong Motion Web Viewer

Strong Motion Web Viewer is a static browser application for loading and analyzing K-NET, KiK-net, and CSV strong-motion waveform data. It runs entirely in the browser and can be published with GitHub Pages.

## Live App

https://sugiyamamitsuki.github.io/strong-motion-web-viewer/

## Features

- K-NET / KiK-net file import
  - Supports files such as `*.NS`, `*.EW`, `*.UD`, `*.NS1`, `*.EW1`, and `*.UD1`
  - Reads `Scale Factor` and converts waveform values to `cm/s²` after mean removal
- JMA strong-motion acceleration CSV import
  - Reads `SITE CODE`, station latitude/longitude, sampling rate, unit, initial time, and NS/EW/UD component columns
  - Uses source latitude/longitude, depth, and magnitude when they are included in the first header line
- CSV time-history import
  - Drag and drop
  - File picker
  - Folder picker in Chromium-based browsers
  - Recursive loading of observation folders, including subfolders
- Manual import for unknown text formats
  - Files that cannot be detected automatically are held for manual configuration
  - Header rows, delimiter, time column, time step, amplitude multiplier, and component columns can be specified by the user
  - Column count and leading data preview are shown before import
- Automatic estimation of acceleration, velocity, and displacement records
  - Uses CSV headers and units when available
  - Can be manually overridden in the record table
- Preprocessing
  - Mean removal and linear detrending
  - High-pass / low-pass filtering using an FFT cosine taper based on the calcFFT / calcDerivative approach
  - User-configurable high-pass and low-pass cutoff frequencies
- Time-history plots
  - Acceleration
  - Velocity
  - Displacement
  - Switchable overlay and separate NS/EW/UD component views
  - Maximum absolute amplitude and occurrence time annotations
- Particle orbit plots
  - EW-NS, EW-UD, and NS-UD projections
  - Acceleration, velocity, and displacement modes
  - Components are separated by event and aligned on their shared physical time span
  - Different sampling intervals are resampled onto a shared time grid
  - Square plots with equal X/Y scale
- Fourier amplitude spectra
- Morlet wavelet scalograms
  - Continuous wavelet transform with Morlet wavelet `omega0 = 8`
  - Frequency or period Y-axis display
  - Fast / Standard / Detailed resolution options for browser-side calculation
  - SVG and PNG export
- Horizontal-to-vertical spectral ratio
  - Default horizontal combination follows the SESAME-style geometric mean: H/V = `sqrt(NS * EW) / UD`
  - RMS combination is also available: H/V = `sqrt((NS² + EW²) / 2) / UD`
  - If only one horizontal component is available, that component is divided by UD
  - Uses a 5% cosine time taper, FFT, and Konno-Ohmachi smoothing before taking the ratio
  - Computed on a logarithmic frequency grid with Fast / Standard / Detailed resolution options
  - Smoothing can be set to None, Light, Standard, or Strong
  - Y-axis range can be switched between robust outlier-resistant scaling and full-range scaling
  - Peak frequency, peak period, and peak H/V ratio are displayed
- Response spectra
  - Nigam-Jennings method
  - Default damping ratio: 5%
  - Tracks oscillator peaks between input samples and after the record ends
  - Rejects periods that would exceed the bounded substep calculation and caps UI periods at 100 s
  - Sd / pSv / Sa views
  - Switchable log-log 1:1 view and fitted data-range view
  - Tripartite spectrum background for pSv in log-log 1:1 mode
- JMA seismic intensity
  - Calculated when NS/EW/UD three-component data are available
  - JMA seismic intensity filter is applied in the FFT domain
  - Components must form one unambiguous station/channel set with matching start times
  - JMA downloads containing multiple 60-second intervals are evaluated interval by interval
  - Materially truncated intervals, missing samples, and unknown acceleration units are rejected
  - Display preprocessing does not alter the intensity used by the summary, report, or exports
- Peak amplitudes
  - PGA
  - PGV
  - PGD
- Station map
  - Reads station latitude and longitude from K-NET / KiK-net headers
  - Displays station locations on an OpenStreetMap-based map
  - Displays the epicenter when event latitude and longitude are available
- Location and distance tools
  - Source latitude, source longitude, source depth, station latitude, and station longitude can be manually edited
  - Epicentral distance and hypocentral distance are calculated
- Report overview figure
  - Combines record metadata, latitude/longitude, distances, ground motion strength, stacked acceleration/velocity waveforms, and tripartite response spectrum in an A4 portrait report-ready figure
  - Exports the overview figure as SVG or PNG
- Figure export
  - SVG
  - PNG
- Data export
  - Time-history CSV
  - Distance CSV
  - Fourier spectrum CSV
  - Horizontal-to-vertical spectral ratio CSV
  - Response spectrum CSV
  - Summary JSON
  - ZIP export

## Local Development

```bash
npm install
npm run dev
```

Open the local URL shown by Vite in your browser.

The `Load Real Sample` button loads three-component NS/EW/UD K-NET KNG001 records from the western Kanagawa Prefecture earthquake at around 19:57 on August 9, 2024.

## Build

```bash
npm run build
npm run preview
```

## GitHub Pages Deployment

1. Create a new repository on GitHub.
2. Push this project to the repository.
3. In GitHub, open `Settings > Pages` and set the source to GitHub Actions.
4. Push to the `main` branch. The `.github/workflows/deploy.yml` workflow will build the app and deploy `dist` to GitHub Pages.

The Vite `base` path is automatically set from the repository name when running in GitHub Actions.

## CSV Examples

With a time column:

```csv
time,acc_NS(gal),acc_EW(gal),acc_UD(gal)
0.00,0.1,0.2,0.0
0.01,0.2,0.1,0.0
```

Without a time column:

```csv
acc_NS(gal),acc_EW(gal),acc_UD(gal)
0.1,0.2,0.0
0.2,0.1,0.0
```

If no time column is available, the app uses the default CSV sampling frequency specified in the settings panel.

## Notes

- Because of browser security restrictions, local path strings such as `C:\data\file.csv` or `/Users/.../file.csv` cannot be read directly. Use the file picker, folder picker, or drag and drop.
- The waveform quantity type, such as acceleration, velocity, or displacement, cannot always be detected automatically when CSV headers are missing. Use the record table to correct it manually.
- Integration results depend on preprocessing, mean removal, and drift correction settings. For research or professional use, compare the results with trusted reference data.
- JMA seismic intensity is calculated only when three-component data are available. The current implementation uses a browser-side FFT implementation. Verification against official or trusted datasets is recommended before formal use.

## Main Files

```text
src/parsers/knet.ts                         K-NET / KiK-net parser
src/parsers/jma.ts                          JMA strong-motion acceleration CSV parser
src/parsers/csv.ts                          CSV parser
src/parsers/customText.ts                   Manual parser for unknown text formats
src/analysis/derive.ts                      Conversion between acceleration, velocity, and displacement
src/analysis/distance.ts                    Epicentral and hypocentral distance
src/analysis/fourier.ts                     Fourier amplitude spectrum
src/analysis/wavelet.ts                     Morlet continuous wavelet transform
src/analysis/horizontalVerticalRatio.ts     Horizontal-to-vertical spectral ratio
src/analysis/orbit.ts                       Particle orbit calculations
src/analysis/responseSpectrum.ts            Nigam-Jennings response spectrum
src/analysis/jmaIntensity.ts                JMA seismic intensity
src/components/LocationDistancePanel.tsx    Location input and distance display
src/components/ManualFormatImportPanel.tsx  UI for unknown text formats
src/components/ParticleOrbitPanel.tsx       Particle orbit view
src/components/WaveletPanel.tsx             Wavelet scalogram view
src/components/ReportFigurePanel.tsx        Report-ready overview figure
src/components/StationMap.tsx               Station map
src/components/SvgChart.tsx                 SVG chart and PNG/SVG export
src/export/                                 CSV/JSON/ZIP export
```
